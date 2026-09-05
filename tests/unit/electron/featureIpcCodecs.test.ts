import {
    describe,
    expect,
    it,
} from 'vitest';
import { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import { PLATFORM_FEATURE_REGISTRY } from '@contracts/platformApiDescriptor';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import { OCR_PLATFORM_FEATURE } from '@contracts/ocrPlatformFeature';
import { SCAN_CLEANUP_PLATFORM_FEATURE } from '@contracts/scanCleanupPlatformFeature';
import {PDF_DECRYPT_PASSWORD_MAX_BYTES} from '@contracts/pdfDecryptSchemas';

const AGENT_CHANNELS = AGENT_PLATFORM_FEATURE.invokeChannels;
const AGENT_IPC_CODECS = AGENT_PLATFORM_FEATURE.ipcCodecs;
const DJVU_CHANNELS = DJVU_PLATFORM_FEATURE.invokeChannels;
const DJVU_IPC_CODECS = DJVU_PLATFORM_FEATURE.ipcCodecs;
const OCR_CHANNELS = OCR_PLATFORM_FEATURE.invokeChannels;
const OCR_IPC_CODECS = OCR_PLATFORM_FEATURE.ipcCodecs;
const djvuCodec = (channel: string) => DJVU_IPC_CODECS[channel]!;
const agentCodec = (channel: string) => AGENT_IPC_CODECS[channel]!;
const ocrCodec = (channel: string) => OCR_IPC_CODECS[channel]!;
const validStagedArtifact = {
    receiptVersion: 1 as const,
    artifactKind: 'pdf' as const,
    path: '/tmp/staged.pdf',
    size: 512,
    sha256: 'a'.repeat(64),
    fileIdentity: {
        platform: 'posix' as const,
        deviceId: '1',
        inode: '2',
    },
    validations: {
        qpdfCheck: false,
        tailCheck: false,
        semanticCheck: false,
        fsynced: false,
    },
    leaseId: 'lease-1',
    revision: null,
};

function expectExhaustiveMap(
    channels: Record<string, string>,
    codecs: Record<string, unknown>,
    excludedChannels: readonly string[] = [],
) {
    const excluded = new Set(excludedChannels);
    expect(Object.keys(codecs).sort()).toEqual([...new Set(Object.values(channels).filter(channel => !excluded.has(channel)))].sort());
}

describe('feature IPC codec maps', () => {
    it('cover every invoke channel exactly once', () => {
        for (const feature of PLATFORM_FEATURE_REGISTRY) {
            expectExhaustiveMap(feature.invokeChannels, feature.ipcCodecs);
        }
        expectExhaustiveMap(DOCUMENTS_CHANNELS, DOCUMENTS_IPC_CODECS, [DOCUMENTS_CHANNELS.fileSavePdfDataPort]);
    });

    it('keeps scan-cleanup generated-output pruning zero-argument', () => {
        const channel = SCAN_CLEANUP_PLATFORM_FEATURE.invokeChannels.pruneGeneratedOutputs;
        const codec = SCAN_CLEANUP_PLATFORM_FEATURE.ipcCodecs[channel];

        expect(codec?.decodeArgs([])).toEqual([]);
        expect(() => codec?.decodeArgs([['/tmp/reported-open.pdf']])).toThrow('expected 0 arguments, received 1');
    });

    it('preserves native path print layout options when the filename is omitted', () => {
        const options = {
            pageNumbers: [
                2,
                5,
            ],
            viewMode: 'facing',
            orientation: 'landscape',
            requestId: 'print-request-1',
        } as const;
        const codec = DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfPrintPath];

        expect(codec.decodeArgs([
            '/tmp/document.pdf',
            undefined,
            options,
        ])).toEqual([
            '/tmp/document.pdf',
            undefined,
            options,
        ]);
        expect(() => codec.decodeArgs([
            '/tmp/document.pdf',
            'document.pdf',
            {
                ...options,
                orientation: 'diagonal',
            },
        ])).toThrow('options.orientation is invalid');
    });

    it('preserves native data print handoff options when the filename is omitted', () => {
        const data = Uint8Array.of(1, 2, 3);
        const options = {requestId: 'print-data-request-1'};
        const codec = DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfPrintData];

        expect(codec.decodeArgs([
            data,
            undefined,
            options,
        ])).toEqual([
            data,
            undefined,
            options,
        ]);
        expect(() => codec.decodeArgs([
            data,
            'document.pdf',
            {requestId: ''},
        ])).toThrow('options.requestId must be a non-empty bounded string');

        const cancelCodec = DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfPrintCancel];
        expect(cancelCodec.decodeArgs(['print-data-request-1'])).toEqual(['print-data-request-1']);
        expect(cancelCodec.decodeResult({canceled: true})).toEqual({canceled: true});
        expect(() => cancelCodec.decodeArgs([])).toThrow('expected 1 arguments');
    });

    it('validates native print-dialog handoff events', () => {
        const event = DOCUMENT_PDF_PLATFORM_FEATURE.events.onNativePrintDialogOpened;

        expect(event.payload.decode({requestId: 'print-request-1'})).toEqual({requestId: 'print-request-1'});
        expect(() => event.payload.decode({requestId: ''})).toThrow(
            'native print dialog event requestId must be a non-empty bounded string',
        );
    });

    it('validates working-copy backing status once at the generated IPC boundary', () => {
        const channel = DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.getWorkingCopyBackingStatus;
        const validStatus = {
            documentRef: '/tmp/managed.pdf',
            failure: null,
            progress: 0.5,
            state: 'materializing' as const,
        };

        expect(DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs[channel]?.decodeArgs(['/tmp/managed.pdf']))
            .toEqual(['/tmp/managed.pdf']);
        expect(DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs[channel]?.decodeResult(validStatus))
            .toEqual(validStatus);
        expect(DOCUMENT_FILES_PLATFORM_FEATURE.events.onWorkingCopyBackingStatusChanged.payload.decode(validStatus))
            .toEqual(validStatus);
        expect(DOCUMENT_FILES_PLATFORM_FEATURE.platformDescriptors.methods.find(
            descriptor => descriptor.path.at(-1) === 'onWorkingCopyBackingStatusChanged',
        )).toMatchObject({
            optionalWhenImplemented: true,
            required: {
                browser: false,
                electron: false,
            },
        });
        expect(() => DOCUMENT_FILES_PLATFORM_FEATURE.events
            .onWorkingCopyBackingStatusChanged.payload.decode({
                ...validStatus,
                progress: 1.1,
            }))
            .toThrow('invalid working-copy backing status');
    });

    it('accepts only the bounded opening purpose for path validation', () => {
        const channel = DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.validatePdfPath;
        const codec = DOCUMENT_PDF_PLATFORM_FEATURE.ipcCodecs[channel];

        expect(codec?.decodeArgs(['/tmp/document.pdf']))
            .toEqual(['/tmp/document.pdf']);
        expect(codec?.decodeArgs([
            '/tmp/document.pdf',
            {purpose: 'opening'},
        ])).toEqual([
            '/tmp/document.pdf',
            {purpose: 'opening'},
        ]);
        expect(() => codec?.decodeArgs([
            '/tmp/document.pdf',
            {purpose: 'save'},
        ]))
            .toThrow('validation options must be {purpose: \'opening\'}');
    });

    it('preserves typed native mutation fallback errors and rejects unknown codes', () => {
        const codec = DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs[
            DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.applyPdfNativeMutationsToWorkingCopy
        ];
        const fallback = {
            applied: false,
            validation: null,
            error: {
                code: 'too-large',
                message: 'Native mutation input exceeds limits',
            },
        } as const;

        expect(codec?.decodeResult(fallback)).toEqual(fallback);
        expect(() => codec?.decodeResult({
            ...fallback,
            error: {
                code: 'future-native-code',
                message: 'Unknown native mutation failure',
            },
        })).toThrow('invalid native PDF save result');
    });

    it('preserves only an affirmative native mutation postcondition proof', () => {
        const codec = DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs[
            DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.applyPdfNativeMutationsToWorkingCopy
        ];
        const verified = {
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
                errors: [],
                warnings: [],
            },
            nativeMutationPostconditionsVerified: true,
        } as const;

        expect(codec?.decodeResult(verified)).toEqual(verified);
        expect(() => codec?.decodeResult({
            ...verified,
            nativeMutationPostconditionsVerified: false,
        })).toThrow('invalid native PDF save result');
    });

    it('canonically validates native mutation requests at the feature boundary', () => {
        const saveCodec = DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs[
            DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfNativeMutations
        ];
        const applyCodec = DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs[
            DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.applyPdfNativeMutationsToWorkingCopy
        ];
        const validMutation = {updates: [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }]};
        const validModifiedAt = 'D:20260810010203Z';
        const revisionOptions = {expectedDocumentRevisionToken: 'drt1:test:feature-ipc'};

        expect(saveCodec?.decodeArgs([
            '/tmp/working.pdf',
            validMutation,
            validModifiedAt,
        ])).toEqual([
            '/tmp/working.pdf',
            validMutation,
            validModifiedAt,
        ]);
        expect(() => saveCodec?.decodeArgs([
            '/tmp/working.pdf',
            {},
            validModifiedAt,
        ])).toThrow('must include at least one native PDF mutation');
        expect(() => saveCodec?.decodeArgs([
            '/tmp/working.pdf',
            validMutation,
            '2026-08-10T01:02:03.000Z',
        ])).toThrow('modifiedAt must be a PDF date string');
        expect(() => saveCodec?.decodeArgs([
            '/tmp/working.pdf',
            {updates: [{
                objectNumber: 0,
                generationNumber: 0,
                text: 'Invalid',
            }]},
            validModifiedAt,
        ])).toThrow('mutations.updates[0].objectNumber');
        expect(() => applyCodec?.decodeArgs([
            '/tmp/working.pdf',
            validMutation,
            validModifiedAt,
        ])).toThrow('expected 4 arguments');
        expect(applyCodec?.decodeArgs([
            '/tmp/working.pdf',
            validMutation,
            validModifiedAt,
            revisionOptions,
        ])).toEqual([
            '/tmp/working.pdf',
            validMutation,
            validModifiedAt,
            revisionOptions,
        ]);
    });

    it('deeply validates workspace snapshots at the platform boundary', () => {
        const codec = agentCodec(AGENT_CHANNELS.submitWorkspaceSnapshot);
        const snapshot = {
            capturedAt: '2026-08-10T01:02:03.000Z',
            activePaneId: null,
            activeTabId: null,
            summary: {
                mode: 'empty-workspace',
                activeDocument: null,
                documentCount: 0,
                recentFileCount: 0,
                recentFilesResolved: true,
            },
            panes: [],
            tabs: [],
            recentFiles: [],
            layout: null,
        };

        expect(codec.decodeArgs([{
            requestId: 'snapshot-1',
            ok: true,
            snapshot,
        }])).toEqual([{
            requestId: 'snapshot-1',
            ok: true,
            snapshot,
        }]);
        expect(() => codec.decodeArgs([{
            requestId: 'snapshot-1',
            ok: true,
            snapshot: {
                ...snapshot,
                panes: [42],
            },
        }])).toThrow('invalid workspace snapshot response');
    });

    it('preserves the source identity needed to validate cached opening geometry', () => {
        expect(DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs[
            DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.getPdfOpeningGeometry
        ]?.decodeResult(null)).toBeNull();
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.fileStat].decodeResult({
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        })).toEqual({
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        });
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.fileStat].decodeResult({
            size: 28_000_000,
            modifiedAt: -1,
        })).toThrow('invalid file modification time');
        expect(djvuCodec(DJVU_CHANNELS.getPageSourceInfo).decodeResult({
            pageCount: 431,
            pageNumber: 1,
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
            sourceSize: 28_000_000,
            sourceModifiedAt: 1_720_000_000_000,
        })).toEqual({
            pageCount: 431,
            pageNumber: 1,
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
            sourceSize: 28_000_000,
            sourceModifiedAt: 1_720_000_000_000,
        });
        expect(djvuCodec(DJVU_CHANNELS.awaitOpenJob).decodeResult({
            success: true,
            pageCount: 431,
            pageSourceInfo: {
                pageCount: 431,
                pageNumber: 1,
                pageSize: {
                    width: 600,
                    height: 800,
                    dpi: 300,
                },
                sourceSize: 28_000_000,
                sourceModifiedAt: 1_720_000_000_000,
            },
        })).toMatchObject({
            success: true,
            pageSourceInfo: {
                sourceSize: 28_000_000,
                sourceModifiedAt: 1_720_000_000_000,
            },
        });
    });

    it('validates native DjVu page text and nested outline provider results', () => {
        expect(djvuCodec(DJVU_CHANNELS.getPageText).decodeArgs([
            '/tmp/book.djvu',
            3,
        ])).toEqual([
            '/tmp/book.djvu',
            3,
        ]);
        expect(djvuCodec(DJVU_CHANNELS.getPageText).decodeResult('Native page text'))
            .toBe('Native page text');
        expect(djvuCodec(DJVU_CHANNELS.getOutline).decodeResult([{
            title: 'Chapter',
            pageNumber: 1,
            children: [{
                title: 'Section',
                pageNumber: 3,
                children: [],
            }],
        }])).toEqual([{
            title: 'Chapter',
            pageNumber: 1,
            children: [{
                title: 'Section',
                pageNumber: 3,
                children: [],
            }],
        }]);
        expect(() => djvuCodec(DJVU_CHANNELS.getPageText).decodeArgs([
            '/tmp/book.djvu',
            0,
        ])).toThrow('pageNumber');
        expect(() => djvuCodec(DJVU_CHANNELS.getOutline).decodeResult([{
            title: 'Broken',
            pageNumber: 0,
            children: [],
        }])).toThrow('invalid DjVu outline item');
    });

    it('validates streamed DjVu text-search options and word geometry', () => {
        expect(djvuCodec(DJVU_CHANNELS.searchText).decodeArgs([
            '/tmp/book.djvu',
            'needle',
            {
                requestId: 'djvu-search-1',
                pageCount: 431,
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            },
        ])).toEqual([
            '/tmp/book.djvu',
            'needle',
            {
                requestId: 'djvu-search-1',
                pageCount: 431,
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            },
        ]);
        expect(djvuCodec(DJVU_CHANNELS.searchText).decodeResult({
            truncated: false,
            results: [{
                pageNumber: 9,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 5,
                endOffset: 11,
                excerpt: {
                    prefix: false,
                    suffix: false,
                    before: '',
                    match: 'needle',
                    after: '',
                },
                pageWidth: 1000,
                pageHeight: 2000,
                rotation: 0,
                words: [{
                    text: 'needle',
                    x: 150,
                    y: 400,
                    width: 200,
                    height: 100,
                }],
            }],
        })).toMatchObject({results: [{
            pageNumber: 9,
            words: [{y: 400}],
        }]});
        const largePageCountArgs = [
            '/tmp/book.djvu',
            'needle',
            {
                requestId: 'djvu-search-1',
                pageCount: 1_000_001,
            },
        ] as const;
        expect(djvuCodec(DJVU_CHANNELS.searchText).decodeArgs(largePageCountArgs)).toEqual([
            '/tmp/book.djvu',
            'needle',
            {
                requestId: 'djvu-search-1',
                pageCount: 1_000_001,
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
        ]);

        for (const invalidPageCount of [
            0,
            -1,
            1.5,
            Number.MAX_SAFE_INTEGER + 1,
            Number.POSITIVE_INFINITY,
        ]) {
            expect(() => djvuCodec(DJVU_CHANNELS.searchText).decodeArgs([
                '/tmp/book.djvu',
                'needle',
                {
                    requestId: 'djvu-search-1',
                    pageCount: invalidPageCount,
                },
            ])).toThrow('pageCount must be a positive safe integer');
        }
        expect(() => djvuCodec(DJVU_CHANNELS.searchText).decodeResult({
            truncated: false,
            results: [{
                pageNumber: 9,
                words: [{width: -1}],
            }],
        })).toThrow('invalid');
    });

    it('validates exact first-page opening geometry at the IPC boundary', () => {
        const validGeometry = {
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 90,
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
            linearized: false,
        };
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfOpeningGeometry].decodeResult(validGeometry))
            .toEqual(validGeometry);
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeResult({
            kind: 'pdf',
            workingPath: '/managed/scan.pdf',
            originalPath: '/documents/scan.pdf',
            openingGeometry: validGeometry,
        })).toEqual({
            kind: 'pdf',
            workingPath: '/managed/scan.pdf',
            originalPath: '/documents/scan.pdf',
            openingGeometry: validGeometry,
        });
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeResult({
            kind: 'pdf-needs-password',
            originalPath: '/documents/scan.pdf',
        })).toEqual({
            kind: 'pdf-needs-password',
            originalPath: '/documents/scan.pdf',
        });
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeResult({
            kind: 'pdf-unsupported-encryption',
            originalPath: '/documents/scan.pdf',
        })).toEqual({
            kind: 'pdf-unsupported-encryption',
            originalPath: '/documents/scan.pdf',
        });
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeArgs([
            '/documents/scan.pdf',
            'correct-password',
        ])).toEqual([
            '/documents/scan.pdf',
            'correct-password',
        ]);
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeArgs([
            '/documents/scan.pdf',
            undefined,
        ])).toEqual(['/documents/scan.pdf']);
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeArgs([
            '/documents/scan.pdf',
            'x'.repeat(PDF_DECRYPT_PASSWORD_MAX_BYTES + 1),
        ])).toThrow(`password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        const multibytePassword = '🔒'.repeat(Math.ceil((PDF_DECRYPT_PASSWORD_MAX_BYTES + 1) / 4));
        expect(multibytePassword.length).toBeLessThan(PDF_DECRYPT_PASSWORD_MAX_BYTES);
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeArgs([
            '/documents/scan.pdf',
            multibytePassword,
        ])).toThrow(`password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeResult({
            kind: 'pdf-needs-password',
            originalPath: '',
        })).toThrow('invalid encrypted PDF open-file result');
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfOpeningGeometry].decodeResult({
            ...validGeometry,
            pageNumber: 2,
        })).toThrow('invalid PDF opening geometry result');
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfOpeningGeometry].decodeResult({
            ...validGeometry,
            rotation: 45,
        })).toThrow('invalid PDF opening geometry result');
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfOpeningGeometry].decodeResult({
            ...validGeometry,
            linearized: 'no',
        })).toThrow('invalid PDF opening geometry result');
        const {
            linearized: _linearized,
            ...geometryWithoutLinearization
        } = validGeometry;
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfOpeningGeometry]
            .decodeResult(geometryWithoutLinearization))
            .toEqual(geometryWithoutLinearization);
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeResult({
            kind: 'pdf',
            workingPath: '/managed/scan.pdf',
            originalPath: '/documents/scan.pdf',
            openingGeometry: {
                ...validGeometry,
                rotation: 45,
            },
        })).toThrow('invalid PDF opening geometry result');
    });

    it.each([
        'djvu-convert',
        'djvu-open',
        'djvu-print',
    ] as const)('decodes %s document-output job state', (operation) => {
        expect(djvuCodec(DJVU_CHANNELS.subscribeJob).decodeResult({
            jobId: `${operation}-job`,
            operation,
            status: 'queued',
            progress: {
                jobId: `${operation}-job`,
                phase: operation === 'djvu-open' ? 'loading' : 'converting',
                percent: 0,
            },
            updatedAtMs: 1,
        })).toMatchObject({
            operation,
            status: 'queued',
        });
    });

    it('decodes staged artifact receipts in both native IPC directions', () => {
        expect(DOCUMENTS_IPC_CODECS[
            DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy
        ].decodeResult({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
                errors: [],
                warnings: [],
            },
            stagedOutput: validStagedArtifact,
        })).toMatchObject({stagedOutput: validStagedArtifact});
        expect(DOCUMENTS_IPC_CODECS[
            DOCUMENTS_CHANNELS.fileCommitStagedPdfNativeMutations
        ].decodeArgs([
            '/tmp/working.pdf',
            validStagedArtifact,
        ])).toEqual([
            '/tmp/working.pdf',
            validStagedArtifact,
        ]);
    });

    it('rejects malformed staged artifact receipts at the IPC boundary', () => {
        const malformedArtifact = {
            ...validStagedArtifact,
            validations: {
                ...validStagedArtifact.validations,
                qpdfCheck: true,
            },
        };

        expect(() => DOCUMENTS_IPC_CODECS[
            DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy
        ].decodeResult({
            applied: true,
            validation: null,
            stagedOutput: malformedArtifact,
        })).toThrow('invalid staged native PDF output');
        expect(() => DOCUMENTS_IPC_CODECS[
            DOCUMENTS_CHANNELS.fileCommitStagedPdfNativeMutations
        ].decodeArgs([
            '/tmp/working.pdf',
            malformedArtifact,
        ])).toThrow('typed staged artifact');
    });

    it('rejects oversized renderer collections before handler dispatch', () => {
        expect(() => agentCodec(AGENT_CHANNELS.sendAssistantMessage).decodeArgs([{
            text: 'inspect',
            attachments: Array.from({length: 9}, () => ({})),
        }])).toThrow('assistant attachments exceeds maximum item count (8)');

        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.allowRendererFileOpenBatch].decodeArgs(
            [Array.from({length: 4_097}, () => ({}))],
        )).toThrow('requests exceeds maximum item count (4096)');

        expect(() => djvuCodec(DJVU_CHANNELS.printDjvuPath).decodeArgs([
            '/tmp/a.djvu',
            {
                orientation: 'auto',
                pageNumbers: Array.from({length: 100_001}, (_, index) => index + 1),
                viewMode: 'single',
            },
        ])).toThrow('pageNumbers exceeds maximum item count (100000)');

        expect(() => ocrCodec(OCR_CHANNELS.createSearchablePdf).decodeArgs([
            '/tmp/a.pdf',
            Array.from({length: 100_001}),
            'request-1',
        ])).toThrow('OCR searchable PDF pages exceeds maximum item count (100000)');
    });
});
