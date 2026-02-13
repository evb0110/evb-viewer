import {
    ref,
    onUnmounted,
} from 'vue';
import { getElectronAPI } from '@app/utils/electron';
import { useDjvuMode } from '@app/composables/useDjvuMode';

interface IDjvuConversionState {
    isConverting: boolean;
    phase: 'converting' | 'bookmarks' | null;
    percent: number;
}

interface IDjvuLoadingProgress {
    current: number;
    total: number;
}

export const useDjvu = () => {
    const {
        isDjvuMode,
        djvuSourcePath,
        djvuTempPdfPath,
        enterDjvuMode,
        exitDjvuMode,
        isDjvuFeatureDisabled,
    } = useDjvuMode();

    const conversionState = ref<IDjvuConversionState>({
        isConverting: false,
        phase: null,
        percent: 0,
    });

    const isLoadingPages = ref(false);
    const loadingProgress = ref<IDjvuLoadingProgress>({
        current: 0,
        total: 0, 
    });

    const showBanner = ref(true);
    const showConvertDialog = ref(false);

    let unsubProgress: (() => void) | null = null;
    let unsubViewingReady: (() => void) | null = null;
    let swapHandler: ((event: {
        pdfPath: string;
        isPartial: boolean 
    }) => void) | null = null;

    function setupProgressListener() {
        if (unsubProgress) {
            return;
        }

        try {
            const api = getElectronAPI();
            unsubProgress = api.djvu.onProgress((progress) => {
                if (progress.phase === 'loading') {
                    if (isLoadingPages.value) {
                        loadingProgress.value = {
                            current: progress.current ?? 0,
                            total: progress.total ?? 0,
                        };
                    }
                } else {
                    conversionState.value = {
                        isConverting: true,
                        phase: progress.phase,
                        percent: progress.percent,
                    };
                }
            });
        } catch {
            // Not in Electron
        }
    }

    function setupViewingReadyListener() {
        if (unsubViewingReady) {
            return;
        }

        try {
            const api = getElectronAPI();
            unsubViewingReady = api.djvu.onViewingReady((event) => {
                if (swapHandler) {
                    swapHandler(event);
                }
            });
        } catch {
            // Not in Electron
        }
    }

    function teardownListeners() {
        if (unsubProgress) {
            unsubProgress();
            unsubProgress = null;
        }
        if (unsubViewingReady) {
            unsubViewingReady();
            unsubViewingReady = null;
        }
        swapHandler = null;
    }

    setupProgressListener();
    setupViewingReadyListener();
    onUnmounted(teardownListeners);

    async function openDjvuFile(
        djvuPath: string,
        loadPdfFromPath: (path: string) => Promise<void>,
        getCurrentPage?: () => number,
        setPage?: (page: number) => void,
        setOriginalPath?: (path: string | null) => void,
    ) {
        const api = getElectronAPI();
        const djvuFileName = djvuPath.split(/[\\/]/).pop() ?? 'DjVu';

        showBanner.value = true;

        try {
            const result = await api.djvu.openForViewing(djvuPath);

            if (!result.success || !result.pdfPath) {
                throw new Error(result.error ?? 'DjVu conversion failed');
            }

            const initialPdfPath = result.pdfPath;
            const pageCount = result.pageCount ?? 0;

            // Set originalPath to DjVu source so the status bar shows
            // the real file location instead of the /var temp path
            setOriginalPath?.(djvuPath);

            enterDjvuMode(djvuPath, initialPdfPath);
            await loadPdfFromPath(initialPdfPath);

            // loadPdfFromPath overwrites the window title with the temp filename;
            // restore it to the DjVu source filename
            await api.setWindowTitle(djvuFileName);

            if (pageCount > 1) {
                isLoadingPages.value = true;
                loadingProgress.value = {
                    current: 0,
                    total: pageCount,
                };

                swapHandler = (event) => {
                    (async () => {
                        try {
                            const savedPage = getCurrentPage?.() ?? 1;
                            const oldPath = djvuTempPdfPath.value;

                            enterDjvuMode(djvuPath, event.pdfPath);
                            await loadPdfFromPath(event.pdfPath);
                            await api.setWindowTitle(djvuFileName);

                            if (savedPage > 1 && setPage) {
                                setPage(savedPage);
                            }

                            if (oldPath && oldPath !== event.pdfPath) {
                                api.djvu.cleanupTemp(oldPath).catch(() => {});
                            }
                        } finally {
                            isLoadingPages.value = false;
                            loadingProgress.value = {
                                current: 0,
                                total: 0, 
                            };
                            swapHandler = null;
                        }
                    })().catch(() => {});
                };
            }
        } catch (e) {
            isLoadingPages.value = false;
            loadingProgress.value = {
                current: 0,
                total: 0, 
            };
            throw e;
        }
    }

    async function convertToPdf(
        subsample: number,
        preserveBookmarks: boolean,
        loadPdfFromPath: (path: string) => Promise<void>,
    ) {
        if (!djvuSourcePath.value) {
            return;
        }

        const api = getElectronAPI();

        const suggestedName = (djvuSourcePath.value.split(/[\\/]/).pop() ?? 'document')
            .replace(/\.djvu$/i, '.pdf');
        const savePath = await api.savePdfDialog(suggestedName);
        if (!savePath) {
            return;
        }

        conversionState.value = {
            isConverting: true,
            phase: 'converting',
            percent: 0,
        };

        try {
            const result = await api.djvu.convertToPdf(
                djvuSourcePath.value,
                savePath,
                {
                    subsample,
                    preserveBookmarks,
                },
            );

            if (!result.success || !result.pdfPath) {
                throw new Error(result.error ?? 'Conversion failed');
            }

            const tempPath = djvuTempPdfPath.value;
            exitDjvuMode();

            if (tempPath) {
                try {
                    await api.djvu.cleanupTemp(tempPath);
                } catch {
                    // Ignore cleanup errors
                }
            }

            const openResult = await api.openPdfDirect(result.pdfPath);
            if (openResult) {
                await loadPdfFromPath(openResult.workingPath);
                await api.setWindowTitle(result.pdfPath.split(/[\\/]/).pop() ?? 'PDF');
            }
        } finally {
            conversionState.value = {
                isConverting: false,
                phase: null,
                percent: 0,
            };
        }
    }

    async function cleanupDjvuTemp() {
        if (!djvuTempPdfPath.value) {
            return;
        }

        try {
            const api = getElectronAPI();
            await api.djvu.cleanupTemp(djvuTempPdfPath.value);
        } catch {
            // Ignore cleanup errors
        }
    }

    function openConvertDialog() {
        showConvertDialog.value = true;
    }

    function closeConvertDialog() {
        showConvertDialog.value = false;
    }

    function dismissBanner() {
        showBanner.value = false;
    }

    return {
        isDjvuMode,
        djvuSourcePath,
        djvuTempPdfPath,
        conversionState,
        isLoadingPages,
        loadingProgress,
        showBanner,
        showConvertDialog,
        isDjvuFeatureDisabled,
        openDjvuFile,
        convertToPdf,
        cleanupDjvuTemp,
        exitDjvuMode,
        openConvertDialog,
        closeConvertDialog,
        dismissBanner,
    };
};
