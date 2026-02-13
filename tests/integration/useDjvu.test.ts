import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';

vi.mock('vue', async (importOriginal) => {
    const actual = await importOriginal<typeof import('vue')>();
    return {
        ...actual,
        onUnmounted: vi.fn(),
    };
});

const mockElectronAPI = {
    djvu: {
        onProgress: vi.fn(() => vi.fn()),
        onViewingReady: vi.fn(() => vi.fn()),
        openForViewing: vi.fn(),
        convertToPdf: vi.fn(),
        cancel: vi.fn(),
        cleanupTemp: vi.fn(),
    },
    setWindowTitle: vi.fn(),
    savePdfDialog: vi.fn(),
    openPdfDirect: vi.fn(),
};

vi.mock('@app/utils/electron', () => ({getElectronAPI: () => mockElectronAPI}));

vi.mock('@app/composables/useDjvuMode', () => {
    const isDjvuMode = ref(false);
    const djvuSourcePath = ref<string | null>(null);
    const djvuTempPdfPath = ref<string | null>(null);

    return {useDjvuMode: () => ({
        isDjvuMode,
        djvuSourcePath,
        djvuTempPdfPath,
        isDjvuFeatureDisabled: vi.fn(() => false),
        enterDjvuMode: vi.fn((source: string, temp: string) => {
            isDjvuMode.value = true;
            djvuSourcePath.value = source;
            djvuTempPdfPath.value = temp;
        }),
        exitDjvuMode: vi.fn(() => {
            isDjvuMode.value = false;
            djvuSourcePath.value = null;
            djvuTempPdfPath.value = null;
        }),
    })};
});

const mockT = vi.fn((key: string) => key);
vi.stubGlobal('useI18n', () => ({ t: mockT }));

const { useDjvu } = await import('@app/composables/useDjvu');

describe('useDjvu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockElectronAPI.djvu.onProgress.mockReturnValue(vi.fn());
        mockElectronAPI.djvu.onViewingReady.mockReturnValue(vi.fn());
    });

    describe('initial state', () => {
        it('starts with no conversion in progress', () => {
            const djvu = useDjvu();

            expect(djvu.conversionState.value.isConverting).toBe(false);
            expect(djvu.conversionState.value.phase).toBeNull();
            expect(djvu.conversionState.value.percent).toBe(0);
        });

        it('starts with loading not active', () => {
            const djvu = useDjvu();

            expect(djvu.isLoadingPages.value).toBe(false);
        });

        it('starts with banner visible', () => {
            const djvu = useDjvu();

            expect(djvu.showBanner.value).toBe(true);
        });

        it('starts with convert dialog closed', () => {
            const djvu = useDjvu();

            expect(djvu.showConvertDialog.value).toBe(false);
        });
    });

    describe('openDjvuFile', () => {
        it('opens a single-page DjVu file', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pdfPath: '/tmp/converted.pdf',
                pageCount: 1,
                jobId: 'job-1',
            });

            const djvu = useDjvu();
            const loadPdf = vi.fn(async () => {});

            await djvu.openDjvuFile(
                '/path/to/doc.djvu',
                loadPdf,
            );

            expect(loadPdf).toHaveBeenCalledWith('/tmp/converted.pdf');
            expect(mockElectronAPI.setWindowTitle).toHaveBeenCalled();
            expect(djvu.isLoadingPages.value).toBe(false);
        });

        it('throws when openForViewing fails', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: false,
                error: 'File corrupted',
            });

            const djvu = useDjvu();

            await expect(
                djvu.openDjvuFile('/bad.djvu', vi.fn()),
            ).rejects.toThrow('File corrupted');
        });

        it('sets loading state for multi-page files', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pdfPath: '/tmp/partial.pdf',
                pageCount: 10,
                jobId: 'job-multi',
            });

            const djvu = useDjvu();
            const loadPdf = vi.fn(async () => {});

            await djvu.openDjvuFile('/multi.djvu', loadPdf);

            expect(djvu.isLoadingPages.value).toBe(true);
            expect(djvu.loadingProgress.value.total).toBe(10);
        });
    });

    describe('cancelActiveJobs', () => {
        it('returns false when no active jobs exist and not converting', async () => {
            const djvu = useDjvu();

            const result = await djvu.cancelActiveJobs();

            expect(result).toBe(false);
        });

        it('sets pendingConvertCancel when converting but no job ID yet', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pdfPath: '/tmp/test.pdf',
                pageCount: 1,
                jobId: 'v-1',
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/a.djvu', vi.fn(async () => {}));

            djvu.conversionState.value = {
                isConverting: true,
                phase: 'converting',
                percent: 50,
            };

            const result = await djvu.cancelActiveJobs();

            expect(result).toBe(true);
        });
    });

    describe('dialog management', () => {
        it('opens and closes the convert dialog', () => {
            const djvu = useDjvu();

            djvu.openConvertDialog();
            expect(djvu.showConvertDialog.value).toBe(true);

            djvu.closeConvertDialog();
            expect(djvu.showConvertDialog.value).toBe(false);
        });

        it('dismisses the banner', () => {
            const djvu = useDjvu();

            djvu.dismissBanner();
            expect(djvu.showBanner.value).toBe(false);
        });
    });

    describe('listener setup', () => {
        it('sets up progress and viewing-ready listeners on creation', () => {
            useDjvu();

            expect(mockElectronAPI.djvu.onProgress).toHaveBeenCalled();
            expect(mockElectronAPI.djvu.onViewingReady).toHaveBeenCalled();
        });
    });
});
