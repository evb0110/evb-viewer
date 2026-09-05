import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {
    DOCUMENT_PLATFORM_FEATURES,
    type IDocumentMenuInvokeMap,
    type IDocumentPickerInvokeMap,
    type IDocumentRecentFilesInvokeMap,
    type IDocumentWindowInvokeMap,
} from '@contracts/documentsPlatformFeature';
import {
    createPdfPersistenceAckFrame,
    createPdfPersistenceReadyFrame,
    createPdfPersistenceResultFrame,
    isPdfPersistencePreloadToMainPayload,
} from '@contracts/documentPersistenceFrames';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import type { IDocumentsService } from '@electron/features/documents/documentsService';
import { registerDocumentsIpcAdapter } from '@electron/features/documents/registerDocumentsIpcAdapter';
import { cast } from '@tests/helpers/cast';
import { createInProcessIpcRoundTripHarness } from '@tests/unit/electron/helpers/createInProcessIpcRoundTripHarness';

const mocks = vi.hoisted(() => ({
    appOn: vi.fn(),
    fromWebContents: vi.fn(() => null),
    isTrustedIpcInvokeSender: vi.fn(() => true),
}));
type TDocumentsCombinedInvokeMap =
    & IDocumentsInvokeMap
    & IDocumentPickerInvokeMap
    & IDocumentRecentFilesInvokeMap
    & IDocumentWindowInvokeMap
    & IDocumentMenuInvokeMap;
const documentsCombinedChannels = {
    ...DOCUMENTS_CHANNELS,
    ...Object.assign({}, ...DOCUMENT_PLATFORM_FEATURES.map(feature => feature.invokeChannels)),
};
const documentsCombinedCodecs = {
    ...DOCUMENTS_IPC_CODECS,
    ...Object.assign({}, ...DOCUMENT_PLATFORM_FEATURES.map(feature => feature.ipcCodecs)),
};

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        on: mocks.appOn,
    },
    BrowserWindow: {fromWebContents: mocks.fromWebContents},
    ipcMain: {
        handle: vi.fn(),
        on: vi.fn(),
    },
}));
vi.mock('@electron/platform-ipc/trustedIpcSender', () => ({
    isTrustedIpcInvokeSender: mocks.isTrustedIpcInvokeSender,
    isTrustedWebContentsSender: vi.fn(() => true),
}));
vi.mock('@electron/features/documents/createDocumentsService', () => ({createDocumentsService: vi.fn()}));
vi.mock('@electron/features/documents/public', () => ({attachSerializedPdfPersistencePort: vi.fn()}));

describe('in-process preload to validated IPC round trips', () => {
    it('preserves paths and binary streams through the file preload client and adapter', async () => {
        const sourcePaths = [
            '/documents/duplicate-source-a/duplicate-recent-source.pdf',
            '/documents/duplicate-source-b/duplicate-recent-source.pdf',
        ];
        const receivedChunks: Uint8Array[] = [];
        const openDocumentDirect = vi.fn(async (
            _context: unknown,
            originalPath: string,
            password?: string,
        ) => originalPath === '/documents/protected.pdf' && password !== 'correct-password'
            ? {
                kind: 'pdf-needs-password' as const,
                originalPath,
            }
            : {
                kind: 'pdf' as const,
                originalPath,
                workingPath: `/managed/duplicate-source-${originalPath.includes('-a/') ? 'a' : 'b'}.pdf`,
            });
        const parsePdfAnnotations = vi.fn(async (
            _context: unknown,
            _path: string,
            options: {expectedDocumentRevisionToken: ReturnType<typeof requireDocumentRevisionToken>},
        ) => ({
            documentRevisionToken: options.expectedDocumentRevisionToken,
            pageCount: 1,
            entities: [],
            foreign: [],
        }));
        const service = cast<IDocumentsService>({
            beginSavePdfData: vi.fn(async () => ({sessionId: 'persistence-session-1'})),
            createWorkingCopyFromData: vi.fn(async () => '/tmp/working-copy.pdf'),
            openDocumentDirect,
            parsePdfAnnotations,
        });
        const harness = createInProcessIpcRoundTripHarness<
            TDocumentsCombinedInvokeMap,
            IDocumentsService,
            ReturnType<typeof createDocumentsPreloadFileClient>
        >({
            channels: documentsCombinedChannels,
            codecs: documentsCombinedCodecs,
            createClient: createDocumentsPreloadFileClient,
            postMessage: (channel, sessionId, transfer) => {
                expect([
                    channel,
                    sessionId,
                ]).toEqual([
                    DOCUMENTS_CHANNELS.fileSavePdfDataPort,
                    'persistence-session-1',
                ]);
                const port = transfer?.[0];
                if (!port) {
                    throw new Error('Missing transferred PDF persistence port');
                }
                port.addEventListener('message', ({data: frame}) => {
                    if (!isPdfPersistencePreloadToMainPayload(frame)) {
                        return;
                    }
                    if (frame.type === 'chunk') {
                        const bytes = frame.bytes instanceof Uint8Array
                            ? frame.bytes
                            : new Uint8Array(frame.bytes ?? new ArrayBuffer(0));
                        receivedChunks.push(Uint8Array.from(bytes));
                        port.postMessage(createPdfPersistenceAckFrame(frame.seq!, bytes.byteLength));
                    } else if (frame.type === 'complete') {
                        port.postMessage(createPdfPersistenceResultFrame('/tmp/working.pdf', {
                            errors: [],
                            isValid: true,
                            tool: 'browser',
                            warnings: [],
                        }));
                    }
                });
                port.start();
                port.postMessage(createPdfPersistenceReadyFrame());
            },
            register: (registrar, documentsService) => registerDocumentsIpcAdapter(
                registrar,
                documentsService,
                {eventRegistrar: {on: vi.fn()}},
            ),
            service,
        });
        const data = Uint8Array.from([
            1,
            3,
            5,
            7,
        ]);

        await expect(harness.client.createWorkingCopyFromData('round-trip.pdf', data, '/tmp/source.pdf'))
            .resolves.toBe('/tmp/working-copy.pdf');
        expect(service.createWorkingCopyFromData).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            'round-trip.pdf',
            data,
            '/tmp/source.pdf',
            undefined,
        );
        const parseRevision = requireDocumentRevisionToken('round-trip-parse-revision');
        await expect(harness.client.parsePdfAnnotations(
            '/tmp/working-copy.pdf',
            {expectedDocumentRevisionToken: parseRevision},
        )).resolves.toEqual({
            documentRevisionToken: parseRevision,
            pageCount: 1,
            entities: [],
            foreign: [],
        });
        expect(parsePdfAnnotations).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            '/tmp/working-copy.pdf',
            {expectedDocumentRevisionToken: parseRevision},
        );
        expect(harness.invokeCalls).toContainEqual({
            channel: DOCUMENTS_CHANNELS.parsePdfAnnotations,
            args: [
                '/tmp/working-copy.pdf',
                {expectedDocumentRevisionToken: parseRevision},
            ],
        });
        await expect(harness.client.savePdfDataChunks('/tmp/working.pdf', 5, [
            Uint8Array.from([
                1,
                2,
            ]),
            Uint8Array.from([
                3,
                4,
                5,
            ]),
        ], {expectedDocumentRevisionToken: requireDocumentRevisionToken('round-trip-revision')}))
            .resolves.toMatchObject({
                isValid: true,
                tool: 'browser',
            });
        expect(receivedChunks).toEqual([
            Uint8Array.from([
                1,
                2,
            ]),
            Uint8Array.from([
                3,
                4,
                5,
            ]),
        ]);

        const opened = await Promise.all(sourcePaths.map(path => harness.client.openDocumentDirect(path)));
        expect(opened.map(result => result?.kind === 'pdf' ? result.workingPath : undefined)).toEqual([
            '/managed/duplicate-source-a.pdf',
            '/managed/duplicate-source-b.pdf',
        ]);
        expect(openDocumentDirect.mock.calls.map(call => call.slice(1))).toEqual(sourcePaths.map(path => [path]));
        expect(harness.invokeCalls.slice(-2)).toEqual(sourcePaths.map(path => ({
            args: [path],
            channel: DOCUMENTS_CHANNELS.openDocumentDirect,
        })));

        await expect(harness.client.openDocumentDirect('/documents/protected.pdf'))
            .resolves.toEqual({
                kind: 'pdf-needs-password',
                originalPath: '/documents/protected.pdf',
            });
        await expect(harness.client.openDocumentDirect('/documents/protected.pdf', 'wrong-password'))
            .resolves.toEqual({
                kind: 'pdf-needs-password',
                originalPath: '/documents/protected.pdf',
            });
        await expect(harness.client.openDocumentDirect('/documents/protected.pdf', 'correct-password'))
            .resolves.toMatchObject({
                kind: 'pdf',
                originalPath: '/documents/protected.pdf',
            });
        expect(openDocumentDirect.mock.calls.slice(-2).map(call => call.slice(1))).toEqual([
            [
                '/documents/protected.pdf',
                'wrong-password',
            ],
            [
                '/documents/protected.pdf',
                'correct-password',
            ],
        ]);
        expect(harness.invokeCalls.slice(-2)).toEqual([
            {
                args: [
                    '/documents/protected.pdf',
                    'wrong-password',
                ],
                channel: DOCUMENTS_CHANNELS.openDocumentDirect,
            },
            {
                args: [
                    '/documents/protected.pdf',
                    'correct-password',
                ],
                channel: DOCUMENTS_CHANNELS.openDocumentDirect,
            },
        ]);
    });
});
