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
            awaitOpenJob: 'djvu:open:await',
            releaseViewingPath: 'djvu:releaseViewingPath',
            startConvertToPdf: 'djvu:convert:start',
            awaitConvertJob: 'djvu:convert:await',
            printDjvuPath: 'djvu:printDjvuPath',
            cancel: 'djvu:cancel',
            getJobState: 'djvu:job:getState',
            subscribeJob: 'djvu:job:subscribe',
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
            onTextSearchProgress: 'djvu:text:progress',
            onMenuConvertToPdf: 'menu:convertToPdf',
        });
        expect(DJVU_PLATFORM_FEATURE.events.onMenuConvertToPdf.payload.decode(undefined))
            .toBeUndefined();
        expect(() => DJVU_PLATFORM_FEATURE.events.onMenuConvertToPdf.payload.decode('payload'))
            .toThrow('expected an undefined IPC result');
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

    it('rejects oversized preview request ids before invoking main', async () => {
        const ipcRenderer = {
            invoke: vi.fn(),
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
        expect(() => client.renderPagePreview(requireDocumentRef('/tmp/book.djvu'), requirePageNumber(1), {previewRequestId: invalidRequestId}))
            .toThrow('renderPagePreview.options.previewRequestId exceeds maximum length (128)');
        expect(() => DJVU_PLATFORM_FEATURE.methods.cancelPagePreview.ipc.args.decode([oversizedRequestId]))
            .toThrow('cancelPagePreview.requestId exceeds maximum length (128)');
        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('drops malformed DjVu events before callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const on = vi.fn();
        on.mockImplementation((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
            listeners.set(channel, handler);
        });
        const ipcRenderer = {
            invoke: vi.fn(),
            on,
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies TIpcRendererFixture;
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer,
            DJVU_PLATFORM_FEATURE,
        );
        const progressCallback = vi.fn();

        client.onProgress(progressCallback);
        listeners.get(eventChannels.onProgress)?.({}, {
            jobId: 'djvu-1',
            phase: 'converting',
            percent: 25,
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            jobId: 'djvu-1',
            phase: 'printing',
            percent: 100,
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            jobId: 'djvu-terminal',
            phase: 'converting',
            percent: 100,
            status: 'failed',
            error: 'failed',
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            jobId: 'djvu-2',
            phase: 'invalid',
            percent: 25,
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            jobId: 'djvu-3',
            phase: 'converting',
            percent: 100,
            status: 'invalid',
        });

        expect(progressCallback).toHaveBeenCalledTimes(3);
        expect(progressCallback).toHaveBeenNthCalledWith(1, {
            jobId: 'djvu-1',
            phase: 'converting',
            percent: 25,
        });
        expect(progressCallback).toHaveBeenNthCalledWith(2, {
            jobId: 'djvu-1',
            phase: 'printing',
            percent: 100,
        });
        expect(progressCallback).toHaveBeenNthCalledWith(3, {
            jobId: 'djvu-terminal',
            phase: 'converting',
            percent: 100,
            status: 'failed',
            error: 'failed',
        });
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
        expect(() => client.searchText(requireDocumentRef('/tmp/book.djvu'), 'needle', {
            requestId: invalidRequestId,
            pageCount: 431,
        })).toThrow('searchText.options.requestId exceeds maximum length (128)');
        expect(() => client.searchText(requireDocumentRef('/tmp/book.djvu'), 'needle', {
            requestId: requireRequestId('djvu-search-2'),
            pageCount: 0,
        })).toThrow('searchText.options.pageCount must be a positive safe integer');
    });

    it('preserves conversion failure identity and rejects malformed outcomes at the IPC boundary', async () => {
        const invoke = vi.fn().mockResolvedValue({
            success: false,
            jobId: 'djvu-convert-1',
            error: 'native conversion failed',
            failure: conversionFailure,
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

        await expect(client.awaitConvertJob(requireJobId('djvu-convert-1'))).resolves.toEqual({
            success: false,
            jobId: 'djvu-convert-1',
            error: 'native conversion failed',
            failure: conversionFailure,
        });

        invoke.mockResolvedValueOnce({
            success: false,
            jobId: 'djvu-convert-1',
            error: 'malformed receipt',
            failure: {
                ...conversionFailure,
                eventId: 'not-an-event-id',
            },
        });
        await expect(client.awaitConvertJob(requireJobId('djvu-convert-1')))
            .rejects.toThrow('DjVu conversion result has an invalid failure receipt');
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
