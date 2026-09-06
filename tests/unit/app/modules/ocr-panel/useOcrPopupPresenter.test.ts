import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IOcrLanguage } from '@contracts/shared';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
    shallowRef,
    type EffectScope,
} from 'vue';
import type {
    IOcrResults,
    IOcrSettings,
    IOcrUiProgress,
} from '@app/utils/ocr/ocrTypes';
import {requireDocumentRevisionToken} from '@contracts';

const useOcrMock = vi.hoisted(() => vi.fn());
const copyClipboardTextMock = vi.hoisted(() => vi.fn());
const getDebugLogsMock = vi.hoisted(() => vi.fn());
const browserLoggerWarnMock = vi.hoisted(() => vi.fn());
const timeoutStartMock = vi.hoisted(() => vi.fn());
const timeoutStopMock = vi.hoisted(() => vi.fn());
const translateMock = vi.hoisted(() => (key: string, params?: Record<string, unknown>) => {
    if (params === undefined) {
        return key;
    }
    return `${key}:${JSON.stringify(params)}`;
});

vi.mock('@app/composables/useOcr', () => ({useOcr: useOcrMock}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({
    locale: ref('en'),
    t: translateMock,
})}));
vi.mock('@vueuse/core', () => ({
    useClipboard: () => ({copy: copyClipboardTextMock}),
    useTimeoutFn: () => ({
        start: timeoutStartMock,
        stop: timeoutStopMock,
    }),
}));
vi.mock('@app/utils/getSettingsCapability', () => ({getSettingsCapability: () => ({getDebugLogs: getDebugLogsMock})}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: browserLoggerWarnMock}}));

const { useOcrPopupPresenter } = await import('@app/modules/ocr-panel/runtime/useOcrPopupPresenter');

function createSettings(): IOcrSettings {
    return {
        pageRange: 'current',
        customRange: '',
        selectedLanguages: ['eng'],
        qualityProfile: 'balanced',
        preprocessingMode: 'off',
        pageSegmentationMode: null,
        supersessionPolicy: 'missing-only',
        replaceAllAcknowledged: false,
    };
}

function createProgress(): IOcrUiProgress {
    return {
        isRunning: false,
        phase: 'preparing',
        currentPage: 0,
        totalPages: 0,
        processedCount: 0,
        phaseProgress: null,
    };
}

function createResults(): IOcrResults {
    return {
        pages: new Map(),
        languages: [],
        completedAt: null,
        searchablePdfResult: null,
    };
}

function createLanguages(): IOcrLanguage[] {
    return [
        {
            code: 'eng',
            script: 'latin',
        },
        {
            code: 'rus',
            script: 'cyrillic',
        },
        {
            code: 'ell',
            script: 'greek',
        },
        {
            code: 'ara',
            script: 'rtl',
        },
    ];
}

function createOcrMock() {
    const settings = ref(createSettings());
    const activeRunSettings = ref<IOcrSettings | null>(null);
    const lastCompletedRunSettings = ref<IOcrSettings | null>(null);
    const progress = ref(createProgress());
    const results = ref(createResults());
    const error = ref<string | null>(null);
    const languages = ref(createLanguages());
    const clearResults = vi.fn(() => {
        results.value = createResults();
    });
    const clearRunSettingsHistory = vi.fn(() => {
        activeRunSettings.value = null;
        lastCompletedRunSettings.value = null;
    });

    return {
        availableLanguages: languages,
        settings,
        activeRunSettings,
        lastCompletedRunSettings,
        progress,
        results,
        error,
        isExporting: ref(false),
        hasResults: computed(() => results.value.searchablePdfResult !== null),
        progressPercent: computed(() => 0),
        loadLanguages: vi.fn(async () => {}),
        runOcr: vi.fn(async () => {}),
        cancelOcr: vi.fn(async () => ({canceled: true})),
        clearResults,
        clearRunSettingsHistory,
        toggleLanguage: vi.fn(),
        exportDocx: vi.fn(),
    };
}

type TOcrMock = ReturnType<typeof createOcrMock>;

function setSearchableResult(
    ocr: TOcrMock,
    requestId: string,
    pdfPath: TDocumentRef,
) {
    ocr.results.value = {
        pages: new Map(),
        languages: [...ocr.settings.value.selectedLanguages],
        completedAt: 1,
        searchablePdfResult: {
            requestId,
            pdfPath,
            sourceDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token'),
            requiresCleanupAck: true,
        },
    };
}

function createPresenterHarness(ocr: TOcrMock = createOcrMock()) {
    useOcrMock.mockReturnValue(ocr);

    const isOpen = ref(false);
    const currentPage = ref(3);
    const totalPages = ref(12);
    const workingCopyPath = ref<TDocumentRef | null>('/tmp/source.pdf');
    const pdfDocument = shallowRef<IPdfDocument | null>({} as IPdfDocument);
    const disabled = ref(false);
    const externalError = ref<string | null | undefined>(null);
    const onRunningChange = vi.fn();
    const onOcrComplete = vi.fn();
    const onExportDocx = vi.fn();
    const onCancelDocxExport = vi.fn();

    const scope = effectScope();
    const presenter = scope.run(() => useOcrPopupPresenter({
        isOpen: computed({
            get: () => isOpen.value,
            set: value => {
                isOpen.value = value;
            },
        }),
        context: {
            pdfDocument,
            currentPage,
            totalPages,
            workingCopyPath,
            disabled,
            externalError,
        },
        events: {
            onRunningChange,
            onOcrComplete,
            onExportDocx,
            onCancelDocxExport,
        },
    }));

    if (!presenter) {
        throw new Error('Failed to create OCR popup presenter');
    }

    return {
        scope,
        presenter,
        ocr,
        isOpen,
        currentPage,
        totalPages,
        workingCopyPath,
        pdfDocument,
        disabled,
        externalError,
        events: {
            onRunningChange,
            onOcrComplete,
            onExportDocx,
            onCancelDocxExport,
        },
    };
}

function stopHarness(scope: EffectScope) {
    scope.stop();
}

describe('useOcrPopupPresenter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        copyClipboardTextMock.mockResolvedValue(undefined);
        getDebugLogsMock.mockResolvedValue([{
            source: 'ocr',
            message: 'trace line',
            timestamp: '2026-06-28T00:00:00.000Z',
        }]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('normalizes agent settings and applies completed OCR results with the source page to restore', async () => {
        const harness = createPresenterHarness();
        const resultPath = '/tmp/result.pdf';
        harness.currentPage.value = 5;
        harness.ocr.runOcr.mockImplementation(async () => {
            harness.ocr.lastCompletedRunSettings.value = {
                ...harness.ocr.settings.value,
                selectedLanguages: [...harness.ocr.settings.value.selectedLanguages],
            };
            setSearchableResult(harness.ocr, 'req-success', resultPath);
            await nextTick();
        });

        try {
            const result = await harness.presenter.runOcrForAgent({
                open: true,
                pageRange: 'custom',
                customRange: '2-5',
                languages: [
                    ' rus ',
                    'eng',
                    'missing',
                    'eng',
                ],
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 6,
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: true,
            });

            expect(harness.isOpen.value).toBe(true);
            expect(harness.ocr.settings.value).toMatchObject({
                pageRange: 'custom',
                customRange: '2-5',
                selectedLanguages: [
                    'rus',
                    'eng',
                ],
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 6,
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: true,
            });
            expect(harness.ocr.runOcr).toHaveBeenCalledWith(
                5,
                12,
                '/tmp/source.pdf',
            );
            expect(harness.events.onOcrComplete).toHaveBeenCalledWith({
                requestId: 'req-success',
                pdfPath: resultPath,
                sourceDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token'),
                requiresCleanupAck: true,
                sourceWorkingCopyPath: '/tmp/source.pdf',
                sourcePageToRestore: 5,
            });
            expect(result).toMatchObject({
                ok: true,
                ocr: {
                    hasResults: true,
                    selectedLanguages: [
                        'rus',
                        'eng',
                    ],
                },
            });
            expect(harness.presenter.showSuccessState.value).toBe(false);
            expect(harness.presenter.viewState.value).toBe('applying');
            harness.pdfDocument.value = {} as IPdfDocument;
            await nextTick();
            expect(harness.presenter.showSuccessState.value).toBe(true);
            expect(harness.presenter.viewState.value).toBe('results');
        } finally {
            stopHarness(harness.scope);
        }
    });

    it('clears source tracking when canceled before completion so late results are not applied', async () => {
        const harness = createPresenterHarness();

        try {
            harness.presenter.handleRunOcr();
            harness.presenter.handleCancel();
            setSearchableResult(harness.ocr, 'req-canceled', '/tmp/canceled.pdf');
            await nextTick();

            expect(harness.ocr.runOcr).toHaveBeenCalledWith(3, 12, '/tmp/source.pdf');
            expect(harness.ocr.cancelOcr).toHaveBeenCalledTimes(1);
            expect(harness.events.onOcrComplete).not.toHaveBeenCalled();

            harness.presenter.handleCloseResults();
            expect(harness.isOpen.value).toBe(false);
            expect(harness.ocr.clearResults).toHaveBeenCalled();
            expect(harness.ocr.clearRunSettingsHistory).toHaveBeenCalled();
        } finally {
            stopHarness(harness.scope);
        }
    });

    it('forwards DOCX export cancellation to the workspace owner', () => {
        const harness = createPresenterHarness();

        try {
            harness.presenter.handleCancelDocxExport();
            expect(harness.events.onCancelDocxExport).toHaveBeenCalledOnce();
        } finally {
            stopHarness(harness.scope);
        }
    });

    it('cancels and clears on source changes, then preserves applied results across document reload', async () => {
        const harness = createPresenterHarness();

        try {
            harness.presenter.handleRunOcr();
            harness.ocr.progress.value = {
                ...harness.ocr.progress.value,
                isRunning: true,
            };
            await nextTick();

            harness.workingCopyPath.value = '/tmp/other.pdf';
            await nextTick();
            setSearchableResult(harness.ocr, 'req-stale', '/tmp/stale.pdf');
            await nextTick();

            expect(harness.ocr.cancelOcr).toHaveBeenCalledTimes(1);
            expect(harness.ocr.clearResults).toHaveBeenCalledTimes(1);
            expect(harness.events.onOcrComplete).not.toHaveBeenCalled();

            harness.ocr.progress.value = {
                ...harness.ocr.progress.value,
                isRunning: false,
            };
            harness.currentPage.value = 7;
            harness.presenter.handleRunOcr();
            setSearchableResult(harness.ocr, 'req-applied', '/tmp/applied.pdf');
            await nextTick();
            expect(harness.events.onOcrComplete).toHaveBeenCalledTimes(1);

            harness.pdfDocument.value = {} as IPdfDocument;
            await nextTick();

            expect(harness.presenter.viewState.value).toBe('results');
            expect(harness.ocr.clearResults).toHaveBeenCalledTimes(1);
            expect(harness.ocr.clearRunSettingsHistory).toHaveBeenCalledTimes(1);
        } finally {
            stopHarness(harness.scope);
        }
    });

    it('keeps diagnostics copy state coherent for success, failure, and no-error no-op', async () => {
        const harness = createPresenterHarness();

        try {
            await harness.presenter.handleCopyLogs();
            expect(getDebugLogsMock).not.toHaveBeenCalled();
            expect(copyClipboardTextMock).not.toHaveBeenCalled();
            expect(harness.presenter.copyLogsState.value).toBe('idle');

            harness.externalError.value = 'OCR failed';
            await harness.presenter.handleCopyLogs();

            expect(getDebugLogsMock).toHaveBeenCalledTimes(1);
            expect(copyClipboardTextMock).toHaveBeenCalledTimes(1);
            expect(copyClipboardTextMock.mock.calls[0]?.[0]).toContain('uiError=OCR failed');
            expect(copyClipboardTextMock.mock.calls[0]?.[0]).toContain('[ocr] trace line');
            expect(harness.presenter.copyLogsState.value).toBe('copied');
            expect(harness.presenter.copyLogsTooltip.value).toBe('ocr.logsCopied');

            copyClipboardTextMock.mockRejectedValueOnce(new Error('clipboard denied'));
            await harness.presenter.handleCopyLogs();

            expect(harness.presenter.copyLogsState.value).toBe('failed');
            expect(harness.presenter.copyLogsTooltip.value).toBe('ocr.logsCopyFailed');
            expect(browserLoggerWarnMock).toHaveBeenCalledWith(
                'ocr',
                'Failed to copy OCR debug logs',
                expect.any(Error),
            );
        } finally {
            stopHarness(harness.scope);
        }
    });

    it('keeps poor-scan quality and preprocessing settings synchronized outside active runs', async () => {
        const harness = createPresenterHarness();

        try {
            harness.ocr.settings.value = {
                ...harness.ocr.settings.value,
                qualityProfile: 'poor-scan',
            };
            await nextTick();
            expect(harness.ocr.settings.value.preprocessingMode).toBe('clean');

            harness.ocr.settings.value = {
                ...harness.ocr.settings.value,
                qualityProfile: 'balanced',
            };
            await nextTick();
            expect(harness.ocr.settings.value.preprocessingMode).toBe('off');

            harness.ocr.progress.value = {
                ...harness.ocr.progress.value,
                isRunning: true,
            };
            harness.ocr.settings.value = {
                ...harness.ocr.settings.value,
                qualityProfile: 'poor-scan',
            };
            await nextTick();
            expect(harness.ocr.settings.value.preprocessingMode).toBe('off');
        } finally {
            stopHarness(harness.scope);
        }
    });

    it('uses missing-only by default and requires acknowledgement before replacing foreign hidden OCR', async () => {
        const harness = createPresenterHarness();

        try {
            expect(harness.ocr.settings.value.supersessionPolicy).toBe('missing-only');
            expect(harness.presenter.canRunOcr.value).toBe(true);

            harness.ocr.settings.value = {
                ...harness.ocr.settings.value,
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: false,
            };
            await nextTick();
            expect(harness.presenter.canRunOcr.value).toBe(false);
            expect(harness.presenter.getAgentOcrSnapshot()).toMatchObject({
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: false,
            });

            harness.ocr.settings.value = {
                ...harness.ocr.settings.value,
                replaceAllAcknowledged: true,
            };
            await nextTick();
            expect(harness.presenter.canRunOcr.value).toBe(true);

            harness.isOpen.value = true;
            await nextTick();
            harness.isOpen.value = false;
            await nextTick();
            expect(harness.ocr.settings.value).toMatchObject({
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: false,
            });
            expect(harness.presenter.canRunOcr.value).toBe(false);

            harness.ocr.settings.value = {
                ...harness.ocr.settings.value,
                supersessionPolicy: 'replace-evb',
            };
            await nextTick();
            expect(harness.ocr.settings.value.replaceAllAcknowledged).toBe(false);
        } finally {
            stopHarness(harness.scope);
        }
    });
});
