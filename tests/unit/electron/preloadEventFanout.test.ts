import type { IpcRenderer } from 'electron';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import { DOCUMENT_MENU_PLATFORM_FEATURE } from '@contracts/documentsPlatformFeature';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';
import { DOCUMENTS_EVENT_CHANNELS } from '@electron/features/documents/contract';
import { IMAGE_EXPORT_PLATFORM_FEATURE } from '@contracts/imageExportPlatformFeature';
import { OCR_PLATFORM_FEATURE } from '@contracts/ocrPlatformFeature';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';

type TEventHandler = (event: unknown, payload: unknown) => void;
type TTestIpcRenderer = Pick<IpcRenderer, 'invoke' | 'on' | 'postMessage' | 'removeListener' | 'send'>;

function createIpcRendererHarness() {
    const listeners = new Map<string, TEventHandler>();
    const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => undefined);
    const on = vi.fn();
    const removeListener = vi.fn();
    const ipcRenderer: TTestIpcRenderer = {
        invoke,
        postMessage: vi.fn(),
        on,
        removeListener,
        send: vi.fn(),
    };
    on.mockImplementation((channel: string, handler: TEventHandler) => {
        listeners.set(channel, handler);
        return ipcRenderer;
    });
    removeListener.mockImplementation((channel: string, handler: TEventHandler) => {
        if (listeners.get(channel) === handler) {
            listeners.delete(channel);
        }
        return ipcRenderer;
    });
    return {
        ipcRenderer,
        invoke,
        listeners,
    };
}

describe('preload global event fan-out', () => {
    it('fans out all four decoded Agent streams through one listener per channel', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const client = createPlatformFeaturePreloadClient(ipcRenderer, AGENT_PLATFORM_FEATURE);
        const cases = [
            {
                channel: AGENT_PLATFORM_FEATURE.eventChannels.onAssistantEvent,
                subscribe: client.onAssistantEvent,
                payload: {
                    type: 'heartbeat',
                    binding: {
                        scopeFingerprint: 'scope',
                        sessionKey: 'codex:scope',
                        turnGeneration: 1,
                        windowId: 1,
                    },
                },
            },
            {
                channel: AGENT_PLATFORM_FEATURE.eventChannels.onWorkspaceSnapshotRequest,
                subscribe: client.onWorkspaceSnapshotRequest,
                payload: {requestId: 'snapshot-1'},
            },
            {
                channel: AGENT_PLATFORM_FEATURE.eventChannels.onCommandCancelRequest,
                subscribe: client.onCommandCancelRequest,
                payload: {requestId: 'command-1'},
            },
            {
                channel: AGENT_PLATFORM_FEATURE.eventChannels.onCommandRequest,
                subscribe: client.onCommandRequest,
                payload: {
                    requestId: 'command-1',
                    command: {
                        name: 'activate_tab',
                        arguments: {tabId: 'tab-1'},
                    },
                },
            },
        ] as const;
        const callbacks = cases.map(() => Array.from({length: 24}, () => vi.fn()));
        const unsubscribes = cases.flatMap((testCase, index) =>
            callbacks[index]!.map(callback => testCase.subscribe(callback)));

        expect(ipcRenderer.on).toHaveBeenCalledTimes(4);
        cases.forEach((testCase, index) => {
            listeners.get(testCase.channel)?.({}, testCase.payload);
            expect(callbacks[index]!.every(callback => callback.mock.calls.length === 1)).toBe(true);
        });

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(4);
    });

    it('serves many document revision consumers with one native listener', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const callbacks = Array.from({length: 24}, () => vi.fn());
        const unsubscribes = callbacks.map(callback => client.onDocumentRevisionChanged(callback));

        expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(1);

        const event = {
            version: 1,
            token: requireDocumentRevisionToken('revision-2'),
            previousToken: requireDocumentRevisionToken('revision-1'),
            documentRef: '/tmp/working.pdf',
            authority: 'electron-working-copy',
            contentRevision: 2,
            mintedAt: 123,
            reason: 'write',
        } as const;
        listeners.get(DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged)?.({}, event);
        expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);

        unsubscribes.slice(0, -1).forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).not.toHaveBeenCalled();
        unsubscribes.at(-1)?.();
        unsubscribes.at(-1)?.();
        expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
        expect(listeners.size).toBe(0);
    });

    it('serves many PDF optimization consumers with one native listener', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const client = createPlatformFeaturePreloadClient(ipcRenderer, DOCUMENT_MENU_PLATFORM_FEATURE);
        const callbacks = Array.from({length: 24}, () => vi.fn());
        const unsubscribes = callbacks.map(callback => client.onPdfOptimizeProgress(callback));

        expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
        listeners.get(DOCUMENT_MENU_PLATFORM_FEATURE.eventChannels.onPdfOptimizeProgress)?.({}, {
            requestId: 'optimize-1',
            preset: 'lossless',
            phase: 'optimizing',
            processed: 1,
            total: 2,
            percent: 50,
        });
        expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
    });

    it('serves many DjVu progress consumers with one listener and one main subscription', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const client = createPlatformFeaturePreloadClient(ipcRenderer, DJVU_PLATFORM_FEATURE);
        const callbacks = Array.from({length: 24}, () => vi.fn());
        const unsubscribes = callbacks.map(callback => client.onProgress(callback));

        expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
        expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DJVU_PLATFORM_FEATURE.invokeChannels.subscribeProgress,
        );
        listeners.get(DJVU_PLATFORM_FEATURE.eventChannels.onProgress)?.({}, {
            jobId: 'djvu-1',
            phase: 'converting',
            percent: 25,
        });
        expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
    });

    it('retries a failed DjVu subscription for a later consumer', async () => {
        const {
            ipcRenderer,
            invoke,
        } = createIpcRendererHarness();
        invoke.mockRejectedValueOnce(new Error('lazy feature is reloading'));
        const client = createPlatformFeaturePreloadClient(ipcRenderer, DJVU_PLATFORM_FEATURE);

        client.onProgress(vi.fn());
        await new Promise<void>(resolve => setImmediate(resolve));
        client.onProgress(vi.fn());
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(invoke).toHaveBeenCalledTimes(2);
        expect(invoke).toHaveBeenNthCalledWith(1, DJVU_PLATFORM_FEATURE.invokeChannels.subscribeProgress);
        expect(invoke).toHaveBeenNthCalledWith(2, DJVU_PLATFORM_FEATURE.invokeChannels.subscribeProgress);
    });

    it('fans out validated DjVu text-search progress through one native listener', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const client = createPlatformFeaturePreloadClient(ipcRenderer, DJVU_PLATFORM_FEATURE);
        const callbacks = Array.from({length: 24}, () => vi.fn());
        const unsubscribes = callbacks.map(callback => client.onTextSearchProgress(callback));

        expect(ipcRenderer.on).toHaveBeenCalledOnce();
        listeners.get(DJVU_PLATFORM_FEATURE.eventChannels.onTextSearchProgress)?.({}, {
            requestId: 'djvu-search-1',
            processed: 8,
            total: 431,
            resultsStartIndex: 0,
            results: [],
            status: 'running',
        });
        expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
    });

    it('requests each related process-global progress stream only once for many consumers', () => {
        const {
            ipcRenderer,
            invoke,
        } = createIpcRendererHarness();
        const ocr = createPlatformFeaturePreloadClient(
            ipcRenderer,
            OCR_PLATFORM_FEATURE,
        );
        const djvu = createPlatformFeaturePreloadClient(ipcRenderer, DJVU_PLATFORM_FEATURE);
        const search = createPlatformFeaturePreloadClient(ipcRenderer, SEARCH_PLATFORM_FEATURE);
        const imageExport = createPlatformFeaturePreloadClient(ipcRenderer, IMAGE_EXPORT_PLATFORM_FEATURE);
        const unsubscribes = [
            ...Array.from({length: 24}, () => ocr.onProgress(vi.fn())),
            ...Array.from({length: 24}, () => djvu.onProgress(vi.fn())),
            ...Array.from({length: 24}, () => search.onProgress(vi.fn())),
            ...Array.from({length: 24}, () => imageExport.onProgress(vi.fn())),
        ];

        for (const channel of [
            OCR_PLATFORM_FEATURE.invokeChannels.subscribeProgress,
            DJVU_PLATFORM_FEATURE.invokeChannels.subscribeProgress,
            SEARCH_PLATFORM_FEATURE.invokeChannels.subscribeProgress,
            IMAGE_EXPORT_PLATFORM_FEATURE.invokeChannels.subscribeProgress,
        ]) {
            expect(invoke).toHaveBeenCalledWith(channel);
            expect(invoke.mock.calls.filter(call => call[0] === channel)).toHaveLength(1);
        }
        expect(ipcRenderer.on).toHaveBeenCalledTimes(4);

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(4);
    });

    it('fans out decoded update status through one native listener', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const updates = createPlatformFeaturePreloadClient(ipcRenderer, UPDATES_PLATFORM_FEATURE);
        const callbacks = Array.from({length: 24}, () => vi.fn());
        const unsubscribes = callbacks.map(callback => updates.onStatus(callback));

        expect(ipcRenderer.on).toHaveBeenCalledOnce();
        listeners.get(UPDATES_PLATFORM_FEATURE.eventChannels.onStatus)?.({}, {
            phase: 'downloaded',
            origin: 'auto',
            version: '2.0.0',
            percent: 100,
            message: null,
        });
        expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
    });
});
