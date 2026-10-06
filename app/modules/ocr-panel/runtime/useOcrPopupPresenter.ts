import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import type { TOcrProgressPhase } from '@contracts/electronApiOcr';
import {
    isAvailableOcrLanguageCode,
    type TOcrLanguageCode,
} from '@contracts/ocrLanguages';
import type { IOcrLanguage } from '@contracts/shared';
import type {
    TLocale,
    TTranslationKey,
} from '@i18n-app';
import {
    useClipboard,
    useTimeoutFn,
} from '@vueuse/core';
import type { MaybeRefOrGetter } from 'vue';
import { useOcr } from '@app/composables/useOcr';
import { useTypedI18n } from '@app/composables/useTypedI18n';
import type {IAgentOcrRunOptions} from '@contracts/agentOcr';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import type { IOcrSearchablePdfResult } from '@app/utils/ocr/ocrTypes';
import { resolveOcrExportLanguages } from '@app/utils/ocr/resolveOcrExportLanguages';
import {
    applyAgentOcrOptionsToSettings,
    cloneOcrSettingsSnapshot,
    resolveOcrPageSegmentationModeFromSelectValue,
    resolveOcrPageSegmentationSelectValue,
    resolveQualityProfileSettings,
} from '@app/modules/ocr-panel/runtime/ocrPopupSettings';

type TOcrViewState = 'configure' | 'running' | 'applying' | 'results' | 'error';
type TOcrLanguagePickerGroup = 'selected' | 'installed' | 'missing' | 'unavailable';
type TOcrSupersessionChoice = 'missing-only' | 'repeat';
export type TOcrLanguageModelDisplayState = 'ready' | 'missing' | 'downloading' | 'error' | 'unavailable';

const OCR_LANGUAGE_BCP47_OVERRIDES: Partial<Record<TOcrLanguageCode, string>> = {
    grc: 'grc',
    kmr: 'kmr',
    nor: 'no',
    srp: 'sr-Cyrl',
    syr: 'syr',
} as const satisfies Partial<Record<TOcrLanguageCode, string>>;

export const OCR_LANGUAGE_ENGLISH_FALLBACK_NAMES = {
    ara: 'Arabic',
    bul: 'Bulgarian',
    ces: 'Czech',
    dan: 'Danish',
    deu: 'German',
    ell: 'Greek',
    eng: 'English',
    fin: 'Finnish',
    fra: 'French',
    grc: 'Ancient Greek',
    heb: 'Hebrew',
    hrv: 'Croatian',
    hun: 'Hungarian',
    ind: 'Indonesian',
    ita: 'Italian',
    kmr: 'Kurdish (Kurmanji)',
    nld: 'Dutch',
    nor: 'Norwegian',
    pol: 'Polish',
    por: 'Portuguese',
    ron: 'Romanian',
    rus: 'Russian',
    slk: 'Slovak',
    spa: 'Spanish',
    srp: 'Serbian (Cyrillic)',
    swe: 'Swedish',
    syr: 'Syriac',
    tur: 'Turkish',
    ukr: 'Ukrainian',
    vie: 'Vietnamese',
} as const satisfies Record<TOcrLanguageCode, string>;

const OCR_LANGUAGE_NAME_KEYS = {
    ara: 'ocr.languagePicker.names.ara',
    bul: 'ocr.languagePicker.names.bul',
    ces: 'ocr.languagePicker.names.ces',
    dan: 'ocr.languagePicker.names.dan',
    deu: 'ocr.languagePicker.names.deu',
    ell: 'ocr.languagePicker.names.ell',
    eng: 'ocr.languagePicker.names.eng',
    fin: 'ocr.languagePicker.names.fin',
    fra: 'ocr.languagePicker.names.fra',
    grc: 'ocr.languagePicker.names.grc',
    heb: 'ocr.languagePicker.names.heb',
    hrv: 'ocr.languagePicker.names.hrv',
    hun: 'ocr.languagePicker.names.hun',
    ind: 'ocr.languagePicker.names.ind',
    ita: 'ocr.languagePicker.names.ita',
    kmr: 'ocr.languagePicker.names.kmr',
    nld: 'ocr.languagePicker.names.nld',
    nor: 'ocr.languagePicker.names.nor',
    pol: 'ocr.languagePicker.names.pol',
    por: 'ocr.languagePicker.names.por',
    ron: 'ocr.languagePicker.names.ron',
    rus: 'ocr.languagePicker.names.rus',
    slk: 'ocr.languagePicker.names.slk',
    spa: 'ocr.languagePicker.names.spa',
    srp: 'ocr.languagePicker.names.srp',
    swe: 'ocr.languagePicker.names.swe',
    syr: 'ocr.languagePicker.names.syr',
    tur: 'ocr.languagePicker.names.tur',
    ukr: 'ocr.languagePicker.names.ukr',
    vie: 'ocr.languagePicker.names.vie',
} as const satisfies Record<TOcrLanguageCode, TTranslationKey>;

function createLanguageDisplayNames(locale: TLocale) {
    try {
        return new Intl.DisplayNames(locale, {type: 'language'});
    } catch {
        return null;
    }
}

export function resolveOcrLanguageDisplayName(
    code: string,
    locale: TLocale,
    displayNames: Intl.DisplayNames | null = createLanguageDisplayNames(locale),
) {
    const fallbackName = code in OCR_LANGUAGE_ENGLISH_FALLBACK_NAMES
        ? OCR_LANGUAGE_ENGLISH_FALLBACK_NAMES[code as TOcrLanguageCode]
        : code;
    const languageTag = isAvailableOcrLanguageCode(code)
        ? OCR_LANGUAGE_BCP47_OVERRIDES[code] ?? code
        : code;
    try {
        const localizedName = displayNames?.of(languageTag)?.trim();
        if (
            localizedName
            && localizedName.toLocaleLowerCase(locale) !== languageTag.toLocaleLowerCase(locale)
            && localizedName.toLocaleLowerCase(locale) !== code.toLocaleLowerCase(locale)
        ) {
            return localizedName;
        }
    } catch {
        // Fall through to the canonical English name when ICU rejects a tag.
    }
    return fallbackName;
}

export function resolveOcrLanguageShortCode(code: string) {
    try {
        const shortCode = Intl.getCanonicalLocales(code)[0]?.split('-')[0];
        return shortCode && shortCode !== code ? shortCode : null;
    } catch {
        return null;
    }
}

function matchesOcrLanguageQuery(
    haystack: ReadonlyArray<string | null>,
    normalizedQuery: string,
    canonicalQuery: string | null,
    locale: TLocale,
) {
    return haystack.some(candidate => candidate !== null
        && (
            candidate.toLocaleLowerCase(locale).includes(normalizedQuery)
            || (canonicalQuery !== null && candidate === canonicalQuery)
        ));
}

export function findFailedOcrLanguageCodes(
    languages: readonly IOcrLanguage[],
    error: string | null,
) {
    if (!error) {
        return new Set<string>();
    }
    const normalizedError = error.toLocaleLowerCase();
    return new Set(languages
        .map(language => language.code)
        .filter(code => normalizedError.includes(`"${code}"`)));
}

export function buildOcrLanguagePickerItems(
    languages: readonly IOcrLanguage[],
    groupingSelection: readonly string[],
    locale: TLocale,
    searchQuery: string,
    failedLanguageCodes: ReadonlySet<string>,
    displayNameResolver?: (code: TOcrLanguageCode) => string,
) {
    const selectedCodes = new Set(groupingSelection);
    const displayNames = createLanguageDisplayNames(locale);
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase(locale);
    const canonicalQuery = normalizedQuery.length === 0
        ? null
        : resolveOcrLanguageShortCode(normalizedQuery) ?? normalizedQuery;
    const groupOrder: Record<TOcrLanguagePickerGroup, number> = {
        selected: 0,
        installed: 1,
        missing: 2,
        unavailable: 3,
    };
    return languages
        .map((language) => {
            const label = displayNameResolver?.(language.code)
                ?? resolveOcrLanguageDisplayName(language.code, locale, displayNames);
            const group: TOcrLanguagePickerGroup = selectedCodes.has(language.code)
                ? 'selected'
                : language.modelState === 'installed'
                    ? 'installed'
                    : language.modelState === undefined
                        ? 'unavailable'
                        : 'missing';
            return {
                value: language.code,
                label,
                shortCode: resolveOcrLanguageShortCode(language.code),
                group,
                modelState: failedLanguageCodes.has(language.code)
                    ? 'error' as const
                    : language.modelState === 'installed'
                        ? 'ready' as const
                        : language.modelState ?? 'unavailable',
            };
        })
        .filter(item => normalizedQuery.length === 0
            || matchesOcrLanguageQuery(
                [
                    item.value,
                    item.shortCode,
                    item.label,
                    item.value in OCR_LANGUAGE_ENGLISH_FALLBACK_NAMES
                        ? OCR_LANGUAGE_ENGLISH_FALLBACK_NAMES[item.value]
                        : null,
                ],
                normalizedQuery,
                canonicalQuery,
                locale,
            ))
        .sort((left, right) => (
            groupOrder[left.group] - groupOrder[right.group]
            || left.label.localeCompare(right.label, locale)
            || left.value.localeCompare(right.value)
        ));
}

export function shouldShowOcrLanguageSearch(languageCount: number) {
    return languageCount > 12;
}

interface IOcrPopupCompletePayload extends IOcrSearchablePdfResult {
    sourceWorkingCopyPath: TDocumentRef;
    sourcePageToRestore: number;
}

interface IOcrPopupPresenterContext {
    /** Only its identity matters: a new document ends the pending apply. */
    pdfDocument: MaybeRefOrGetter<unknown>;
    currentPage: MaybeRefOrGetter<number>;
    totalPages: MaybeRefOrGetter<number>;
    workingCopyPath: MaybeRefOrGetter<TDocumentRef | null>;
    documentRevision: MaybeRefOrGetter<TDocumentRevisionToken | null>;
    /** The document is being saved, changed or exported, so a run must not start. */
    busy: MaybeRefOrGetter<boolean>;
}

export interface IOcrPopupPresenterOptions {
    context: IOcrPopupPresenterContext;
    /** Applies a finished run to the document. */
    applyResult: (payload: IOcrPopupCompletePayload) => void | Promise<void>;
}

const ocrProgressStageKeys = {
    preparing: 'ocr.preparing',
    'model-prep': 'ocr.progressStage.modelPrep',
    'pdf-prep': 'ocr.progressStage.pdfPrep',
    'dpi-inspection': 'ocr.progressStage.dpiInspection',
    'page-size-probing': 'ocr.progressStage.pageSizeProbing',
    merging: 'ocr.progressStage.merging',
    indexing: 'ocr.progressStage.indexing',
} as const satisfies Record<Exclude<TOcrProgressPhase, 'processing'>, TTranslationKey>;

function formatLanguagesForDiagnostics(languages: readonly string[]) {
    return languages.length > 0
        ? languages.join(',')
        : '-';
}

function formatDebugLogEntry(entry: IDebugLogEntry) {
    return `[${entry.timestamp}] [${entry.source}] ${entry.message}`;
}

/**
 * One OCR presenter per document: the run, its settings and its result belong
 * to the document, so they outlive the popup that shows them and the view that
 * started them. A popup only shows this state.
 */
export const useOcrPopupPresenter = ({
    context,
    applyResult,
}: IOcrPopupPresenterOptions) => {
    const {
        locale,
        t,
    } = useTypedI18n();
    const { copy: copyClipboardText } = useClipboard();
    const {
        settings,
        activeRunSettings,
        lastCompletedRunSettings,
        progress,
        results,
        error,
        lastRunOutcome,
        hasResults,
        progressPercent,
        availableLanguages,
        languageLoadState = ref<'idle' | 'loading' | 'ready' | 'error'>('ready'),
        loadLanguages,
        runOcr,
        cancelOcr,
        clearResults,
        clearRunSettingsHistory,
    } = useOcr();

    const isCopyingLogs = ref(false);
    const copyLogsState = ref<'idle' | 'copied' | 'failed'>('idle');
    const showSuccessState = ref(false);
    const activeOcrSourcePath = ref<TDocumentRef | null>(null);
    const activeOcrSourcePage = ref<number | null>(null);
    const pendingAppliedOcrRequestId = ref<string | null>(null);
    const pendingAppliedOcrSourceDocumentRevision = ref<TDocumentRevisionToken | null>(null);
    const languageSearchQuery = ref('');
    const activeRunNeedsModelDownload = ref(false);

    const {
        start: startCopyLogsStateReset,
        stop: stopCopyLogsStateReset,
    } = useTimeoutFn(() => {
        copyLogsState.value = 'idle';
    }, 2500, { immediate: false });
    const {
        start: startSuccessStateReset,
        stop: stopSuccessStateReset,
    } = useTimeoutFn(() => {
        showSuccessState.value = false;
    }, 3000, { immediate: false });

    const currentPage = computed(() => toValue(context.currentPage));
    const totalPages = computed(() => toValue(context.totalPages));
    const workingCopyPath = computed(() => toValue(context.workingCopyPath));
    const documentRevision = computed(() => toValue(context.documentRevision));
    const pdfDocument = computed(() => toValue(context.pdfDocument));
    const isRunSettingsLocked = computed(() => progress.value.isRunning);
    const availableLanguageCodes = computed(() => new Set<string>(
        availableLanguages.value.map(language => language.code),
    ));
    const failedLanguageCodes = computed(() => findFailedOcrLanguageCodes(
        availableLanguages.value,
        error.value,
    ));
    const languagePickerItems = computed(() => buildOcrLanguagePickerItems(
        availableLanguages.value,
        settings.value.selectedLanguages,
        locale.value,
        languageSearchQuery.value,
        failedLanguageCodes.value,
        code => t(OCR_LANGUAGE_NAME_KEYS[code], undefined),
    ));
    const languagePickerGroups = computed(() => (
        [
            'selected',
            'installed',
            'missing',
            'unavailable',
        ] as const
    ).map(group => ({
        key: group,
        items: languagePickerItems.value.filter(item => item.group === group),
    })));
    const languageInventoryState = computed(() => {
        // A refresh keeps the already-loaded inventory on screen so reopening
        // the popup does not collapse the picker to a loading placeholder.
        if (availableLanguages.value.length > 0 && languageLoadState.value !== 'error') {
            return 'ready' as const;
        }
        if (languageLoadState.value === 'error'
            || (languageLoadState.value === 'ready' && availableLanguages.value.length === 0)) {
            return 'unavailable' as const;
        }
        return 'loading' as const;
    });
    const showLanguageSearch = computed(() => shouldShowOcrLanguageSearch(
        availableLanguages.value.length,
    ));
    const hasLanguageDownloadFailure = computed(() => failedLanguageCodes.value.size > 0);
    const supersessionChoiceModel = computed<TOcrSupersessionChoice>({
        get: () => settings.value.supersessionPolicy === 'missing-only'
            ? 'missing-only'
            : 'repeat',
        set: choice => {
            settings.value = {
                ...settings.value,
                supersessionPolicy: choice === 'missing-only' ? 'missing-only' : 'replace-evb',
                replaceAllAcknowledged: false,
            };
        },
    });
    const replaceOnlyEvbModel = computed({
        get: () => settings.value.supersessionPolicy === 'replace-evb',
        set: onlyEvb => {
            settings.value = {
                ...settings.value,
                supersessionPolicy: onlyEvb ? 'replace-evb' : 'replace-all',
                replaceAllAcknowledged: false,
            };
        },
    });
    const hasSavedMultipleLanguages = computed(() => settings.value.selectedLanguages.length > 1);
    const hasSelectedAvailableLanguage = computed(() => settings.value.selectedLanguages.length === 1
        && settings.value.selectedLanguages.every(code => availableLanguageCodes.value.has(code)));
    const hasSelectedLanguageDownload = computed(() => {
        const stateByCode = new Map<string, IOcrLanguage['modelState']>(availableLanguages.value.map(language => [
            language.code,
            language.modelState,
        ]));
        return settings.value.selectedLanguages.some((code) => {
            const state = stateByCode.get(code);
            return state === 'missing' || failedLanguageCodes.value.has(code);
        });
    });
    const canRunOcr = computed(() =>
        !toValue(context.busy)
        && !progress.value.isRunning
        && hasSelectedAvailableLanguage.value
        && Boolean(workingCopyPath.value)
        && (
            settings.value.supersessionPolicy !== 'replace-all'
            || settings.value.replaceAllAcknowledged
        ),
    );

    const showCustomRange = computed(() => settings.value.pageRange === 'custom');
    const progressStatusText = computed(() => {
        if (progress.value.phase === 'processing') {
            return t('ocr.processingPage', {
                page: progress.value.currentPage,
                processed: progress.value.processedCount,
                total: progress.value.totalPages,
            });
        }

        if (progress.value.phase === 'model-prep' && !activeRunNeedsModelDownload.value) {
            return t('ocr.preparing');
        }

        return t(ocrProgressStageKeys[progress.value.phase], undefined);
    });
    const applyingStatusText = computed(() => t('ocr.progressStage.applying'));
    const triggerTooltip = computed(() => {
        if (progress.value.isRunning) {
            return progressStatusText.value;
        }

        if (showSuccessState.value) {
            return t('ocr.complete');
        }

        return t('ocr.button');
    });
    const copyLogsTooltip = computed(() => {
        if (copyLogsState.value === 'copied') {
            return t('ocr.logsCopied');
        }
        if (copyLogsState.value === 'failed') {
            return t('ocr.logsCopyFailed');
        }
        return t('ocr.copyLogs');
    });
    const selectedLanguageModel = computed<TOcrLanguageCode | undefined>({
        get: () => settings.value.selectedLanguages.length === 1
            && isAvailableOcrLanguageCode(settings.value.selectedLanguages[0])
            ? settings.value.selectedLanguages[0]
            : undefined,
        set: (selectedLanguage) => {
            settings.value = {
                ...settings.value,
                selectedLanguages: selectedLanguage ? [selectedLanguage] : [],
            };
        },
    });
    const pageSegmentationModeSelectValue = computed({
        get: () => resolveOcrPageSegmentationSelectValue(settings.value.pageSegmentationMode),
        set: (value: string) => {
            settings.value = {
                ...settings.value,
                pageSegmentationMode: resolveOcrPageSegmentationModeFromSelectValue(value),
            };
        },
    });

    function applyAgentOcrOptions(options: IAgentOcrRunOptions) {
        if (isRunSettingsLocked.value) {
            return;
        }

        settings.value = applyAgentOcrOptionsToSettings(
            settings.value,
            options,
            availableLanguageCodes.value,
        );
    }

    function createAgentOcrSnapshot() {
        const activeSettingsSnapshot = cloneOcrSettingsSnapshot(activeRunSettings.value);
        const draftSettingsSnapshot = cloneOcrSettingsSnapshot(settings.value);
        const completedSettingsSnapshot = cloneOcrSettingsSnapshot(lastCompletedRunSettings.value);

        return {
            isRunning: progress.value.isRunning,
            phase: progress.value.phase,
            phaseLabel: progressStatusText.value,
            currentPage: currentPage.value,
            totalPages: totalPages.value,
            processedCount: progress.value.processedCount,
            progressCurrentPage: progress.value.currentPage,
            progressTotalPages: progress.value.totalPages,
            draftSettings: draftSettingsSnapshot,
            activeRunSettings: activeSettingsSnapshot,
            lastCompletedRunSettings: completedSettingsSnapshot,
            selectedLanguages: [...settings.value.selectedLanguages],
            pageRange: settings.value.pageRange,
            customRange: settings.value.customRange,
            qualityProfile: settings.value.qualityProfile,
            preprocessingMode: settings.value.preprocessingMode,
            pageSegmentationMode: settings.value.pageSegmentationMode,
            supersessionPolicy: settings.value.supersessionPolicy,
            replaceAllAcknowledged: settings.value.replaceAllAcknowledged,
            hasWorkingCopy: Boolean(workingCopyPath.value),
            error: error.value,
            outcome: lastRunOutcome.value,
            hasResults: hasResults.value,
        };
    }

    function scheduleCopyLogsStateReset() {
        stopCopyLogsStateReset();
        startCopyLogsStateReset();
    }

    function getExportLanguages() {
        return resolveOcrExportLanguages(
            lastCompletedRunSettings.value,
            activeRunSettings.value,
            settings.value,
        );
    }

    function buildOcrDiagnosticsLog(debugLogs: IDebugLogEntry[]) {
        return [
            'EVB Viewer OCR diagnostics',
            `generatedAt=${new Date().toISOString()}`,
            `currentPage=${currentPage.value}`,
            `totalPages=${totalPages.value}`,
            `isRunning=${progress.value.isRunning}`,
            `phase=${progress.value.phase}`,
            `phaseLabel=${progressStatusText.value}`,
            `draftSelectedLanguages=${formatLanguagesForDiagnostics(settings.value.selectedLanguages)}`,
            `activeRunSelectedLanguages=${formatLanguagesForDiagnostics(activeRunSettings.value?.selectedLanguages ?? [])}`,
            `lastCompletedSelectedLanguages=${formatLanguagesForDiagnostics(lastCompletedRunSettings.value?.selectedLanguages ?? [])}`,
            `draftPageRange=${settings.value.pageRange}`,
            `activeRunPageRange=${activeRunSettings.value?.pageRange ?? '-'}`,
            `lastCompletedPageRange=${lastCompletedRunSettings.value?.pageRange ?? '-'}`,
            `draftQualityProfile=${settings.value.qualityProfile}`,
            `activeRunQualityProfile=${activeRunSettings.value?.qualityProfile ?? '-'}`,
            `lastCompletedQualityProfile=${lastCompletedRunSettings.value?.qualityProfile ?? '-'}`,
            `draftPreprocessingMode=${settings.value.preprocessingMode}`,
            `activeRunPreprocessingMode=${activeRunSettings.value?.preprocessingMode ?? '-'}`,
            `lastCompletedPreprocessingMode=${lastCompletedRunSettings.value?.preprocessingMode ?? '-'}`,
            `draftPageSegmentationMode=${settings.value.pageSegmentationMode ?? '-'}`,
            `activeRunPageSegmentationMode=${activeRunSettings.value?.pageSegmentationMode ?? '-'}`,
            `lastCompletedPageSegmentationMode=${lastCompletedRunSettings.value?.pageSegmentationMode ?? '-'}`,
            `draftSupersessionPolicy=${settings.value.supersessionPolicy}`,
            `draftReplaceAllAcknowledged=${settings.value.replaceAllAcknowledged}`,
            `activeSupersessionPolicy=${activeRunSettings.value?.supersessionPolicy ?? '-'}`,
            `completedSupersessionPolicy=${lastCompletedRunSettings.value?.supersessionPolicy ?? '-'}`,
            `uiError=${error.value ?? ''}`,
            '',
            '--- debug:log stream ---',
            ...(debugLogs.length > 0
                ? debugLogs.map(formatDebugLogEntry)
                : ['(no buffered logs available)']),
        ];
    }

    async function handleCopyLogs() {
        if (!error.value || isCopyingLogs.value) {
            return;
        }

        isCopyingLogs.value = true;
        copyLogsState.value = 'idle';

        try {
            const debugLogs = await getSettingsCapability().getDebugLogs();
            await copyClipboardText(buildOcrDiagnosticsLog(debugLogs).join('\n'));
            copyLogsState.value = 'copied';
        } catch (copyErr) {
            copyLogsState.value = 'failed';
            BrowserLogger.warn('ocr', 'Failed to copy OCR debug logs', copyErr);
        } finally {
            isCopyingLogs.value = false;
            scheduleCopyLogsStateReset();
        }
    }

    function computeActiveRunNeedsModelDownload() {
        const stateByCode = new Map<string, IOcrLanguage['modelState']>(availableLanguages.value.map(language => [
            language.code,
            language.modelState,
        ]));
        return settings.value.selectedLanguages.some((code) => {
            const state = stateByCode.get(code);
            return state === 'missing' || state === 'downloading';
        });
    }

    function handleRunOcr() {
        if (!canRunOcr.value || !workingCopyPath.value) {
            return;
        }
        activeOcrSourcePath.value = workingCopyPath.value;
        activeOcrSourcePage.value = currentPage.value;
        activeRunNeedsModelDownload.value = computeActiveRunNeedsModelDownload();
        void runOcr(currentPage.value, totalPages.value, workingCopyPath.value);
    }

    function refuseAgentRun(error: string) {
        return {
            ok: false,
            error,
            ocr: createAgentOcrSnapshot(),
        };
    }

    async function runOcrForAgent(options: IAgentOcrRunOptions = {}) {
        if (toValue(context.busy)) {
            return refuseAgentRun(t('errors.ocr.disabled'));
        }

        if (progress.value.isRunning) {
            return refuseAgentRun(t('errors.ocr.alreadyRunning'));
        }

        await loadLanguages();
        applyAgentOcrOptions(options);

        if (!workingCopyPath.value) {
            return refuseAgentRun(t('errors.ocr.noDocument'));
        }

        if (!hasSelectedAvailableLanguage.value) {
            return refuseAgentRun(t('errors.ocr.noLanguages'));
        }

        if (!canRunOcr.value) {
            return refuseAgentRun(t('errors.ocr.start'));
        }

        activeOcrSourcePath.value = workingCopyPath.value;
        activeOcrSourcePage.value = currentPage.value;
        activeRunNeedsModelDownload.value = computeActiveRunNeedsModelDownload();
        await runOcr(currentPage.value, totalPages.value, workingCopyPath.value);
        await nextTick();

        const agentSnapshot = createAgentOcrSnapshot();
        if (lastRunOutcome.value === 'no-pages-to-process') {
            return {
                ok: true,
                warning: t('ocr.noPagesToProcess'),
                ocr: agentSnapshot,
            };
        }
        if (hasResults.value) {
            return {
                ok: true,
                ...(error.value ? { warning: error.value } : {}),
                ocr: agentSnapshot,
            };
        }

        return {
            ok: false,
            error: error.value ?? t('errors.ocr.incomplete'),
            ocr: agentSnapshot,
        };
    }

    function clearActiveOcrSource() {
        activeOcrSourcePath.value = null;
        activeOcrSourcePage.value = null;
    }

    async function handleCancel() {
        const cancelResult = await cancelOcr();
        if (cancelResult.canceled || cancelResult.reason !== 'failed') {
            clearActiveOcrSource();
        }
    }

    async function cancelOcrForAgent() {
        const cancelResult = await cancelOcr();
        if (cancelResult.canceled || cancelResult.reason !== 'failed') {
            clearActiveOcrSource();
        }
        return {
            ok: cancelResult.canceled,
            cancel: cancelResult,
            ...(cancelResult.canceled ? {} : {error: cancelResult.error ?? t('errors.ocr.cancel')}),
            ocr: createAgentOcrSnapshot(),
        };
    }


    function resetCompletedOcrState() {
        activeOcrSourcePath.value = null;
        activeOcrSourcePage.value = null;
        pendingAppliedOcrRequestId.value = null;
        pendingAppliedOcrSourceDocumentRevision.value = null;
        clearResults();
        clearRunSettingsHistory();
    }

    /** The dialog showing this run opened. */
    function handleDialogOpened() {
        void loadLanguages();
    }

    /** The dialog closed while no run was going: the finished run is dismissed. */
    function handleDialogClosed() {
        resetCompletedOcrState();
        if (settings.value.replaceAllAcknowledged) {
            settings.value = {
                ...settings.value,
                replaceAllAcknowledged: false,
            };
        }
    }

    /**
     * What a view's dialog shows of the run, given what only that view knows.
     * Create it in the popup's scope so it goes away with the popup.
     */
    function createViewState(view: {
        disabled: MaybeRefOrGetter<boolean>;
        externalError: MaybeRefOrGetter<string | null | undefined>;
        /** Whether this view's dialog is open, and how it asks to change. */
        open: MaybeRefOrGetter<boolean>;
        setOpen: (open: boolean) => void;
    }) {
        const isOpen = computed({
            get: () => toValue(view.open),
            set: view.setOpen,
        });
        if (isOpen.value) {
            handleDialogOpened();
        }
        watch(isOpen, (value) => {
            if (value) {
                handleDialogOpened();
                return;
            }
            if (progress.value.isRunning) {
                return;
            }
            handleDialogClosed();
        });
        const effectiveError = computed(() => error.value ?? toValue(view.externalError) ?? null);
        const hasResultWarning = computed(() => hasResults.value && effectiveError.value !== null);
        return {
            isOpen,
            effectiveError,
            hasResultWarning,
            resultStatusText: computed(() => (
                hasResultWarning.value ? t('ocr.partialComplete') : t('ocr.complete')
            )),
            canRunOcr: computed(() => !toValue(view.disabled) && canRunOcr.value),
            viewState: computed<TOcrViewState>(() => {
                if (progress.value.isRunning) {
                    return 'running';
                }
                if (pendingAppliedOcrRequestId.value !== null) {
                    return 'applying';
                }
                if (hasResults.value) {
                    return 'results';
                }
                return effectiveError.value !== null ? 'error' : 'configure';
            }),
        };
    }

    watch(() => settings.value.qualityProfile, (nextProfile, previousProfile) => {
        if (isRunSettingsLocked.value) {
            return;
        }

        const nextSettings = resolveQualityProfileSettings(
            settings.value,
            nextProfile,
            previousProfile,
        );
        if (nextSettings !== settings.value) {
            settings.value = nextSettings;
        }
    });

    watch(() => settings.value.supersessionPolicy, (policy) => {
        if (policy !== 'replace-all' && settings.value.replaceAllAcknowledged) {
            settings.value = {
                ...settings.value,
                replaceAllAcknowledged: false,
            };
        }
    });

    watch(workingCopyPath, (nextPath, previousPath) => {
        if (nextPath === previousPath) {
            return;
        }
        if (progress.value.isRunning) {
            void cancelOcr();
        }
        resetCompletedOcrState();
    });

    watch([
        pdfDocument,
        documentRevision,
    ], ([
        nextDocument,
        nextRevision,
    ], [previousDocument]) => {
        const documentChanged = nextDocument !== null && nextDocument !== previousDocument;
        const revisionChangedToAppliedDocument = nextRevision !== null
            && nextRevision !== pendingAppliedOcrSourceDocumentRevision.value;
        if (
            (!documentChanged && !revisionChangedToAppliedDocument)
            || pendingAppliedOcrRequestId.value === null
            || progress.value.isRunning
        ) {
            return;
        }

        pendingAppliedOcrRequestId.value = null;
        pendingAppliedOcrSourceDocumentRevision.value = null;
        showSuccessState.value = true;
        stopSuccessStateReset();
        startSuccessStateReset();
    });

    watch(error, (nextError) => {
        if (nextError !== null && pendingAppliedOcrRequestId.value !== null) {
            pendingAppliedOcrRequestId.value = null;
            pendingAppliedOcrSourceDocumentRevision.value = null;
        }
    });

    watch(() => results.value.searchablePdfResult, (searchablePdfResult) => {
        const sourceWorkingCopyPath = activeOcrSourcePath.value;
        const sourcePageToRestore = activeOcrSourcePage.value ?? currentPage.value;
        if (searchablePdfResult && sourceWorkingCopyPath) {
            pendingAppliedOcrRequestId.value = searchablePdfResult.requestId;
            pendingAppliedOcrSourceDocumentRevision.value = searchablePdfResult.sourceDocumentRevisionToken;
            void applyResult({
                ...searchablePdfResult,
                sourceWorkingCopyPath,
                sourcePageToRestore,
            });
            activeOcrSourcePath.value = null;
            activeOcrSourcePage.value = null;
        }
    });

    onScopeDispose(() => {
        stopCopyLogsStateReset();
        stopSuccessStateReset();
    });

    return {
        settings,
        progress,
        results,
        error,
        hasResults,
        progressPercent,
        availableLanguages,
        createViewState,
        showCustomRange,
        isCopyingLogs,
        copyLogsState,
        copyLogsTooltip,
        showSuccessState,
        progressStatusText,
        applyingStatusText,
        triggerTooltip,
        languageSearchQuery,
        languagePickerItems,
        languagePickerGroups,
        languageInventoryState,
        hasSavedMultipleLanguages,
        hasSelectedLanguageDownload,
        showLanguageSearch,
        hasLanguageDownloadFailure,
        supersessionChoiceModel,
        replaceOnlyEvbModel,
        selectedLanguageModel,
        pageSegmentationModeSelectValue,
        handleCopyLogs,
        handleRunOcr,
        runOcrForAgent,
        handleCancel,
        cancelOcrForAgent,
        handleDialogOpened,
        handleDialogClosed,
        applyResult,
        getExportLanguages,
        getAgentOcrSnapshot: createAgentOcrSnapshot,
    };
};

export type TOcrPopupPresenter = ReturnType<typeof useOcrPopupPresenter>;
