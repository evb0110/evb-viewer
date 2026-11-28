import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireJobId, requireRequestId} from '@contracts/shared';
import {createBrowserExtensionViewerUrl} from '@contracts/browserExtensionLaunch';

describe('browserPlatformApi lazy capability loading', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.doUnmock('@app/platform/browser-api/browserOcrCapability');
        vi.doUnmock('@app/platform/browser-api/browserScanCleanupCapability');
        vi.doUnmock('@app/platform/browser-api/browserDjvuCapability');
        vi.doUnmock('@app/platform/browser-api/createBrowserSearchCapability');
        vi.doUnmock('@app/platform/browser-api/createBrowserDocumentsFileCapability');
        vi.doUnmock('@app/platform/browser-api/createBrowserPageOpsCapability');
        vi.doUnmock('@app/platform/browser-api/browserFilePickerAdapter');
        vi.doUnmock('@app/platform/browser-api/optimizeBrowserPdfAsCopy');
        vi.doUnmock('@app/platform/browser-api/browserWorkingCopyService');
        vi.doUnmock('@app/platform/browser-api/browserDjvuComponents');
        vi.doUnmock('@app/platform/browserDocumentStore');
    });

    it('keeps heavy async capabilities unloaded during boot and buffers event subscriptions until first use', async () => {
        const loads = {
            ocr: 0,
            scanCleanup: 0,
            djvu: 0,
            search: 0,
            documentsFile: 0,
            pageOps: 0,
        };
        const ocrProgressListeners = new Set<(event: unknown) => void>();

        vi.doMock('@app/platform/browser-api/browserOcrCapability', () => {
            loads.ocr += 1;
            return {
                browserOcrCapability: {
                    cancel: vi.fn().mockResolvedValue({canceled: true}),
                    getLanguages: vi.fn().mockImplementation(async () => {
                        for (const listener of ocrProgressListeners) {
                            listener({requestId: 'req-1', status: 'running'});
                        }
                        return [{code: 'eng', script: 'latin', modelState: 'missing'}];
                    }),
                    resolveDocumentTextCatalog: vi.fn(),
                    resolveDocumentTextCatalogWindow: vi.fn(),
                    acknowledgeResultFile: vi.fn().mockResolvedValue({cleaned: true}),
                    createSearchablePdf: vi.fn(),
                    onProgress: (listener: (event: unknown) => void) => {
                        ocrProgressListeners.add(listener);
                        return () => ocrProgressListeners.delete(listener);
                    },
                    onComplete: () => () => {},
                },
            };
        });
        vi.doMock('@app/platform/browser-api/browserScanCleanupCapability', () => {
            loads.scanCleanup += 1;
            return {browserScanCleanupCapability: {}};
        });
        vi.doMock('@app/platform/browser-api/browserDjvuCapability', () => {
            loads.djvu += 1;
            return {browserDjvuCapability: {}};
        });
        vi.doMock('@app/platform/browser-api/createBrowserSearchCapability', () => {
            loads.search += 1;
            return {
                createBrowserSearchCapability: () => ({
                    capability: {},
                    clearSearchCaches: vi.fn().mockResolvedValue(undefined),
                }),
            };
        });
        vi.doMock('@app/platform/browser-api/createBrowserDocumentsFileCapability', () => {
            loads.documentsFile += 1;
            return {
                createBrowserCombinedPdfFromPaths: vi.fn(),
                createBrowserDocumentsFileCapability: vi.fn(() => ({})),
            };
        });
        vi.doMock('@app/platform/browser-api/createBrowserPageOpsCapability', () => {
            loads.pageOps += 1;
            return {createBrowserPageOpsCapability: vi.fn(() => ({}))};
        });

        const {browserPlatformApi} = await import('@app/platform/browserPlatformApi');

        // Subscribing to events and reading sync/no-op startup surfaces must not pull any heavy module.
        const receivedOcr: unknown[] = [];
        const droppedOcr: unknown[] = [];
        const unsubActiveOcr = browserPlatformApi.ocr.onProgress((event) => receivedOcr.push(event));
        const unsubDroppedOcr = browserPlatformApi.ocr.onProgress((event) => droppedOcr.push(event));
        unsubDroppedOcr();

        const unsubSearch = browserPlatformApi.search.onProgress(() => {});
        const unsubDjvu = browserPlatformApi.djvu.onProgress(() => {});
        const unsubScanCleanup = browserPlatformApi.scanCleanup!.onJobState(() => {});

        expect(browserPlatformApi.scanCleanup!.getSupport()).toEqual({
            preview: false,
            detection: false,
            calibration: false,
            conversion: false,
        });
        await expect(browserPlatformApi.scanCleanup!.pruneGeneratedOutputs()).resolves.toBe(0);
        await expect(browserPlatformApi.scanCleanup!.getPendingCompletedOutputs!()).resolves.toEqual([]);
        await expect(browserPlatformApi.ocr.cancel(requireRequestId('req-0'))).resolves.toEqual({
            canceled: false,
            reason: 'not-found',
        });
        await expect(browserPlatformApi.search.cancel(requireRequestId('search-0'))).resolves.toEqual({canceled: false});
        await expect(browserPlatformApi.djvu.cancel(requireJobId('djvu-0'))).resolves.toEqual({canceled: false});
        await expect(browserPlatformApi.pageOps.cancelActive(requireDocumentRef('browser://documents/a/in.pdf'))).resolves.toEqual({
            canceled: 0,
            committing: 0,
        });

        expect(loads).toEqual({
            ocr: 0,
            scanCleanup: 0,
            djvu: 0,
            search: 0,
            documentsFile: 0,
            pageOps: 0,
        });

        // First active OCR call loads only OCR and attaches active buffered listeners before invoking the method.
        await expect(browserPlatformApi.ocr.getLanguages()).resolves.toEqual([{code: 'eng', script: 'latin', modelState: 'missing'}]);
        expect(loads.ocr).toBe(1);
        expect(receivedOcr).toEqual([{requestId: 'req-1', status: 'running'}]);
        expect(droppedOcr).toEqual([]);
        unsubActiveOcr();
        expect(ocrProgressListeners.size).toBe(0);

        // Unrelated heavy modules remain unloaded.
        expect(loads.scanCleanup).toBe(0);
        expect(loads.djvu).toBe(0);
        expect(loads.search).toBe(0);
        expect(loads.documentsFile).toBe(0);
        expect(loads.pageOps).toBe(0);

        unsubSearch();
        unsubDjvu();
        unsubScanCleanup();
    });

    it('invokes file pickers, export choosers, and capture synchronously with one capture-handle owner', async () => {
        let userActivationActive = false;
        const requireActivation = (action: string) => {
            if (!userActivationActive) {
                throw new DOMException(`${action} requires transient user activation`, 'SecurityError');
            }
        };

        const pickFilesMock = vi.fn(() => {
            requireActivation('pickFiles');
            return Promise.resolve([]);
        });
        const pickSingleFileMock = vi.fn(() => {
            requireActivation('pickSingleFile');
            return Promise.resolve(null);
        });
        const pickSaveTargetMock = vi.fn(() => {
            requireActivation('pickSaveTarget');
            return Promise.resolve({canceled: true, fileName: '', handle: null});
        });
        const showDirectoryPickerMock = vi.fn(() => {
            requireActivation('showDirectoryPicker');
            return Promise.reject(new DOMException('Dismissed', 'AbortError'));
        });
        let registeredCaptureHandle: string | null = null;
        const setCaptureHandleConfigMock = vi.fn((config: {handle: string}) => {
            registeredCaptureHandle = config.handle;
        });
        let prepareFrameReached = false;
        const getDisplayMediaMock = vi.fn(() => {
            requireActivation('getDisplayMedia');
            const fakeTrack = {
                readyState: 'live',
                muted: false,
                stop: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                getSettings: () => ({displaySurface: 'browser', width: 10, height: 10}),
                getCaptureHandle: () => ({handle: registeredCaptureHandle, origin: 'https://viewer.example'}),
                applyConstraints: vi.fn().mockResolvedValue(undefined),
                cropTo: vi.fn().mockResolvedValue(undefined),
            };
            return Promise.resolve({
                getAudioTracks: () => [],
                getVideoTracks: () => [fakeTrack],
                getTracks: () => [fakeTrack],
            });
        });

        vi.doMock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
            BrowserFileWriteOutcomeError: class extends Error {},
            configureBrowserFilePickerMessages: vi.fn(),
            openBrowserOutputSink: vi.fn(),
            pickFiles: pickFilesMock,
            pickSingleFile: pickSingleFileMock,
            pickSaveTarget: pickSaveTargetMock,
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        }));
        vi.doMock('@app/platform/browser-api/optimizeBrowserPdfAsCopy', () => ({
            optimizeBrowserPdfAsCopy: vi.fn().mockResolvedValue({canceled: true}),
        }));
        vi.doMock('@app/platform/browser-api/createBrowserDocumentsFileCapability', () => ({
            createBrowserCombinedPdfFromPaths: vi.fn(),
            createBrowserDocumentsFileCapability: vi.fn(() => ({})),
        }));
        vi.doMock('@app/platform/browser-api/createBrowserPageOpsCapability', () => ({
            createBrowserPageOpsCapability: vi.fn(() => ({})),
        }));
        vi.stubGlobal('location', new URL('https://viewer.example/'));
        vi.stubGlobal('window', {showDirectoryPicker: showDirectoryPickerMock});
        vi.stubGlobal('CropTarget', {fromElement: vi.fn()});
        vi.stubGlobal('ImageCapture', class {});
        vi.stubGlobal('navigator', {
            language: 'en-US',
            mediaDevices: {
                setCaptureHandleConfig: setCaptureHandleConfigMock,
                getSupportedConstraints: () => ({resizeMode: true}),
                getDisplayMedia: getDisplayMediaMock,
            },
        });

        const {browserPlatformApi} = await import('@app/platform/browserPlatformApi');
        const docRef = requireDocumentRef('browser://documents/a/spec.pdf');

        // Helper simulates a click whose transient user activation expires immediately after the synchronous call stack.
        async function runWithSyncActivation<T>(fn: () => Promise<T>): Promise<T> {
            userActivationActive = true;
            const promise = fn();
            userActivationActive = false;
            return promise;
        }

        await expect(runWithSyncActivation(() => browserPlatformApi.documentPicker.openDocumentDialog())).resolves.toBeNull();
        await expect(runWithSyncActivation(() => browserPlatformApi.documentPicker.openCombineDialog())).resolves.toBeNull();
        await expect(runWithSyncActivation(() => browserPlatformApi.documentPicker.openImageDialog())).resolves.toBeNull();
        await expect(runWithSyncActivation(() => browserPlatformApi.documentFiles.savePdfDialog('report.pdf'))).resolves.toBeNull();
        await expect(runWithSyncActivation(() => browserPlatformApi.documentFiles.saveDocxAs(docRef))).resolves.toBeNull();
        await expect(runWithSyncActivation(() => browserPlatformApi.documentFiles.prepareOptimizePdfAsCopy!(docRef))).resolves.toBeNull();
        await expect(
            runWithSyncActivation(() => browserPlatformApi.documentFiles.optimizePdfAsCopy!(docRef, {preset: 'lossless'})),
        ).resolves.toEqual({canceled: true});
        await expect(runWithSyncActivation(() => browserPlatformApi.pageOps.insert(docRef, 2, 1))).resolves.toEqual({
            success: false,
            canceled: true,
        });
        await expect(runWithSyncActivation(() => browserPlatformApi.pageOps.extract(docRef, [1]))).resolves.toEqual({
            success: false,
            canceled: true,
        });
        // Cold image export (1 page -> save picker, multi-page -> directory picker) and TIFF export preserve activation.
        await expect(
            runWithSyncActivation(() => browserPlatformApi.imageExport.exportPdfToImages(docRef, [requirePageNumber(1)])),
        ).resolves.toEqual({success: false, canceled: true});
        await expect(
            runWithSyncActivation(() =>
                browserPlatformApi.imageExport.exportPdfToImages(docRef, [requirePageNumber(1), requirePageNumber(2)]),
            ),
        ).resolves.toEqual({success: false, canceled: true});
        await expect(
            runWithSyncActivation(() => browserPlatformApi.imageExport.exportPdfToMultiPageTiff(docRef, [requirePageNumber(1)])),
        ).resolves.toEqual({success: false, canceled: true});
        await expect(runWithSyncActivation(() => browserPlatformApi.imageExport.exportPdfToMultiPageTiff(docRef))).resolves.toEqual({
            success: false,
            canceled: true,
        });

        // Capture handle was registered once by the single owner, so snips after image export pass source assertion.
        expect(setCaptureHandleConfigMock).toHaveBeenCalledTimes(1);
        const stopAtPrepareFrame = new DOMException('Reached prepareFrame', 'AbortError');
        await expect(
            runWithSyncActivation(() =>
                browserPlatformApi.imageExport.captureCurrentView(
                    {
                        x: 0,
                        y: 0,
                        width: 10,
                        height: 10,
                        viewportWidth: 100,
                        viewportHeight: 100,
                        pixelRatio: 1,
                    },
                    {
                        target: {isConnected: true} as Element,
                        signal: new AbortController().signal,
                        assertCurrent: () => undefined,
                        prepareFrame: () => {
                            prepareFrameReached = true;
                            return Promise.reject(stopAtPrepareFrame);
                        },
                        cancel: () => undefined,
                    },
                ),
            ),
        ).rejects.toBe(stopAtPrepareFrame);
        expect(prepareFrameReached).toBe(true);

        expect(pickFilesMock).toHaveBeenCalledTimes(3);
        expect(pickSingleFileMock).toHaveBeenCalledTimes(1);
        expect(pickSaveTargetMock).toHaveBeenCalledTimes(7);
        expect(showDirectoryPickerMock).toHaveBeenCalledTimes(2);
        expect(getDisplayMediaMock).toHaveBeenCalledTimes(1);
    });

    it('cancels queued delete, cold insert, and cold extract before page-ops chunk finishes loading without dispatching', async () => {
        const pageOpsImportGate = Promise.withResolvers<void>();
        const pickerFilesGate = Promise.withResolvers<Array<{file: File; handle: null}>>();
        const saveTargetGate = Promise.withResolvers<{canceled: boolean; fileName: string; handle: null}>();
        const realDelete = vi.fn().mockResolvedValue({success: true, pageCount: 1});
        const realInsertFile = vi.fn().mockResolvedValue({success: true, pageCount: 4});
        const realExtract = vi.fn().mockResolvedValue({success: true, destPath: 'browser://documents/out/extract.pdf'});
        const realCancelActive = vi.fn().mockResolvedValue({canceled: 0, committing: 0});

        vi.doMock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
            BrowserFileWriteOutcomeError: class extends Error {},
            configureBrowserFilePickerMessages: vi.fn(),
            openBrowserOutputSink: vi.fn(),
            pickFiles: vi.fn(() => pickerFilesGate.promise),
            pickSingleFile: vi.fn(),
            pickSaveTarget: vi.fn(() => saveTargetGate.promise),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        }));
        vi.doMock('@app/platform/browser-api/createBrowserDocumentsFileCapability', () => ({
            createBrowserCombinedPdfFromPaths: vi.fn(),
            createBrowserDocumentsFileCapability: vi.fn(() => ({})),
        }));
        vi.doMock('@app/platform/browser-api/createBrowserPageOpsCapability', async () => {
            await pageOpsImportGate.promise;
            return {
                createBrowserPageOpsCapability: () => ({
                    delete: realDelete,
                    insertFile: realInsertFile,
                    extract: realExtract,
                    cancelActive: realCancelActive,
                }),
            };
        });

        const {browserPlatformApi} = await import('@app/platform/browserPlatformApi');
        const docRef = requireDocumentRef('browser://documents/a/book.pdf');

        // Start delete, cold insert (pending picker + import), and cold extract (pending picker + import).
        const deletePromise = browserPlatformApi.pageOps.delete(docRef, [2], 3);
        const insertPromise = browserPlatformApi.pageOps.insert(docRef, 3, 1);
        const extractPromise = browserPlatformApi.pageOps.extract(docRef, [1]);

        // Cancel all three while both pickers and the page-ops import are still pending.
        await expect(browserPlatformApi.pageOps.cancelActive(docRef)).resolves.toEqual({
            canceled: 3,
            committing: 0,
        });
        await expect(deletePromise).resolves.toEqual({success: false, canceled: true});
        await expect(insertPromise).resolves.toEqual({success: false, canceled: true});
        await expect(extractPromise).resolves.toEqual({success: false, canceled: true});

        // Resolve the pickers and chunk import; none of the canceled operations may dispatch.
        pickerFilesGate.resolve([{file: new File([new Uint8Array([37, 80, 68, 70])], 'extra.pdf'), handle: null}]);
        saveTargetGate.resolve({canceled: false, fileName: 'book-extract.pdf', handle: null});
        pageOpsImportGate.resolve();
        await vi.waitFor(async () => {
            await expect(browserPlatformApi.pageOps.cancelActive(docRef)).resolves.toEqual({canceled: 0, committing: 0});
            expect(realCancelActive).toHaveBeenCalledWith(docRef);
        });
        expect(realDelete).not.toHaveBeenCalled();
        expect(realInsertFile).not.toHaveBeenCalled();
        expect(realExtract).not.toHaveBeenCalled();
    });

    it('removes a newly registered single-file Open source if loading browserWorkingCopyService fails', async () => {
        const createdRef = requireDocumentRef('browser://documents/temp/orphan.pdf');
        const removeSpy = vi.fn().mockResolvedValue(undefined);
        const pickedFile = new File([new Uint8Array([37, 80, 68, 70])], 'orphan.pdf', {type: 'application/pdf'});

        vi.doMock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
            BrowserFileWriteOutcomeError: class extends Error {},
            configureBrowserFilePickerMessages: vi.fn(),
            openBrowserOutputSink: vi.fn(),
            pickFiles: vi.fn().mockResolvedValue([{file: pickedFile, handle: null}]),
            pickSingleFile: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        }));
        vi.doMock('@app/platform/browserDocumentStore', () => ({
            browserDocumentStore: {
                registerFileWithOwnership: vi.fn().mockResolvedValue({ref: createdRef, created: true}),
                remove: removeSpy,
            },
            getBrowserDocumentFileName: (path: string) => path.split('/').at(-1) ?? 'document.pdf',
        }));
        vi.doMock('@app/platform/browser-api/browserDjvuComponents', () => ({
            findIndirectDjvuSelection: vi.fn().mockResolvedValue(null),
            setBrowserDjvuComponentFiles: vi.fn(),
        }));
        vi.doMock('@app/platform/browser-api/browserWorkingCopyService', () => {
            throw new Error('chunk load failed');
        });

        const {browserPlatformApi} = await import('@app/platform/browserPlatformApi');
        await expect(browserPlatformApi.documentPicker.openDocumentDialog()).rejects.toThrow();
        expect(removeSpy).toHaveBeenCalledExactlyOnceWith(createdRef);
    });

    it('cleans up already-registered transient sources if batch registration fails part way', async () => {
        const firstRef = requireDocumentRef('browser://documents/temp/first.pdf');
        const removeSpy = vi.fn().mockResolvedValue(undefined);
        const registerFileSpy = vi.fn().mockResolvedValueOnce(firstRef).mockRejectedValueOnce(new Error('storage quota exceeded'));
        const fileA = new File([new Uint8Array([37, 80, 68, 70])], 'a.pdf', {type: 'application/pdf'});
        const fileB = new File([new Uint8Array([37, 80, 68, 70])], 'b.pdf', {type: 'application/pdf'});

        vi.doMock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
            BrowserFileWriteOutcomeError: class extends Error {},
            configureBrowserFilePickerMessages: vi.fn(),
            openBrowserOutputSink: vi.fn(),
            pickFiles: vi.fn().mockResolvedValue([
                {file: fileA, handle: null},
                {file: fileB, handle: null},
            ]),
            pickSingleFile: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        }));
        vi.doMock('@app/platform/browserDocumentStore', () => ({
            browserDocumentStore: {
                registerFile: registerFileSpy,
                remove: removeSpy,
                onDocumentRecordRemoved: vi.fn(),
            },
            getBrowserDocumentFileName: (path: string) => path.split('/').at(-1) ?? 'document.pdf',
        }));

        const {browserPlatformApi} = await import('@app/platform/browserPlatformApi');
        await expect(browserPlatformApi.documentPicker.openCombineDialog()).rejects.toThrow('storage quota exceeded');
        expect(removeSpy).toHaveBeenCalledExactlyOnceWith(firstRef);
    });

    it('overlaps Chrome extension HTTP document fetch with loadBrowserPlatformApi during plugin setup', async () => {
        const events: string[] = [];
        const platformDeferred = Promise.withResolvers<void>();
        const openLaunchSpy = vi.fn().mockResolvedValue(undefined);
        const documentUrl = 'https://papers.example/spec.pdf';

        vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
        vi.stubGlobal('useRoute', () => ({path: '/'}));
        vi.stubGlobal('location', new URL(createBrowserExtensionViewerUrl('chrome-extension://evb-test/', documentUrl)));
        vi.stubGlobal('history', {state: null});
        const fetchMock = vi.fn(() => {
            events.push('fetch-started');
            return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {status: 200}));
        });
        vi.stubGlobal('fetch', fetchMock);

        vi.doMock('@app/utils/platform', () => ({
            shouldPreferDesktopPlatform: () => false,
            loadBrowserPlatformApi: () => {
                events.push('platform-load-started');
                return platformDeferred.promise.then(() => {
                    events.push('platform-load-finished');
                });
            },
        }));
        vi.doMock('@app/platform/browserPlatformApi', () => ({
            openBrowserExtensionLaunchDocument: (prefetched: unknown) => {
                events.push('open-launch-called');
                return openLaunchSpy(prefetched);
            },
        }));

        try {
            const pluginModule = await import('@app/plugins/browserPlatform');
            const plugin = pluginModule.default as unknown as {setup: () => Promise<void>};
            const setupPromise = plugin.setup();

            // fetch(documentUrl) must already be in flight BEFORE loadBrowserPlatformApi resolves.
            expect(fetchMock).toHaveBeenCalledExactlyOnceWith(documentUrl, {
                credentials: 'include',
                signal: expect.any(AbortSignal),
            });
            expect(events).toEqual(['fetch-started', 'platform-load-started']);

            platformDeferred.resolve();
            await setupPromise;
            await vi.waitFor(() => {
                expect(openLaunchSpy).toHaveBeenCalledTimes(1);
            });

            expect(events).toEqual(['fetch-started', 'platform-load-started', 'platform-load-finished', 'open-launch-called']);
            expect(openLaunchSpy.mock.calls[0]?.[0]).toMatchObject({url: documentUrl});
        } finally {
            vi.doUnmock('@app/utils/platform');
            vi.doUnmock('@app/platform/browserPlatformApi');
        }
    });

    it('aborts an in-flight pre-headers extension prefetch immediately when platform loading fails', async () => {
        const documentUrl = 'https://papers.example/slow.pdf';
        let capturedSignal: AbortSignal | undefined;
        const neverSettlingResponse = new Promise<Response>(() => {});

        vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
        vi.stubGlobal('useRoute', () => ({path: '/'}));
        vi.stubGlobal('location', new URL(createBrowserExtensionViewerUrl('chrome-extension://evb-test/', documentUrl)));
        vi.stubGlobal('history', {state: null});
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) => {
                capturedSignal = init?.signal ?? undefined;
                return neverSettlingResponse;
            }),
        );

        vi.doMock('@app/utils/platform', () => ({
            shouldPreferDesktopPlatform: () => false,
            loadBrowserPlatformApi: () => Promise.reject(new Error('boot failed')),
        }));

        try {
            const pluginModule = await import('@app/plugins/browserPlatform');
            const plugin = pluginModule.default as unknown as {setup: () => Promise<void>};
            await expect(plugin.setup()).rejects.toThrow('boot failed');
            expect(capturedSignal).toBeDefined();
            expect(capturedSignal?.aborted).toBe(true);
        } finally {
            vi.doUnmock('@app/utils/platform');
        }
    });
});
