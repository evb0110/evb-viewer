import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { OCR_PLATFORM_FEATURE } from '@contracts/ocrPlatformFeature';
import * as v from 'valibot';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';
import type { IpcRenderer } from 'electron';
import {requireRequestId} from '@contracts/shared';

const channels = OCR_PLATFORM_FEATURE.invokeChannels;
const eventChannels = OCR_PLATFORM_FEATURE.eventChannels;

describe('OCR platform feature', () => {
    it('keeps optional catalog arguments in their declared slots', () => {
        const revision = parseDocumentRevisionToken('drt1:ocr-fixture');
        if (revision === null) throw new Error('fixture revision must be valid');
        const catalogArgs = OCR_PLATFORM_FEATURE.ipcCodecs[channels.resolveDocumentTextCatalog];
        const windowArgs = OCR_PLATFORM_FEATURE.ipcCodecs[channels.resolveDocumentTextCatalogWindow];

        expect(catalogArgs.decodeArgs([
            '/tmp/ocr-fixture.pdf',
            revision,
            undefined,
            'ocr-catalog-1',
        ])).toEqual([
            '/tmp/ocr-fixture.pdf',
            revision,
            undefined,
            'ocr-catalog-1',
        ]);
        expect(catalogArgs.decodeArgs([
            '/tmp/ocr-fixture.pdf',
            revision,
            7,
            'ocr-catalog-2',
        ])).toEqual([
            '/tmp/ocr-fixture.pdf',
            revision,
            7,
            'ocr-catalog-2',
        ]);
        expect(windowArgs.decodeArgs([
            '/tmp/ocr-fixture.pdf',
            revision,
            2,
            4,
            undefined,
            'ocr-window-1',
        ])).toEqual([
            '/tmp/ocr-fixture.pdf',
            revision,
            2,
            4,
            undefined,
            'ocr-window-1',
        ]);
        expect(windowArgs.decodeArgs([
            '/tmp/ocr-fixture.pdf',
            revision,
            2,
            4,
            9,
            'ocr-window-2',
        ])).toEqual([
            '/tmp/ocr-fixture.pdf',
            revision,
            2,
            4,
            9,
            'ocr-window-2',
        ]);
    });

    it('preserves channels, timeouts, optional members, and registry replay policy', () => {
        expect(channels).toEqual({
            cancel: 'ocr:cancel',
            getLanguages: 'ocr:getLanguages',
            resolveDocumentTextCatalog: 'ocr:resolveDocumentTextCatalog',
            resolveDocumentTextCatalogWindow: 'ocr:resolveDocumentTextCatalogWindow',
            resolveDocumentOcrAvailability: 'ocr:resolveDocumentOcrAvailability',
            resolveDocumentOcrPage: 'ocr:resolveDocumentOcrPage',
            acknowledgeResultFile: 'ocr:ackResultFile',
            createSearchablePdf: 'ocr:createSearchablePdf',
            subscribeProgress: 'ocr:progress:subscribe',
        });
        expect(eventChannels).toEqual({
            onProgress: 'ocr:progress',
            onComplete: 'ocr:complete',
        });
        expect(OCR_PLATFORM_FEATURE.methods.resolveDocumentOcrAvailability)
            .toMatchObject({
                optionalWhenImplemented: true,
                required: {
                    browser: false,
                    electron: false,
                },
            });
        expect(OCR_PLATFORM_FEATURE.methods.resolveDocumentOcrPage)
            .toMatchObject({optionalWhenImplemented: true});
        expect(OCR_PLATFORM_FEATURE.methods.createSearchablePdf.ipc.timeoutMs)
            .toBe(30 * 60 * 1_000);
        const replay = OCR_PLATFORM_FEATURE.events.onProgress.subscription.replay;
        expect(replay).toMatchObject({
            intervalMs: 50,
            mode: 'latest-per-key',
            owner: 'ipc-progress-pump',
            terminalRetentionMs: 30_000,
        });
        expect(replay.key({
            requestId: requireRequestId('ocr-1'),
            currentPage: 1,
            processedCount: 0,
            totalPages: 1,
        })).toBe('ocr-1');
        expect(replay.terminal({
            requestId: requireRequestId('ocr-1'),
            currentPage: 1,
            processedCount: 1,
            totalPages: 1,
            status: 'success',
        })).toBe(true);
    });

    it('parses OCR languages in the feature codec while preload forwards trusted main results', async () => {
        let result: unknown = [
            {
                code: 'eng',
                script: 'latin',
            },
            {
                code: 'ara',
                script: 'rtl',
            },
        ];
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(async () => result),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer as IpcRenderer,
            OCR_PLATFORM_FEATURE,
        );
        const codec = OCR_PLATFORM_FEATURE.ipcCodecs[channels.getLanguages];

        expect(codec.decodeResult(result)).toEqual(result);
        await expect(client.getLanguages()).resolves.toEqual(result);

        for (result of [
            {
                code: 'eng',
                script: 'latin',
            },
            [{
                code: 'ENG',
                script: 'latin',
            }],
            [{
                code: 'eng',
                script: 'future-script',
            }],
            [
                {
                    code: 'eng',
                    script: 'latin',
                },
                {
                    code: 'eng',
                    script: 'latin',
                },
            ],
        ]) {
            expect(() => codec.decodeResult(result)).toThrow();
            await expect(client.getLanguages()).resolves.toEqual(result);
        }
    });

    it('forwards main-originated OCR events without re-decoding them in preload', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return ipcRenderer as IpcRenderer;
            }),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer as IpcRenderer,
            OCR_PLATFORM_FEATURE,
        );
        const progressCallback = vi.fn();
        const completeCallback = vi.fn();

        client.onProgress(progressCallback);
        client.onComplete(completeCallback);
        listeners.get(eventChannels.onProgress)?.({}, {
            requestId: 'ocr-1',
            currentPage: 1,
            processedCount: 1,
            totalPages: 2,
            phase: 'processing',
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            requestId: 'ocr-2',
            currentPage: '1',
            processedCount: 1,
            totalPages: 2,
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            requestId: 'ocr-3',
            currentPage: 1,
            processedCount: 1,
            totalPages: 2,
            phase: 'not-a-contract-phase',
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-1',
            success: true,
            pdfPath: '/tmp/out.pdf',
            sourceDocumentRevisionToken: 'source-revision-token',
            resultSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            requiresCleanupAck: true,
            errors: [],
            diagnostics: [{
                code: 'OCR_SOURCE_DPI_LIMITED',
                severity: 'info',
                message: 'Source DPI was limited',
                pageNumber: 1,
            }],
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-2',
            success: true,
            errors: [42],
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-3',
            success: false,
            errors: ['OCR queue is full'],
            errorEnvelope: {
                code: 'OCR_QUEUE_BACKPRESSURE',
                message: 'OCR queue is full',
                retryable: true,
                timestamp: 123,
            },
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-4',
            success: false,
            errors: ['Malformed envelope'],
            errorEnvelope: {
                code: 'OCR_INTERNAL_ERROR',
                message: 'Malformed envelope',
                retryable: 'no',
                timestamp: 123,
            },
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-5',
            success: true,
            pdfPath: '/tmp/out-without-token.pdf',
            requiresCleanupAck: true,
            errors: [],
        });

        expect(progressCallback).toHaveBeenCalledTimes(3);
        expect(progressCallback).toHaveBeenNthCalledWith(1, {
            requestId: 'ocr-1',
            currentPage: 1,
            processedCount: 1,
            totalPages: 2,
            phase: 'processing',
        });
        expect(progressCallback).toHaveBeenNthCalledWith(2, {
            requestId: 'ocr-2',
            currentPage: '1',
            processedCount: 1,
            totalPages: 2,
        });
        expect(progressCallback).toHaveBeenNthCalledWith(3, {
            requestId: 'ocr-3',
            currentPage: 1,
            processedCount: 1,
            totalPages: 2,
            phase: 'not-a-contract-phase',
        });
        expect(completeCallback).toHaveBeenCalledTimes(5);
        expect(completeCallback).toHaveBeenNthCalledWith(1, expect.objectContaining({
            requestId: 'ocr-1',
            pdfPath: '/tmp/out.pdf',
        }));
        expect(completeCallback).toHaveBeenNthCalledWith(2, {
            requestId: 'ocr-2',
            success: true,
            errors: [42],
        });
        expect(completeCallback).toHaveBeenNthCalledWith(3, expect.objectContaining({
            requestId: 'ocr-3',
            success: false,
            errorEnvelope: expect.objectContaining({code: 'OCR_QUEUE_BACKPRESSURE'}),
        }));
        expect(completeCallback).toHaveBeenNthCalledWith(4, expect.objectContaining({
            requestId: 'ocr-4',
            errorEnvelope: expect.objectContaining({retryable: 'no'}),
        }));
        expect(completeCallback).toHaveBeenNthCalledWith(5, expect.objectContaining({
            requestId: 'ocr-5',
            success: true,
        }));

        const progressSchema = OCR_PLATFORM_FEATURE.events.onProgress.payload;
        expect(v.parse(progressSchema, {
            requestId: 'ocr-1',
            currentPage: 1,
            processedCount: 1,
            totalPages: 2,
            phase: 'processing',
        })).toEqual({
            requestId: 'ocr-1',
            currentPage: 1,
            processedCount: 1,
            totalPages: 2,
            phase: 'processing',
        });
        expect(v.safeParse(progressSchema, {
            requestId: 'ocr-2',
            currentPage: '1',
            processedCount: 1,
            totalPages: 2,
        }).success).toBe(false);
    });
});
