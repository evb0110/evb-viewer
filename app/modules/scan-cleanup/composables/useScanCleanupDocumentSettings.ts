import type {
    IScanCleanupOptions,
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
import type {IScanCleanupDocumentPreferencePatch} from '@contracts/scanCleanupSettings';
import {
    flushScanCleanupPreferencesStore,
    flushScanCleanupDocumentPreferencesStore,
    getScanCleanupPreferencesStore,
    loadScanCleanupDocumentSettings,
    saveScanCleanupDocumentPreferencesInStore,
    scheduleScanCleanupDocumentPreferencesInStore,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';
import type {IScanCleanupDocumentSettingsSnapshot} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';
import {
    resolveScanCleanupMarginPatch,
    scanCleanupMarginsUniform,
    type TScanCleanupMarginTarget,
} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';

interface IUseScanCleanupDocumentSettingsOptions {
    documentLifecycleKey: ComputedRef<string | null>;
    sourceSha256?: ComputedRef<string | null>;
    legacyDocumentKey?: ComputedRef<string | null>;
    preferenceDocumentKey?: ComputedRef<string | null>;
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
    const preferences = getScanCleanupPreferencesStore({
        sourceSha256: sourceSha256.value,
        legacyDocumentKey: legacyDocumentKey.value,
    });
    const loadingDocument = ref(false);
    let documentLoadGeneration = 0;
    let applyingDocumentSettings = false;
    const documentSettingsReady = ref(false);
    const documentIntents = new Set<'overrides' | 'pageOverrideDefaults' | 'marginsMm' | 'outputMode'>();

    function scheduleDocumentPersistence(
        sourceSha256: string | null | undefined,
        legacyDocumentKey: string | null | undefined,
        patch: IScanCleanupDocumentPreferencePatch,
    ) {
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
        window.addEventListener('beforeunload', handleWindowLifecycle);
        window.addEventListener('pagehide', handleWindowLifecycle);
    }
    tryOnScopeDispose(() => {
        void flushPersistence().catch(() => undefined);
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', handleWindowLifecycle);
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
        Object.assign(values.marginsMm, resolveScanCleanupMarginPatch(
            marginsLinked.value ? 'all' : target,
            value,
        ));
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
        lifecycleKey: string | null,
        sourceSha256: string | null,
        legacyDocumentKey: string | null,
        snapshot: IScanCleanupDocumentSettingsSnapshot,
    ) {
        if (generation !== documentLoadGeneration) {
            return;
        }
        if (lifecycleKey !== options.documentLifecycleKey.value) {
            void finishDocumentLoad(generation);
            return;
        }
        applyingDocumentSettings = true;
        if (!documentIntents.has('overrides')) values.pageOverrides = snapshot.overrides;
        if (!documentIntents.has('pageOverrideDefaults')) {
            values.pageOverrideDefaults = snapshot.pageOverrideDefaults ?? createScanCleanupPageOverride();
        }
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
        if (!documentIntents.has('marginsMm')) Object.assign(values.marginsMm, snapshot.marginsMm ?? preferences.marginsMm);
        attachScanCleanupPageOverrideDefaults(
            values.pageOverrides,
            values.pageOverrideDefaults,
            values.marginsMm,
        );
        marginsLinked.value = scanCleanupMarginsUniform(values.marginsMm);
        documentSettingsReady.value = true;
        void finishDocumentLoad(generation);
    }

    function loadDocumentSettingsForCurrentSource() {
        const generation = ++documentLoadGeneration;
        documentIntents.clear();
        documentSettingsReady.value = false;
        const lifecycleKey = options.documentLifecycleKey.value;
        void flushPersistence().catch(() => undefined);
        const currentSourceSha256 = sourceSha256.value;
        const currentLegacyDocumentKey = legacyDocumentKey.value;
        loadingDocument.value = true;
        const snapshot = loadScanCleanupDocumentSettings(currentSourceSha256, currentLegacyDocumentKey);
        if (!(snapshot instanceof Promise)) {
            applyDocumentSettings(
                generation,
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
                lifecycleKey,
                currentSourceSha256,
                currentLegacyDocumentKey,
                resolvedSnapshot,
            ))
            .catch(() => {
                if (generation === documentLoadGeneration) {
                    documentSettingsReady.value = false;
                    void finishDocumentLoad(generation);
                }
            });
    }
    watch(options.documentLifecycleKey, () => {
        void loadDocumentSettingsForCurrentSource();
    }, {immediate: true});
    watch(() => values.pageOverrides, overrides => {
        if (applyingDocumentSettings) {
            return;
        }
        documentIntents.add('overrides');
        scheduleDocumentPersistence(sourceSha256.value, legacyDocumentKey.value, {overrides});
    }, {deep: true});
    watch(() => values.pageOverrideDefaults, pageOverrideDefaults => {
        attachScanCleanupPageOverrideDefaults(
            values.pageOverrides,
            pageOverrideDefaults,
            values.marginsMm,
        );
        if (applyingDocumentSettings) {
            return;
        }
        documentIntents.add('pageOverrideDefaults');
        scheduleDocumentPersistence(
            sourceSha256.value,
            legacyDocumentKey.value,
            pageOverrideDefaults === undefined ? {} : {pageOverrideDefaults},
        );
    }, {deep: true});
    watch(() => values.marginsMm, marginsMm => {
        if (applyingDocumentSettings) {
            return;
        }
        documentIntents.add('marginsMm');
        Object.assign(preferences.marginsMm, marginsMm);
        scheduleDocumentPersistence(sourceSha256.value, legacyDocumentKey.value, {marginsMm});
    }, {deep: true});
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
