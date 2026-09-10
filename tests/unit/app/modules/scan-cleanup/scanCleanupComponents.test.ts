// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    computed,
    defineComponent,
    h,
    nextTick,
    reactive,
    ref,
    shallowRef,
    type Ref,
} from 'vue';
import type {
    IScanCleanupManualZones,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupPreviewRequest,
    IScanCleanupRawPreviewResult,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
    TScanCleanupPageAlignment,
    TScanCleanupPageLayoutOverride,
} from '@contracts/electronApiScanCleanup';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import {updateScanCleanupPageOverrides} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import ScanCleanupPreviewPane from '@app/modules/scan-cleanup/components/preview/PreviewShell.vue';
import CleanedCanvas from '@app/modules/scan-cleanup/components/preview/CleanedCanvas.vue';
import ZoneEditorOverlay from '@app/modules/scan-cleanup/components/preview/ZoneEditorOverlay.vue';
import ScanCleanupToolbar from '@app/modules/scan-cleanup/components/ScanCleanupToolbar.vue';
import ScanCleanupWorkspace from '@app/modules/scan-cleanup/components/ScanCleanupWorkspace.vue';
import ScanCleanupAutoValueRow from '@app/modules/scan-cleanup/components/settings/ScanCleanupAutoValueRow.vue';
import ScanCleanupSettingsPanel from '@app/modules/scan-cleanup/components/settings/ScanCleanupSettingsPanel.vue';
import ToolbarOverflowMenu from '@app/components/toolbar/ToolbarOverflowMenu.vue';
import {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import {resetScanCleanupPreferencesStore} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';
import type {IScanCleanupTabSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';

const workspaceSession = vi.hoisted(() => ({value: null as Record<string, unknown> | null}));
const workspaceSessionOptions = vi.hoisted(() => ({value: null as Record<string, () => unknown> | null}));
const workspaceSessionInitial = vi.hoisted(() => ({value: null as {
    page: unknown;
    viewMode: unknown;
} | null}));

vi.mock('@app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession', () => ({useScanCleanupWorkspaceSession: (
    options: Record<string, () => unknown>,
) => {
    workspaceSessionOptions.value = options;
    workspaceSessionInitial.value = {
        page: options.initialPreviewPage?.(),
        viewMode: options.initialPreviewViewMode?.(),
    };
    const session = workspaceSession.value!;
    return {
        settings: {
            alignmentItems: session.alignmentItems,
            dismissFirstRunGuidance: session.dismissFirstRunGuidance,
            handleThicknessInput: session.handleThicknessInput,
            layoutItems: session.layoutItems,
            marginsLinked: session.documentMarginsLinked ?? ref(true),
            setMarginsLinked: session.setDocumentMarginsLinked ?? vi.fn(),
            outputItems: session.outputItems,
            readingOrderItems: session.readingOrderItems,
            resetPageOverrides: session.resetPageOverrides,
            showFirstRunGuidance: session.showFirstRunGuidance,
            thicknessLabel: session.thicknessLabel,
            updateMargin: session.updateDocumentMargin ?? vi.fn(),
            values: session.settings,
        },
        selection: {
            applyLeaderOverrides: session.applyLeaderOverrides,
            contentBoxes: session.selectionContentBoxes,
            currentPageOverride: session.currentPageOverride,
            excluded: session.selectionExcluded,
            highlightedScope: session.highlightedScope ?? ref(null),
            layoutOverride: session.selectionLayoutOverride,
            leader: session.selectionLeader,
            margins: session.selectionMargins ?? ref({
                empty: false,
                mixed: false,
                value: {
                    leftMm: 5,
                    topMm: 5,
                    rightMm: 5,
                    bottomMm: 5,
                },
            }),
            marginsLinked: session.selectionMarginsLinked ?? ref(true),
            setMarginsLinked: session.setSelectionMarginsLinked ?? vi.fn(),
            manualSplit: session.selectionManualSplit,
            outputModeOverride: session.selectionOutputModeOverride ?? ref({
                empty: false,
                mixed: false,
                value: undefined,
            }),
            hasMarginOverrides: session.hasSelectionMarginOverrides ?? ref(false),
            placementAlignment: session.selectionPlacementAlignment,
            resetContentBoxes: session.resetSelectionContentBoxes,
            resetControlOverride: session.resetControlOverride ?? vi.fn(),
            resetManualSplit: session.resetSelectionManualSplit,
            resetMargins: session.resetSelectionMargins ?? vi.fn(),
            resetOverrides: session.resetScopeOverrides ?? vi.fn(),
            rotation: session.selectionRotation,
            selectedPages: session.selectedPages,
            selectPage: session.selectPage,
            setSettingsScope: session.setSettingsScope ?? vi.fn(),
            settingsScope: session.settingsScope ?? ref('all'),
            updateCurrentManualContentBox: session.updateCurrentManualContentBox,
            updateCurrentManualSplit: session.updateCurrentManualSplit,
            updateCurrentPlacement: session.updateCurrentPlacement,
            updateCurrentPlacementAll: session.updateCurrentPlacementAll,
            updateExcluded: session.updateSelectionExcluded,
            updateLayoutOverride: session.updateSelectionLayoutOverride,
            updateMargins: session.updateSelectionMargins ?? vi.fn(),
            updateOutputModeOverride: session.updateSelectionOutputModeOverride ?? vi.fn(),
            updatePageOverride: session.updatePageOverride,
            updatePlacement: session.updateSelectionPlacement,
            updateRotation: session.updateSelectionRotation,
        },
        detection: {
            authoritativeLayoutByPage: session.authoritativeLayoutByPage,
            blankPageCount: session.blankPageCount ?? computed(() => 0),
            canDetectAll: session.canDetectAll,
            cancel: session.cancelDetection,
            cancelRequested: session.detectionCancelRequested,
            confidenceByPage: session.detectedLayoutConfidenceByPage,
            detectAllPages: session.detectAllPages,
            error: session.detectionError,
            outputEstimate: session.outputEstimate,
            pending: session.detectionPending,
            progress: session.detectionProgress,
            progressCountText: session.detectionProgressCountText ?? ref(''),
            progressCountWidestText: session.detectionProgressCountWidestText ?? ref(''),
            progressEtaText: session.detectionProgressEtaText ?? ref(''),
            progressEtaWidestText: session.detectionProgressEtaWidestText ?? ref(''),
            progressPercent: session.detectionProgressPercent ?? computed(() => {
                const progress = (session.detectionProgress as {value: {
                    completedUnits: number;
                    totalUnits: number
                }}).value;
                return progress.totalUnits === 0
                    ? 0
                    : progress.completedUnits / progress.totalUnits * 100;
            }),
            progressPhaseText: session.detectionProgressPhaseText ?? ref('Pre-analyzing pages'),
            progressText: session.detectionProgressText ?? computed(() => {
                const progress = (session.detectionProgress as {value: {
                    completedUnits: number;
                    totalUnits: number
                }}).value;
                return `Analyzing ${String(progress.completedUnits)} / ${String(progress.totalUnits)}`;
            }),
            progressWidestText: session.detectionProgressWidestText ?? computed(() => {
                const progress = (session.detectionProgress as {value: {totalUnits: number}}).value;
                return `Analyzing ${String(progress.totalUnits)} / ${String(progress.totalUnits)}`;
            }),
            settledPages: session.detectionSettledPages ?? reactive(new Set()),
            recommendedOutputModeByPage: session.recommendedOutputModeByPage ?? reactive(new Map()),
            recommendedOutputModeConfidenceByPage: session.recommendedOutputModeConfidenceByPage ?? reactive(new Map()),
            recommendedOutputModeReasonByPage: session.recommendedOutputModeReasonByPage ?? reactive(new Map()),
            textAxisByPage: session.detectedTextAxisByPage ?? reactive(new Map()),
        },
        preview: {
            error: session.previewError,
            loading: session.previewLoading,
            navigate: session.navigatePreview,
            rawResult: session.previewRawResult ?? ref(null),
            result: session.previewResult,
            resultCurrent: session.previewResultCurrent ?? computed(() => true),
            resultPresentationKey: session.previewResultPresentationKey ?? computed(() => ''),
            metadataByPage: session.previewMetadataByPage ?? reactive(new Map()),
            retry: session.retryPreview,
            totalPages: session.previewTotalPages,
            viewMode: session.previewViewMode,
        },
        run: {
            cancel: session.cancel,
            cancelRequested: session.cancelRequested,
            canRun: session.canRun,
            inlineError: session.inlineError,
            isRunning: session.isRunning,
            ownerId: session.ownerId,
            processedPages: session.processedPages,
            progress: session.jobProgress,
            progressCountText: session.progressCountText ?? ref(''),
            progressCountWidestText: session.progressCountWidestText ?? ref('392 / 392'),
            progressEtaText: session.progressEtaText ?? ref(''),
            progressEtaWidestText: session.progressEtaWidestText ?? ref(''),
            progressPhaseText: session.progressPhaseText ?? session.progressText,
            progressText: session.progressText,
            runLabel: session.runLabel ?? ref('Clean up'),
            runDisabledReason: session.runDisabledReason ?? ref(''),
            run: session.run,
            transitionText: session.transitionText ?? ref(''),
            waitingForDetection: session.waitingForDetection ?? computed(() => false),
        },
    };
}}));

const translations: Record<string, string> = {
    'scanCleanup.pages.title': 'Source pages',
    'scanCleanup.pages.classification.single': 'Single',
    'scanCleanup.pages.classification.spread': 'Spread',
    'scanCleanup.pages.classification.offcut': 'Offcut',
    'scanCleanup.pages.includeInOutput': 'Include in output',
    'scanCleanup.pages.excludedFromOutput': 'Excluded from output',
    'scanCleanup.pages.excludedBadge': 'Excluded',
    'scanCleanup.preview.unavailable': 'Preview isn\'t available. You can still run cleanup.',
    'scanCleanup.preview.retry': 'Retry',
    'scanCleanup.preview.technicalDetails': 'Technical details',
    'scanCleanup.preview.loadingPage': 'Loading page {page}…',
    'scanCleanup.preview.loading': 'Building cleanup preview…',
    'scanCleanup.preview.cleanedAlt': 'Cleaned scan preview for page {page}, {half}',
    'scanCleanup.preview.originalAlt': 'Original scan preview for page {page}',
    'scanCleanup.preview.cleaningPage': 'Cleaning page {page}… showing the original scan',
    'scanCleanup.preview.cleaningAlt': 'Original scan of page {page}, shown while cleanup is still running',
    'scanCleanup.preview.outputHalf.left': 'left half',
    'scanCleanup.preview.outputHalf.right': 'right half',
    'scanCleanup.preview.outputHalf.full': 'full page',
    'scanCleanup.preview.preview': 'Preview',
    'scanCleanup.preview.zoomControls': 'Preview zoom',
    'scanCleanup.preview.zoomIn': 'Zoom in',
    'scanCleanup.preview.zoomOut': 'Zoom out',
    'scanCleanup.preview.zoomFit': 'Fit',
    'scanCleanup.preview.zoomValue': '{zoom}%',
    'scanCleanup.preview.fitPage': 'Fit whole page in view',
    'scanCleanup.preview.legend': 'Preview overlay legend',
    'scanCleanup.preview.toggleZoom': 'Zoom {zoom}, toggle fit and 100%',
    'scanCleanup.output.label': 'Output mode',
    'scanCleanup.output.pageLabel': 'Output mode for pages',
    'scanCleanup.output.auto': 'Auto',
    'scanCleanup.output.bw': 'Black and white',
    'scanCleanup.output.grayscale': 'Grayscale',
    'scanCleanup.output.color': 'Color',
    'scanCleanup.output.mixed': 'Text + pictures',
    'scanCleanup.output.preserveOriginalQuality': 'Preserve original quality (no rasterization)',
    'scanCleanup.output.losslessDisabledOptions': 'Raster cleanup options are unavailable in this mode.',
    'scanCleanup.pages.outputModeFollowDocument': 'Follow document setting',
    'scanCleanup.pages.outputModeLosslessControlHint': 'Per-page output mode is unavailable because preserving original quality forces color.',
    'scanCleanup.imageOnly': 'Output is image-only —',
    'scanCleanup.rasterNotice': 'Pages are rasterized.',
    'scanCleanup.lossNotice': 'Original PDF objects are not carried over.',
    'scanCleanup.workspaceTitle': 'Scan cleanup',
    'scanCleanup.button': 'Scan cleanup',
    'scanCleanup.description': 'Clean scanned pages.',
    'scanCleanup.done': 'Done',
    'scanCleanup.settings.scope.label': 'Settings scope',
    'scanCleanup.settings.scope.all': 'All {count} pages',
    'scanCleanup.settings.scope.page': 'This page (p. {page})',
    'scanCleanup.settings.scope.selected': 'Selected: {count} pages',
    'scanCleanup.settings.scope.customized': '{count} customized',
    'scanCleanup.settings.scope.pageCustomized': 'This page has custom settings',
    'scanCleanup.settings.applyThisPageTo': 'Copy this page\'s settings to…',
    'scanCleanup.settings.applyThisPageToHint': 'Choose “This page” above to copy its settings.',
    'scanCleanup.settings.layoutOverride': 'Page layout override',
    'scanCleanup.settings.rotation': 'Rotation',
    'scanCleanup.settings.rotationDegrees': '{value}°',
    'scanCleanup.settings.inOutput': 'Output inclusion',
    'scanCleanup.settings.mixed': '— Mixed',
    'scanCleanup.settings.override': 'Override',
    'scanCleanup.settings.resetToDocument': 'Reset to document',
    'scanCleanup.settings.overrideCount': '{count} pages override this',
    'scanCleanup.settings.manualSplit': 'Spread cutter',
    'scanCleanup.settings.contentBox': 'Content box',
    'scanCleanup.settings.reset': 'Reset',
    'scanCleanup.settings.automatic': 'Automatic',
    'scanCleanup.preview.page': 'Page {page} of {total}',
    'scanCleanup.settings.manualSkew': 'Deskew angle ({min}° to {max}°)',
    'scanCleanup.thickness.label': 'Text thickness ({value})',
    'scanCleanup.thickness.control': 'Text thickness',

    'scanCleanup.settings.manual': 'Manual',
    'scanCleanup.settings.returnToAutomatic': 'Return to automatic',
    'scanCleanup.settings.selectionAlignment': 'Content placement for selected pages',
    'scanCleanup.settings.contentPlacement': 'Content placement',
    'scanCleanup.settings.enableMatchPageSize': 'Enable match page size',
    'scanCleanup.settings.resetScope.all': 'Reset all overrides…',
    'scanCleanup.settings.resetScope.page': 'Reset this page…',
    'scanCleanup.settings.resetScope.selected': 'Reset selected pages…',
    'scanCleanup.settings.resetScope.confirm': 'Reset matching page overrides?',
    'scanCleanup.settings.resetScope.allBody': 'Clear all overrides',
    'scanCleanup.settings.resetScope.pageBody': 'Clear page {page}',
    'scanCleanup.settings.resetScope.selectedBody': 'Clear {count} selected pages',
    'scanCleanup.settings.applyScopes.allPages': 'All pages',
    'scanCleanup.settings.applyScopes.menuLabel': 'Copy to',
    'scanCleanup.settings.applyScopes.fromHere': 'From this page on',
    'scanCleanup.settings.applyScopes.selectedPages': 'Selected pages',
    'scanCleanup.settings.applyScopes.everyOther': 'Every other page',
    'scanCleanup.groups.pageSettings': 'Page settings',
    'scanCleanup.groups.documentSettings': 'Document settings',
    'scanCleanup.crop.blankDetected': '{count} pages look blank',
    'scanCleanup.layout.label': 'Page layout',
    'scanCleanup.margins.title': 'Margins',
    'scanCleanup.margins.left': 'Left (mm)',
    'scanCleanup.margins.top': 'Top (mm)',
    'scanCleanup.margins.right': 'Right (mm)',
    'scanCleanup.margins.bottom': 'Bottom (mm)',
    'scanCleanup.margins.link': 'Link margins',
    'scanCleanup.margins.linkTooltip': 'Change all four margins together',
    'scanCleanup.margins.resetToDocument': 'Reset to document settings',
    'common.cancel': 'Cancel',
    'menu.file': 'File',
    'menu.edit': 'Edit',
    'menu.view': 'View',
    'toolbar.annotations': 'Tools',
    'toolbar.moreTools': 'More tools',
    'assistant.toggle': 'Assistant',
    'scanCleanup.cleanUp': 'Clean up',
    'scanCleanup.detectAll.action': 'Detect layout for all pages',
    'scanCleanup.detectAll.redetect': 'Re-detect',
    'scanCleanup.detectAll.preAnalyzing': 'Pre-analyzing pages',
    'scanCleanup.detectAll.progressAria': 'Detecting layout: {detected} of {total} pages',
    'scanCleanup.detectAll.cancelDetection': 'Stop detecting pages — pages already detected keep their results',
    'scanCleanup.detectAll.canceling': 'Canceling…',
    'scanCleanup.pages.resetAll': 'Reset overrides…',
    'scanCleanup.pages.resetConfirm': 'Reset all page overrides?',
    'scanCleanup.pages.resetConfirmBody': 'Clear overrides',
    'scanCleanup.pages.resetAction': 'Reset',
    'scanCleanup.runStatusLabel': 'Cleanup progress',
    'scanCleanup.runStep': 'Step {index} of {count}',
    'scanCleanup.progressPhases.label': 'Cleanup phases',
    'scanCleanup.progressPhases.analyze': 'Analyze pages',
    'scanCleanup.progressPhases.clean': 'Clean pages',
    'scanCleanup.progressPhases.finish': 'Finish PDF',
    'scanCleanup.etaPending': 'Calculating time for current task…',
    'scanCleanup.etaMinutes': 'Current task: about {minutes} min',
    'scanCleanup.etaSeconds': 'Current task: about {seconds} sec',
    'scanCleanup.finishingPhase': 'Finishing current task…',
    'scanCleanup.almostDone': 'Almost done',
    'scanCleanup.cancelingDetection': 'Stopping background analysis…',
    'scanCleanup.runProgress.rasterizing': 'Preparing cleanup pages',
    'scanCleanup.firstRun.title': 'How scan cleanup works',
    'scanCleanup.firstRun.detect': 'Pages are detected automatically.',
    'scanCleanup.firstRun.review': 'Review pages — drag the cutter or boxes, and adjust per-page settings.',
    'scanCleanup.firstRun.cleanUp': 'Clean up creates a new PDF; the original is untouched.',
    'scanCleanup.firstRun.dismiss': 'Got it',
    'scanCleanup.zones.toggle': 'Edit picture and fill zones',
    'scanCleanup.zones.useMixedOutput': 'Use mixed output',
    'common.close': 'Close',
};

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (
        key: string,
        parameters?: Record<string, string | number>,
    ) => Object.entries(parameters ?? {}).reduce(
        (value, [
            parameter,
            replacement,
        ]) => value.replace(`{${parameter}}`, String(replacement)),
        translations[key] ?? key,
    )}),
}));

const ButtonStub = defineComponent({
    inheritAttrs: false,
    props: {
        disabled: Boolean,
        icon: {
            type: String,
            default: '',
        },
        label: {
            type: String,
            default: '',
        },
    },
    setup(props, {
        attrs,
        slots,
    }) {
        return () => h('button', {
            ...attrs,
            disabled: props.disabled,
            type: 'button',
        }, [
            props.icon ? h('span', {'data-icon': props.icon}) : null,
            ...(slots.default?.() ?? []),
            props.label,
        ]);
    },
});
const SelectStub = defineComponent({
    inheritAttrs: false,
    props: {
        items: {
            type: Array,
            default: () => [],
        },
        modelValue: {
            type: [
                String,
                Number,
            ],
            default: '',
        },
    },
    emits: ['update:modelValue'],
    setup: (props, {
        attrs,
        emit,
    }) => () => h('select', {
        ...attrs,
        'data-ui-select': '',
        value: props.modelValue,
        onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
    }, (props.items as Array<{
        label: string;
        value: string | number;
    }>).map(item => h('option', {value: item.value}, item.label))),
});
const InputStub = defineComponent({
    inheritAttrs: false,
    props: {modelValue: {
        type: [
            String,
            Number,
        ],
        default: '',
    }},
    emits: ['update:modelValue'],
    setup: (props, {
        attrs,
        emit,
    }) => () => h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
    }),
});
const InputNumberStub = defineComponent({
    inheritAttrs: false,
    props: {modelValue: {
        type: Number,
        default: undefined,
    }},
    emits: ['update:modelValue'],
    setup: (props, {
        attrs,
        emit,
    }) => () => h('input', {
        ...attrs,
        value: props.modelValue ?? '',
        onInput: (event: Event) => {
            const parsed = Number((event.target as HTMLInputElement).value);
            emit('update:modelValue', Number.isFinite(parsed) ? parsed : undefined);
        },
    }),
});
const SlotStub = defineComponent({setup: (_props, {slots}) => () => h('span', slots.default?.())});
const TooltipStub = defineComponent({
    inheritAttrs: false,
    props: {
        disabled: Boolean,
        text: {
            type: String,
            default: '',
        },
    },
    setup: (
        props,
        {
            attrs,
            slots,
        },
    ) => () => h('span', {
        ...attrs,
        'data-tooltip-disabled': String(props.disabled),
        'data-tooltip-root': '',
    }, slots.default?.()),
});
const BadgeStub = defineComponent({setup: (_props, {slots}) => () => h('span', {'data-ui-badge': ''}, slots.default?.())});
const IconStub = defineComponent({setup: () => () => h('span', {'data-ui-icon': ''})});
const SkeletonStub = defineComponent({setup: () => () => h('span', {'data-ui-skeleton': ''})});
const PopoverStub = defineComponent({setup: (_props, {slots}) => () => h('span', [
    slots.default?.(),
    slots.content?.(),
])});
const CheckboxStub = defineComponent({
    inheritAttrs: false,
    props: {
        disabled: Boolean,
        label: {
            type: String,
            default: '',
        },
        modelValue: Boolean,
    },
    emits: ['update:modelValue'],
    setup: (props, {
        attrs,
        emit,
    }) => () => h('label', [
        h('input', {
            ...attrs,
            checked: props.modelValue,
            disabled: props.disabled,
            type: 'checkbox',
            onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).checked),
        }),
        props.label,
    ]),
});
const DropdownMenuStub = defineComponent({
    props: {items: {
        type: Array,
        default: () => [],
    }},
    setup: (props, {slots}) => () => h('div', [
        slots.default?.(),
        h('div', {role: 'menu'}, (props.items as Array<{
            class?: string;
            disabled?: boolean;
            label: string;
            onSelect?: () => void;
            slot?: string;
        }>).map(item => item.onSelect
            ? h('button', {
                class: item.class,
                disabled: item.disabled,
                role: 'menuitem',
                type: 'button',
                onClick: item.onSelect,
            }, [
                ...(item.slot ? slots[`${item.slot}-leading`]?.() ?? [] : []),
                item.label,
            ])
            : h('span', item.label))),
    ]),
});
const CollapsibleStub = defineComponent({
    props: {open: Boolean},
    setup: (props, {slots}) => () => h('div', [
        slots.default?.({open: props.open}),
        slots.content?.(),
    ]),
});
const TabsStub = defineComponent({
    props: {
        items: {
            type: Array,
            default: () => [],
        },
        modelValue: {
            type: String,
            default: '',
        },
    },
    emits: ['update:modelValue'],
    setup: (props, {emit}) => () => h('div', {role: 'tablist'}, (props.items as Array<{
        disabled?: boolean;
        label: string;
        title?: string;
        value: string;
    }>).map(item => h('button', {
        'aria-selected': item.value === props.modelValue,
        disabled: item.disabled,
        role: 'tab',
        title: item.title,
        type: 'button',
        onClick: () => emit('update:modelValue', item.value),
    }, item.label))),
});

const activeUnmounts = new Set<() => void>();

function rawPreviewResult(pageNumber: number): IScanCleanupRawPreviewResult {
    return {
        pageNumber: requirePageNumber(pageNumber),
        totalPages: 3,
        rawImageData: new Uint8Array([1]),
        rawWidthPx: 1000,
        rawHeightPx: 800,
    };
}

function spreadPreviewResult(pageNumber = 1): IScanCleanupPreviewResult {
    const output = (half: 'left' | 'right', x: number) => ({
        imageData: new Uint8Array([1]),
        metadata: {
            canvasScope: 'page' as const,
            half,
            layoutClassification: 'two-page-spread' as const,
            layoutConfidence: 0.82,
            sourceRegion: {
                xPx: x,
                yPx: 0,
                widthPx: 500,
                heightPx: 800,
            },
            contentBox: null,
            appliedMargins: {
                leftPx: 0,
                topPx: 0,
                rightPx: 0,
                bottomPx: 0,
            },
            outputWidthPx: 500,
            outputHeightPx: 800,
            canvasWidthPx: 500,
            canvasHeightPx: 800,
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
            forwardTransform: {matrix: [
                [
                    1,
                    0,
                    -x,
                ],
                [
                    0,
                    1,
                    0,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ]},
            cutterXPx: 500,
            inputWidthPx: 1000,
            inputHeightPx: 800,
            rotationDegrees: 0 as const,
            resamplePasses: 1,
            warnings: [],
        },
    });
    return {
        pageNumber: requirePageNumber(pageNumber),
        totalPages: 3,
        rawImageData: new Uint8Array([1]),
        rawWidthPx: 1000,
        rawHeightPx: 800,
        pageMetadata: {
            canvasScope: 'page',
            layoutClassification: 'two-page-spread',
            layoutConfidence: 0.9,
            cutterXPx: 500,
            rotationDegrees: 0,
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: 'two-page-spread',
            reconciled: false,
            clusterAgreement: 0,
        },
        outputs: [
            output('left', 0),
            output('right', 500),
        ],
    };
}

function rotatedSinglePreviewResult(): IScanCleanupPreviewResult {
    const result = spreadPreviewResult();
    const output = result.outputs[0]!;
    output.metadata = {
        ...output.metadata,
        half: 'full',
        sourceRegion: {
            xPx: 0,
            yPx: 0,
            widthPx: 400,
            heightPx: 1000,
        },
        outputWidthPx: 400,
        outputHeightPx: 1000,
        canvasWidthPx: 400,
        canvasHeightPx: 1000,
        inputWidthPx: 1000,
        inputHeightPx: 800,
        rotationDegrees: 90,
        forwardTransform: {matrix: [
            [
                1,
                0,
                0,
            ],
            [
                0,
                1,
                0,
            ],
            [
                0,
                0,
                1,
            ],
        ]},
    };
    return {
        ...result,
        pageMetadata: {
            ...result.pageMetadata,
            layoutClassification: 'single-uncut-page',
            rotationDegrees: 90,
        },
        outputs: [output],
    };
}

function previewPageSource(widthPoints: number, heightPoints: number): IDocumentPageSource {
    return {
        kind: 'pdf',
        documentRef: requireDocumentRef('/preview.pdf'),
        pageCount: 1,
        getPageMetrics: vi.fn(async () => ({
            widthPoints,
            heightPoints,
            rotation: 0 as const,
        })),
        renderPage: vi.fn(async () => ({
            widthPx: widthPoints,
            heightPx: heightPoints,
            bytes: widthPoints * heightPoints * 4,
            surface: 'data:image/png;base64,',
            release: vi.fn(),
        })),
        dispose: vi.fn(),
    };
}

function mount(component: Parameters<typeof createApp>[0]) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(component);
    app.component('AppTooltip', TooltipStub);
    app.component('UBadge', BadgeStub);
    app.component('UButton', ButtonStub);
    app.component('UCheckbox', CheckboxStub);
    app.component('UCollapsible', CollapsibleStub);
    app.component('UDropdownMenu', DropdownMenuStub);
    app.component('UFormField', SlotStub);
    app.component('UIcon', IconStub);
    app.component('UInput', InputStub);
    app.component('UInputNumber', InputNumberStub);
    app.component('UPopover', PopoverStub);
    app.component('UProgress', SlotStub);
    app.component('USelect', SelectStub);
    app.component('USkeleton', SkeletonStub);
    app.component('USlider', SlotStub);
    app.component('UTabs', TabsStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        host,
        unmount,
    };
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
    return {
        left,
        right: left + width,
        top,
        bottom: top + height,
        width,
        height,
        x: left,
        y: top,
        toJSON: () => ({}),
    };
}

async function loadPendingCleanedFrame(host: HTMLElement) {
    for (const image of host.querySelectorAll('.preview-cleaned-pixel-preload')) {
        image.dispatchEvent(new Event('load'));
    }
    await nextTick();
}

function previewZoomWheel(init: WheelEventInit) {
    const event = new WheelEvent('wheel', init);
    Object.defineProperty(event, 'metaKey', {value: true});
    return event;
}

function mockPointerCapture(element: HTMLElement) {
    const captured = new Set<number>();
    element.setPointerCapture = vi.fn(pointerId => captured.add(pointerId));
    element.hasPointerCapture = vi.fn(pointerId => captured.has(pointerId));
    element.releasePointerCapture = vi.fn(pointerId => captured.delete(pointerId));
    return {
        hasPointerCapture: element.hasPointerCapture,
        releasePointerCapture: element.releasePointerCapture,
        setPointerCapture: element.setPointerCapture,
    };
}

function mockPreviewGeometry(host: HTMLElement, canvasRects: DOMRect[]) {
    vi.spyOn(host.querySelector<HTMLElement>('.preview-surface')!, 'getBoundingClientRect')
        .mockReturnValue(domRect(0, 0, 1000, 800));
    vi.spyOn(host.querySelector<HTMLElement>('.cutter-stage')!, 'getBoundingClientRect')
        .mockReturnValue(domRect(0, 0, 1000, 800));
    host.querySelectorAll<HTMLElement>('.uniform-canvas').forEach((canvas, index) => {
        vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(canvasRects[index] ?? domRect(0, 0, 500, 800));
    });
}

const placementAlignments = [
    'top-left',
    'top-center',
    'top-right',
    'center-left',
    'center',
    'center-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
] as const satisfies readonly TScanCleanupPageAlignment[];

function settingsPanelProps(
    settings: Record<string, unknown>,
    scope: 'all' | 'page' | 'selected',
    overrides: Record<string, unknown> = {},
) {
    const single = <TValue>(value: TValue) => ({
        empty: false,
        mixed: false,
        value,
    });
    return {
        alignmentItems: [],
        applyScopeItems: [],
        blankPageCount: 0,
        contentBoxes: single({}),
        customizedCounts: {
            all: 0,
            page: 0,
            selected: 0,
        },
        detectedSkewDegrees: undefined,
        excluded: single(false),
        hasScopeOverrides: false,
        highlightedScope: null,
        inclusionItems: [],
        inlineError: '',
        layout: single('auto'),
        layoutItems: [],
        manualSplit: single(null),
        manualSkew: single(undefined),
        margins: single({
            leftMm: 0,
            topMm: 0,
            rightMm: 0,
            bottomMm: 0,
        }),
        marginsLinked: true,
        outputItems: [],
        outputModeOverride: single(undefined),
        outputModeOverrideItems: [],
        overrideCounts: {
            inclusion: 0,
            layout: 0,
            margins: 0,
            outputMode: 0,
            placement: 0,
            rotation: 0,
        },
        pageNumber: 1,
        placementAlignment: single('center'),
        readingOrderItems: [],
        rotation: single(0),
        rotationItems: [],
        scope,
        selectedCount: 1,
        settings,
        thicknessLabel: '0',
        totalPages: 392,
        ...overrides,
    } as never;
}

function mountPreviewZoomHarness(options: {
    canvasRect?: (index: number, scale: number, panX: number, panY: number) => DOMRect;
    detailResult?: IScanCleanupPreviewResult | null;
    detailResultRef?: Ref<IScanCleanupPreviewResult | null>;
    layoutDetectionCompleteRef?: Ref<boolean>;
    manualZones?: IScanCleanupManualZones;
    onUpdateManualZones?: (value: IScanCleanupManualZones) => void;
    onRequestDetail?: (
        viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
    ) => void;
    rawResult?: IScanCleanupRawPreviewResult | null;
    result?: IScanCleanupPreviewResult | null;
    resultCurrentRef?: Ref<boolean>;
    resultPresentationKeyRef?: Ref<string>;
    resultRef?: Ref<IScanCleanupPreviewResult | null>;
    disabled?: boolean;
    viewMode?: 'original' | 'cleaned';
    zoneEditing?: boolean;
} = {}) {
    const viewMode = ref<'original' | 'cleaned'>(options.viewMode ?? 'original');
    const disabled = ref(options.disabled ?? false);
    const splitUpdates: IScanCleanupNormalizedSplit[] = [];
    const previewResult = options.result === undefined ? spreadPreviewResult() : options.result;
    const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
        result: options.resultRef ? options.resultRef.value : previewResult,
        rawResult: options.rawResult ?? null,
        loading: false,
        error: '',
        viewMode: viewMode.value,
        matchPageSize: true,
        alignment: 'top-center',
        pageNumber: 1,
        totalPages: 3,
        manualSplit: null,
        manualZones: options.manualZones,
        disabled: disabled.value,
        readingOrder: 'ltr',
        zoneEditing: options.zoneEditing,
        detailResult: options.detailResultRef
            ? options.detailResultRef.value
            : options.detailResult ?? null,
        ...(options.layoutDetectionCompleteRef
            ? {layoutDetectionComplete: options.layoutDetectionCompleteRef.value}
            : {}),
        ...(options.resultCurrentRef
            ? {resultCurrent: options.resultCurrentRef.value}
            : {}),
        ...(options.resultPresentationKeyRef
            ? {resultPresentationKey: options.resultPresentationKeyRef.value}
            : {}),
        ...(options.onUpdateManualZones ? {'onUpdate:manualZones': options.onUpdateManualZones} : {}),
        ...(options.onRequestDetail ? {onRequestDetail: options.onRequestDetail} : {}),
        'onUpdate:manualSplit': (value: IScanCleanupNormalizedSplit | null) => {
            if (value) splitUpdates.push(value);
        },
    })}));
    const surface = harness.host.querySelector<HTMLElement>('.preview-surface')!;
    const stage = harness.host.querySelector<HTMLElement>('.cutter-stage')!;
    Object.defineProperties(stage, {
        clientHeight: {
            configurable: true,
            value: 400,
        },
        clientWidth: {
            configurable: true,
            value: 500,
        },
    });
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(domRect(0, 0, 500, 400));
    vi.spyOn(stage, 'getBoundingClientRect').mockImplementation(() => {
        const scale = Number(stage.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
        const translation = stage.style.transform.match(/translate3d\(([^p]+)px, ([^p]+)px/);
        const panX = Number(translation?.[1] ?? 0);
        const panY = Number(translation?.[2] ?? 0);
        return domRect(
            panX - 500 * (scale - 1) / 2,
            panY - 400 * (scale - 1) / 2,
            500 * scale,
            400 * scale,
        );
    });
    harness.host.querySelectorAll<HTMLElement>('.uniform-canvas').forEach((canvas, index) => {
        vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => {
            const scale = Number(stage.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
            const translation = stage.style.transform.match(/translate3d\(([^p]+)px, ([^p]+)px/);
            const panX = Number(translation?.[1] ?? 0);
            const panY = Number(translation?.[2] ?? 0);
            if (options.canvasRect) {
                return options.canvasRect(index, scale, panX, panY);
            }
            const single = previewResult?.outputs.length === 1;
            const baseWidth = single ? 160 : 250;
            const baseHeight = 400;
            const baseLeft = single ? 170 : index * 250;
            return domRect(
                250 + (baseLeft - 250) * scale + panX,
                200 + (0 - 200) * scale + panY,
                baseWidth * scale,
                baseHeight * scale,
            );
        });
    });
    const pointerCapture = mockPointerCapture(surface);
    return {
        ...harness,
        pointerCapture,
        stage,
        splitUpdates,
        disabled,
        surface,
        viewMode,
    };
}

function installResizeObserverHarness() {
    const original = globalThis.ResizeObserver;
    const observers: Array<{
        callback: ResizeObserverCallback;
        observer: ResizeObserver;
    }> = [];
    class ResizeObserverHarness implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
            observers.push({
                callback,
                observer: this,
            });
        }

        disconnect() {}

        observe(_target: Element, _options?: ResizeObserverOptions) {}

        unobserve(_target: Element) {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: ResizeObserverHarness,
    });
    return {
        restore: () => Object.defineProperty(globalThis, 'ResizeObserver', {
            configurable: true,
            value: original,
        }),
        trigger: () => {
            for (const {
                callback,
                observer,
            } of observers) callback([], observer);
        },
    };
}

function contentCropRefresh(result: IScanCleanupPreviewResult, factor: number) {
    return {
        ...result,
        rawImageData: new Uint8Array([2]),
        outputs: result.outputs.map(output => ({
            ...output,
            imageData: new Uint8Array([2]),
            metadata: {
                ...output.metadata,
                outputWidthPx: output.metadata.outputWidthPx * factor,
                outputHeightPx: output.metadata.outputHeightPx * factor,
                canvasWidthPx: output.metadata.canvasWidthPx * factor,
                canvasHeightPx: output.metadata.canvasHeightPx * factor,
            },
        })),
    };
}

function createWorkspaceEntrySession(overrides: Record<string, unknown> = {}) {
    const previewPage = ref(1);
    return {
        ownerId: 'component-entry-owner',
        alignmentItems: ref([]),
        applyLeaderOverrides: vi.fn(),
        authoritativeLayoutByPage: reactive(new Map()),
        blankPageCount: ref(0),
        cancel: vi.fn(),
        cancelDetection: vi.fn(),
        cancelRequested: ref(false),
        canDetectAll: ref(false),
        canRun: ref(false),
        currentPageOverride: ref({
            manualSplit: null,
            manualContentBoxes: {},
            placementOverrides: {},
            rotationDegrees: 0,
        }),
        detectedLayoutConfidenceByPage: reactive(new Map()),
        detectAllPages: vi.fn(),
        detectionCancelRequested: ref(false),
        detectionError: ref(''),
        detectionPending: ref(true),
        detectionProgress: ref({
            completedUnits: 0,
            totalUnits: 2,
        }),
        dismissFirstRunGuidance: vi.fn(),
        handleThicknessInput: vi.fn(),
        inlineError: ref(''),
        isRunning: ref(false),
        jobProgress: ref({
            percent: 0,
            completedUnits: 0,
            totalUnits: 2,
        }),
        layoutItems: ref([]),
        navigatePreview: vi.fn(),
        outputEstimate: ref(''),
        outputItems: ref([]),
        previewError: ref(''),
        previewLoading: ref(true),
        previewPage,
        previewResult: shallowRef<IScanCleanupPreviewResult | null>(null),
        previewTotalPages: ref(2),
        previewViewMode: ref<'original' | 'cleaned'>('cleaned'),
        processedPages: ref(new Set<number>()),
        progressText: ref(''),
        readingOrderItems: ref([]),
        resetPageOverrides: vi.fn(),
        retryPreview: vi.fn(),
        run: vi.fn(),
        runLabel: ref('Clean up'),
        selectedPages: ref<ReadonlySet<number>>(new Set([1])),
        selectionContentBoxes: ref({
            empty: false,
            mixed: false,
            value: {},
        }),
        selectionExcluded: ref({
            empty: false,
            mixed: false,
            value: false,
        }),
        selectionLayoutOverride: ref({
            empty: false,
            mixed: false,
            value: 'auto',
        }),
        selectionLeader: previewPage,
        selectionManualSplit: ref({
            empty: false,
            mixed: false,
            value: null,
        }),
        selectionPlacementAlignment: ref({
            empty: false,
            mixed: false,
            value: 'top-center',
        }),
        selectionRotation: ref({
            empty: false,
            mixed: false,
            value: 0,
        }),
        selectPage: vi.fn(),
        settings: reactive({
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'color',
            readingOrder: 'ltr',
            thickness: 0,
            crop: false,
            matchPageSize: true,
            pageAlignment: 'top-center',
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
            despeckle: false,
            skipBlankPages: false,
            pageOverrides: {},
        }),
        showFirstRunGuidance: ref(false),
        thicknessLabel: ref('0'),
        updateCurrentManualContentBox: vi.fn(),
        updateCurrentManualSplit: vi.fn(),
        updateCurrentPlacement: vi.fn(),
        updateCurrentPlacementAll: vi.fn(),
        updatePageOverride: vi.fn(),
        updateSelectionExcluded: vi.fn(),
        updateSelectionLayoutOverride: vi.fn(),
        updateSelectionOutputModeOverride: vi.fn(),
        updateSelectionPlacement: vi.fn(),
        updateSelectionRotation: vi.fn(),
        ...overrides,
    };
}

afterEach(() => {
    for (const unmount of activeUnmounts) unmount();
    document.body.innerHTML = '';
    localStorage.clear();
    resetScanCleanupPreferencesStore();
});

describe('Scan cleanup components', () => {
    it('publishes matched-canvas point dimensions for spread and mixed-scale outputs', () => {
        const renderOutput = (output: IScanCleanupPreviewResult['outputs'][number]) => ({
            canvasStyle: {},
            contentRect: output.metadata.contentBox,
            contentStyle: null,
            imageStyle: {},
            marginBoundaryStyle: {},
            metadata: output.metadata,
            pixelSwap: {
                currentUrl: '',
                entering: false,
                incomingUrl: '',
                outgoingUrl: '',
            },
            placement: {
                canvasWidthPx: output.metadata.canvasWidthPx,
                canvasHeightPx: output.metadata.canvasHeightPx,
                contentWidthPx: output.metadata.outputWidthPx,
                contentHeightPx: output.metadata.outputHeightPx,
                left: 0,
                top: 0,
                scaleX: 1,
                scaleY: 1,
            },
            sourceCropStyle: {},
        });
        const spread = spreadPreviewResult();
        spread.outputs = spread.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                matchedCanvasTargetWidthPoints: 612,
                matchedCanvasTargetHeightPoints: 792,
            },
        }));
        const mixedScale = spreadPreviewResult();
        mixedScale.outputs = [{
            ...mixedScale.outputs[0]!,
            metadata: {
                ...mixedScale.outputs[0]!.metadata,
                half: 'full',
                renderDpi: 300,
                matchedCanvasTargetWidthPoints: 612,
                matchedCanvasTargetHeightPoints: 792,
            },
        }];

        for (const outputs of [
            spread.outputs,
            mixedScale.outputs,
        ]) {
            const harness = mount(defineComponent(() => () => h(CleanedCanvas, {
                activePlacementHalf: null,
                altByHalf: {},
                detailUrls: {},
                matchPageSize: true,
                outputs: outputs.map(renderOutput),
            })));

            expect([...harness.host.querySelectorAll<HTMLElement>('.uniform-canvas')]
                .map(element => [
                    element.getAttribute('data-matched-canvas-width-points'),
                    element.getAttribute('data-matched-canvas-height-points'),
                ])).toEqual(outputs.map(() => [
                '612',
                '792',
            ]));
            harness.unmount();
        }
    });

    it('drives workspace activity from tab visibility without changing source identity', async () => {
        const toolbarActive = ref(true);
        const sourceSha256 = 'a'.repeat(64);
        workspaceSession.value = createWorkspaceEntrySession();
        mount(defineComponent(() => () => h(ScanCleanupWorkspace, {
            sourcePath: '/docs/visible-scan.pdf',
            documentRevision: 'revision-7',
            sourceSha256,
            toolbarActive: toolbarActive.value,
        })));

        expect(workspaceSessionOptions.value?.active?.()).toBe(true);
        expect(workspaceSessionOptions.value?.sourcePath?.()).toBe('/docs/visible-scan.pdf');
        expect(workspaceSessionOptions.value?.documentRevision?.()).toBe('revision-7');
        expect(workspaceSessionOptions.value?.sourceSha256?.()).toBe(sourceSha256);

        toolbarActive.value = false;
        await nextTick();

        expect(workspaceSessionOptions.value?.active?.()).toBe(false);
        expect(workspaceSessionOptions.value?.sourcePath?.()).toBe('/docs/visible-scan.pdf');
        expect(workspaceSessionOptions.value?.documentRevision?.()).toBe('revision-7');
        expect(workspaceSessionOptions.value?.sourceSha256?.()).toBe(sourceSha256);

        toolbarActive.value = true;
        await nextTick();
        expect(workspaceSessionOptions.value?.active?.()).toBe(true);
        expect(workspaceSessionOptions.value?.sourceSha256?.()).toBe(sourceSha256);
    });

    it('renders automatic, manual, and mixed auto-value states and emits reset only from the manual chip', async () => {
        const state = ref<'auto' | 'manual' | 'mixed'>('auto');
        const reset = vi.fn();
        const harness = mount(defineComponent(() => () => h(ScanCleanupAutoValueRow, {
            label: 'Deskew angle',
            state: state.value,
            valueText: '+1.4°',
            hint: 'Detected angle: 1.2°',
            onReset: reset,
        })));

        expect(harness.host.querySelector('[data-auto-value-state="auto"]')?.textContent?.trim()).toBe('Automatic');
        expect(harness.host.querySelector('.scan-cleanup-auto-value-reset')).toBeNull();
        expect(harness.host.textContent).toContain('Detected angle: 1.2°');

        state.value = 'manual';
        await nextTick();
        expect(harness.host.querySelector('[data-auto-value-state="manual"]')?.textContent).toContain('+1.4°');
        harness.host.querySelector<HTMLButtonElement>('.scan-cleanup-auto-value-reset')?.click();
        expect(reset).toHaveBeenCalledOnce();

        state.value = 'mixed';
        await nextTick();
        expect(harness.host.querySelector('[data-auto-value-state="mixed"]')?.textContent?.trim()).toBe('Mixed');
        expect(harness.host.querySelector('.scan-cleanup-auto-value-reset')).toBeNull();
    });

    it('normalizes persisted document mixed output to Auto and exposes Auto/B&W/Gray/Color labels', () => {
        localStorage.setItem('evb.scanCleanup.documentOverrides.v1', JSON.stringify({'document-mixed': {
            outputMode: 'mixed',
            updatedAt: 1,
        }}));
        let documentSettings: ReturnType<typeof useScanCleanupDocumentSettings> | undefined;
        mount(defineComponent({setup: () => {
            documentSettings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => 'lifecycle-mixed'),
                preferenceDocumentKey: computed(() => 'document-mixed'),
            });
            return () => h('div');
        }}));

        expect(documentSettings?.values.outputMode).toBe('auto');
        expect(documentSettings?.outputItems.value.map(item => [
            item.value,
            item.label,
            item.fullLabel,
        ])).toEqual([
            [
                'auto',
                'scanCleanup.output.autoShort',
                'scanCleanup.output.autoDescription',
            ],
            [
                'bw',
                'scanCleanup.output.bwShort',
                'Black and white',
            ],
            [
                'grayscale',
                'scanCleanup.output.grayscaleShort',
                'Grayscale',
            ],
            [
                'color',
                'scanCleanup.output.colorShort',
                'Color',
            ],
        ]);
        const persisted = JSON.parse(
            localStorage.getItem('evb.scanCleanup.documentOverrides.v1') ?? '{}',
        ) as Record<string, {outputMode?: string}>;
        expect(persisted['document-mixed']?.outputMode).toBe('auto');
    });

    it('applies mixed output only to the current page from the zone editor', async () => {
        const updateSelectionOutputModeOverride = vi.fn();
        const settings = reactive({
            preserveOriginalQuality: true,
            layoutMode: 'auto' as const,
            outputMode: 'color' as const,
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: false,
            matchPageSize: true,
            pageAlignment: 'top-center' as const,
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
            despeckle: false,
            skipBlankPages: false,
            pageOverrides: {},
        });
        workspaceSession.value = createWorkspaceEntrySession({
            currentPageOverride: ref(createScanCleanupPageOverride()),
            detectionPending: ref(false),
            previewLoading: ref(false),
            previewResult: shallowRef(spreadPreviewResult(2)),
            previewTotalPages: ref(3),
            selectionLeader: ref(2),
            selectedPages: ref(new Set([2])),
            settings,
            updateSelectionOutputModeOverride,
        });
        const harness = mount(defineComponent(() => () => h(ScanCleanupWorkspace, {
            sourcePath: null,
            totalPages: 3,
        })));

        harness.host.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-zone-editor')?.click();
        await nextTick();
        const useMixed = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.textContent?.trim() === 'Use mixed output');
        expect(useMixed).not.toBeUndefined();
        useMixed?.click();

        expect(settings.preserveOriginalQuality).toBe(false);
        expect(settings.outputMode).toBe('color');
        expect(updateSelectionOutputModeOverride).toHaveBeenCalledWith('mixed', [2]);
    });

    it('reserves only the counter width in the run meter while a run waits for detection', () => {
        // Regression: the meter's count slot was sized to the whole pre-analysis
        // sentence, which overflowed the meter and ellipsized the phase label
        // ("Pre-analyzing p…") although the visible line is short.
        workspaceSession.value = createWorkspaceEntrySession({
            detectionPending: ref(true),
            detectionProgress: ref({
                completedUnits: 1,
                totalUnits: 158,
            }),
            detectionProgressCountText: ref('1 of 158 pages'),
            detectionProgressCountWidestText: ref('158 of 158 pages'),
            detectionProgressPhaseText: ref('Pre-analyzing pages'),
            detectionProgressText: ref('Pre-analyzing pages — 1 of 158 pages'),
            detectionProgressWidestText: ref('Pre-analyzing pages — 158 of 158 pages'),
            isRunning: ref(true),
            waitingForDetection: computed(() => true),
        });
        const harness = mount(defineComponent(() => () => h(ScanCleanupWorkspace, {
            sourcePath: null,
            totalPages: 158,
        })));
        const meter = harness.host.querySelector('.scan-cleanup-run-meter');
        const count = meter?.querySelector('.scan-cleanup-run-meter-count');

        expect(meter?.querySelector('.scan-cleanup-run-meter-phase')?.textContent).toBe('Pre-analyzing pages');
        expect(count?.querySelector('.scan-cleanup-stable-width-value')?.textContent).toBe('1 of 158 pages');
        expect(count?.querySelector('.scan-cleanup-stable-width-sizer')?.textContent).toBe('158 of 158 pages');
        expect(meter?.textContent).not.toContain('Pre-analyzing pages — ');
    });

    it('shows detected blank pages under the sidebar setting without changing the default', async () => {
        const blankPageCount = ref(2);
        const settings = reactive({
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'color',
            readingOrder: 'ltr',
            thickness: 0,
            crop: false,
            matchPageSize: true,
            pageAlignment: 'top-center',
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
            despeckle: false,
            skipBlankPages: false,
            pageOverrides: {},
        });
        workspaceSession.value = createWorkspaceEntrySession({
            blankPageCount,
            detectionPending: ref(false),
            settings,
        });

        const harness = mount(defineComponent(() => () => h(ScanCleanupWorkspace, {
            sourcePath: '/docs/scanned.pdf',
            documentKey: 'document-a',
            currentPage: 1,
            totalPages: 2,
        })));
        await nextTick();

        const hint = harness.host.querySelector('.scan-cleanup-blank-detected-hint');
        expect(hint?.textContent).toContain('2 pages look blank');
        expect(harness.host.querySelector('.scan-cleanup-blank-hint')).toBeNull();
        expect(settings.skipBlankPages).toBe(false);

        settings.skipBlankPages = true;
        await nextTick();
        expect(settings.skipBlankPages).toBe(true);
        expect(harness.host.querySelector('.scan-cleanup-blank-detected-hint')?.textContent)
            .toContain('2 pages look blank');
    });

    it('keeps a native page frame visible through the real workspace debounce state while metrics resolve', async () => {
        const source: IDocumentPageSource = {
            ...previewPageSource(1000, 800),
            pageCount: 2,
            getPageMetrics: vi.fn(() => new Promise<never>(() => undefined)),
        };
        workspaceSession.value = createWorkspaceEntrySession();

        const harness = mount(defineComponent(() => () => h(ScanCleanupWorkspace, {
            sourcePath: '/docs/scanned.pdf',
            currentPage: 1,
            totalPages: 2,
            pageSource: source,
            pageSourcePending: false,
        })));
        await nextTick();

        const skeleton = harness.host.querySelector<HTMLElement>('.preview-skeleton-page');
        expect(skeleton?.tagName).toBe('DIV');
        expect(skeleton?.style.height).toContain('--app-scan-preview-skeleton-height');
        expect(skeleton?.style.aspectRatio).not.toBe('');
        expect(harness.host.querySelector('.preview-viewport-caption')?.textContent)
            .toBe('Building cleanup preview…');
    });

    it('relocates the collapsed scan-cleanup and OCR actions into overflow and activates them', async () => {
        const workspaceOpen = ref(false);
        const ocrOpen = ref(false);
        const assistantOpen = ref(false);
        const collapseTier = ref(1);
        const scanCleanupDisabled = ref(false);
        const scanCleanupRunning = ref(false);
        const harness = mount(defineComponent(() => () => h('div', [
            h(ToolbarOverflowMenu, {
                open: true,
                collapseTier: collapseTier.value,
                hasPdf: true,
                canToggleSidebar: true,
                canCaptureRegion: true,
                canCrop: true,
                canQuickNote: true,
                canUseOcr: true,
                canUseScanCleanup: true,
                scanCleanupDisabled: scanCleanupDisabled.value,
                scanCleanupRunning: scanCleanupRunning.value,
                scanCleanupLabel: scanCleanupRunning.value
                    ? 'Scan cleanup running, 0 of 2'
                    : 'Scan cleanup',
                canUseAssistant: true,
                assistantAvailable: true,
                assistantOpen: assistantOpen.value,
                assistantLabel: 'Assistant',
                showSidebar: false,
                dragMode: false,
                continuousScroll: false,
                viewMode: 'single',
                isDjvuMode: false,
                isFitWidthActive: false,
                isFitHeightActive: false,
                isCapturingRegion: false,
                isCropSelecting: false,
                isPlacingPageNote: false,
                documentBusy: false,
                triggerIcon: 'i-ph-dots-three',
                onOpenScanCleanup: () => { workspaceOpen.value = true; },
                onOpenOcr: () => { ocrOpen.value = true; },
                onToggleAssistant: () => { assistantOpen.value = !assistantOpen.value; },
            }),
            workspaceOpen.value ? h('div', {'data-scan-cleanup-workspace': ''}) : null,
            ocrOpen.value ? h('div', {'data-ocr-popup': ''}) : null,
        ])));

        const menuItems = () => Array.from(harness.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const scanCleanupItem = menuItems().find(item => item.textContent?.includes('Scan cleanup'));
        const ocrItem = menuItems().find(item => item.textContent?.includes('ocr.button'));
        expect(scanCleanupItem).not.toBeUndefined();
        expect(scanCleanupItem?.querySelector('.overflow-menu-scan-cleanup-icon')).not.toBeNull();
        expect(ocrItem).not.toBeUndefined();

        scanCleanupItem?.click();
        await nextTick();
        expect(harness.host.querySelector('[data-scan-cleanup-workspace]')).not.toBeNull();

        scanCleanupRunning.value = true;
        scanCleanupDisabled.value = true;
        await nextTick();
        const runningItem = menuItems().find(item => item.textContent?.includes('Scan cleanup running'));
        expect(runningItem?.classList.contains('is-active')).toBe(true);
        expect(runningItem?.disabled).toBe(true);
        expect(runningItem?.querySelector('.overflow-menu-running-dot')).not.toBeNull();

        menuItems().find(item => item.textContent?.includes('ocr.button'))?.click();
        await nextTick();
        expect(harness.host.querySelector('[data-ocr-popup]')).not.toBeNull();

        collapseTier.value = 5;
        scanCleanupDisabled.value = false;
        await nextTick();
        const assistantItem = menuItems().find(item => item.textContent?.includes('Assistant'));
        expect(assistantItem).not.toBeUndefined();
        assistantItem?.click();
        await nextTick();
        expect(assistantOpen.value).toBe(true);
    });

    it('round-trips the toolbar surface command through Done while Escape keeps the workspace open', async () => {
        const updateCurrentPlacementAll = vi.fn();
        const detectAllPages = vi.fn();
        const cancelDetection = vi.fn();
        const isDetecting = ref(false);
        const detectionProgress = ref({
            completedUnits: 0,
            totalUnits: 12,
        });
        const selectedPages = ref<ReadonlySet<number>>(new Set([7]));
        const previewPage = ref(7);
        const previewViewMode = ref<'original' | 'cleaned'>('cleaned');
        const isRunning = ref(false);
        const jobProgress = ref({
            percent: 0,
            completedUnits: 0,
            totalUnits: 12,
        });
        const progressText = ref('Processed 0 of 12 source pages');
        workspaceSession.value = {
            ownerId: 'component-test-owner',
            alignmentItems: ref([{
                value: 'bottom-right',
                icon: 'i-ph-arrow-down-right',
                label: 'Place at bottom right',
            }]),
            cancel: vi.fn(),
            cancelDetection,
            cancelRequested: ref(false),
            canDetectAll: ref(true),
            canRun: ref(false),
            currentPageOverride: ref({
                manualSplit: null,
                manualContentBoxes: {},
                placementOverrides: {},
            }),
            currentPlacementAlignment: ref('top-center'),
            handleThicknessInput: vi.fn(),
            detectAllPages,
            detectionCancelRequested: ref(false),
            detectionError: ref(''),
            detectionPending: isDetecting,
            detectionProgress,
            inlineError: ref(''),
            isDetecting,
            isRunning,
            jobProgress,
            layoutItems: ref([
                {
                    value: 'auto',
                    label: 'Detect automatically',
                },
                {
                    value: 'force-single',
                    label: 'Force single pages',
                },
                {
                    value: 'force-two-page',
                    label: 'Force two-page spreads',
                },
            ]),
            navigatePreview: vi.fn(),
            outputEstimate: ref(''),
            outputItems: ref([
                {
                    value: 'auto',
                    label: 'Auto',
                    fullLabel: 'Auto — recommended per page',
                },
                {
                    value: 'bw',
                    label: 'B&W',
                    fullLabel: 'Black and white',
                },
                {
                    value: 'grayscale',
                    label: 'Gray',
                    fullLabel: 'Grayscale',
                },
                {
                    value: 'color',
                    label: 'Color',
                    fullLabel: 'Color',
                },
            ]),
            authoritativeLayoutByPage: reactive(new Map()),
            detectedLayoutConfidenceByPage: reactive(new Map()),
            previewError: ref(''),
            previewLoading: ref(false),
            previewPage,
            processedPages: ref(new Set()),
            previewResult: ref(null),
            previewTotalPages: ref(12),
            previewViewMode,
            progressText,
            readingOrderItems: ref([]),
            resetPageOverrides: vi.fn(),
            retryPreview: vi.fn(),
            run: vi.fn(),
            runLabel: ref('Clean up'),
            showFirstRunGuidance: ref(false),
            dismissFirstRunGuidance: vi.fn(),
            selectedPages,
            selectionLeader: previewPage,
            selectPage: vi.fn(),
            settings: reactive({
                preserveOriginalQuality: false,
                layoutMode: 'auto',
                outputMode: 'color',
                readingOrder: 'ltr',
                thickness: 0,
                crop: false,
                matchPageSize: true,
                pageAlignment: 'top-center',
                marginsMm: {
                    leftMm: 0,
                    topMm: 0,
                    rightMm: 0,
                    bottomMm: 0,
                },
                despeckle: false,
                skipBlankPages: false,
                pageOverrides: {},
            }),
            thicknessLabel: ref('0'),
            updateCurrentManualSplit: vi.fn(),
            updateCurrentManualContentBox: vi.fn(),
            updateCurrentPlacement: vi.fn(),
            updateCurrentPlacementAll,
            updatePageOverride: vi.fn(),
        };
        const readerState = {
            surfaceMode: ref<'reader' | 'scan-cleanup'>('reader'),
            viewport: {
                page: 37,
                zoom: 1.75,
            },
        };
        const retainedViewport = readerState.viewport;
        const cleanupSession = ref<IScanCleanupTabSessionState>({
            previewPage: 31,
            previewViewMode: 'original',
        });
        const harness = mount(defineComponent(() => () => h('div', [
            h('button', {
                'data-toolbar-scan-cleanup': '',
                onClick: () => { readerState.surfaceMode.value = 'scan-cleanup'; },
            }),
            h('div', {
                'data-reader': '',
                style: {display: readerState.surfaceMode.value === 'reader' ? '' : 'none'},
            }),
            readerState.surfaceMode.value === 'scan-cleanup'
                ? h(ScanCleanupWorkspace, {
                    sourcePath: '/docs/book.pdf',
                    currentPage: readerState.viewport.page,
                    totalPages: 100,
                    sessionState: cleanupSession.value,
                    'onUpdate:sessionState': (state: IScanCleanupTabSessionState) => {
                        cleanupSession.value = state;
                    },
                    onDone: () => { readerState.surfaceMode.value = 'reader'; },
                })
                : null,
        ])));

        harness.host.querySelector<HTMLButtonElement>('[data-toolbar-scan-cleanup]')?.click();
        await nextTick();
        expect(readerState.surfaceMode.value).toBe('scan-cleanup');
        expect(harness.host.querySelector('.scan-cleanup-surface')).not.toBeNull();
        expect(harness.host.querySelector<HTMLElement>('[data-reader]')?.style.display).toBe('none');
        const losslessToggle = Array.from(harness.host.querySelectorAll('label'))
            .find(label => label.textContent?.includes('Preserve original quality'))
            ?.querySelector<HTMLInputElement>('input');
        expect(losslessToggle).not.toBeUndefined();
        losslessToggle!.checked = true;
        losslessToggle!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        const outputModeOptions = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('[aria-label="Output mode"] [role="radio"]'));
        expect(outputModeOptions).toHaveLength(4);
        expect(outputModeOptions[0]?.textContent).toContain('Auto');
        expect(outputModeOptions.every(option => option.disabled)).toBe(true);
        expect(harness.host.textContent).toContain('Raster cleanup options are unavailable in this mode.');
        expect(harness.host.querySelector('.scan-cleanup-footnote')).toBeNull();
        losslessToggle!.checked = false;
        losslessToggle!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(workspaceSessionInitial.value).toEqual({
            page: 31,
            viewMode: 'original',
        });

        previewPage.value = 9;
        previewViewMode.value = 'original';
        await nextTick();
        expect(cleanupSession.value).toEqual({
            ownerId: expect.any(String),
            previewPage: 9,
            previewViewMode: 'original',
        });

        const detectButton = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.textContent?.trim() === 'Re-detect');
        expect(detectButton?.disabled).toBe(false);
        detectButton?.click();
        expect(detectAllPages).toHaveBeenCalledOnce();
        isDetecting.value = true;
        detectionProgress.value = {
            completedUnits: 2,
            totalUnits: 12,
        };
        await nextTick();
        expect(harness.host.querySelector('.scan-cleanup-toolbar')?.textContent).toContain('2 / 12');
        const cancelDetectionButton = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.getAttribute('aria-label')
                === 'Stop detecting pages — pages already detected keep their results');
        cancelDetectionButton?.click();
        expect(cancelDetection).toHaveBeenCalledOnce();
        isDetecting.value = false;
        await nextTick();

        harness.host.querySelector<HTMLButtonElement>('[aria-label="Place at bottom right"]')?.click();
        expect(updateCurrentPlacementAll).toHaveBeenCalledWith('bottom-right');

        isRunning.value = true;
        jobProgress.value = {
            percent: 25,
            completedUnits: 3,
            totalUnits: 12,
        };
        progressText.value = 'Processed 3 of 12 source pages';
        await nextTick();
        expect(harness.host.querySelector('.scan-cleanup-toolbar')?.textContent)
            .toContain('Processed 3 of 12 source pages');
        expect(harness.host.querySelector('.scan-cleanup-run-meter')).not.toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-header')).toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-footer')).toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-progress-overlay')).toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-preview-hero')).not.toBeNull();

        const doneButton = Array.from(harness.host.querySelectorAll('button'))
            .find(button => button.textContent?.trim() === 'Done');
        doneButton?.click();
        await nextTick();
        expect(readerState.surfaceMode.value).toBe('reader');
        expect(harness.host.querySelector('.scan-cleanup-surface')).toBeNull();
        expect(readerState.viewport).toBe(retainedViewport);
        expect(readerState.viewport).toEqual({
            page: 37,
            zoom: 1.75,
        });

        selectedPages.value = new Set();
        harness.host.querySelector<HTMLButtonElement>('[data-toolbar-scan-cleanup]')?.click();
        await nextTick();
        expect(workspaceSessionInitial.value).toEqual({
            page: 9,
            viewMode: 'original',
        });
        expect(harness.host.querySelector('[role="tablist"]')).toBeNull();
        expect(harness.host.querySelector('[role="radiogroup"][aria-label="Settings scope"]')).not.toBeNull();
        expect(harness.host.querySelector('[data-settings-scope="selected"]')).toBeNull();
        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            cancelable: true,
        }));
        await nextTick();
        expect(readerState.surfaceMode.value).toBe('scan-cleanup');
        expect(harness.host.querySelector('.scan-cleanup-surface')).not.toBeNull();
        expect(readerState.viewport).toBe(retainedViewport);

        const reopenedDoneButton = Array.from(harness.host.querySelectorAll('button'))
            .find(button => button.textContent?.trim() === 'Done');
        reopenedDoneButton?.click();
        await nextTick();
        expect(readerState.surfaceMode.value).toBe('reader');
    });

    it('keeps all toolbar zone widths identical across review, detection, and cleanup states', async () => {
        const state = reactive({
            detecting: false,
            running: false,
        });
        const etaText = ref('Calculating time for current task…');
        const zoneWidths = {
            'scan-cleanup-toolbar-zone-left': 160,
            'scan-cleanup-toolbar-zone-center': 680,
            'scan-cleanup-toolbar-zone-right': 336,
        } as const;
        const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const matched = Object.entries(zoneWidths).find(([className]) => this.classList.contains(className));
            const width = matched?.[1] ?? 0;
            return {
                bottom: 0,
                height: 0,
                left: 0,
                right: width,
                top: 0,
                width,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            };
        });
        const harness = mount(defineComponent(() => () => h(ScanCleanupToolbar, {
            canDetectAll: !state.detecting,
            canRun: true,
            cancelRequested: false,
            detectionCancelRequested: false,
            detectionError: '',
            detectionProgressText: 'Analyzing 17 / 120',
            detectionProgressWidestText: 'Analyzing 120 / 120',
            isDetecting: state.detecting,
            isRunning: state.running,
            outputEstimate: '120 source pages → about 145 output pages',
            percent: 42,
            progressPhase: 'clean',
            progressCountText: '51 / 120',
            progressCountWidestText: '120 / 120',
            progressEtaText: etaText.value,
            progressEtaWidestText: 'Current task: about 999 min',
            progressPhaseText: 'Cleaning pages',
            progressText: `Cleaning pages — 51 / 120. ${etaText.value}`,
            runLabel: 'Clean up',
            runDisabledReason: '',
            transitionText: '',
        })));
        const widths = () => Array.from(harness.host.querySelectorAll<HTMLElement>('.scan-cleanup-toolbar-zone'))
            .map(zone => zone.getBoundingClientRect().width);

        const reviewWidths = widths();
        expect(harness.host.querySelector('.scan-cleanup-toolbar-status-slot')?.textContent)
            .toContain('120 source pages → about 145 output pages');

        state.detecting = true;
        await nextTick();
        expect(widths()).toEqual(reviewWidths);
        expect(harness.host.querySelector('.scan-cleanup-toolbar-status-slot')?.textContent)
            .toContain('Analyzing 17 / 120');

        state.detecting = false;
        state.running = true;
        await nextTick();
        expect(widths()).toEqual(reviewWidths);
        const meter = harness.host.querySelector('.scan-cleanup-run-meter');
        expect(meter?.textContent).toContain('Cleaning pages');
        expect(meter?.textContent).toContain('Step 2 of 3');
        expect(meter?.textContent).not.toContain('Step 5 of 8');
        expect(meter?.textContent).toContain('51 / 120');
        expect(meter?.textContent).not.toContain('42%');
        expect(meter?.textContent).toContain('Calculating time for current task…');
        expect(meter?.querySelector('[aria-current="step"]')?.getAttribute('aria-label')).toBe('Clean pages');
        // The step list stays a native list so each step's label and the
        // current-step marker reach assistive tech; progress is exposed by a
        // progressbar inside the current step, not by the list itself.
        expect(meter?.querySelector('ol')?.getAttribute('role')).toBeNull();
        expect(meter?.querySelectorAll('ol > li')).toHaveLength(3);
        expect(meter?.querySelector('[role="progressbar"]')?.closest('[aria-current="step"]')).not.toBeNull();
        expect(meter?.querySelector('.scan-cleanup-run-meter-eta .scan-cleanup-stable-width-sizer')?.textContent)
            .toBe('Current task: about 999 min');
        const progressbar = meter?.querySelector('[role="progressbar"]');
        expect(progressbar?.getAttribute('aria-valuenow')).toBe('42');
        expect(progressbar?.getAttribute('aria-valuetext'))
            .toContain('Cleaning pages');
        expect(meter?.querySelector('.scan-cleanup-run-meter-count .scan-cleanup-stable-width-sizer')?.textContent)
            .toBe('120 / 120');
        expect(harness.host.querySelector('.scan-cleanup-toolbar-status-slot')).toBeNull();
        expect(harness.host.querySelectorAll('.scan-cleanup-toolbar-primary-action')).toHaveLength(1);
        etaText.value = 'Current task: about 4 min';
        await nextTick();
        expect(meter?.textContent).toContain('Current task: about 4 min');
        rectSpy.mockRestore();
    });

    it('prioritizes and dismisses a persisted cleanup failure while detection restarts', () => {
        const dismiss = vi.fn();
        const harness = mount(defineComponent(() => () => h(ScanCleanupToolbar, {
            canDetectAll: true,
            canRun: true,
            cancelRequested: false,
            detectionCancelRequested: false,
            detectionError: '',
            detectionProgressText: 'Pre-analyzing pages — 1 / 392',
            detectionProgressWidestText: 'Pre-analyzing pages — 392 / 392',
            isDetecting: true,
            isRunning: false,
            outputEstimate: '',
            percent: 0,
            progressCountText: '',
            progressPhaseText: '',
            progressText: '',
            runError: 'Native cleanup failed',
            runLabel: 'Clean up',
            runDisabledReason: '',
            transitionText: '',
            onDismissRunError: dismiss,
        })));

        expect(harness.host.querySelector('[role="alert"]')?.textContent).toContain('Native cleanup failed');
        expect(harness.host.querySelector('.scan-cleanup-toolbar-count')).toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-toolbar-cancel-detection')).toBeNull();
        harness.host.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-dismiss-error')?.click();
        expect(dismiss).toHaveBeenCalledOnce();
    });

    it('renders one scope-aware panel and routes all, page, and selected writes to their visible targets', async () => {
        const pageOverrides = reactive({
            '1': createScanCleanupPageOverride({
                layoutOverride: 'single',
                outputModeOverride: 'bw',
                marginsMm: {
                    leftMm: 8,
                    topMm: 8,
                    rightMm: 8,
                    bottomMm: 8,
                },
            }),
            '2': createScanCleanupPageOverride({
                layoutOverride: 'spread',
                outputModeOverride: 'color',
            }),
        });
        const settings = reactive({
            preserveOriginalQuality: false,
            layoutMode: 'force-single' as const,
            outputMode: 'color' as const,
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'top-left' as const,
            marginsMm: {
                leftMm: 5,
                topMm: 5,
                rightMm: 5,
                bottomMm: 5,
            },
            despeckle: false,
            skipBlankPages: false,
            pageOverrides,
        });
        const selectionLayoutOverride = ref<{
            empty: boolean;
            mixed: boolean;
            value: TScanCleanupPageLayoutOverride;
        }>({
            empty: false,
            mixed: true,
            value: 'single' as const,
        });
        const applyLeaderOverrides = vi.fn();
        const resetPageOverrides = vi.fn();
        const resetScopeOverrides = vi.fn((pages: Iterable<number>) => {
            updateScanCleanupPageOverrides(pageOverrides, pages, () => createScanCleanupPageOverride());
        });
        const resetControlOverride = vi.fn((control: string, pages: Iterable<number>) => {
            updateScanCleanupPageOverrides(pageOverrides, pages, current => {
                if (control === 'margins') {
                    const {
                        marginsMm: _marginsMm,
                        ...withoutMargins
                    } = current;
                    return createScanCleanupPageOverride(withoutMargins);
                }
                if (control === 'layout') {
                    return createScanCleanupPageOverride({
                        ...current,
                        layoutOverride: 'auto',
                    });
                }
                return current;
            });
        });
        const updateSelectionMargins = vi.fn((
            _target: string,
            value: number,
            pages: Iterable<number>,
        ) => {
            updateScanCleanupPageOverrides(pageOverrides, pages, current => ({
                ...current,
                marginsMm: {
                    leftMm: value,
                    topMm: value,
                    rightMm: value,
                    bottomMm: value,
                },
            }), settings.marginsMm);
        });
        const settingsScope = ref<'all' | 'page' | 'selected'>('all');
        workspaceSession.value = {
            ownerId: 'component-test-owner',
            alignmentItems: ref([]),
            applyLeaderOverrides,
            cancel: vi.fn(),
            cancelDetection: vi.fn(),
            cancelRequested: ref(false),
            canDetectAll: ref(false),
            canRun: ref(false),
            currentPageOverride: ref(getScanCleanupPageOverride(pageOverrides, requirePageNumber(2))),
            detectionCancelRequested: ref(false),
            detectionError: ref(''),
            detectionPending: ref(false),
            detectionProgress: ref({
                completedUnits: 0,
                totalUnits: 3,
            }),
            handleThicknessInput: vi.fn(),
            inlineError: ref(''),
            isDetecting: ref(false),
            isRunning: ref(false),
            jobProgress: ref({
                percent: 0,
                completedUnits: 0,
                totalUnits: 3,
            }),
            layoutItems: ref([
                {
                    value: 'auto',
                    label: 'Detect automatically',
                },
                {
                    value: 'force-single',
                    label: 'Force single pages',
                },
                {
                    value: 'force-two-page',
                    label: 'Force two-page spreads',
                },
            ]),
            navigatePreview: vi.fn(),
            outputEstimate: ref(''),
            outputItems: ref([]),
            authoritativeLayoutByPage: reactive(new Map()),
            detectedLayoutConfidenceByPage: reactive(new Map()),
            previewError: ref(''),
            previewLoading: ref(false),
            previewPage: ref(2),
            previewResult: ref(null),
            previewTotalPages: ref(3),
            previewViewMode: ref('cleaned'),
            progressText: ref(''),
            readingOrderItems: ref([]),
            resetPageOverrides,
            resetSelectionContentBoxes: vi.fn(),
            resetSelectionManualSplit: vi.fn(),
            retryPreview: vi.fn(),
            run: vi.fn(),
            runLabel: ref('Clean up'),
            showFirstRunGuidance: ref(false),
            dismissFirstRunGuidance: vi.fn(),
            selectedPages: ref(new Set([
                1,
                2,
            ])),
            selectionContentBoxes: ref({
                empty: false,
                mixed: false,
                value: {},
            }),
            selectionExcluded: ref({
                empty: false,
                mixed: false,
                value: false,
            }),
            selectionLayoutOverride,
            selectionLeader: ref(2),
            selectionManualSplit: ref({
                empty: false,
                mixed: false,
                value: null,
            }),
            selectionPlacementAlignment: ref({
                empty: false,
                mixed: false,
                value: 'top-left',
            }),
            selectionRotation: ref({
                empty: false,
                mixed: false,
                value: 0,
            }),
            selectPage: vi.fn(),
            setSettingsScope: (value: 'all' | 'page' | 'selected') => { settingsScope.value = value; },
            settingsScope,
            resetScopeOverrides,
            resetControlOverride,
            settings,
            thicknessLabel: ref('0'),
            updateCurrentManualContentBox: vi.fn(),
            updateCurrentManualSplit: vi.fn(),
            updateCurrentPlacement: vi.fn(),
            updateCurrentPlacementAll: vi.fn(),
            updatePageOverride: vi.fn(),
            updateSelectionExcluded: vi.fn(),
            updateSelectionLayoutOverride: (
                value: 'auto' | 'single' | 'spread' | 'keep-left' | 'keep-right',
                pages: Iterable<number>,
            ) => {
                updateScanCleanupPageOverrides(pageOverrides, pages, current => ({
                    ...current,
                    layoutOverride: value,
                }));
                selectionLayoutOverride.value = {
                    empty: false,
                    mixed: false,
                    value,
                };
            },
            updateSelectionMargins,
            updateSelectionPlacement: vi.fn(),
            updateSelectionRotation: vi.fn(),
        };
        const harness = mount(defineComponent(() => () => h(ScanCleanupWorkspace, {
            sourcePath: null,
            totalPages: 3,
        })));

        const scopeGroup = harness.host.querySelector('[role="radiogroup"][aria-label="Settings scope"]');
        expect(scopeGroup).not.toBeNull();
        expect(harness.host.querySelector('[role="tablist"]')).toBeNull();
        expect(harness.host.querySelectorAll('[aria-label="Page layout"]')).toHaveLength(1);
        expect(harness.host.querySelector('[aria-label="Output mode for pages"]')).toBeNull();
        expect(harness.host.querySelector('[data-override-marker]')).toBeNull();
        expect(harness.host.querySelector('[data-reset-override]')).toBeNull();
        expect(harness.host.querySelector('[data-override-count="layout"]')?.textContent).toBe('1');
        expect(harness.host.querySelector('[data-override-count="margins"]')?.getAttribute('title'))
            .toBe('1 pages override this');
        expect(harness.host.querySelector('[data-customized-scope="all"]')?.textContent?.trim())
            .toBe('2 customized');
        const disabledApply = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.textContent?.includes('Copy this page\'s settings to…'));
        expect(disabledApply?.disabled).toBe(true);
        expect(disabledApply?.getAttribute('aria-describedby')).toBe('scan-cleanup-apply-page-hint');
        expect(harness.host.querySelector('#scan-cleanup-apply-page-hint')?.textContent)
            .toContain('Choose “This page” above');

        const layout = harness.host.querySelector<HTMLSelectElement>('[aria-label="Page layout"]')!;
        layout.value = 'force-two-page';
        layout.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(settings.layoutMode).toBe('force-two-page');
        const documentDefaults = {
            layoutMode: settings.layoutMode,
            outputMode: settings.outputMode,
            pageAlignment: settings.pageAlignment,
        };

        harness.host.querySelector<HTMLButtonElement>('[data-settings-scope="selected"]')?.click();
        await nextTick();
        expect(settingsScope.value).toBe('selected');
        expect(harness.host.querySelector('[data-customized-scope="selected"]')?.textContent?.trim())
            .toBe('2 customized');
        expect(harness.host.textContent).toContain('— Mixed');
        const outputMode = harness.host.querySelector<HTMLSelectElement>(
            '[aria-label="Output mode for pages"]',
        )!;
        const placement = harness.host.querySelector<HTMLElement>(
            '[role="radiogroup"][aria-label="Content placement"]',
        )!;
        expect(outputMode).not.toBeNull();
        expect(placement.compareDocumentPosition(outputMode) & Node.DOCUMENT_POSITION_FOLLOWING)
            .toBeTruthy();
        expect(Array.from(outputMode.options).map(option => option.value)).toEqual([
            'mixed-values',
            'auto',
            'bw',
            'grayscale',
            'color',
            'mixed',
        ]);
        expect(new Set(Array.from(outputMode.options).map(option => option.value)).size)
            .toBe(outputMode.options.length);
        expect(harness.host.querySelector('[data-override-marker="layout"]')).not.toBeNull();
        expect(harness.host.querySelector('[data-reset-override="layout"]')?.getAttribute('aria-label'))
            .toBe('Reset to document');

        layout.value = 'keep-right';
        layout.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(getScanCleanupPageOverride(pageOverrides, requirePageNumber(1)).layoutOverride).toBe('keep-right');
        expect(getScanCleanupPageOverride(pageOverrides, requirePageNumber(2)).layoutOverride).toBe('keep-right');
        expect({
            layoutMode: settings.layoutMode,
            outputMode: settings.outputMode,
            pageAlignment: settings.pageAlignment,
        }).toEqual(documentDefaults);
        expect(layout.closest('.scan-cleanup-selection-field')?.textContent).not.toContain('— Mixed');

        harness.host.querySelector<HTMLButtonElement>('[data-settings-scope="page"]')?.click();
        await nextTick();
        expect(settingsScope.value).toBe('page');
        expect(harness.host.querySelector('[data-customized-scope="page"] .sr-only')?.textContent)
            .toBe('This page has custom settings');
        expect(harness.host.querySelector('[aria-label="Output mode for pages"]')).not.toBeNull();
        expect(harness.host.querySelector('#scan-cleanup-apply-page-hint')?.textContent?.trim()).toBe('');
        layout.value = 'keep-left';
        layout.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(getScanCleanupPageOverride(pageOverrides, requirePageNumber(1)).layoutOverride).toBe('keep-right');
        expect(getScanCleanupPageOverride(pageOverrides, requirePageNumber(2)).layoutOverride).toBe('keep-left');
        settings.preserveOriginalQuality = true;
        await nextTick();
        expect(harness.host.querySelector<HTMLSelectElement>(
            '[aria-label="Output mode for pages"]',
        )?.disabled).toBe(true);
        expect(harness.host.textContent).toContain(
            'Per-page output mode is unavailable because preserving original quality forces color.',
        );
        settings.preserveOriginalQuality = false;
        await nextTick();

        expect(harness.host.querySelectorAll('[data-margin-side]')).toHaveLength(4);
        const leftMarginField = harness.host.querySelector<HTMLInputElement>('[data-margin-side="leftMm"]')!;
        expect(harness.host.querySelector('[data-override-marker="margins"]')).toBeNull();
        leftMarginField.value = '11';
        leftMarginField.dispatchEvent(new Event('input', {bubbles: true}));
        leftMarginField.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(updateSelectionMargins).toHaveBeenCalledWith('leftMm', 11, [2]);
        expect(harness.host.querySelector('[data-override-marker="margins"]')).not.toBeNull();
        const resetMarginsButton = harness.host.querySelector<HTMLButtonElement>('[data-reset-override="margins"]');
        expect(resetMarginsButton?.getAttribute('aria-label')).toBe('Reset to document');
        resetMarginsButton?.click();
        await nextTick();
        expect(resetControlOverride).toHaveBeenCalledWith('margins', [2]);
        expect(harness.host.querySelector('[data-override-marker="margins"]')).toBeNull();
        expect(harness.host.querySelector('[data-reset-override="margins"]')).toBeNull();
        expect(harness.host.querySelector<HTMLInputElement>('[data-margin-side="leftMm"]')?.value).toBe('5');

        expect(harness.host.textContent).toContain('Copy this page\'s settings to…');
        expect(harness.host.querySelector('[role="menu"]')?.textContent).toContain('Copy to');
        Array.from(harness.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
            .find(item => item.textContent === 'Every other page')
            ?.click();
        expect(applyLeaderOverrides).toHaveBeenCalledWith('every-other');
        const resetOverridesButton = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.textContent?.trim() === 'Reset this page…');
        expect(resetOverridesButton).not.toBeUndefined();
        expect(resetOverridesButton?.closest('.scan-thumbnail-rail-header')).toBeNull();
        harness.host.querySelector<HTMLButtonElement>('.scan-cleanup-reset-confirmation button:last-child')?.click();
        expect(resetScopeOverrides).toHaveBeenCalledWith([2]);
        expect(resetPageOverrides).not.toHaveBeenCalled();
        await nextTick();
        expect(Array.from(harness.host.querySelectorAll<HTMLButtonElement>('button'))
            .some(button => button.textContent?.trim() === 'Reset this page…')).toBe(false);
    });

    it('keeps a canceled detection provisional until a later re-detection completes', async () => {
        const terminalStatus = ref<'running' | 'cancelled' | 'completed'>('running');
        const transitionKey = ref('session-1:page-1:user-0');
        const result = shallowRef(spreadPreviewResult());
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            resultCurrent: true,
            resultPresentationKey: transitionKey.value,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            layoutDetectionComplete: terminalStatus.value === 'completed',
            alignment: 'top-center',
            pageNumber: requirePageNumber(1),
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));
        const caption = () => harness.host.querySelector<HTMLElement>('.preview-viewport-caption');

        // Detection is still running, so the rectangle every page is drawn on
        // can still change — the preview says so instead of relaying out later
        // with no explanation.
        expect(caption()?.dataset.canvasNotice).toBe('provisional');
        expect(caption()?.textContent).toContain('scanCleanup.preview.matchedCanvasProvisional');

        // Cancellation is terminal for the worker but is not completion of the
        // document plan, so it cannot cross the presentation phase edge.
        terminalStatus.value = 'cancelled';
        await nextTick();
        expect(caption()?.dataset.canvasNotice).toBe('provisional');

        // A settings change and its current preview still remain provisional
        // after cancellation.
        transitionKey.value = 'session-1:page-1:user-1';
        const cancelledReplan = structuredClone(result.value);
        cancelledReplan.outputs = cancelledReplan.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                canvasPolicy: 'intrinsic',
            },
        }));
        result.value = cancelledReplan;
        await nextTick();
        await loadPendingCleanedFrame(harness.host);
        expect(caption()?.dataset.canvasNotice).toBe('provisional');

        // A later genuine re-detection completion can still commit the first
        // settled candidate on that same user transition.
        terminalStatus.value = 'running';
        await nextTick();
        const settledResult = structuredClone(cancelledReplan);
        settledResult.outputs = settledResult.outputs.map(output => ({
            ...output,
            imageData: new Uint8Array([9]),
        }));
        terminalStatus.value = 'completed';
        result.value = settledResult;
        await nextTick();
        expect(caption()?.dataset.canvasNotice).toBe('provisional');
        await loadPendingCleanedFrame(harness.host);
        expect(caption()?.dataset.canvasNotice).toBe('unavailable');
        expect(caption()?.textContent).toContain('scanCleanup.preview.matchedCanvasUnavailable');

        // Detection settled and the canvas held: nothing to explain, and the
        // caption line stays where it was.
        const userResult = structuredClone(result.value);
        userResult.outputs = userResult.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                canvasPolicy: 'strict-maximum',
            },
        }));
        result.value = userResult;
        transitionKey.value = 'session-1:page-1:user-2';
        await nextTick();
        await loadPendingCleanedFrame(harness.host);
        expect(caption()?.dataset.canvasNotice).toBe('');
        expect(caption()?.textContent?.trim()).toBe('');
        expect(caption()).not.toBeNull();
    });

    it('shows the delivered margin boundary only while the margin control is active', async () => {
        const showMarginBoundary = ref(false);
        const result = spreadPreviewResult();
        result.outputs = result.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                appliedMargins: {
                    leftPx: 20,
                    topPx: 30,
                    rightPx: 40,
                    bottomPx: 50,
                },
            },
        }));
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: requirePageNumber(1),
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
            showMarginBoundary: showMarginBoundary.value,
        })}));

        expect(harness.host.querySelector('.margin-boundary-overlay')).toBeNull();
        showMarginBoundary.value = true;
        await nextTick();

        const boundary = harness.host.querySelector<HTMLElement>('.margin-boundary-overlay');
        expect(boundary?.style.left).toBe('4%');
        expect(boundary?.style.top).toBe('3.75%');
        expect(boundary?.style.right).toBe('8%');
        expect(boundary?.style.bottom).toBe('6.25%');
    });

    it('reports when focus enters and leaves the margin controls', () => {
        const marginInteraction = vi.fn();
        const settings = reactive({
            preserveOriginalQuality: false,
            layoutMode: 'auto' as const,
            outputMode: 'bw' as const,
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'center' as const,
            marginsMm: {
                leftMm: 5,
                topMm: 5,
                rightMm: 5,
                bottomMm: 5,
            },
            despeckle: true,
            skipBlankPages: false,
            pageOverrides: {},
        });
        const harness = mount(defineComponent({setup: () => () => h(
            ScanCleanupSettingsPanel,
            Object.assign({}, settingsPanelProps(settings, 'all'), {onMarginInteraction: marginInteraction}),
        )}));
        const control = harness.host.querySelector('.scan-cleanup-margins-control');

        control?.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
        control?.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));

        expect(marginInteraction).toHaveBeenNthCalledWith(1, true);
        expect(marginInteraction).toHaveBeenNthCalledWith(2, false);
    });

    it('shows a friendly retry state with raw details collapsed', () => {
        const rawError = 'Error: An object could not be cloned.';
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: null,
            loading: false,
            error: rawError,
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: requirePageNumber(1),
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        const errorState = harness.host.querySelector('.preview-message.is-error');
        expect(harness.host.querySelector('.preview-skeleton-page')).toBeNull();
        expect(errorState?.textContent).toContain('Preview isn\'t available. You can still run cleanup.');
        expect(errorState?.querySelector('button')?.textContent).toContain('Retry');
        const details = errorState?.querySelector('details');
        expect(details?.hasAttribute('open')).toBe(false);
        expect(details?.querySelector('.preview-error-detail')?.textContent).toBe(rawError);
        expect(Array.from(errorState?.children ?? [])
            .filter(child => child.tagName !== 'DETAILS')
            .some(child => child.textContent?.includes(rawError))).toBe(false);
    });

    it('keeps Original renderable and confines a cleaned-preview failure to Cleaned', async () => {
        const viewMode = ref<'original' | 'cleaned'>('original');
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: null,
            rawResult: {
                pageNumber: 1,
                totalPages: 3,
                rawImageData: new Uint8Array([1]),
                rawWidthPx: 100,
                rawHeightPx: 150,
            },
            loading: false,
            error: 'invalid cleaned preview metadata',
            viewMode: viewMode.value,
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        expect(harness.host.querySelector('[data-testid="scan-cleanup-original-only"]')).not.toBeNull();
        expect(harness.host.querySelector('[role="alert"]')).toBeNull();
        const overlayHelp = harness.host.querySelector('.preview-overlay-help-trigger');
        expect(overlayHelp).not.toBeNull();
        expect(harness.host.querySelector('.overlay-legend')).toBeNull();

        viewMode.value = 'cleaned';
        await nextTick();

        expect(harness.host.querySelector('[data-testid="scan-cleanup-original-only"]')).toBeNull();
        expect(harness.host.querySelector('[role="alert"]')?.textContent)
            .toContain('Preview isn\'t available. You can still run cleanup.');
        expect(harness.host.querySelector('.preview-overlay-help-trigger')).toBe(overlayHelp);
    });

    it('shows dismissible first-run guidance inline over the reserved preview surface', () => {
        const dismiss = vi.fn();
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: null,
            loading: true,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
            showFirstRunGuidance: true,
            onDismissFirstRunGuidance: dismiss,
        })}));

        const guidance = harness.host.querySelector('.scan-cleanup-first-run-guidance');
        expect(guidance?.closest('.preview-surface')).not.toBeNull();
        expect(guidance?.textContent).toContain('Pages are detected automatically.');
        expect(guidance?.textContent).toContain('Review pages');
        expect(guidance?.textContent).toContain('the original is untouched');
        guidance?.querySelector<HTMLButtonElement>('button')?.click();
        expect(dismiss).toHaveBeenCalledOnce();
    });

    it('replaces a previous page with the requested page topology while navigating', () => {
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(1),
            loading: true,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 2,
            totalPages: 3,
            stalePage: true,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        expect(harness.host.querySelector('.preview-surface')?.classList.contains('is-stale-page')).toBe(true);
        expect(harness.host.querySelector('.cutter-stage')?.classList.contains('is-stale-content')).toBe(false);
        expect(harness.host.querySelector('.page-loading-overlay')).toBeNull();
        expect(harness.host.querySelector('.preview-viewport-caption')?.textContent)
            .toBe('Building cleanup preview…');
        expect(harness.host.querySelector('.refresh-indicator')).toBeNull();
    });

    it('keeps the last rendered frame while the current page topology refreshes', () => {
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(1),
            loading: true,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            layoutClassification: 'single-uncut-page',
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        expect(harness.host.querySelector('.preview-result-layer')).not.toBeNull();
        expect(harness.host.querySelector('.preview-skeleton-page')).toBeNull();
        expect(harness.host.querySelector('.refresh-indicator')).not.toBeNull();
    });

    it('publishes cleaned pixels, canvas geometry, and content overlays as one loaded frame', async () => {
        const initial = spreadPreviewResult(1);
        for (const output of initial.outputs) {
            output.metadata.contentBox = {
                xPx: 10,
                yPx: 20,
                widthPx: 400,
                heightPx: 700,
            };
        }
        const fresh = structuredClone(initial);
        for (const output of fresh.outputs) {
            output.imageData = new Uint8Array([2]);
            output.metadata.canvasWidthPx = 640;
            output.metadata.canvasHeightPx = 900;
            output.metadata.contentBox = {
                xPx: 80,
                yPx: 100,
                widthPx: 300,
                heightPx: 500,
            };
        }
        const result = ref(initial);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            loading: true,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));
        const frameWidths = () => [...harness.host.querySelectorAll('.uniform-canvas')]
            .map(element => element.getAttribute('data-frame-width'));
        const contentStyle = () => harness.host.querySelector<HTMLElement>('.content-overlay')
            ?.getAttribute('style');
        const initialContentStyle = contentStyle();

        expect(frameWidths()).toEqual([
            '500',
            '500',
        ]);
        result.value = fresh;
        await nextTick();

        const pending = [...harness.host.querySelectorAll<HTMLImageElement>('.preview-cleaned-pixel-preload')];
        expect(pending).toHaveLength(2);
        expect(frameWidths()).toEqual([
            '500',
            '500',
        ]);
        expect(contentStyle()).toBe(initialContentStyle);

        pending[0]?.dispatchEvent(new Event('load'));
        await nextTick();
        expect(frameWidths()).toEqual([
            '500',
            '500',
        ]);

        pending[1]?.dispatchEvent(new Event('load'));
        await nextTick();
        expect(frameWidths()).toEqual([
            '640',
            '640',
        ]);
        expect(contentStyle()).not.toBe(initialContentStyle);
        expect(harness.host.querySelector('.preview-cleaned-pixel-preload')).toBeNull();
    });

    it('keeps native placement pinned to the displayed generation while its blob URL is unchanged', async () => {
        const result = spreadPreviewResult(1);
        for (const output of result.outputs) {
            Object.assign(output.metadata, {
                canvasHeightPx: 1_000,
                outputHeightPx: 500,
                placementOffsetYPx: 20,
            });
        }
        const resultCurrent = ref(true);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result,
            resultCurrent: resultCurrent.value,
            resultPresentationKey: 'session-1:page-1:user-0',
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'bottom-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));
        const image = () => harness.host.querySelector<HTMLElement>('.placed-image')!;
        const initialUrl = image().querySelector<HTMLImageElement>('.cleaned-image')!.src;
        const initialTop = image().style.top;

        resultCurrent.value = false;
        await nextTick();

        expect(image().querySelector<HTMLImageElement>('.cleaned-image')!.src).toBe(initialUrl);
        expect(image().style.top).toBe(initialTop);
        expect(Number.parseFloat(initialTop)).toBeCloseTo(2);
    });

    it('keeps native placement while live changes label the displayed raster stale', async () => {
        const result = shallowRef(spreadPreviewResult(1));
        for (const output of result.value.outputs) {
            Object.assign(output.metadata, {
                canvasHeightPx: 1_000,
                canvasWidthPx: 1_000,
                outputHeightPx: 500,
                outputWidthPx: 500,
            });
        }
        const alignment = ref<TScanCleanupPageAlignment>('top-left');
        const matchPageSize = ref(true);
        const resultCurrent = ref(true);
        const readingOrder = ref<'ltr' | 'rtl'>('ltr');
        const manualContentBoxes = ref<Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>>({left: {
            xNormalized: 0.1,
            yNormalized: 0.1,
            widthNormalized: 0.7,
            heightNormalized: 0.7,
            rotationDegrees: 0,
        }});
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            resultCurrent: resultCurrent.value,
            resultPresentationKey: 'session-1:page-1:user-0',
            layoutDetectionComplete: true,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: matchPageSize.value,
            alignment: alignment.value,
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            manualContentBoxes: manualContentBoxes.value,
            readingOrder: readingOrder.value,
        })}));
        const outputOrder = () => [...harness.host.querySelectorAll('.output-fit-area')]
            .map(element => element.getAttribute('data-output-half'));
        const initialImageStyle = harness.host.querySelector<HTMLElement>('.placed-image')!.getAttribute('style');
        const initialContentStyle = harness.host.querySelector<HTMLElement>('.content-overlay')!.getAttribute('style');
        const canvasNotice = () => harness.host.querySelector<HTMLElement>('.preview-viewport-caption')
            ?.dataset.canvasNotice;
        expect(canvasNotice()).toBe('');

        alignment.value = 'bottom-right';
        resultCurrent.value = false;
        readingOrder.value = 'rtl';
        manualContentBoxes.value = {left: {
            xNormalized: 0.2,
            yNormalized: 0.2,
            widthNormalized: 0.5,
            heightNormalized: 0.5,
            rotationDegrees: 0,
        }};
        await nextTick();

        expect(outputOrder()).toEqual([
            'right',
            'left',
        ]);
        expect(harness.host.querySelector('.uniform-canvas')?.classList).toContain('has-uniform-canvas');
        expect(harness.host.querySelector<HTMLElement>('.placed-image')!.getAttribute('style'))
            .toBe(initialImageStyle);
        expect(harness.host.querySelector<HTMLElement>('.content-overlay')!.getAttribute('style'))
            .not.toBe(initialContentStyle);
        expect(canvasNotice()).toBe('updating');
        expect(harness.host.querySelector('.preview-viewport-caption')?.textContent)
            .toContain('scanCleanup.preview.updatingPreviousPlacement');

        matchPageSize.value = false;
        await nextTick();
        expect(harness.host.querySelector('.uniform-canvas')?.classList).not.toContain('has-uniform-canvas');
        expect(canvasNotice()).toBe('updating');
    });

    it('coalesces provisional churn, commits the first settled frame, and pins later replans', async () => {
        vi.useFakeTimers();
        try {
            const result = shallowRef(spreadPreviewResult(1));
            const detectionComplete = ref(false);
            const transitionKey = ref('session-1:page-1:user-0');
            const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
                result: result.value,
                resultCurrent: true,
                resultPresentationKey: transitionKey.value,
                layoutDetectionComplete: detectionComplete.value,
                loading: false,
                error: '',
                viewMode: 'cleaned',
                matchPageSize: true,
                alignment: 'top-center',
                pageNumber: 1,
                totalPages: 3,
                manualSplit: null,
                readingOrder: 'ltr',
            })}));
            const frameWidth = () => harness.host.querySelector<HTMLElement>('.uniform-canvas')!.dataset.frameWidth;
            const displayedUrl = () => harness.host.querySelector<HTMLImageElement>('.cleaned-image')!.src;
            const canvasNotice = () => harness.host.querySelector<HTMLElement>(
                '.preview-viewport-caption',
            )?.dataset.canvasNotice;
            const initialUrl = displayedUrl();
            expect(canvasNotice()).toBe('provisional');

            const firstProvisionalReplan = structuredClone(result.value);
            for (const output of firstProvisionalReplan.outputs) {
                output.imageData = new Uint8Array([2]);
                output.metadata.canvasWidthPx = 600;
            }
            result.value = firstProvisionalReplan;
            await nextTick();
            await loadPendingCleanedFrame(harness.host);
            expect(frameWidth()).toBe('500');
            expect(displayedUrl()).toBe(initialUrl);

            const latestProvisionalReplan = structuredClone(firstProvisionalReplan);
            for (const output of latestProvisionalReplan.outputs) {
                output.imageData = new Uint8Array([3]);
                output.metadata.canvasWidthPx = 700;
            }
            result.value = latestProvisionalReplan;
            await nextTick();
            await loadPendingCleanedFrame(harness.host);
            expect(frameWidth()).toBe('500');
            expect(displayedUrl()).toBe(initialUrl);

            // Elapsed wall time cannot consume the settle allowance.
            await vi.advanceTimersByTimeAsync(10_000);
            await nextTick();
            expect(frameWidth()).toBe('500');

            const firstSettledResult = structuredClone(latestProvisionalReplan);
            for (const output of firstSettledResult.outputs) {
                output.imageData = new Uint8Array([4]);
                output.metadata.canvasWidthPx = 800;
            }
            detectionComplete.value = true;
            result.value = firstSettledResult;
            await nextTick();
            expect(frameWidth()).toBe('500');
            await loadPendingCleanedFrame(harness.host);
            expect(frameWidth()).toBe('800');
            expect(canvasNotice()).toBe('');
            const settledUrl = displayedUrl();
            expect(settledUrl).not.toBe(initialUrl);

            const secondSettledReplan = structuredClone(firstSettledResult);
            for (const output of secondSettledReplan.outputs) {
                output.imageData = new Uint8Array([5]);
                output.metadata.canvasWidthPx = 900;
            }
            result.value = secondSettledReplan;
            await nextTick();
            await loadPendingCleanedFrame(harness.host);
            expect(harness.host.querySelector('.preview-cleaned-pixel-preload')).toBeNull();
            expect(frameWidth()).toBe('800');
            expect(displayedUrl()).toBe(settledUrl);
            expect(canvasNotice()).toBe('');

            const surface = harness.host.querySelector<HTMLElement>('.preview-surface')!;
            surface.click();
            surface.dispatchEvent(new Event('scroll'));
            const zoomButtons = harness.host.querySelectorAll<HTMLButtonElement>('.preview-zoom-button');
            expect(zoomButtons.length).toBeGreaterThan(1);
            zoomButtons[1]!.click();
            const cutter = harness.host.querySelector<HTMLElement>('.cutter-control')!;
            mockPointerCapture(cutter);
            cutter.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true,
                clientX: 0,
                clientY: 0,
                pointerId: 17,
            }));
            await nextTick();
            await loadPendingCleanedFrame(harness.host);
            expect(frameWidth()).toBe('800');
            expect(displayedUrl()).toBe(settledUrl);

            const laterAutomatic = structuredClone(secondSettledReplan);
            for (const output of laterAutomatic.outputs) {
                output.imageData = new Uint8Array([6]);
                output.metadata.canvasWidthPx = 1_000;
            }
            result.value = laterAutomatic;
            await nextTick();
            await loadPendingCleanedFrame(harness.host);
            expect(frameWidth()).toBe('800');
            expect(displayedUrl()).toBe(settledUrl);

            transitionKey.value = 'session-1:page-1:user-1';
            await nextTick();
            await loadPendingCleanedFrame(harness.host);
            expect(frameWidth()).toBe('1000');
            expect(displayedUrl()).not.toBe(settledUrl);
        } finally {
            vi.useRealTimers();
        }
    });

    it('derives displayed-frame currentness from publication identity after rejecting a replan', async () => {
        const result = shallowRef(spreadPreviewResult(1));
        const detailResult = shallowRef(structuredClone(result.value));
        const detectionComplete = ref(false);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            detailResult: detailResult.value,
            resultCurrent: true,
            resultPresentationKey: 'session-1:page-1:user-0',
            layoutDetectionComplete: detectionComplete.value,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));
        const surface = harness.host.querySelector<HTMLElement>('.preview-surface')!;
        surface.dispatchEvent(previewZoomWheel({
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
            deltaY: -1_200,
            metaKey: true,
        }));
        await nextTick();
        expect(harness.host.querySelectorAll('.preview-detail-pixel')).toHaveLength(2);

        const settledLoading = structuredClone(result.value);
        for (const output of settledLoading.outputs) {
            output.imageData = new Uint8Array([2]);
            output.metadata.canvasWidthPx = 800;
        }
        detectionComplete.value = true;
        result.value = settledLoading;
        detailResult.value = structuredClone(settledLoading);
        await nextTick();

        const rejectedReplan = structuredClone(settledLoading);
        for (const output of rejectedReplan.outputs) {
            output.imageData = new Uint8Array([3]);
            output.metadata.canvasWidthPx = 900;
        }
        result.value = rejectedReplan;
        detailResult.value = structuredClone(rejectedReplan);
        await nextTick();
        await loadPendingCleanedFrame(harness.host);

        expect(harness.host.querySelector<HTMLElement>('.uniform-canvas')?.dataset.frameWidth).toBe('800');
        expect(harness.host.querySelectorAll('.preview-detail-pixel')).toHaveLength(0);
    });

    it('reopens the settled phase after preload decode failure and accepts the next result', async () => {
        const result = shallowRef(spreadPreviewResult(1));
        const detectionComplete = ref(false);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            resultCurrent: true,
            resultPresentationKey: 'session-1:page-1:user-0',
            layoutDetectionComplete: detectionComplete.value,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));
        const frameWidth = () => harness.host.querySelector<HTMLElement>('.uniform-canvas')?.dataset.frameWidth;

        const failingSettled = structuredClone(result.value);
        for (const output of failingSettled.outputs) {
            output.imageData = new Uint8Array([2]);
            output.metadata.canvasWidthPx = 800;
        }
        detectionComplete.value = true;
        result.value = failingSettled;
        await nextTick();
        const failingPreload = harness.host.querySelector<HTMLImageElement>('.preview-cleaned-pixel-preload')!;

        const competingSettled = structuredClone(failingSettled);
        for (const output of competingSettled.outputs) {
            output.imageData = new Uint8Array([3]);
            output.metadata.canvasWidthPx = 900;
        }
        result.value = competingSettled;
        await nextTick();
        expect(harness.host.querySelector<HTMLImageElement>('.preview-cleaned-pixel-preload')?.src)
            .toBe(failingPreload.src);

        failingPreload.dispatchEvent(new Event('error'));
        await nextTick();
        expect(frameWidth()).toBe('500');
        expect(harness.host.querySelector('.preview-refresh-error')?.textContent)
            .toContain('Failed to decode the cleaned preview image.');
        expect(harness.host.querySelector('.preview-cleaned-pixel-preload')).toBeNull();

        const recoveredSettled = structuredClone(competingSettled);
        for (const output of recoveredSettled.outputs) {
            output.imageData = new Uint8Array([4]);
            output.metadata.canvasWidthPx = 1_000;
        }
        result.value = recoveredSettled;
        await nextTick();
        expect(harness.host.querySelector('.preview-refresh-error')).toBeNull();
        await loadPendingCleanedFrame(harness.host);
        expect(frameWidth()).toBe('1000');
    });

    it('reveals the latest pinned frame atomically through the run gate', async () => {
        const result = shallowRef(spreadPreviewResult(1));
        const previewPane = ref<{revealLatestFrame: () => Promise<void>} | null>(null);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            ref: previewPane,
            result: result.value,
            resultCurrent: true,
            resultPresentationKey: 'session-1:page-1:user-0',
            layoutDetectionComplete: true,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));
        const frameWidth = () => harness.host.querySelector<HTMLElement>('.uniform-canvas')!.dataset.frameWidth;
        const displayedUrl = () => harness.host.querySelector<HTMLImageElement>('.cleaned-image')!.src;
        const initialUrl = displayedUrl();

        const latest = structuredClone(result.value);
        for (const output of latest.outputs) {
            output.imageData = new Uint8Array([8]);
            output.metadata.canvasWidthPx = 800;
        }
        result.value = latest;
        await nextTick();

        expect(frameWidth()).toBe('500');
        expect(displayedUrl()).toBe(initialUrl);
        expect(harness.host.querySelector('.preview-cleaned-pixel-preload')).toBeNull();
        expect(harness.host.querySelector<HTMLElement>('.preview-viewport-caption')?.dataset.canvasNotice)
            .toBe('');

        const revealed = previewPane.value!.revealLatestFrame();
        await nextTick();
        expect(harness.host.querySelector('.preview-cleaned-pixel-preload')).not.toBeNull();
        await loadPendingCleanedFrame(harness.host);
        await revealed;

        expect(frameWidth()).toBe('800');
        expect(displayedUrl()).not.toBe(initialUrl);
        expect(harness.host.querySelector<HTMLElement>('.preview-viewport-caption')?.dataset.canvasNotice)
            .toBe('');
    });

    it('never presents the requested raw sheet as a cleaned output while its result is pending', () => {
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(1),
            rawResult: rawPreviewResult(2),
            loading: true,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 2,
            totalPages: 3,
            stalePage: true,
            layoutClassification: 'two-page-spread',
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        expect(harness.host.querySelector('.raw-preview')).toBeNull();
        const loadingOutputs = harness.host.querySelector('.preview-skeleton-outputs');
        expect(loadingOutputs?.classList).toContain('is-spread');
        expect(loadingOutputs?.querySelectorAll('.preview-skeleton-page')).toHaveLength(2);
        expect(harness.host.querySelector('.page-loading-overlay')).toBeNull();
        expect(harness.host.querySelector('.preview-surface')?.classList.contains('is-stale-page')).toBe(true);
        expect(harness.host.querySelector('.cutter-stage')?.classList.contains('is-stale-content')).toBe(false);
        const caption = harness.host.querySelector('.preview-viewport-caption');
        expect(caption?.textContent).toBe('Building cleanup preview…');
        expect(harness.host.querySelector('.drag-overlay-layer')).toBeNull();
    });

    it('does not keep the previous page ghost while the requested page is pending', () => {
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(1),
            rawResult: rawPreviewResult(1),
            loading: true,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 2,
            totalPages: 3,
            stalePage: true,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        expect(harness.host.querySelector('.raw-preview')).toBeNull();
        expect(harness.host.querySelector('.cutter-stage')?.classList.contains('is-stale-content')).toBe(false);
        expect(harness.host.querySelector('.page-loading-overlay')).toBeNull();
        expect(harness.host.querySelector('.preview-viewport-caption')?.textContent)
            .toBe('Building cleanup preview…');
    });

    it('never shows a previous page raw raster in Original view', () => {
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(1),
            rawResult: rawPreviewResult(1),
            loading: true,
            error: '',
            viewMode: 'original',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 2,
            totalPages: 3,
            stalePage: true,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        expect(harness.host.querySelector('.raw-preview')).toBeNull();
        expect(harness.host.querySelector('.page-loading-overlay')?.textContent).toContain('Loading page 2…');
        harness.unmount();
    });

    it('replaces the topology-aware loading shell with the requested cleaned result', async () => {
        const result = shallowRef<IScanCleanupPreviewResult | null>(spreadPreviewResult(1));
        const loading = ref(true);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            rawResult: rawPreviewResult(2),
            loading: loading.value,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 2,
            totalPages: 3,
            stalePage: result.value?.pageNumber !== 2,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        const loadingStage = harness.host.querySelector('.cutter-stage');
        expect(harness.host.querySelector('.raw-preview')).toBeNull();
        expect(harness.host.querySelector('.preview-skeleton-outputs')).not.toBeNull();

        result.value = spreadPreviewResult(2);
        loading.value = false;
        await nextTick();
        await loadPendingCleanedFrame(harness.host);

        expect(harness.host.querySelector('.cutter-stage')).not.toBe(loadingStage);
        const previousRaw = harness.host.querySelector('.raw-preview');
        expect(previousRaw?.getAttribute('aria-hidden')).toBe('true');
        expect(previousRaw?.classList).not.toContain('is-visible');
        expect(harness.host.querySelector('.cleaned-outputs')).not.toBeNull();
        expect(harness.host.querySelector('.preview-viewport-caption')?.textContent?.trim()).toBe('');
    });

    it('leaves Original mode and cleaned-preview failures untouched while a page loads', async () => {
        const viewMode = ref<'original' | 'cleaned'>('original');
        const error = ref('');
        const result = spreadPreviewResult(1);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result,
            rawResult: rawPreviewResult(2),
            loading: true,
            error: error.value,
            viewMode: viewMode.value,
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 2,
            totalPages: 3,
            stalePage: true,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        expect(harness.host.querySelector<HTMLImageElement>('.raw-preview .preview-pixel')?.alt)
            .toBe('Original scan preview for page 1');
        expect(harness.host.querySelector('.preview-viewport-caption')?.getAttribute('aria-hidden')).toBe('true');
        expect(harness.host.querySelector('.page-loading-overlay')?.textContent).toContain('Loading page 2…');

        viewMode.value = 'cleaned';
        error.value = 'cleaned preview failed';
        await nextTick();

        expect(harness.host.querySelector('.raw-preview')).toBeNull();
        expect(harness.host.querySelector('.preview-refresh-error')?.textContent)
            .toContain('Preview isn\'t available. You can still run cleanup.');
    });

    it('removes visual half labels while preserving each output half in image alternatives', () => {
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(2),
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 2,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));
        const images = Array.from(harness.host.querySelectorAll<HTMLImageElement>('.cleaned-image'));

        expect(harness.host.querySelector('.half-label')).toBeNull();
        expect(images.map(image => image.alt)).toEqual([
            'Cleaned scan preview for page 2, left half',
            'Cleaned scan preview for page 2, right half',
        ]);
    });

    it('shows the original page with crop overlays and a single Preview state in lossless mode', async () => {
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            right: 1000,
            top: 0,
            bottom: 800,
            width: 1000,
            height: 800,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        try {
            const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
                result: spreadPreviewResult(2),
                loading: false,
                error: '',
                viewMode: 'cleaned',
                matchPageSize: true,
                alignment: 'top-center',
                pageNumber: 2,
                totalPages: 3,
                manualSplit: null,
                readingOrder: 'ltr',
                lossless: true,
            })}));
            await nextTick();

            const comparison = harness.host.querySelectorAll<HTMLElement>('[role="radiogroup"]')[0]!;
            expect(Array.from(comparison.querySelectorAll('[role="radio"]')).map(option => option.textContent)).toEqual(['Preview']);
            expect(harness.host.querySelector('.raw-preview')).not.toBeNull();
            expect(harness.host.querySelector('.cleaned-outputs')).toBeNull();
            expect(harness.host.querySelectorAll('.lossless-crop-overlay')).toHaveLength(2);
        } finally {
            rect.mockRestore();
        }
    });

    it('zooms a 150-DPI preview around the wheel cursor', async () => {
        const harness = mountPreviewZoomHarness();
        expect(harness.host.querySelector('.preview-zoom-value')?.getAttribute('aria-label'))
            .toBe('Zoom Fit, toggle fit and 100%');
        const wheel = previewZoomWheel({
            bubbles: true,
            cancelable: true,
            clientX: 400,
            clientY: 200,
            deltaY: -240,
            metaKey: true,
        });
        Object.defineProperties(wheel, {
            clientX: {value: 400},
            clientY: {value: 200},
        });

        harness.surface.dispatchEvent(wheel);
        await nextTick();

        expect(wheel.defaultPrevented).toBe(true);
        expect(harness.surface.dataset.previewZoomMode).toBe('custom');
        expect(Number(harness.surface.dataset.previewZoomPercent)).toBeGreaterThan(50);
        expect(harness.stage.style.transform).toMatch(/translate3d\(-\d/);
        expect(Number(harness.stage.style.transform.match(/scale\(([\d.]+)/u)?.[1])).toBeGreaterThan(1);
        const zoomPastActualSize = previewZoomWheel({
            bubbles: true,
            cancelable: true,
            clientX: 400,
            clientY: 200,
            deltaY: -400,
            metaKey: true,
        });
        Object.defineProperties(zoomPastActualSize, {
            clientX: {value: 400},
            clientY: {value: 200},
        });
        harness.surface.dispatchEvent(zoomPastActualSize);
        await nextTick();
        expect(Number(harness.surface.dataset.previewZoomPercent)).toBeGreaterThan(100);
    });

    it('removes preview hover and gesture affordances while cleanup is running', async () => {
        const harness = mountPreviewZoomHarness({disabled: true});
        const wheel = previewZoomWheel({
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
            deltaY: -240,
            metaKey: true,
        });
        const doubleClick = new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        });

        harness.surface.dispatchEvent(wheel);
        harness.surface.dispatchEvent(doubleClick);
        await nextTick();

        expect(harness.surface.classList).toContain('is-disabled');
        expect(harness.surface.classList).not.toContain('can-pan-preview');
        expect(harness.surface.getAttribute('aria-disabled')).toBe('true');
        expect(harness.surface.dataset.previewZoomMode).toBe('fit');
        expect(wheel.defaultPrevented).toBe(false);
        expect(doubleClick.defaultPrevented).toBe(false);
        expect(harness.host.querySelector<HTMLElement>('.preview-pane')?.getAttribute('tabindex')).toBe('-1');
        expect(Array.from(harness.host.querySelectorAll<HTMLButtonElement>('.preview-zoom-button, .preview-zoom-value'))
            .every(button => button.disabled)).toBe(true);
        const tooltipRoots = Array.from(harness.host.querySelectorAll<HTMLElement>('[data-tooltip-root]'));
        expect(tooltipRoots.length).toBeGreaterThan(0);
        expect(tooltipRoots.every(root => root.dataset.tooltipDisabled === 'true')).toBe(true);
    });

    it('cancels an active preview pan when cleanup becomes disabled', async () => {
        const harness = mountPreviewZoomHarness();
        harness.surface.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        }));
        await nextTick();
        harness.surface.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 250,
            clientY: 200,
            pointerId: 61,
        }));
        harness.surface.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: 300,
            clientY: 225,
            pointerId: 61,
        }));
        await nextTick();
        expect(harness.surface.classList).toContain('is-panning-preview');

        harness.disabled.value = true;
        await nextTick();
        const transformAfterDisable = harness.stage.style.transform;
        expect(harness.pointerCapture.releasePointerCapture).toHaveBeenCalledWith(61);
        expect(harness.surface.classList).not.toContain('is-panning-preview');

        harness.surface.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: 350,
            clientY: 250,
            pointerId: 61,
        }));
        expect(harness.stage.style.transform).toBe(transformAfterDisable);
    });

    it('cancels active cutter, content-box, and placement drags when cleanup becomes disabled', async () => {
        const cutterHarness = mountPreviewZoomHarness();
        const cutter = cutterHarness.host.querySelector<HTMLButtonElement>('.cutter-control')!;
        const cutterCapture = mockPointerCapture(cutter);
        cutter.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 300,
            clientY: 200,
            pointerId: 62,
        }));
        cutterHarness.disabled.value = true;
        await nextTick();
        expect(cutterCapture.releasePointerCapture).toHaveBeenCalledWith(62);

        const contentResult = spreadPreviewResult();
        contentResult.outputs[0]!.metadata = {
            ...contentResult.outputs[0]!.metadata,
            contentBox: {
                heightPx: 600,
                widthPx: 350,
                xPx: 50,
                yPx: 100,
            },
        };
        const contentHarness = mountPreviewZoomHarness({
            result: contentResult,
            viewMode: 'cleaned',
        });
        const contentHandle = contentHarness.host.querySelector<HTMLButtonElement>('.content-handle')!;
        const contentCapture = mockPointerCapture(contentHandle);
        contentHandle.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 200,
            clientY: 200,
            pointerId: 63,
        }));
        contentHarness.disabled.value = true;
        await nextTick();
        expect(contentCapture.releasePointerCapture).toHaveBeenCalledWith(63);

        const placementHarness = mountPreviewZoomHarness({viewMode: 'cleaned'});
        const placement = placementHarness.host.querySelector<HTMLElement>('.placement-control')!;
        const placementCapture = mockPointerCapture(placement);
        placement.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 100,
            clientY: 100,
            pointerId: 64,
        }));
        placementHarness.disabled.value = true;
        await nextTick();
        expect(placementCapture.releasePointerCapture).toHaveBeenCalledWith(64);
    });

    it('keeps both step controls enabled at Fit and lets minus enter a smaller manual zoom', async () => {
        const harness = mountPreviewZoomHarness();
        await nextTick();
        const zoomOut = harness.host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]');
        const zoomIn = harness.host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');

        expect(harness.surface.dataset.previewZoomMode).toBe('fit');
        expect(harness.surface.dataset.previewZoomPercent).toBe('50');
        expect(zoomOut?.disabled).toBe(false);
        expect(zoomIn?.disabled).toBe(false);

        zoomOut?.click();
        await nextTick();

        expect(harness.surface.dataset.previewZoomMode).toBe('custom');
        expect(harness.surface.dataset.previewZoomPercent).toBe('25');
        expect(zoomOut?.disabled).toBe(true);
        expect(zoomIn?.disabled).toBe(false);
    });

    it('leaves plain and macOS platform-scroll wheel gestures to the shared viewer policy', async () => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
        Object.defineProperty(navigator, 'platform', {
            configurable: true,
            value: 'MacIntel',
        });
        try {
            const harness = mountPreviewZoomHarness();
            const plainWheel = new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                deltaY: -240,
            });
            const platformScroll = new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
                deltaY: -240,
            });

            harness.surface.dispatchEvent(plainWheel);
            harness.surface.dispatchEvent(platformScroll);
            await nextTick();

            expect(plainWheel.defaultPrevented).toBe(false);
            expect(platformScroll.defaultPrevented).toBe(false);
            expect(harness.surface.dataset.previewZoomMode).toBe('fit');
        } finally {
            if (platformDescriptor) {
                Object.defineProperty(navigator, 'platform', platformDescriptor);
            } else {
                Reflect.deleteProperty(navigator, 'platform');
            }
        }
    });

    it('accumulates fine wheel packets below fit without a zoom dead zone', async () => {
        const harness = mountPreviewZoomHarness();
        const firstPacket = previewZoomWheel({
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
            deltaY: -1,
            metaKey: true,
        });
        const secondPacket = previewZoomWheel({
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
            deltaY: -1,
            metaKey: true,
        });

        harness.surface.dispatchEvent(firstPacket);
        harness.surface.dispatchEvent(secondPacket);
        await nextTick();

        expect(firstPacket.defaultPrevented).toBe(true);
        expect(secondPacket.defaultPrevented).toBe(true);
        expect(harness.surface.dataset.previewZoomMode).toBe('custom');
        expect(Number(harness.surface.dataset.previewZoomPercent)).toBeGreaterThan(50);
    });

    it('keeps trailing packets in the shared modifier-wheel gesture', async () => {
        const harness = mountPreviewZoomHarness();
        const start = previewZoomWheel({
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
            deltaY: -240,
            metaKey: true,
        });
        const continuation = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
            deltaY: -240,
        });

        harness.surface.dispatchEvent(start);
        const firstZoom = Number(harness.surface.dataset.previewZoomPercent);
        harness.surface.dispatchEvent(continuation);
        await nextTick();

        expect(continuation.defaultPrevented).toBe(true);
        expect(Number(harness.surface.dataset.previewZoomPercent)).toBeGreaterThan(firstZoom);
    });

    it('keeps wheel and double-click zoom available while only the original raster is ready', async () => {
        const rawResult: IScanCleanupRawPreviewResult = {
            pageNumber: requirePageNumber(1),
            totalPages: 3,
            rawImageData: new Uint8Array([1]),
            rawWidthPx: 1_000,
            rawHeightPx: 800,
        };
        const wheelHarness = mountPreviewZoomHarness({
            rawResult,
            result: null,
        });
        const wheel = previewZoomWheel({
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
            deltaY: -240,
            metaKey: true,
        });
        wheelHarness.surface.dispatchEvent(wheel);
        await nextTick();

        expect(wheelHarness.host.querySelector('[data-testid="scan-cleanup-original-only"]')).not.toBeNull();
        expect(wheel.defaultPrevented).toBe(true);
        expect(wheelHarness.surface.dataset.previewZoomMode).toBe('custom');
        expect(Number(wheelHarness.surface.dataset.previewZoomPercent)).toBeGreaterThan(50);

        const doubleClickHarness = mountPreviewZoomHarness({
            rawResult,
            result: null,
        });
        doubleClickHarness.surface.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        }));
        await nextTick();

        expect(doubleClickHarness.surface.dataset.previewZoomMode).toBe('custom');
        expect(doubleClickHarness.surface.dataset.previewZoomPercent).toBe('100');
        expect(doubleClickHarness.stage.style.transform).toContain('scale(2)');
    });

    it('tracks display-density changes with a re-registered resolution media query', async () => {
        const originalMatchMedia = window.matchMedia;
        const originalDevicePixelRatio = window.devicePixelRatio;
        const queries: Array<{
            listener: ((event: MediaQueryListEvent) => void) | null;
            media: string;
            remove: ReturnType<typeof vi.fn>;
        }> = [];
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: 1,
        });
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            value: vi.fn((media: string) => {
                const query = {
                    listener: null as ((event: MediaQueryListEvent) => void) | null,
                    media,
                    remove: vi.fn(),
                };
                queries.push(query);
                return {
                    matches: true,
                    media,
                    onchange: null,
                    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
                        if (typeof listener === 'function') {
                            query.listener = listener as (event: MediaQueryListEvent) => void;
                        }
                    },
                    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
                        query.remove(listener);
                        if (typeof listener === 'function' && query.listener === listener) {
                            query.listener = null;
                        }
                    },
                    addListener: vi.fn(),
                    removeListener: vi.fn(),
                    dispatchEvent: vi.fn(),
                } satisfies MediaQueryList;
            }),
        });
        try {
            const harness = mountPreviewZoomHarness();
            await nextTick();
            expect(queries.map(query => query.media)).toEqual(['(resolution: 1dppx)']);

            Object.defineProperty(window, 'devicePixelRatio', {
                configurable: true,
                value: 2,
            });
            queries[0]?.listener?.({} as MediaQueryListEvent);
            await nextTick();

            expect(queries.map(query => query.media)).toEqual([
                '(resolution: 1dppx)',
                '(resolution: 2dppx)',
            ]);
            expect(queries[0]?.remove).toHaveBeenCalledOnce();

            harness.unmount();
            expect(queries[1]?.remove).toHaveBeenCalledOnce();
        } finally {
            Object.defineProperty(window, 'devicePixelRatio', {
                configurable: true,
                value: originalDevicePixelRatio,
            });
            Object.defineProperty(window, 'matchMedia', {
                configurable: true,
                value: originalMatchMedia,
            });
        }
    });

    it('debounces a non-blocking high-detail viewport request while keeping the base preview visible', async () => {
        vi.useFakeTimers();
        try {
            const requestDetail = vi.fn<(
                viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
            ) => void>();
            const harness = mountPreviewZoomHarness({
                onRequestDetail: requestDetail,
                result: rotatedSinglePreviewResult(),
                viewMode: 'cleaned',
            });
            const zoom = previewZoomWheel({
                bubbles: true,
                cancelable: true,
                clientX: 250,
                clientY: 200,
                deltaY: -1_200,
                metaKey: true,
            });
            Object.defineProperties(zoom, {
                clientX: {value: 250},
                clientY: {value: 200},
            });

            harness.surface.dispatchEvent(zoom);
            await nextTick();
            expect(Number(harness.surface.dataset.previewZoomPercent)).toBeGreaterThanOrEqual(150);
            expect(harness.host.querySelectorAll('.preview-detail-shimmer')).toHaveLength(0);
            expect(harness.host.querySelectorAll('.cleaned-image')).toHaveLength(1);
            expect(requestDetail).not.toHaveBeenCalled();

            vi.advanceTimersByTime(299);
            expect(requestDetail).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            await nextTick();

            expect(requestDetail).toHaveBeenCalledOnce();
            expect(requestDetail).toHaveBeenCalledWith({full: expect.objectContaining({rotationDegrees: 90})});
            const viewport = requestDetail.mock.calls[0]![0].full!;
            expect(viewport.xNormalized).toBeGreaterThanOrEqual(0);
            expect(viewport.yNormalized).toBeGreaterThanOrEqual(0);
            expect(viewport.xNormalized + viewport.widthNormalized).toBeLessThanOrEqual(1);
            expect(viewport.yNormalized + viewport.heightNormalized).toBeLessThanOrEqual(1);
            expect(viewport.widthNormalized).toBeGreaterThan(0.2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-admits detail after a pinned cleaned frame becomes current without another zoom', async () => {
        vi.useFakeTimers();
        try {
            const result = shallowRef(spreadPreviewResult());
            const resultCurrent = ref(true);
            const resultPresentationKey = ref('session-1:page-1:user-0');
            const layoutDetectionComplete = ref(true);
            const requestDetail = vi.fn<(
                viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
            ) => void>();
            const harness = mountPreviewZoomHarness({
                layoutDetectionCompleteRef: layoutDetectionComplete,
                onRequestDetail: requestDetail,
                resultCurrentRef: resultCurrent,
                resultPresentationKeyRef: resultPresentationKey,
                resultRef: result,
                viewMode: 'cleaned',
            });

            // The settled first frame is pinned. A later live result cannot
            // replace it until a new presentation identity is committed.
            const staleResult = structuredClone(result.value);
            for (const output of staleResult.outputs) {
                output.imageData = new Uint8Array([2]);
            }
            resultCurrent.value = false;
            result.value = staleResult;
            await nextTick();

            harness.surface.dispatchEvent(previewZoomWheel({
                bubbles: true,
                cancelable: true,
                clientX: 250,
                clientY: 200,
                deltaY: -1_200,
                metaKey: true,
            }));
            await nextTick();
            await vi.advanceTimersByTimeAsync(300);
            expect(requestDetail).not.toHaveBeenCalled();

            // Publishing the current frame is enough to retry admission. No
            // second zoom or pan event is needed.
            const currentResult = structuredClone(staleResult);
            for (const output of currentResult.outputs) {
                output.imageData = new Uint8Array([3]);
            }
            resultPresentationKey.value = 'session-1:page-1:user-1';
            resultCurrent.value = true;
            result.value = currentResult;
            await nextTick();
            expect(harness.host.querySelectorAll('.preview-cleaned-pixel-preload')).toHaveLength(2);

            await loadPendingCleanedFrame(harness.host);
            await vi.advanceTimersByTimeAsync(299);
            expect(requestDetail).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await nextTick();
            expect(requestDetail).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('positions a cropped high-detail tile over its intrinsic output region', async () => {
        const base = rotatedSinglePreviewResult();
        base.outputs[0]!.metadata.foldClipLeftPx = 40;
        base.outputs[0]!.metadata.foldClipRightPx = 20;
        const detail = structuredClone(base);
        detail.outputs[0]!.metadata.renderRegion = {
            xPx: 100,
            yPx: 250,
            widthPx: 200,
            heightPx: 500,
        };
        const harness = mountPreviewZoomHarness({
            detailResult: detail,
            result: base,
            viewMode: 'cleaned',
        });

        harness.surface.dispatchEvent(previewZoomWheel({
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
            deltaY: -1_200,
            metaKey: true,
        }));
        await nextTick();

        const tile = harness.host.querySelector<HTMLElement>('.preview-detail-pixel');
        expect(tile?.style.left).toBe('25%');
        expect(tile?.style.top).toBe('25%');
        expect(tile?.style.width).toBe('50%');
        expect(tile?.style.height).toBe('50%');
        const clippedPixels = tile?.closest<HTMLElement>('.fold-clipped-pixels');
        expect(clippedPixels?.style.clipPath).toBe('inset(0 5% 0 10%)');
        expect(clippedPixels?.querySelector('.preview-pixel')).not.toBeNull();
    });

    it('requests distinct output-local crops for both visible spread halves', async () => {
        vi.useFakeTimers();
        try {
            const requestDetail = vi.fn<(
                viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
            ) => void>();
            const harness = mountPreviewZoomHarness({
                onRequestDetail: requestDetail,
                viewMode: 'cleaned',
            });

            harness.surface.dispatchEvent(previewZoomWheel({
                bubbles: true,
                cancelable: true,
                clientX: 250,
                clientY: 200,
                deltaY: -1_200,
                metaKey: true,
            }));
            await nextTick();
            vi.advanceTimersByTime(300);
            await nextTick();

            expect(requestDetail).toHaveBeenCalledOnce();
            const viewports = requestDetail.mock.calls[0]![0];
            expect(viewports.left).toBeDefined();
            expect(viewports.right).toBeDefined();
            expect(viewports.left?.xNormalized).toBeGreaterThan(viewports.right?.xNormalized ?? 1);
            expect(viewports.left?.xNormalized).not.toBe(viewports.right?.xNormalized);
            expect(harness.host.querySelectorAll('.preview-detail-shimmer')).toHaveLength(0);
            expect(harness.host.querySelectorAll('.cleaned-image:not(.preview-detail-pixel)')).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('omits an offscreen spread half from the batched detail request', async () => {
        vi.useFakeTimers();
        try {
            const requestDetail = vi.fn<(
                viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
            ) => void>();
            const harness = mountPreviewZoomHarness({
                canvasRect: index => index === 0
                    ? domRect(0, 0, 250, 400)
                    : domRect(700, 0, 250, 400),
                onRequestDetail: requestDetail,
                viewMode: 'cleaned',
            });

            harness.surface.dispatchEvent(previewZoomWheel({
                bubbles: true,
                cancelable: true,
                clientX: 250,
                clientY: 200,
                deltaY: -1_200,
                metaKey: true,
            }));
            await nextTick();
            vi.advanceTimersByTime(300);
            await nextTick();

            expect(requestDetail).toHaveBeenCalledOnce();
            expect(requestDetail.mock.calls[0]![0]).toEqual({left: {
                xNormalized: 0,
                yNormalized: 0,
                widthNormalized: 1,
                heightNormalized: 1,
                rotationDegrees: 0,
            }});
        } finally {
            vi.useRealTimers();
        }
    });

    it('maps cutter dragging through 2x preview zoom and pan', async () => {
        const harness = mountPreviewZoomHarness();
        harness.surface.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        }));
        await nextTick();
        harness.surface.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 250,
            clientY: 200,
            pointerId: 45,
        }));
        harness.surface.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: 300,
            clientY: 200,
            pointerId: 45,
        }));
        harness.surface.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: 45,
        }));
        await nextTick();
        expect(harness.stage.style.transform).toContain('translate3d(50px, 0px, 0) scale(2)');

        const cutter = harness.host.querySelector<HTMLButtonElement>('.cutter-control')!;
        mockPointerCapture(cutter);
        cutter.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 300,
            clientY: 200,
            pointerId: 46,
        }));
        cutter.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            clientX: 400,
            clientY: 200,
            pointerId: 46,
        }));

        expect(harness.splitUpdates).toEqual([{
            xNormalized: 0.6,
            rotationDegrees: 0,
        }]);
    });

    it('clamps preview panning to the zoomed stage bounds', async () => {
        const harness = mountPreviewZoomHarness();
        harness.surface.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        }));
        await nextTick();

        harness.surface.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 250,
            clientY: 200,
            pointerId: 41,
        }));
        harness.surface.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: 2_000,
            clientY: 2_000,
            pointerId: 41,
        }));
        await nextTick();

        expect(harness.stage.style.transform).toContain('translate3d(250px, 200px, 0) scale(2)');
        expect(harness.surface.classList).toContain('is-panning-preview');
        harness.surface.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: 41,
        }));
        await nextTick();
        expect(harness.surface.classList).not.toContain('is-panning-preview');
    });

    it('pans the cleaned view by dragging the full-surface placement overlay at navigation zoom', async () => {
        const harness = mountPreviewZoomHarness({viewMode: 'cleaned'});
        harness.surface.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        }));
        await nextTick();
        expect(harness.stage.style.transform).toContain('scale(2)');

        const placementControl = harness.host.querySelector<HTMLElement>('.placement-control');
        expect(placementControl).not.toBeNull();
        placementControl!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 250,
            clientY: 200,
            pointerId: 51,
        }));
        harness.surface.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: 300,
            clientY: 225,
            pointerId: 51,
        }));
        await nextTick();

        expect(harness.surface.classList).toContain('is-panning-preview');
        expect(harness.stage.style.transform).toContain('translate3d(50px, 25px, 0) scale(2)');
        harness.surface.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: 51,
        }));
        await nextTick();
        expect(harness.surface.classList).not.toContain('is-panning-preview');
    });

    it('draws a manual zone at navigation zoom without giving the pointer to preview pan', async () => {
        const updateManualZones = vi.fn<(value: IScanCleanupManualZones) => void>();
        const harness = mountPreviewZoomHarness({
            onUpdateManualZones: updateManualZones,
            viewMode: 'cleaned',
            zoneEditing: true,
        });
        harness.surface.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        }));
        await nextTick();
        expect(harness.stage.style.transform).toContain('scale(2)');

        const editor = harness.host.querySelector<HTMLElement>('.zone-editor-overlay')!;
        const polygons = harness.host.querySelector<SVGElement>('.zone-editor-polygons')!;
        vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(domRect(0, 0, 500, 400));
        const editorCapture = mockPointerCapture(editor);
        polygons.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 100,
            clientY: 100,
            pointerId: 52,
        }));

        expect(editorCapture.setPointerCapture).toHaveBeenCalledWith(52);
        expect(harness.surface.setPointerCapture).not.toHaveBeenCalled();
        expect(harness.surface.classList).not.toContain('is-panning-preview');

        editor.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: 200,
            clientY: 200,
            pointerId: 52,
        }));
        editor.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            clientX: 200,
            clientY: 200,
            pointerId: 52,
        }));

        expect(updateManualZones).toHaveBeenCalledOnce();
        expect(updateManualZones.mock.calls[0]![0].picture).toHaveLength(1);
    });

    it('selects an existing manual zone without emitting an unchanged zone list', () => {
        const manualZones: IScanCleanupManualZones = {
            picture: [{
                layer: 'painter2',
                polygon: {
                    points: [
                        {
                            xNormalized: 0.1,
                            yNormalized: 0.1,
                        },
                        {
                            xNormalized: 0.4,
                            yNormalized: 0.1,
                        },
                        {
                            xNormalized: 0.4,
                            yNormalized: 0.5,
                        },
                        {
                            xNormalized: 0.1,
                            yNormalized: 0.5,
                        },
                    ],
                    rotationDegrees: 0,
                },
            }],
            fill: [],
        };
        const updateManualZones = vi.fn<(value: IScanCleanupManualZones) => void>();
        const updateSelected = vi.fn();
        const harness = mount(defineComponent({setup: () => () => h(ZoneEditorOverlay, {
            frame: {
                height: 300,
                left: 0,
                top: 0,
                width: 200,
            },
            manualZones,
            rotationDegrees: 0,
            selected: null,
            zoneKind: 'picture',
            'onUpdate:manualZones': updateManualZones,
            'onUpdate:selected': updateSelected,
        })}));
        const editor = harness.host.querySelector<HTMLElement>('.zone-editor-overlay')!;
        vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(domRect(0, 0, 200, 300));
        mockPointerCapture(editor);
        const polygon = harness.host.querySelector<SVGPolygonElement>('.zone-editor-polygon')!;

        polygon.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 40,
            clientY: 60,
            pointerId: 53,
        }));
        polygon.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            clientX: 40,
            clientY: 60,
            pointerId: 53,
        }));

        expect(updateSelected).toHaveBeenCalledOnce();
        expect(updateSelected).toHaveBeenCalledWith({
            kind: 'picture',
            index: 0,
        });
        expect(updateManualZones).not.toHaveBeenCalled();
    });

    it('toggles preview zoom between fit and bitmap 100% on double-click', async () => {
        const harness = mountPreviewZoomHarness();

        harness.surface.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        }));
        await nextTick();
        expect(harness.surface.dataset.previewZoomMode).toBe('custom');
        expect(harness.surface.dataset.previewZoomPercent).toBe('100');
        expect(harness.stage.style.transform).toContain('scale(2)');
        harness.surface.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        }));
        await nextTick();
        expect(harness.surface.dataset.previewZoomMode).toBe('fit');
        expect(harness.surface.dataset.previewZoomPercent).toBe('50');
        expect(harness.stage.style.transform).toContain('translate3d(0px, 0px, 0) scale(1)');
    });

    it('keeps zoom and pan aligned when switching between original and cleaned views', async () => {
        const harness = mountPreviewZoomHarness();
        harness.surface.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 250,
            clientY: 200,
        }));
        await nextTick();
        harness.surface.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 250,
            clientY: 200,
            pointerId: 42,
        }));
        harness.surface.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: 300,
            clientY: 225,
            pointerId: 42,
        }));
        harness.surface.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: 42,
        }));
        await nextTick();
        const originalTransform = harness.stage.style.transform;
        const originalZoom = harness.surface.dataset.previewZoomPercent;

        harness.viewMode.value = 'cleaned';
        await nextTick();

        expect(harness.host.querySelector('.cleaned-outputs')).not.toBeNull();
        expect(harness.stage.style.transform).toBe(originalTransform);
        expect(harness.surface.dataset.previewZoomPercent).toBe(originalZoom);
    });

    it('keeps the spread cutter mounted through a committed drag and the debounced loading cycle', async () => {
        const loading = ref(false);
        const manualSplit = ref<IScanCleanupNormalizedSplit | null>(null);
        const result = shallowRef(spreadPreviewResult());
        const splitUpdates: Array<IScanCleanupNormalizedSplit | null> = [];
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            loading: loading.value,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            stalePage: false,
            manualSplit: manualSplit.value,
            readingOrder: 'ltr',
            'onUpdate:manualSplit': (value: IScanCleanupNormalizedSplit | null) => {
                splitUpdates.push(value);
                manualSplit.value = value;
                loading.value = true;
            },
        })}));

        const cutter = harness.host.querySelector<HTMLButtonElement>('.cutter-control');
        expect(cutter).not.toBeNull();
        expect(cutter?.querySelector('.cutter-grab-handle')).not.toBeNull();

        const stage = harness.host.querySelector<HTMLElement>('.cutter-stage');
        vi.spyOn(stage!, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            right: 1000,
            top: 0,
            bottom: 800,
            width: 1000,
            height: 800,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        const capture = mockPointerCapture(cutter!);
        cutter!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 600,
            pointerId: 1,
        }));
        expect(splitUpdates).toEqual([]);
        cutter!.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            clientX: 600,
            pointerId: 1,
        }));
        expect(splitUpdates).toEqual([{
            xNormalized: 0.6,
            rotationDegrees: 0,
        }]);
        expect(capture.releasePointerCapture).toHaveBeenCalledWith(1);
        await nextTick();
        expect(harness.host.querySelector('.cutter-control')).not.toBeNull();
        expect(harness.host.querySelector('.cutter-control')?.classList.contains('is-refreshing')).toBe(true);

        result.value = {
            ...result.value,
            pageMetadata: {
                ...result.value.pageMetadata,
                layoutClassification: 'single-uncut-page',
            },
        };
        loading.value = false;
        await nextTick();
        const persistentCutter = harness.host.querySelector<HTMLButtonElement>('.cutter-control');
        expect(persistentCutter).not.toBeNull();
        vi.spyOn(harness.host.querySelector<HTMLElement>('.cutter-stage')!, 'getBoundingClientRect')
            .mockReturnValue(domRect(0, 0, 1000, 800));
        mockPointerCapture(persistentCutter!);

        persistentCutter!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 550,
            pointerId: 2,
        }));
        persistentCutter!.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Escape',
        }));
        const updateCountAfterEscape = splitUpdates.length;
        persistentCutter!.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: 700,
            pointerId: 2,
        }));
        expect(splitUpdates).toHaveLength(updateCountAfterEscape);

        persistentCutter!.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
        expect(splitUpdates.at(-1)).toBeNull();
    });

    it('keeps cutter moves draft-only on the stable source underlay and commits once on release', async () => {
        const sessionWrites = {
            override: vi.fn(),
            localStorage: vi.fn(),
            previewCache: vi.fn(),
            classification: vi.fn(),
            ipc: vi.fn(),
        };
        const commitCurrentManualSplit = vi.fn((value: IScanCleanupNormalizedSplit | null) => {
            sessionWrites.override(value);
        });
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(),
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
            'onUpdate:manualSplit': commitCurrentManualSplit,
        })}));
        mockPreviewGeometry(harness.host, [
            domRect(0, 0, 500, 800),
            domRect(500, 0, 500, 800),
        ]);

        const overlay = harness.host.querySelector<HTMLElement>('.drag-overlay-layer')!;
        const resultLayer = harness.host.querySelector<HTMLElement>('.preview-result-layer')!;
        expect(overlay.parentElement).toBe(resultLayer.parentElement);
        expect(resultLayer.contains(overlay)).toBe(false);
        const cutter = overlay.querySelector<HTMLButtonElement>('.cutter-control')!;
        mockPointerCapture(cutter);
        cutter.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 600,
            clientY: 400,
            pointerId: 11,
        }));
        cutter.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: 700,
            clientY: 400,
            pointerId: 11,
        }));
        await nextTick();

        expect(commitCurrentManualSplit).not.toHaveBeenCalled();
        expect(Object.values(sessionWrites).every(spy => spy.mock.calls.length === 0)).toBe(true);
        expect(harness.host.querySelector('.cutter-source-underlay')).not.toBeNull();
        expect(resultLayer.classList.contains('is-cutter-source-dimmed')).toBe(true);
        expect(cutter.style.insetInlineStart).toBe('700px');

        cutter.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            clientX: 700,
            clientY: 400,
            pointerId: 11,
        }));
        expect(commitCurrentManualSplit).toHaveBeenCalledOnce();
        expect(commitCurrentManualSplit).toHaveBeenCalledWith({
            xNormalized: 0.7,
            rotationDegrees: 0,
        });
        expect(sessionWrites.override).toHaveBeenCalledOnce();
        expect(sessionWrites.localStorage).not.toHaveBeenCalled();
        expect(sessionWrites.previewCache).not.toHaveBeenCalled();
        expect(sessionWrites.classification).not.toHaveBeenCalled();
        expect(sessionWrites.ipc).not.toHaveBeenCalled();
    });

    it('rolls an active cutter back on Escape and aborts lost capture without committing', async () => {
        const commitCurrentManualSplit = vi.fn();
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(),
            loading: false,
            error: '',
            viewMode: 'original',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: {
                xNormalized: 0.4,
                rotationDegrees: 0,
            },
            readingOrder: 'ltr',
            'onUpdate:manualSplit': commitCurrentManualSplit,
        })}));
        mockPreviewGeometry(harness.host, []);
        const cutter = harness.host.querySelector<HTMLButtonElement>('.cutter-control')!;
        const capture = mockPointerCapture(cutter);

        cutter.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 400,
            pointerId: 12,
        }));
        cutter.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: 700,
            pointerId: 12,
        }));
        await nextTick();
        expect(cutter.style.insetInlineStart).toBe('700px');
        cutter.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Escape',
        }));
        await nextTick();
        expect(cutter.style.insetInlineStart).toBe('400px');
        expect(commitCurrentManualSplit).not.toHaveBeenCalled();
        expect(capture.releasePointerCapture).toHaveBeenCalledWith(12);

        cutter.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 400,
            pointerId: 13,
        }));
        cutter.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: 650,
            pointerId: 13,
        }));
        cutter.dispatchEvent(new PointerEvent('lostpointercapture', {
            bubbles: true,
            pointerId: 13,
        }));
        await nextTick();
        expect(cutter.style.insetInlineStart).toBe('400px');
        expect(commitCurrentManualSplit).not.toHaveBeenCalled();
    });

    it('keeps rotated content-box moves draft-only and commits the rotation-90 normalized rect once', async () => {
        const sessionWrites = {
            override: vi.fn(),
            localStorage: vi.fn(),
            previewCache: vi.fn(),
            classification: vi.fn(),
            ipc: vi.fn(),
        };
        const commitCurrentManualContentBox = vi.fn((
            half: TScanCleanupOutputHalf,
            value: IScanCleanupNormalizedRect | null,
        ) => sessionWrites.override(half, value));
        const manualContentBoxes = {full: {
            xNormalized: 0.1,
            yNormalized: 0.1,
            widthNormalized: 0.3,
            heightNormalized: 0.4,
            rotationDegrees: 90 as const,
        }};
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: rotatedSinglePreviewResult(),
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-left',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
            manualContentBoxes,
            'onUpdate:manualContentBox': commitCurrentManualContentBox,
        })}));
        mockPreviewGeometry(harness.host, [domRect(0, 0, 400, 1000)]);
        const handle = harness.host.querySelector<HTMLButtonElement>('.content-handle.is-e')!;
        mockPointerCapture(handle);

        handle.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 320,
            clientY: 300,
            pointerId: 14,
        }));
        handle.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: 360,
            clientY: 300,
            pointerId: 14,
        }));
        await nextTick();
        expect(commitCurrentManualContentBox).not.toHaveBeenCalled();
        expect(Object.values(sessionWrites).every(spy => spy.mock.calls.length === 0)).toBe(true);
        expect(harness.host.querySelector<HTMLElement>('.content-overlay')?.style.width).toBe('70%');

        handle.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            clientX: 360,
            clientY: 300,
            pointerId: 14,
        }));
        expect(commitCurrentManualContentBox).toHaveBeenCalledOnce();
        expect(commitCurrentManualContentBox).toHaveBeenCalledWith('full', {
            xNormalized: 0.1,
            yNormalized: 0.1,
            widthNormalized: 0.35,
            heightNormalized: 0.4,
            rotationDegrees: 90,
        });
        expect(sessionWrites.override).toHaveBeenCalledOnce();
    });

    it('moves placement continuously without writes and commits the nearest anchor once', async () => {
        const result = spreadPreviewResult();
        const first = result.outputs[0]!;
        first.metadata.outputWidthPx = 300;
        first.metadata.outputHeightPx = 600;
        first.metadata.canvasWidthPx = 500;
        first.metadata.canvasHeightPx = 800;
        const sessionWrites = {
            override: vi.fn(),
            localStorage: vi.fn(),
            previewCache: vi.fn(),
            classification: vi.fn(),
            ipc: vi.fn(),
        };
        const commitCurrentPlacement = vi.fn((half: TScanCleanupOutputHalf, value: TScanCleanupPageAlignment) => {
            sessionWrites.override(half, value);
        });
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-left',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
            'onUpdate:placement': commitCurrentPlacement,
        })}));
        mockPreviewGeometry(harness.host, [
            domRect(0, 0, 500, 800),
            domRect(500, 0, 500, 800),
        ]);
        const placement = harness.host.querySelector<HTMLElement>('.placement-control')!;
        mockPointerCapture(placement);

        placement.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 100,
            clientY: 100,
            pointerId: 15,
        }));
        placement.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: 300,
            clientY: 300,
            pointerId: 15,
        }));
        await nextTick();
        expect(commitCurrentPlacement).not.toHaveBeenCalled();
        expect(Object.values(sessionWrites).every(spy => spy.mock.calls.length === 0)).toBe(true);
        expect(placement.style.left).toBe('40%');
        expect(placement.style.top).toBe('25%');
        expect(harness.host.querySelectorAll('.placement-snap-anchor')).toHaveLength(9);
        expect(harness.host.querySelector('.placement-snap-anchor.is-nearest')?.getAttribute('style'))
            .toContain('100%');
        expect(harness.host.querySelector('.placed-image')?.classList.contains('is-drag-placeholder')).toBe(true);

        placement.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            clientX: 300,
            clientY: 300,
            pointerId: 15,
        }));
        expect(commitCurrentPlacement).toHaveBeenCalledOnce();
        expect(commitCurrentPlacement).toHaveBeenCalledWith('left', 'bottom-right');
        expect(sessionWrites.override).toHaveBeenCalledOnce();
        expect(sessionWrites.ipc).not.toHaveBeenCalled();
    });

    it.each(placementAlignments)(
        'round-trips native %s placement against the retained fold window',
        async alignment => {
            const result = spreadPreviewResult();
            const first = result.outputs[0]!;
            const [
                vertical,
                horizontal = vertical,
            ] = alignment.split('-');
            const horizontalOffset = horizontal === 'left' ? 0 : horizontal === 'right' ? 60 : 30;
            const verticalOffset = vertical === 'top' ? 0 : vertical === 'bottom' ? 40 : 20;
            const retainedLeftPx = 10 + horizontalOffset;
            const intrinsicLeftPx = retainedLeftPx - 12;
            Object.assign(first.metadata, {
                appliedMargins: {
                    leftPx: 10,
                    topPx: 20,
                    rightPx: 30,
                    bottomPx: 40,
                },
                outputWidthPx: 60,
                outputHeightPx: 100,
                canvasWidthPx: 200,
                canvasHeightPx: 300,
                matchedCanvasContentWidthPx: 120,
                matchedCanvasContentHeightPx: 200,
                matchedCanvasIntrinsicOverflowLeftPx: Math.max(0, -intrinsicLeftPx),
                foldClipLeftPx: 12,
                foldClipRightPx: 8,
                placementOffsetXPx: Math.max(0, intrinsicLeftPx),
                placementOffsetYPx: 20 + verticalOffset,
            });
            const commitCurrentPlacement = vi.fn();
            const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
                result,
                loading: false,
                error: '',
                viewMode: 'cleaned',
                matchPageSize: true,
                alignment,
                pageNumber: 1,
                totalPages: 3,
                manualSplit: null,
                readingOrder: 'ltr',
                'onUpdate:placement': commitCurrentPlacement,
            })}));
            mockPreviewGeometry(harness.host, [
                domRect(0, 0, 200, 300),
                domRect(200, 0, 500, 800),
            ]);
            const placement = harness.host.querySelector<HTMLElement>('.placement-control')!;
            mockPointerCapture(placement);

            placement.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true,
                button: 0,
                clientX: 100,
                clientY: 100,
                pointerId: 54,
            }));
            await nextTick();

            const anchors = Array.from(harness.host.querySelectorAll<HTMLElement>('.placement-snap-anchor'));
            const nearestIndex = anchors.findIndex(anchor => anchor.classList.contains('is-nearest'));
            const nearest = anchors[nearestIndex]!;
            const expectedLeft = horizontal === 'left' ? 5 : horizontal === 'right' ? 85 : 45;
            const expectedTop = vertical === 'top'
                ? 20 / 300 * 100
                : vertical === 'bottom' ? 260 / 300 * 100 : 140 / 300 * 100;

            expect(anchors).toHaveLength(9);
            expect(nearestIndex).toBe(placementAlignments.indexOf(alignment));
            expect(Number.parseFloat(nearest.style.left)).toBeCloseTo(expectedLeft);
            expect(Number.parseFloat(nearest.style.top)).toBeCloseTo(expectedTop);
            expect(Number.parseFloat(placement.style.left)).toBeCloseTo(intrinsicLeftPx / 200 * 100);

            placement.dispatchEvent(new PointerEvent('pointerup', {
                bubbles: true,
                clientX: 100,
                clientY: 100,
                pointerId: 54,
            }));

            expect(commitCurrentPlacement).not.toHaveBeenCalled();
        },
    );

    it('re-fits a margin sweep from native paper geometry without letting the raster escape', async () => {
        const resize = installResizeObserverHarness();
        const initial = spreadPreviewResult();
        const initialMetadata = initial.outputs[0]!.metadata;
        Object.assign(initialMetadata, {
            contentBox: {
                xPx: 100,
                yPx: 100,
                widthPx: 200,
                heightPx: 300,
            },
            outputWidthPx: 466,
            outputHeightPx: 766,
            canvasWidthPx: 500,
            canvasHeightPx: 800,
            placementOffsetXPx: 17,
            placementOffsetYPx: 17,
        });
        const result = shallowRef(initial);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'bottom-right',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));
        await nextTick();

        const fitAreas = Array.from(harness.host.querySelectorAll<HTMLElement>('.output-fit-area'));
        fitAreas.forEach((area, index) => vi.spyOn(area, 'getBoundingClientRect')
            .mockReturnValue(domRect(index * 500, 0, 500, 800)));
        resize.trigger();
        await nextTick();

        const beforePaper = harness.host.querySelector<HTMLElement>('.uniform-canvas')!;
        expect(beforePaper.style.width).toBe('500px');
        expect(beforePaper.dataset.frameWidth).toBe('500');

        const expanded = structuredClone(result.value);
        Object.assign(expanded.outputs[0]!.metadata, {
            outputWidthPx: 594,
            outputHeightPx: 894,
            canvasWidthPx: 620,
            canvasHeightPx: 920,
            placementOffsetXPx: 13,
            placementOffsetYPx: 13,
        });
        expanded.rawImageData = new Uint8Array([2]);
        expanded.outputs[0]!.imageData = new Uint8Array([2]);
        result.value = expanded;
        await nextTick();
        await loadPendingCleanedFrame(harness.host);
        resize.trigger();
        await nextTick();

        const paper = harness.host.querySelector<HTMLElement>('.uniform-canvas')!;
        const raster = paper.querySelector<HTMLElement>('.placed-image')!;
        expect(paper.style.width).toBe('500px');
        expect(Number.parseFloat(paper.style.height)).toBeCloseTo(920 / 620 * 500);
        expect(paper.dataset.frameWidth).toBe('620');
        expect(paper.dataset.frameHeight).toBe('920');
        expect(Number.parseFloat(raster.style.left)).toBeCloseTo(13 / 620 * 100);
        expect(Number.parseFloat(raster.style.top)).toBeCloseTo(13 / 920 * 100);

        const paperWidth = Number.parseFloat(paper.style.width);
        const paperHeight = Number.parseFloat(paper.style.height);
        const rasterRect = {
            left: Number.parseFloat(raster.style.left) / 100 * paperWidth,
            top: Number.parseFloat(raster.style.top) / 100 * paperHeight,
            width: Number.parseFloat(raster.style.width) / 100 * paperWidth,
            height: Number.parseFloat(raster.style.height) / 100 * paperHeight,
        };
        expect(rasterRect.left).toBeCloseTo(13 / 620 * paperWidth);
        expect(rasterRect.top).toBeCloseTo(13 / 920 * paperHeight);
        expect(rasterRect.left + rasterRect.width).toBeLessThanOrEqual(paperWidth);
        expect(rasterRect.top + rasterRect.height).toBeLessThanOrEqual(paperHeight);
        expect(paper.contains(harness.host.querySelector('.placement-overlay-canvas'))).toBe(true);
        expect(paper.contains(harness.host.querySelector('.content-overlay'))).toBe(true);
        resize.restore();
    });

    it.each([
        {
            classification: 'single-uncut-page' as const,
            label: 'single page',
            result: (() => {
                const result = rotatedSinglePreviewResult();
                const metadata = result.outputs[0]!.metadata;
                metadata.sourceRegion.widthPx = 800;
                metadata.outputWidthPx = 800;
                metadata.canvasWidthPx = 800;
                return result;
            })(),
            rotationDegrees: 90 as const,
        },
        {
            classification: 'two-page-spread' as const,
            label: 'spread',
            result: spreadPreviewResult(),
            rotationDegrees: 0 as const,
        },
    ])('replaces the $label source skeleton with the authoritative native paper rectangle', async ({
        classification,
        result: resolvedResult,
        rotationDegrees,
    }) => {
        const resize = installResizeObserverHarness();
        try {
            const result = shallowRef<IScanCleanupPreviewResult | null>(null);
            const loading = ref(true);
            const source = previewPageSource(1000, 800);
            const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
                result: result.value,
                loading: loading.value,
                error: '',
                source,
                layoutClassification: classification,
                rotationDegrees,
                viewMode: 'cleaned',
                matchPageSize: false,
                alignment: 'top-left',
                pageNumber: 1,
                totalPages: 1,
                manualSplit: null,
                readingOrder: 'ltr',
            })}));
            await Promise.resolve();
            await nextTick();

            const mockFitAreas = () => {
                const areas = Array.from(harness.host.querySelectorAll<HTMLElement>('.output-fit-area'));
                areas.forEach((area, index) => vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(domRect(
                    index * (1000 / areas.length),
                    0,
                    1000 / areas.length,
                    760,
                )));
                resize.trigger();
            };
            mockFitAreas();
            await nextTick();
            const skeletonRects = Array.from(
                harness.host.querySelectorAll<HTMLElement>('.preview-skeleton-page'),
            ).map(placeholder => ({
                height: placeholder.style.height,
                width: placeholder.style.width,
            }));
            expect(harness.host.querySelector('.preview-viewport-caption')?.textContent)
                .toBe('Building cleanup preview…');

            result.value = resolvedResult;
            loading.value = false;
            await nextTick();
            mockFitAreas();
            await nextTick();
            const renderedRects = Array.from(
                harness.host.querySelectorAll<HTMLElement>('.uniform-canvas'),
            ).map(canvas => ({
                height: canvas.style.height,
                width: canvas.style.width,
            }));

            expect(renderedRects).toEqual(skeletonRects);
            expect(renderedRects).toHaveLength(classification === 'two-page-spread' ? 2 : 1);
        } finally {
            resize.restore();
        }
    });

    it('renders the complete entry sequence from metrics-backed skeleton to content or an exclusive error banner', async () => {
        const result = shallowRef<IScanCleanupPreviewResult | null>(null);
        const loading = ref(true);
        const error = ref('');
        const source = previewPageSource(1000, 800);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            loading: loading.value,
            error: error.value,
            source,
            viewMode: 'cleaned',
            matchPageSize: false,
            alignment: 'top-left',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        expect(harness.host.querySelector('.preview-skeleton-page')).not.toBeNull();
        expect(harness.host.querySelector('.preview-result-layer')).toBeNull();
        expect(harness.host.querySelector('[role="alert"]')).toBeNull();
        await nextTick();
        expect(harness.host.querySelector<HTMLElement>('.preview-skeleton-page')?.style.aspectRatio)
            .toBe('1000 / 800');

        result.value = rotatedSinglePreviewResult();
        loading.value = false;
        await nextTick();
        expect(harness.host.querySelector('.preview-skeleton-page')).toBeNull();
        expect(harness.host.querySelector('.preview-result-layer')).not.toBeNull();
        expect(harness.host.querySelector('[role="alert"]')).toBeNull();

        result.value = null;
        loading.value = true;
        await nextTick();
        expect(harness.host.querySelector('.preview-skeleton-page')).not.toBeNull();

        loading.value = false;
        await nextTick();
        expect(harness.host.querySelector('.preview-skeleton-page')).not.toBeNull();

        error.value = 'preview boundary failed';
        await nextTick();
        expect(harness.host.querySelector('.preview-skeleton-page')).toBeNull();
        expect(harness.host.querySelector('.preview-result-layer')).toBeNull();
        expect(harness.host.querySelector('.preview-message.is-error')?.textContent)
            .toContain('Preview isn\'t available. You can still run cleanup.');
    });

    it('reserves the preview stage without painting guessed paper geometry while page metrics are pending', () => {
        const source: IDocumentPageSource = {
            ...previewPageSource(1000, 800),
            getPageMetrics: vi.fn(() => new Promise<never>(() => undefined)),
        };
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: null,
            loading: true,
            error: '',
            source,
            viewMode: 'cleaned',
            matchPageSize: false,
            alignment: 'top-left',
            pageNumber: 2,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        const skeleton = harness.host.querySelector<HTMLElement>('.preview-skeleton-page');
        expect(skeleton).not.toBeNull();
        expect(skeleton?.tagName).toBe('DIV');
        expect(skeleton?.style.width).toBe('auto');
        expect(skeleton?.style.height).toContain('--app-scan-preview-skeleton-height');
        expect(skeleton?.style.aspectRatio).not.toBe('');
        expect(skeleton?.style.visibility).toBe('hidden');
        expect(harness.host.querySelector('.preview-viewport-caption')?.textContent)
            .toBe('Building cleanup preview…');
        harness.unmount();
    });

    it('reveals the fallback frame when source page metrics fail', async () => {
        const source: IDocumentPageSource = {
            ...previewPageSource(1000, 800),
            getPageMetrics: vi.fn(async () => {
                throw new Error('page metrics unavailable');
            }),
        };
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: null,
            loading: true,
            error: '',
            source,
            viewMode: 'cleaned',
            matchPageSize: false,
            alignment: 'top-left',
            pageNumber: 2,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        await Promise.resolve();
        await nextTick();
        expect(harness.host.querySelector<HTMLElement>('.preview-skeleton-page')?.style.visibility).not.toBe('hidden');
        harness.unmount();
    });

    it('never paints a reduced source raster as cleaned content while authoritative pixels are pending', async () => {
        const source: IDocumentPageSource = {
            ...previewPageSource(1000, 800),
            renderPage: vi.fn(async () => ({
                widthPx: 1000,
                heightPx: 800,
                bytes: 3_200_000,
                surface: 'data:image/png;base64,source-page',
                release: vi.fn(),
            })),
        };
        const result = shallowRef<IScanCleanupPreviewResult | null>(null);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            loading: true,
            error: '',
            source,
            viewMode: 'cleaned',
            matchPageSize: false,
            alignment: 'top-left',
            pageNumber: 1,
            totalPages: 3,
            layoutClassification: 'two-page-spread',
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        await Promise.resolve();
        await nextTick();

        expect(source.renderPage).not.toHaveBeenCalled();
        expect(harness.host.querySelectorAll('.preview-skeleton-page')).toHaveLength(2);
        expect(harness.host.querySelector('.preview-skeleton-page img, .preview-skeleton-page canvas'))
            .toBeNull();

        result.value = spreadPreviewResult(1);
        await nextTick();
        expect(harness.host.querySelector('.preview-skeleton-page')).toBeNull();
        expect(harness.host.querySelector('.preview-result-layer')).not.toBeNull();
    });

    it('retains a cleaned result while authoritative output topology refreshes', async () => {
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(1),
            loading: true,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: false,
            alignment: 'top-left',
            pageNumber: 1,
            totalPages: 3,
            layoutClassification: 'single-page',
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        await nextTick();

        expect(harness.host.querySelector('.preview-result-layer')).not.toBeNull();
        expect(harness.host.querySelector('.refresh-indicator')).not.toBeNull();
        expect(harness.host.querySelector('.preview-skeleton-page')).toBeNull();
        harness.unmount();
    });

    it('recomputes the viewport frame for container resize and layout-classification changes', async () => {
        const resize = installResizeObserverHarness();
        try {
            const result = shallowRef(spreadPreviewResult());
            const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
                result: result.value,
                loading: false,
                error: '',
                viewMode: 'cleaned',
                matchPageSize: false,
                alignment: 'top-left',
                pageNumber: 1,
                totalPages: 3,
                manualSplit: null,
                readingOrder: 'ltr',
            })}));
            let areaWidth = 500;
            Array.from(harness.host.querySelectorAll<HTMLElement>('.output-fit-area')).forEach((area, index) => {
                vi.spyOn(area, 'getBoundingClientRect').mockImplementation(() => domRect(
                    index * areaWidth,
                    0,
                    areaWidth,
                    areaWidth / 500 * 800,
                ));
            });
            resize.trigger();
            await nextTick();
            expect(harness.host.querySelector<HTMLElement>('.uniform-canvas')?.style.width).toBe('500px');

            areaWidth = 250;
            resize.trigger();
            await nextTick();
            expect(harness.host.querySelector<HTMLElement>('.uniform-canvas')?.style.width).toBe('250px');

            const single = rotatedSinglePreviewResult();
            single.pageMetadata.rotationDegrees = 0;
            single.outputs[0]!.metadata.rotationDegrees = 0;
            single.outputs[0]!.metadata.inputWidthPx = 1000;
            single.outputs[0]!.metadata.inputHeightPx = 800;
            result.value = single;
            await nextTick();
            await loadPendingCleanedFrame(harness.host);
            const singleArea = harness.host.querySelector<HTMLElement>('.output-fit-area')!;
            vi.spyOn(singleArea, 'getBoundingClientRect').mockReturnValue(domRect(0, 0, 1000, 800));
            resize.trigger();
            await nextTick();

            const singleCanvas = harness.host.querySelector<HTMLElement>('.uniform-canvas')!;
            expect(singleCanvas.dataset.frameWidth).toBe('400');
            expect(singleCanvas.style.width).toBe('320px');
        } finally {
            resize.restore();
        }
    });

    it('keeps the active draft, frame, overlay, and pointer capture through a preview refresh', async () => {
        const result = shallowRef(spreadPreviewResult());
        const commit = vi.fn();
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-left',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
            'onUpdate:manualSplit': commit,
        })}));
        mockPreviewGeometry(harness.host, [
            domRect(0, 0, 500, 800),
            domRect(500, 0, 500, 800),
        ]);
        const cutter = harness.host.querySelector<HTMLButtonElement>('.cutter-control')!;
        const capture = mockPointerCapture(cutter);
        const overlay = harness.host.querySelector<HTMLElement>('.drag-overlay-layer')!;
        const frameBefore = harness.host.querySelector<HTMLElement>('.uniform-canvas')!.dataset.frameWidth;
        cutter.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 700,
            clientY: 400,
            pointerId: 21,
        }));
        cutter.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: 720,
            clientY: 400,
            pointerId: 21,
        }));
        await nextTick();
        const draftPosition = cutter.style.insetInlineStart;

        result.value = contentCropRefresh(result.value, 0.5);
        await nextTick();

        expect(harness.host.querySelector('.drag-overlay-layer')).toBe(overlay);
        expect(harness.host.querySelector('.cutter-control')).toBe(cutter);
        expect(cutter.style.insetInlineStart).toBe(draftPosition);
        expect(harness.host.querySelector<HTMLElement>('.uniform-canvas')!.dataset.frameWidth).toBe(frameBefore);
        expect(capture.hasPointerCapture(21)).toBe(true);
        expect(commit).not.toHaveBeenCalled();
    });

    it('retains half-keyed fit-area refs across refreshes and observes later resizes', async () => {
        const resize = installResizeObserverHarness();
        try {
            const result = shallowRef(spreadPreviewResult());
            const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
                result: result.value,
                loading: false,
                error: '',
                viewMode: 'cleaned',
                matchPageSize: false,
                alignment: 'top-left',
                pageNumber: 1,
                totalPages: 3,
                manualSplit: null,
                readingOrder: 'ltr',
            })}));
            let width = 500;
            const leftArea = harness.host.querySelector<HTMLElement>('[data-output-half="left"]')!;
            vi.spyOn(leftArea, 'getBoundingClientRect').mockImplementation(() => domRect(0, 0, width, 800));
            const rightArea = harness.host.querySelector<HTMLElement>('[data-output-half="right"]')!;
            vi.spyOn(rightArea, 'getBoundingClientRect').mockImplementation(() => domRect(width, 0, width, 800));
            resize.trigger();
            await nextTick();

            result.value = contentCropRefresh(result.value, 0.75);
            await nextTick();
            expect(harness.host.querySelector('[data-output-half="left"]')).toBe(leftArea);

            width = 300;
            resize.trigger();
            await nextTick();
            expect(harness.host.querySelector<HTMLElement>('.uniform-canvas')?.style.width).toBe('300px');
        } finally {
            resize.restore();
        }
    });

    it('supports keyboard content-box resizing/reset and per-output placement nudging', async () => {
        const contentUpdates: Array<{
            half: string;
            value: unknown
        }> = [];
        const placementUpdates: Array<{
            half: string;
            value: string
        }> = [];
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(),
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
            manualContentBoxes: {left: {
                xNormalized: 0.05,
                yNormalized: 0.075,
                widthNormalized: 0.3,
                heightNormalized: 0.625,
                rotationDegrees: 0,
            }},
            placementOverrides: {left: 'top-center'},
            'onUpdate:manualContentBox': (
                half: TScanCleanupOutputHalf,
                value: IScanCleanupNormalizedRect | null,
            ) => contentUpdates.push({
                half,
                value,
            }),
            'onUpdate:placement': (
                half: TScanCleanupOutputHalf,
                value: TScanCleanupPageAlignment,
            ) => placementUpdates.push({
                half,
                value,
            }),
        })}));

        harness.host.querySelector<HTMLButtonElement>('.content-handle.is-e')?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            bubbles: true,
            cancelable: true,
        }));
        expect(contentUpdates.at(-1)).toMatchObject({
            half: 'left',
            value: {
                xNormalized: 0.05,
                yNormalized: 0.075,
                heightNormalized: 0.625,
                rotationDegrees: 0,
            },
        });
        expect((contentUpdates.at(-1)?.value as {widthNormalized: number}).widthNormalized).toBeGreaterThan(0.3);

        harness.host.querySelector<HTMLElement>('.content-overlay')?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
        expect(contentUpdates.at(-1)).toEqual({
            half: 'left',
            value: null,
        });

        harness.host.querySelector<HTMLElement>('.placement-control')?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        expect(placementUpdates.at(-1)).toEqual({
            half: 'left',
            value: 'center',
        });
    });

    it('places each intrinsic preview image inside its declared canvas metadata', async () => {
        const result = spreadPreviewResult();
        const first = result.outputs[0]!;
        first.metadata.outputWidthPx = 300;
        first.metadata.outputHeightPx = 600;
        first.metadata.canvasWidthPx = 500;
        first.metadata.canvasHeightPx = 800;
        first.metadata.placementOffsetXPx = 200;
        first.metadata.placementOffsetYPx = 200;
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'bottom-right',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        await nextTick();
        const placed = harness.host.querySelector<HTMLElement>('.placed-image');
        expect(placed?.style.left).toBe('40%');
        expect(placed?.style.top).toBe('25%');
        expect(placed?.style.width).toBe('60%');
        expect(placed?.style.height).toBe('75%');
    });

    it('keeps top-center matched preview content below its requested top margin', async () => {
        const result = spreadPreviewResult();
        const first = result.outputs[0]!;
        Object.assign(first.metadata, {
            appliedMargins: {
                leftPx: 17,
                topPx: 17,
                rightPx: 17,
                bottomPx: 17,
            },
            outputWidthPx: 233,
            outputHeightPx: 350,
            canvasWidthPx: 500,
            canvasHeightPx: 800,
            matchedCanvasContentWidthPx: 466,
            matchedCanvasContentHeightPx: 700,
            placementOffsetXPx: 17,
            placementOffsetYPx: 17,
        });
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        await nextTick();
        const placed = harness.host.querySelector<HTMLElement>('.placed-image');
        expect(placed?.style.left).toBe(`${17 / 500 * 100}%`);
        expect(placed?.style.top).toBe(`${17 / 800 * 100}%`);
        expect(placed?.style.width).toBe(`${466 / 500 * 100}%`);
        expect(placed?.style.height).toBe(`${700 / 800 * 100}%`);
    });

    it('keeps cached native placement and labels a changed placement override stale', async () => {
        const result = spreadPreviewResult();
        const first = result.outputs[0]!;
        first.metadata.outputWidthPx = 300;
        first.metadata.outputHeightPx = 600;
        first.metadata.canvasWidthPx = 500;
        first.metadata.canvasHeightPx = 800;
        first.metadata.matchedCanvasContentWidthPx = 300;
        first.metadata.foldClipLeftPx = 30;
        first.metadata.foldClipRightPx = 15;
        first.metadata.placementOffsetXPx = 0;
        first.metadata.placementOffsetYPx = 0;
        const placementOverrides = ref<Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>>({left: 'top-left'});
        const resultCurrent = ref(true);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result,
            resultCurrent: resultCurrent.value,
            resultPresentationKey: 'session-1:page-1:user-0',
            layoutDetectionComplete: true,
            loading: false,
            error: '',
            viewMode: 'cleaned',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplit: null,
            readingOrder: 'ltr',
            placementOverrides: placementOverrides.value,
        })}));

        await nextTick();
        const placed = harness.host.querySelector<HTMLElement>('.placed-image');
        expect(placed?.style.left).toBe('0%');
        expect(placed?.style.top).toBe('0%');
        expect(placed?.querySelector<HTMLElement>('.fold-clipped-pixels')?.style.clipPath)
            .toBe('inset(0 5% 0 10%)');

        placementOverrides.value = {left: 'bottom-right'};
        resultCurrent.value = false;
        await nextTick();
        expect(placed?.style.left).toBe('0%');
        expect(placed?.style.top).toBe('0%');
        expect(harness.host.querySelector<HTMLElement>('.preview-viewport-caption')?.dataset.canvasNotice)
            .toBe('updating');
    });

    it('names the preview fit control after fitting the whole page and marks it pressed', async () => {
        const harness = mountPreviewZoomHarness();
        await nextTick();
        const fit = harness.host.querySelector<HTMLButtonElement>(
            '[aria-label="Fit whole page in view"]',
        );
        expect(fit).not.toBeNull();
        expect(fit?.querySelector('[data-ui-icon]')?.getAttribute('name')).toBe('i-ph-frame-corners');
        expect(fit?.getAttribute('aria-pressed')).toBe('true');
        expect(fit?.classList).toContain('is-fit-page');
        expect(harness.host.querySelector('[aria-label="Fit preview"]')).toBeNull();
        expect(harness.host.querySelector('[name="i-ph-arrows-out"]')).toBeNull();
    });

    it('keeps overlay help in the header without reserving a full legend row', async () => {
        const viewMode = ref<'original' | 'cleaned'>('cleaned');
        const matchPageSize = ref(true);
        const result = ref<IScanCleanupPreviewResult | null>(null);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            rawResult: null,
            loading: false,
            error: '',
            viewMode: viewMode.value,
            matchPageSize: matchPageSize.value,
            alignment: 'top-left',
            pageNumber: 9,
            totalPages: 392,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));

        const zoomGroup = () => harness.host.querySelector('.preview-zoom-controls');
        const overlayHelp = () => harness.host.querySelector('.preview-overlay-help-trigger');

        // No result at all: controls retain their place, while the old full
        // width legend row is absent.
        expect(zoomGroup()).not.toBeNull();
        expect(harness.host.querySelector<HTMLButtonElement>('.preview-zoom-value')?.disabled).toBe(true);
        expect(overlayHelp()).not.toBeNull();
        expect(overlayHelp()?.getAttribute('aria-label')).toBe('Preview overlay legend');
        expect(harness.host.querySelector('.overlay-legend')).toBeNull();

        result.value = spreadPreviewResult();
        await nextTick();
        expect(harness.host.querySelector<HTMLButtonElement>('.preview-zoom-value')?.disabled).toBe(false);

        // Comparison and canvas-mode changes do not move the compact help
        // trigger or bring the removed row back.
        viewMode.value = 'original';
        await nextTick();
        expect(overlayHelp()).not.toBeNull();

        matchPageSize.value = false;
        viewMode.value = 'cleaned';
        await nextTick();
        expect(overlayHelp()).not.toBeNull();
        expect(harness.host.querySelector('.overlay-legend')).toBeNull();
    });

    it('reserves the widest page counter and detection counter so their neighbours never move', async () => {
        const pageNumber = ref(9);
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: null,
            rawResult: null,
            loading: false,
            error: '',
            matchPageSize: true,
            alignment: 'top-left',
            pageNumber: pageNumber.value,
            totalPages: 392,
            manualSplit: null,
            readingOrder: 'ltr',
        })}));
        const sizer = () => harness.host
            .querySelector('.page-label .scan-cleanup-stable-width-sizer')?.textContent;
        const value = () => harness.host
            .querySelector('.page-label .scan-cleanup-stable-width-value')?.textContent;

        expect(value()).toBe('Page 9 of 392');
        expect(sizer()).toBe('Page 392 of 392');
        pageNumber.value = 10;
        await nextTick();
        expect(value()).toBe('Page 10 of 392');
        // The reserved box is driven by the total, so it does not grow with the page.
        expect(sizer()).toBe('Page 392 of 392');

        const toolbar = mount(defineComponent(() => () => h(ScanCleanupToolbar, {
            canDetectAll: false,
            canRun: true,
            cancelRequested: false,
            detectionCancelRequested: false,
            detectionError: '',
            detectionProgressText: 'Detecting pages — 9 / 392',
            detectionProgressWidestText: 'Detecting pages — 392 / 392',
            isDetecting: true,
            isRunning: false,
            outputEstimate: '',
            percent: 2,
            progressCountText: '',
            progressPhaseText: '',
            progressText: '',
            runLabel: 'Clean up',
            runDisabledReason: '',
            transitionText: '',
        })));
        expect(toolbar.host.querySelector('.scan-cleanup-toolbar-count .scan-cleanup-stable-width-sizer')?.textContent)
            .toBe('Detecting pages — 392 / 392');
    });

    it('says what stopping detection costs and offers it as a tooltip, not a bare X', () => {
        const cancelLabel = 'Stop detecting pages — pages already detected keep their results';
        const harness = mount(defineComponent(() => () => h(ScanCleanupToolbar, {
            canDetectAll: false,
            canRun: true,
            cancelRequested: false,
            detectionCancelRequested: false,
            detectionError: '',
            detectionProgressText: 'Detecting pages — 36 / 392',
            detectionProgressWidestText: 'Detecting pages — 392 / 392',
            isDetecting: true,
            isRunning: false,
            outputEstimate: '',
            percent: 9,
            progressCountText: '',
            progressPhaseText: '',
            progressText: '',
            runLabel: 'Clean up',
            runDisabledReason: '',
            transitionText: '',
        })));
        const cancel = harness.host.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-cancel-detection');
        expect(cancel?.getAttribute('aria-label')).toBe(cancelLabel);
    });

    it('presents the background-analysis handoff as indeterminate instead of resetting to zero percent', () => {
        const transitionText = 'Stopping background analysis…';
        const harness = mount(defineComponent(() => () => h(ScanCleanupToolbar, {
            canDetectAll: false,
            canRun: false,
            cancelRequested: false,
            detectionCancelRequested: false,
            detectionError: '',
            detectionProgressText: '',
            detectionProgressWidestText: '',
            isDetecting: false,
            isRunning: true,
            outputEstimate: '',
            percent: 0,
            progressCountText: '0 / 392',
            progressPhaseText: 'Queued',
            progressText: 'Queued',
            runLabel: 'Clean up',
            runDisabledReason: '',
            transitionText,
        })));
        const meter = harness.host.querySelector('.scan-cleanup-run-meter');

        expect(meter?.textContent).toContain(transitionText);
        expect(meter?.textContent).toContain('Calculating time for current task…');
        expect(meter?.textContent).not.toContain('0 / 392');
        expect(meter?.textContent).not.toContain('0%');
        expect(meter?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBeNull();
        expect(meter?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe(`Step 2 of 3: ${transitionText}`);
        expect(meter?.querySelector('.scan-cleanup-run-segment-fill--indeterminate')).not.toBeNull();
    });

    it('shows live pre-analysis progress in the run meter while a run waits for detection', () => {
        // The queued run job sits at 0% for the entire pre-analysis of a large
        // book; the meter must carry detection's counter and percent instead
        // of a dead bar (observed as minutes at 0 on a 392-page scan).
        const harness = mount(defineComponent(() => () => h(ScanCleanupToolbar, {
            canDetectAll: false,
            canRun: false,
            cancelRequested: false,
            detectionCancelRequested: false,
            detectionError: '',
            detectionProgressText: '',
            detectionProgressWidestText: '',
            isDetecting: false,
            isRunning: true,
            outputEstimate: '',
            percent: 25,
            progressPhase: 'analyze',
            progressCountText: '98 / 392',
            progressPhaseText: 'Pre-analyzing pages',
            progressText: 'Pre-analyzing pages — 98 / 392',
            runLabel: 'Clean up',
            runDisabledReason: '',
            transitionText: '',
        })));
        const meter = harness.host.querySelector('.scan-cleanup-run-meter');
        const fill = harness.host.querySelector<HTMLElement>('[aria-current="step"] .scan-cleanup-run-segment-fill');

        expect(meter?.textContent).toContain('Pre-analyzing pages');
        expect(meter?.textContent).toContain('98 / 392');
        expect(meter?.textContent).toContain('Calculating time for current task…');
        expect(meter?.querySelector('[aria-current="step"]')?.getAttribute('aria-label')).toBe('Analyze pages');
        expect(meter?.textContent).toContain('Step 1 of 3');
        expect(fill?.style.width).toBe('25%');
        expect(meter?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
        // Progress belongs to the step it measures: only the current segment
        // fills, and segments not yet reached carry no fill.
        expect(meter?.querySelectorAll('.scan-cleanup-run-segment-fill')).toHaveLength(1);
    });

    it('finishes with a stable user phase instead of object counts or a false percentage', () => {
        const harness = mount(defineComponent(() => () => h(ScanCleanupToolbar, {
            canDetectAll: false,
            canRun: false,
            cancelRequested: false,
            detectionCancelRequested: false,
            detectionError: '',
            detectionProgressText: '',
            detectionProgressWidestText: '',
            isDetecting: false,
            isRunning: true,
            outputEstimate: '',
            percent: null,
            progressPhase: 'finish',
            progressCountText: '',
            progressEtaText: 'Almost done',
            progressPhaseText: 'Building PDF',
            progressText: 'Building PDF. Almost done',
            runLabel: 'Clean up',
            runDisabledReason: '',
            transitionText: '',
        })));
        const meter = harness.host.querySelector('.scan-cleanup-run-meter');

        expect(meter?.querySelector('[aria-current="step"]')?.getAttribute('aria-label')).toBe('Finish PDF');
        expect(meter?.textContent).toContain('Step 3 of 3');
        expect(meter?.textContent).toContain('Building PDF');
        expect(meter?.textContent).toContain('Almost done');
        expect(meter?.textContent).not.toContain('316 / 316');
        expect(meter?.textContent).not.toMatch(/\b98%\b/);
        expect(meter?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBeNull();
        expect(meter?.querySelector('.scan-cleanup-run-segment-fill--indeterminate')).not.toBeNull();
        expect(meter?.querySelectorAll('.scan-cleanup-run-segment-fill--complete')).toHaveLength(2);
    });

    it('keeps every state-gated setting mounted so switching modes never moves the panel', async () => {
        const settings = reactive({
            preserveOriginalQuality: false,
            layoutMode: 'auto' as const,
            outputMode: 'bw' as 'auto' | 'bw' | 'grayscale' | 'color' | 'mixed',
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'center' as const,
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
            despeckle: true,
            skipBlankPages: false,
            pageOverrides: {},
        });
        const scope = ref<'all' | 'page' | 'selected'>('all');
        const harness = mount(defineComponent({setup: () => () => h(
            ScanCleanupSettingsPanel,
            settingsPanelProps(settings, scope.value),
        )}));

        const thicknessSlider = () => harness.host.querySelector('[aria-label="Text thickness"]');
        const placementHint = () => harness.host.querySelector('.scan-cleanup-selection-hint.is-reserved');
        const applyHint = () => harness.host.querySelector('#scan-cleanup-apply-page-hint');

        expect(thicknessSlider()).not.toBeNull();
        expect(placementHint()).not.toBeNull();
        expect(applyHint()).not.toBeNull();

        // B&W -> grayscale used to unmount the thickness field and pull every
        // control below it upwards; now it only disables.
        settings.outputMode = 'grayscale';
        await nextTick();
        expect(thicknessSlider()).not.toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-field-disabled')).not.toBeNull();

        settings.outputMode = 'color';
        await nextTick();
        expect(thicknessSlider()).not.toBeNull();

        // The placement help text is gated by a checkbox; its line stays.
        settings.matchPageSize = false;
        await nextTick();
        expect(placementHint()?.textContent).toContain('Enable match page size');
        settings.matchPageSize = true;
        await nextTick();
        expect(placementHint()).not.toBeNull();
        expect(placementHint()?.textContent?.trim()).toBe('');

        scope.value = 'page';
        await nextTick();
        expect(applyHint()).not.toBeNull();
        expect(applyHint()?.textContent?.trim()).toBe('');
    });

    it('commits a manually entered margin through the settings control', async () => {
        const settings = reactive({
            preserveOriginalQuality: false,
            layoutMode: 'auto' as const,
            outputMode: 'auto' as const,
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'center' as const,
            marginsMm: {
                leftMm: 5,
                topMm: 5,
                rightMm: 5,
                bottomMm: 5,
            },
            despeckle: true,
            skipBlankPages: false,
            pageOverrides: {},
        });
        const updateMargin = vi.fn((target: keyof typeof settings.marginsMm, value: number) => {
            settings.marginsMm[target] = value;
        });
        const harness = mount(defineComponent({setup: () => () => h(
            ScanCleanupSettingsPanel,
            Object.assign(settingsPanelProps(settings, 'all', {margins: {
                empty: false,
                mixed: false,
                value: settings.marginsMm,
            }}), {'onUpdate-margin': updateMargin}),
        )}));

        const top = harness.host.querySelector<HTMLInputElement>('[data-margin-side="topMm"]');
        expect(top).not.toBeNull();
        top!.value = '25';
        top!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();

        expect(updateMargin).toHaveBeenCalledWith('topMm', 25);
        expect(settings.marginsMm.topMm).toBe(25);

        for (const invalidValue of [
            '',
            '-1',
            '26',
        ]) {
            top!.value = invalidValue;
            top!.dispatchEvent(new Event('change', {bubbles: true}));
        }
        await nextTick();

        expect(updateMargin).toHaveBeenCalledTimes(1);
        expect(settings.marginsMm.topMm).toBe(25);
    });

    it('rejects dewarp depths outside the executable range', async () => {
        const settings = reactive({
            preserveOriginalQuality: false,
            layoutMode: 'auto' as const,
            outputMode: 'auto' as const,
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'center' as const,
            marginsMm: {
                leftMm: 5,
                topMm: 5,
                rightMm: 5,
                bottomMm: 5,
            },
            despeckle: true,
            autoDewarp: true,
            autoDewarpDepth: undefined as number | undefined,
            skipBlankPages: false,
            pageOverrides: {},
        });
        const updateSetting = vi.fn((key: string, value: unknown) => {
            if (key === 'autoDewarpDepth') settings.autoDewarpDepth = value as number;
        });
        const harness = mount(defineComponent({setup: () => () => h(
            ScanCleanupSettingsPanel,
            Object.assign(settingsPanelProps(settings, 'all'), {'onUpdate-setting': updateSetting}),
        )}));

        const depth = harness.host.querySelector<HTMLInputElement>(
            '[aria-label="scanCleanup.advanced.autoDewarpDepth"]',
        );
        expect(depth).not.toBeNull();
        for (const invalidValue of ['0.4', '4.1']) {
            depth!.value = invalidValue;
            depth!.dispatchEvent(new Event('change', {bubbles: true}));
        }
        await nextTick();
        expect(updateSetting).not.toHaveBeenCalledWith('autoDewarpDepth', expect.anything());

        depth!.value = '1.8';
        depth!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(updateSetting).toHaveBeenCalledWith('autoDewarpDepth', 1.8);
    });

    it('starts the deskew stepper at the neutral angle and states the range it accepts', async () => {
        const settings = reactive({
            preserveOriginalQuality: false,
            layoutMode: 'auto' as const,
            outputMode: 'auto' as const,
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'center' as const,
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
            despeckle: true,
            skipBlankPages: false,
            pageOverrides: {},
        });
        const manualSkew = ref<{
            empty: boolean;
            mixed: boolean;
            value: number | undefined;
        }>({
            empty: false,
            mixed: false,
            value: undefined,
        });
        const harness = mount(defineComponent({setup: () => () => h(
            ScanCleanupSettingsPanel,
            settingsPanelProps(settings, 'page', {manualSkew: manualSkew.value}),
        )}));

        const entry = () => harness.host
            .querySelector<HTMLInputElement>('[aria-label="Deskew angle (-15° to 15°)"]');
        expect(entry()).not.toBeNull();
        // Automatic used to bind null, and a null number field steps to its
        // minimum: the first press landed on -15° and never came back.
        expect(entry()?.value).toBe('0');
        expect(entry()?.getAttribute('placeholder')).toBeNull();

        manualSkew.value = {
            empty: false,
            mixed: false,
            value: 4.2,
        };
        await nextTick();
        expect(entry()?.value).toBe('4.2');
        expect(harness.host.querySelector('[data-auto-value-state="manual"]')?.textContent).toContain('+4.2°');

        manualSkew.value = {
            empty: false,
            mixed: true,
            value: undefined,
        };
        await nextTick();
        expect(entry()?.value).toBe('');
        expect(entry()?.getAttribute('increment-disabled')).toBe('true');
    });

});
