import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import { IPC_INVOKE_REQUEST_ID_FIELD } from '@electron/platform-ipc/coreContract';
import { requireDocumentRef } from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import { requireEpochMs } from '@contracts/timestamps';
import {
    requireJobId,
    requireRequestId,
    type TRequestId,
} from '@contracts/shared';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    djvuConvertResultSchema, djvuPageSourceInfoSchema,
} from '@contracts/electronApiDjvu';
import * as v from 'valibot';

type TIpcRendererFixture = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'>;

const channels = DJVU_PLATFORM_FEATURE.invokeChannels;
const eventChannels = DJVU_PLATFORM_FEATURE.eventChannels;
const conversionFailure: FailureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef' as FailureReceipt['eventId'],
    code: 'UNCLASSIFIED_MAIN_ERROR',
    occurredAt: requireEpochMs(1),
    severity: 'error',
};

describe('DjVu platform feature', () => {
    it('preserves channels, timeouts, menu shape, and registry replay policy', () => {
        expect(channels).toEqual({
            startOpenForViewing: 'djvu:open:start',
            releaseViewingPath: 'djvu:releaseViewingPath',
            startConvertToPdf: 'djvu:convert:start',
            printDjvuPath: 'djvu:printDjvuPath',
            cancel: 'djvu:cancel',
            getJobState: 'djvu:job:getState',
            cancelPagePreview: 'djvu:cancelPagePreview',
            searchText: 'djvu:text:search',
            cancelTextSearch: 'djvu:text:cancel',
            getInfo: 'djvu:getInfo',
            getPageSourceInfo: 'djvu:getPageSourceInfo',
            getPageText: 'djvu:getPageText',
            getOutline: 'djvu:getOutline',
            getPageSizes: 'djvu:getPageSizes',
            renderPagePreview: 'djvu:renderPagePreview',
            estimateSizes: 'djvu:estimateSizes',
            cleanupTemp: 'djvu:cleanupTemp',
            subscribeProgress: 'djvu:progress:subscribe',
        });
        expect(eventChannels).toEqual({
            onProgress: 'djvu:progress',
            onConvertComplete: 'djvu:convert:complete',
            onOpenComplete: 'djvu:open:complete',
            onTextSearchProgress: 'djvu:text:progress',
            onMenuConvertToPdf: 'menu:convertToPdf',
        });
        expect(v.parse(DJVU_PLATFORM_FEATURE.events.onMenuConvertToPdf.payload, undefined))
            .toBeUndefined();
        expect(() => v.parse(DJVU_PLATFORM_FEATURE.events.onMenuConvertToPdf.payload, 'payload'))
            .toThrow();
        const replay = DJVU_PLATFORM_FEATURE.events.onProgress.subscription.replay;
        expect(replay).toMatchObject({
            intervalMs: 50,
            mode: 'latest-per-key',
            owner: 'ipc-progress-pump',
            terminalRetentionMs: 30_000,
        });
        expect(replay.key({
            jobId: requireJobId('job-1'),
            phase: 'printing',
            percent: 50,
        })).toBe('job-1:printing');
        expect(replay.terminal({
            jobId: requireJobId('job-1'),
            phase: 'printing',
            percent: 100,
            status: 'success',
        })).toBe(true);
        expect(DJVU_PLATFORM_FEATURE.methods.startOpenForViewing.ipc.timeoutMs)
            .toBe(30 * 60 * 1_000);
        expect(DJVU_PLATFORM_FEATURE.methods.renderPagePreview.ipc.timeoutMs)
            .toBe(30 * 60 * 1_000);
    });

    it('leaves preview request validation to the main IPC boundary', async () => {
        const invoke = vi.fn().mockResolvedValue({
            bytes: new Uint8Array([1]),
            width: 600,
            height: 800,
        });
        const ipcRenderer = {
            invoke,
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies TIpcRendererFixture;
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer,
            DJVU_PLATFORM_FEATURE,
        );
        const oversizedRequestId = 'x'.repeat(129);

        // This deliberately invalid branded value reaches the client validator.
        const invalidRequestId = oversizedRequestId as TRequestId;
        await client.renderPagePreview(requireDocumentRef('/tmp/book.djvu'), requirePageNumber(1), {previewRequestId: invalidRequestId});
        expect(invoke).toHaveBeenCalledOnce();
        expect(() => v.parse(DJVU_PLATFORM_FEATURE.methods.renderPagePreview.ipc.args, [
            '/tmp/book.djvu',
            1,
            {previewRequestId: oversizedRequestId},
        ], {abortEarly: true})).toThrow('renderPagePreview.options.previewRequestId exceeds maximum length (128)');
        expect(() => v.parse(DJVU_PLATFORM_FEATURE.methods.cancelPagePreview.ipc.args, [oversizedRequestId], {abortEarly: true}))
            .toThrow('cancelPagePreview.requestId exceeds maximum length (128)');
    });

    it('strips undeclared result fields and preserves the optional source revision policy', () => {
        expect(v.parse(djvuConvertResultSchema, {
            success: true,
            extra: 'discarded',
        })).toEqual({success: true});
        expect(v.parse(djvuPageSourceInfoSchema, {
            pageCount: 1,
            pageNumber: 1,
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
            sourceSize: 'invalid legacy value',
        })).toEqual({
            pageCount: 1,
            pageNumber: 1,
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
        });
        expect(v.safeParse(djvuConvertResultSchema, {
            success: true,
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        }).success)
            .toBe(false);
    });

    it('carries the conversion page sizes in the completed conversion within the dense page bound', () => {
        const convertComplete = DJVU_PLATFORM_FEATURE.events.onConvertComplete.payload;
        const pageSize = {
            width: 5100,
            height: 6600,
            dpi: 600,
        };
        expect(v.parse(convertComplete, {
            success: true,
            pdfPath: '/tmp/book.pdf',
            pageSizes: [pageSize],
        })).toEqual({
            success: true,
            pdfPath: '/tmp/book.pdf',
            pageSizes: [pageSize],
        });
        expect(v.safeParse(convertComplete, {
            success: true,
            pdfPath: '/tmp/book.pdf',
            pageSizes: Array.from({length: 10_001}, () => pageSize),
        }).success).toBe(false);
    });

    it('keeps the typed reason of a refused open, its receipt and expected cancellation in the open result contract', () => {
        const openResult = DJVU_PLATFORM_FEATURE.events.onOpenComplete.payload;
        const nativeMessage = 'djvused failed with exit code 10. Unrecognized DjVu Message';
        const refused = {
            success: false,
            requestId: 'djvu-open-1',
            error: nativeMessage,
            errorEnvelope: {
                code: 'invalid-djvu',
                message: nativeMessage,
            },
            failure: conversionFailure,
        };
        const canceled = {
            success: false,
            requestId: 'djvu-open-2',
            error: 'The operation was aborted',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        };

        const admitted = {
            success: true,
            pageCount: 12,
            source: {
                sourceSize: 8,
                sourceModifiedAt: 1_700_000_000_000,
            },
        };
        expect(v.parse(openResult, admitted)).toEqual(admitted);
        expect(v.safeParse(openResult, {
            ...admitted,
            source: {sourceSize: 8},
        }).success).toBe(false);
        expect(v.parse(openResult, refused)).toEqual(refused);
        expect(v.parse(openResult, canceled)).toEqual(canceled);
        expect(v.safeParse(openResult, {
            ...canceled,
            errorEnvelope: refused.errorEnvelope,
        }).success).toBe(false);
        expect(v.safeParse(openResult, {
            ...canceled,
            failure: conversionFailure,
        }).success).toBe(false);
        expect(v.safeParse(openResult, {
            success: true,
            pageCount: 1,
            errorEnvelope: {
                code: 'djvu-raster-limit',
                message: 'x',
            },
        }).success).toBe(false);
        expect(v.safeParse(openResult, {
            ...refused,
            errorEnvelope: {
                code: 'native-crash',
                message: nativeMessage,
            },
        }).success).toBe(false);
    });

    it('normalizes bounded native text-search requests before invoking main', async () => {
        const invoke = vi.fn().mockResolvedValue({
            results: [],
            truncated: false,
        });
        const ipcRenderer = {
            invoke,
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies TIpcRendererFixture;
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer,
            DJVU_PLATFORM_FEATURE,
        );

        await expect(client.searchText(requireDocumentRef('/tmp/book.djvu'), 'needle', {
            requestId: requireRequestId('djvu-search-1'),
            pageCount: 431,
            wholeWord: true,
        })).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(invoke).toHaveBeenCalledWith(
            channels.searchText,
            '/tmp/book.djvu',
            'needle',
            {
                requestId: 'djvu-search-1',
                pageCount: 431,
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            },
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
        // This deliberately invalid branded value reaches the client validator.
        const invalidRequestId = 'x'.repeat(129) as TRequestId;
        expect(() => v.parse(DJVU_PLATFORM_FEATURE.methods.searchText.ipc.args, [
            '/tmp/book.djvu',
            'needle',
            {
                requestId: invalidRequestId,
                pageCount: 431,
            },
        ], {abortEarly: true})).toThrow('searchText.options.requestId exceeds maximum length (128)');
        expect(() => v.parse(DJVU_PLATFORM_FEATURE.methods.searchText.ipc.args, [
            '/tmp/book.djvu',
            'needle',
            {
                requestId: requireRequestId('djvu-search-2'),
                pageCount: 0,
            },
        ], {abortEarly: true})).toThrow('searchText.options.pageCount must be a positive safe integer');
    });

    it('preserves a conversion receipt and expected cancellation in durable job state', async () => {
        const invoke = vi.fn().mockResolvedValue({
            jobId: 'djvu-convert-2',
            operation: 'djvu-convert',
            status: 'failed',
            error: 'native conversion failed',
            failure: conversionFailure,
            progress: {
                jobId: 'djvu-convert-2',
                phase: 'converting',
                percent: 100,
                status: 'failed',
            },
            updatedAtMs: 1,
        });
        const ipcRenderer = {
            invoke,
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies TIpcRendererFixture;
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer,
            DJVU_PLATFORM_FEATURE,
        );

        await expect(client.getJobState(requireJobId('djvu-convert-2'))).resolves.toMatchObject({
            status: 'failed',
            failure: conversionFailure,
        });

        invoke.mockResolvedValueOnce({
            jobId: 'djvu-convert-3',
            operation: 'djvu-convert',
            status: 'canceled',
            error: 'DjVu conversion canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
            progress: {
                jobId: 'djvu-convert-3',
                phase: 'converting',
                percent: 100,
                status: 'canceled',
            },
            updatedAtMs: 1,
        });
        await expect(client.getJobState(requireJobId('djvu-convert-3'))).resolves.toMatchObject({
            status: 'canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        });
    });
});
