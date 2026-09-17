import type {
    IScanCleanupMarginsMm,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupPageAlignment,
} from '@contracts/electronApiScanCleanup';
import type {ComputedRef} from 'vue';
import {requirePageNumber} from '@contracts/pageNumbers';
import {tryOnScopeDispose} from '@vueuse/core';
import {
    attachScanCleanupPageOverrideDefaults,
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
    setScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import {DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {
    cloneScanCleanupPreferenceValue,
    isScanCleanupSourceSha256,
    type IScanCleanupDocumentPreferencePatch,
} from '@contracts/scanCleanupSettings';
import {
    captureScanCleanupDocumentPersistenceToken,
    flushScanCleanupPreferencesStore,
    flushScanCleanupDocumentPreferencesStore,
    getScanCleanupPreferencesStore,
    invalidateScanCleanupDocumentPersistence,
    isScanCleanupDocumentPersistenceTokenCurrent,
    loadScanCleanupDocumentSettings,
    retryScanCleanupPreferences,
    saveScanCleanupDocumentPreferencesInStore,
    scheduleScanCleanupDocumentPreferencesInStore,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';
import type {IScanCleanupDocumentSettingsSnapshot} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';
import {
    resolveScanCleanupMarginPatch,
    scanCleanupMarginsUniform,
    type TScanCleanupMarginTarget,
} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';
import {isDesktopPlatformActive} from '@app/utils/platform';
import {initializeRendererFailureReporter} from '@app/utils/failureReporter';
import type {FailurePresentation} from '@app/composables/useFailureToast';
import {getFailureReceipt} from '@contracts/diagnostics/failureReceipt';

interface IUseScanCleanupDocumentSettingsOptions {
    documentLifecycleKey: ComputedRef<string | null>;
    documentRevision?: ComputedRef<string | null>;
    sourceSha256?: ComputedRef<string | null>;
    legacyDocumentKey?: ComputedRef<string | null>;
    preferenceDocumentKey?: ComputedRef<string | null>;
}

interface IPreviousDocumentContext {
    documentRevision: string | null;
    sourceSha256: string | null;
    legacyDocumentKey: string | null;
}

function recordEditedFields<T extends object>(intent: Partial<T>, current: T, previous: T) {
    const keys = new Set([
        ...Object.keys(current),
        ...Object.keys(previous),
    ] as Array<keyof T>);
    for (const key of keys) {
        if (JSON.stringify(current[key]) !== JSON.stringify(previous[key])) {
            intent[key] = current[key];
        }
    }
}

const alignmentIcons: Array<{
    value: TScanCleanupPageAlignment;
    icon: string;
}> = [
    {
        value: 'ink',
        icon: 'i-ph-text-align-center',
    },
    {
        value: 'top-left',
        icon: 'i-ph-arrow-up-left',
    },
    {
        value: 'top-center',
        icon: 'i-ph-arrow-up',
    },
    {
        value: 'top-right',
        icon: 'i-ph-arrow-up-right',
    },
    {
        value: 'center-left',
        icon: 'i-ph-arrow-left',
    },
    {
        value: 'center',
        icon: 'i-ph-dot-outline',
    },
    {
        value: 'center-right',
        icon: 'i-ph-arrow-right',
    },
    {
        value: 'bottom-left',
        icon: 'i-ph-arrow-down-left',
    },
    {
        value: 'bottom-center',
        icon: 'i-ph-arrow-down',
    },
    {
        value: 'bottom-right',
        icon: 'i-ph-arrow-down-right',
    },
];

export const useScanCleanupDocumentSettings = (options: IUseScanCleanupDocumentSettingsOptions) => {
    const {t} = useTypedI18n();
    const sourceSha256 = options.sourceSha256 ?? computed(() => null);
    const legacyDocumentKey = options.legacyDocumentKey
        ?? options.preferenceDocumentKey
        ?? computed(() => null);
    const documentRevision = options.documentRevision ?? options.documentLifecycleKey;
    const preferences = getScanCleanupPreferencesStore({
        sourceSha256: sourceSha256.value,
        legacyDocumentKey: legacyDocumentKey.value,
    });
    const loadingDocument = ref(false);
    let documentLoadGeneration = 0;
    let applyingDocumentSettings = false;
    const documentSettingsReady = ref(false);
    const documentSettingsLoadFailure = shallowRef<FailurePresentation | null>(null);
    const documentIntents = new Set<'overrides' | 'pageOverrideDefaults' | 'marginsMm' | 'outputMode'>();
    let marginIntent: Partial<IScanCleanupMarginsMm> = {};
    let defaultsIntent: Partial<IScanCleanupPageOverride> = {};
    const overrideIntents = new Map<string, Partial<IScanCleanupPageOverride> | null>();
    let overridesReset = false;
    let previousDocumentContext: IPreviousDocumentContext | null = null;

    function scheduleDocumentPersistence(
        sourceSha256: string | null | undefined,
        legacyDocumentKey: string | null | undefined,
        patch: IScanCleanupDocumentPreferencePatch,
    ) {
        if (!documentSettingsReady.value
            || (isDesktopPlatformActive() && !isScanCleanupSourceSha256(sourceSha256))) {
            return;
        }
        void Promise.resolve(scheduleScanCleanupDocumentPreferencesInStore(sourceSha256, legacyDocumentKey, patch))
            .catch(() => undefined);
    }

    async function flushPersistence() {
        await flushScanCleanupDocumentPreferencesStore();
        await flushScanCleanupPreferencesStore();
    }

    const handleWindowLifecycle = () => {
        void flushPersistence().catch(() => undefined);
    };
    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', handleWindowLifecycle);
    }
    tryOnScopeDispose(() => {
        documentLoadGeneration += 1;
        void flushPersistence().catch(() => undefined);
        if (typeof window !== 'undefined') {
            window.removeEventListener('pagehide', handleWindowLifecycle);
        }
    });
    const firstRunGuidanceDismissed = toRef(preferences, 'firstRunGuidanceDismissed');
    const marginsLinked = ref(true);
    const values: IScanCleanupOptions = reactive({
        preserveOriginalQuality: toRef(preferences, 'preserveOriginalQuality'),
        layoutMode: toRef(preferences, 'layoutMode'),
        outputMode: DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE,
        binarization: toRef(preferences, 'binarization'),
        normalizeIllumination: toRef(preferences, 'normalizeIllumination'),
        readingOrder: toRef(preferences, 'readingOrder'),
        thickness: toRef(preferences, 'thickness'),
        crop: toRef(preferences, 'crop'),
        matchPageSize: toRef(preferences, 'matchPageSize'),
        pageAlignment: toRef(preferences, 'pageAlignment'),
        marginsMm: {...preferences.marginsMm},
        despeckleLevel: toRef(preferences, 'despeckleLevel'),
        autoDewarp: toRef(preferences, 'autoDewarp'),
        autoDewarpDepth: toRef(preferences, 'autoDewarpDepth'),
        skipBlankPages: toRef(preferences, 'skipBlankPages'),
        pageOverrides: {},
        pageOverrideDefaults: createScanCleanupPageOverride(),
    });
    const layoutItems = computed(() => [
        {
            value: 'auto' as const,
            label: t('scanCleanup.layout.auto'),
        },
        {
            value: 'force-single' as const,
            label: t('scanCleanup.layout.single'),
        },
        {
            value: 'force-two-page' as const,
            label: t('scanCleanup.layout.twoPage'),
        },
    ]);
    const readingOrderItems = computed(() => [
        {
            value: 'ltr' as const,
            label: t('scanCleanup.layout.leftToRight'),
        },
        {
            value: 'rtl' as const,
            label: t('scanCleanup.layout.rightToLeft'),
        },
    ]);
    const outputItems = computed(() => [
        {
            value: 'auto' as const,
            label: t('scanCleanup.output.autoShort'),
            fullLabel: t('scanCleanup.output.autoDescription'),
        },
        {
            value: 'bw' as const,
            label: t('scanCleanup.output.bwShort'),
            fullLabel: t('scanCleanup.output.bw'),
        },
        {
            value: 'grayscale' as const,
            label: t('scanCleanup.output.grayscaleShort'),
            fullLabel: t('scanCleanup.output.grayscale'),
        },
        {
            value: 'color' as const,
            label: t('scanCleanup.output.colorShort'),
            fullLabel: t('scanCleanup.output.color'),
        },
    ]);
    const alignmentItems = computed(() => alignmentIcons.map(item => ({
        ...item,
        label: t(`scanCleanup.pageSize.${({
            'ink': 'ink',
            'top-left': 'topLeft',
            'top-center': 'topCenter',
            'top-right': 'topRight',
            'center-left': 'centerLeft',
            'center': 'center',
            'center-right': 'centerRight',
            'bottom-left': 'bottomLeft',
            'bottom-center': 'bottomCenter',
            'bottom-right': 'bottomRight',
        } as const)[item.value]}`),
    })));
    const thicknessLabel = computed(() => values.thickness > 0 ? `+${values.thickness}` : String(values.thickness));
    const showFirstRunGuidance = computed(() => !firstRunGuidanceDismissed.value);

    function dismissFirstRunGuidance() {
        firstRunGuidanceDismissed.value = true;
    }

    function handleThicknessInput(value: number | number[]) {
        values.thickness = Array.isArray(value) ? (value[0] ?? 0) : value;
    }

    function updateMargin(target: TScanCleanupMarginTarget, value: number) {
        const patch = resolveScanCleanupMarginPatch(
            marginsLinked.value ? 'all' : target,
            value,
        );
        documentIntents.add('marginsMm');
        Object.assign(marginIntent, patch);
        Object.assign(values.marginsMm, patch);
        if (values.pageOverrideDefaults?.marginsMm !== undefined) {
            const {
                marginsMm: _marginsMm,
                ...withoutMargins
            } = values.pageOverrideDefaults;
            values.pageOverrideDefaults = createScanCleanupPageOverride(withoutMargins);
            attachScanCleanupPageOverrideDefaults(
                values.pageOverrides,
                values.pageOverrideDefaults,
                values.marginsMm,
            );
        }
        for (const pageNumber of Object.keys(values.pageOverrides).map(Number)) {
            const brandedPageNumber = requirePageNumber(pageNumber);
            setScanCleanupPageOverride(
                values.pageOverrides,
                brandedPageNumber,
                getScanCleanupPageOverride(values.pageOverrides, brandedPageNumber),
                values.marginsMm,
            );
        }
    }

    function setMarginsLinked(linked: boolean) {
        marginsLinked.value = linked;
        if (linked && !scanCleanupMarginsUniform(values.marginsMm)) {
            updateMargin('all', values.marginsMm.topMm);
        }
    }

    function resetPageOverrides() {
        overridesReset = true;
        overrideIntents.clear();
        defaultsIntent = {};
        documentIntents.add('overrides');
        documentIntents.add('pageOverrideDefaults');
        values.pageOverrides = {};
        values.pageOverrideDefaults = createScanCleanupPageOverride();
        attachScanCleanupPageOverrideDefaults(
            values.pageOverrides,
            values.pageOverrideDefaults,
            values.marginsMm,
        );
        scheduleDocumentPersistence(sourceSha256.value, legacyDocumentKey.value, {
            overrides: values.pageOverrides,
            pageOverrideDefaults: values.pageOverrideDefaults,
            resetOverrides: true,
        });
    }

    async function finishDocumentLoad(generation: number) {
        await nextTick();
        if (generation === documentLoadGeneration) {
            loadingDocument.value = false;
            applyingDocumentSettings = false;
        }
    }

    function applyDocumentSettings(
        generation: number,
        persistenceToken: ReturnType<typeof captureScanCleanupDocumentPersistenceToken>,
        lifecycleKey: string | null,
        sourceSha256: string | null,
        legacyDocumentKey: string | null,
        snapshot: IScanCleanupDocumentSettingsSnapshot,
    ) {
        if (generation !== documentLoadGeneration || !isScanCleanupDocumentPersistenceTokenCurrent(persistenceToken)) {
            return;
        }
        if (lifecycleKey !== options.documentLifecycleKey.value) {
            void finishDocumentLoad(generation);
            return;
        }
        applyingDocumentSettings = true;
        const overrides = overridesReset ? {} : snapshot.overrides;
        for (const [
            page,
            intent,
        ] of overrideIntents) {
            if (intent === null) {
                Reflect.deleteProperty(overrides, page);
            } else {
                overrides[page] = createScanCleanupPageOverride({
                    ...overrides[page],
                    ...intent,
                });
            }
        }
        values.pageOverrides = overrides;
        values.pageOverrideDefaults = createScanCleanupPageOverride({
            ...(overridesReset ? {} : snapshot.pageOverrideDefaults),
            ...defaultsIntent,
        });
        const persistedOutputMode = snapshot.outputMode;
        if (!documentIntents.has('outputMode')) values.outputMode = persistedOutputMode === 'mixed'
            ? DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE : persistedOutputMode;
        if (persistedOutputMode === 'mixed' && !documentIntents.has('outputMode')) {
            void Promise.resolve(saveScanCleanupDocumentPreferencesInStore(
                sourceSha256,
                legacyDocumentKey,
                {outputMode: DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE},
            )).catch(() => undefined);
        }
        Object.assign(values.marginsMm, snapshot.marginsMm ?? preferences.marginsMm, marginIntent);
        attachScanCleanupPageOverrideDefaults(
            values.pageOverrides,
            values.pageOverrideDefaults,
            values.marginsMm,
        );
        marginsLinked.value = scanCleanupMarginsUniform(values.marginsMm);
        documentSettingsReady.value = true;
        const patch: IScanCleanupDocumentPreferencePatch = {};
        if (documentIntents.has('overrides')) patch.overrides = values.pageOverrides;
        if (documentIntents.has('pageOverrideDefaults')) patch.pageOverrideDefaults = values.pageOverrideDefaults;
        if (documentIntents.has('marginsMm')) patch.marginsMm = values.marginsMm;
        if (documentIntents.has('outputMode')) patch.outputMode = values.outputMode;
        if (overridesReset) patch.resetOverrides = true;
        if (Object.keys(patch).length > 0) scheduleDocumentPersistence(sourceSha256, legacyDocumentKey, patch);
        void finishDocumentLoad(generation);
    }

    function loadDocumentSettingsForCurrentSource(retry = false) {
        const generation = ++documentLoadGeneration;
        const lifecycleKey = options.documentLifecycleKey.value;
        const currentSourceSha256 = sourceSha256.value;
        const currentLegacyDocumentKey = legacyDocumentKey.value;
        const sourceWasPromoted = previousDocumentContext !== null
            && previousDocumentContext.documentRevision === documentRevision.value
            && previousDocumentContext.legacyDocumentKey === currentLegacyDocumentKey
            && previousDocumentContext.sourceSha256 === null
            && isScanCleanupSourceSha256(currentSourceSha256);
        const previousUnresolvedLegacyDocumentKey = !sourceWasPromoted && !retry
            && previousDocumentContext?.sourceSha256 === null
            ? previousDocumentContext.legacyDocumentKey
            : undefined;
        const persistenceFlush = flushPersistence();
        if (!sourceWasPromoted && !retry) {
            documentIntents.clear();
            marginIntent = {};
            defaultsIntent = {};
            overrideIntents.clear();
            overridesReset = false;
            if (previousDocumentContext !== null) {
                applyingDocumentSettings = true;
                values.pageOverrides = {};
                values.pageOverrideDefaults = createScanCleanupPageOverride();
                values.outputMode = DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE;
                Object.assign(values.marginsMm, preferences.marginsMm);
                void nextTick(() => {
                    if (generation === documentLoadGeneration) applyingDocumentSettings = false;
                });
            }
        }
        previousDocumentContext = {
            documentRevision: documentRevision.value,
            sourceSha256: isScanCleanupSourceSha256(currentSourceSha256) ? currentSourceSha256.toLowerCase() : null,
            legacyDocumentKey: currentLegacyDocumentKey,
        };
        documentSettingsReady.value = false;
        documentSettingsLoadFailure.value = null;
        void persistenceFlush
            .finally(() => {
                if (previousUnresolvedLegacyDocumentKey !== undefined) {
                    invalidateScanCleanupDocumentPersistence(
                        null,
                        previousUnresolvedLegacyDocumentKey,
                    );
                }
            })
            .catch(() => undefined);
        loadingDocument.value = true;
        const persistenceToken = captureScanCleanupDocumentPersistenceToken(currentSourceSha256, currentLegacyDocumentKey);
        const snapshot = retry
            ? retryScanCleanupPreferences().then(() => loadScanCleanupDocumentSettings(currentSourceSha256, currentLegacyDocumentKey))
            : loadScanCleanupDocumentSettings(currentSourceSha256, currentLegacyDocumentKey);
        if (!(snapshot instanceof Promise)) {
            applyDocumentSettings(
                generation,
                persistenceToken,
                lifecycleKey,
                currentSourceSha256,
                currentLegacyDocumentKey,
                snapshot,
            );
            return;
        }
        void snapshot
            .then(resolvedSnapshot => applyDocumentSettings(
                generation,
                persistenceToken,
                lifecycleKey,
                currentSourceSha256,
                currentLegacyDocumentKey,
                resolvedSnapshot,
            ))
            .catch(error => {
                if (generation === documentLoadGeneration) {
                    documentSettingsReady.value = false;
                    const existingFailure = getFailureReceipt(error);
                    documentSettingsLoadFailure.value = {
                        ...(existingFailure ? {failure: existingFailure} : initializeRendererFailureReporter().captureForPresentation({
                            code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED',
                            context: {},
                            local: {
                                source: 'scan-cleanup',
                                message: 'Failed to load document settings',
                                cause: error,
                            },
                        }, {localAlreadyRecorded: true})),
                        title: t('errors.settings.load'),
                        actions: [{
                            label: t('common.retry'),
                            onClick: () => loadDocumentSettingsForCurrentSource(true),
                        }],
                    };
                    void finishDocumentLoad(generation);
                }
            });
    }
    watch(options.documentLifecycleKey, () => {
        loadDocumentSettingsForCurrentSource();
    }, {immediate: true});
    watch(() => cloneScanCleanupPreferenceValue(values.pageOverrides), (overrides, previous) => {
        if (applyingDocumentSettings) {
            return;
        }
        documentIntents.add('overrides');
        for (const page of new Set([
            ...Object.keys(overrides),
            ...Object.keys(previous),
        ])) {
            const current = overrides[page];
            if (current === undefined) {
                overrideIntents.set(page, null);
            } else {
                const intent = overrideIntents.get(page) ?? {};
                recordEditedFields(intent, current, previous[page] ?? createScanCleanupPageOverride());
                if (Object.keys(intent).length > 0) overrideIntents.set(page, intent);
            }
        }
        scheduleDocumentPersistence(sourceSha256.value, legacyDocumentKey.value, {overrides});
    });
    watch(() => cloneScanCleanupPreferenceValue(values.pageOverrideDefaults), (pageOverrideDefaults, previous) => {
        attachScanCleanupPageOverrideDefaults(
            values.pageOverrides,
            pageOverrideDefaults,
            values.marginsMm,
        );
        if (applyingDocumentSettings) {
            return;
        }
        documentIntents.add('pageOverrideDefaults');
        recordEditedFields(defaultsIntent, pageOverrideDefaults ?? createScanCleanupPageOverride(), previous ?? createScanCleanupPageOverride());
        scheduleDocumentPersistence(
            sourceSha256.value,
            legacyDocumentKey.value,
            pageOverrideDefaults === undefined ? {} : {pageOverrideDefaults},
        );
    });
    watch(() => ({...values.marginsMm}), (marginsMm, previous) => {
        if (applyingDocumentSettings) {
            return;
        }
        documentIntents.add('marginsMm');
        recordEditedFields(marginIntent, marginsMm, previous);
        if (documentSettingsReady.value) Object.assign(preferences.marginsMm, marginsMm);
        scheduleDocumentPersistence(sourceSha256.value, legacyDocumentKey.value, {marginsMm});
    });
    watch(() => values.outputMode, outputMode => {
        if (applyingDocumentSettings) {
            return;
        }
        documentIntents.add('outputMode');
        scheduleDocumentPersistence(sourceSha256.value, legacyDocumentKey.value, {outputMode});
    });

    return {
        alignmentItems,
        dismissFirstRunGuidance,
        documentSettingsReady,
        documentSettingsLoadFailure,
        handleThicknessInput,
        layoutItems,
        loadingDocument: computed(() => loadingDocument.value),
        marginsLinked,
        outputItems,
        readingOrderItems,
        resetPageOverrides,
        setMarginsLinked,
        showFirstRunGuidance,
        thicknessLabel,
        updateMargin,
        values,
    };
};
