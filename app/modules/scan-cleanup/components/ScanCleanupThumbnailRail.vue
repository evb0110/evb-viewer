<template>
    <aside class="scan-thumbnail-rail" :aria-label="t('scanCleanup.pages.title')">
        <header class="scan-thumbnail-rail-header">
            <div class="scan-thumbnail-rail-heading">
                <strong>{{ t('scanCleanup.pages.title') }}</strong>
                <span :aria-label="t('scanCleanup.pages.count', {count: totalPages})">{{ totalPages }}</span>
            </div>
            <div class="scan-thumbnail-rail-actions">
                <USelect
                    v-model="sortMode"
                    class="scan-thumbnail-sort"
                    :items="sortItems"
                    value-key="value"
                    size="xs"
                    portal="body"
                    :ui="{content: 'min-w-fit'}"
                    :disabled="disabled"
                    :aria-label="t('scanCleanup.pages.sort.label')"
                />
            </div>
        </header>

        <div
            v-if="!source"
            class="scan-thumbnail-source-state"
            :class="{'is-error': !sourcePending}"
            :role="sourcePending ? 'status' : 'alert'"
            :aria-live="sourcePending ? 'polite' : 'assertive'"
        >
            <UIcon
                :name="sourcePending ? 'i-ph-circle-notch' : 'i-ph-warning-circle'"
                :class="{'is-spinning': sourcePending}"
            />
            <strong>{{ sourcePending
                ? t('scanCleanup.pages.sourceLoading')
                : t('scanCleanup.pages.sourceUnavailable') }}</strong>
            <span v-if="!sourcePending">{{ t('scanCleanup.pages.sourceUnavailableHint') }}</span>
        </div>

        <DocumentThumbnailList
            v-else
            class="scan-thumbnail-list"
            :source="orderedSource"
            :current-page="leaderPosition"
            :selected-pages="selectedPositions"
            :item-metrics-key="leaderPosition"
            :disabled="disabled"
            item-tag="div"
            role="listbox"
            aria-multiselectable="true"
            :aria-disabled="disabled"
            :aria-label="t('scanCleanup.pages.title')"
            :tabindex="disabled ? -1 : 0"
            @go-to-page="handleRowClick"
            @keydown="handleKeydown"
        >
            <template #overlay="{pageNumber: position}">
                <div
                    class="scan-thumbnail-overlay"
                    :class="{'is-excluded': pageOverride(naturalPage(position)).excluded}"
                    :data-page-number="naturalPage(position)"
                    :data-classification="classificationKind(naturalPage(position))"
                >
                    <div
                        class="scan-thumbnail-actions"
                        @click.stop
                        @pointerdown.stop
                    >
                        <UPopover
                            :open="optionsPopoverPage === naturalPage(position)"
                            portal="body"
                            :content="{side: 'right', align: 'start'}"
                            @update:open="updateOptionsPopover(naturalPage(position), $event)"
                        >
                            <UButton
                                type="button"
                                class="scan-thumbnail-options-toggle"
                                :class="{'is-customized': isCustomized(naturalPage(position))}"
                                color="neutral"
                                variant="soft"
                                size="xs"
                                square
                                :icon="needsAttention(naturalPage(position))
                                    ? 'i-ph-warning'
                                    : 'i-ph-sliders-horizontal'"
                                :aria-label="t('scanCleanup.pages.options', {page: naturalPage(position)})"
                                :aria-expanded="optionsPopoverPage === naturalPage(position)"
                                aria-haspopup="dialog"
                                :disabled="disabled"
                            />

                            <template #content>
                                <div
                                    class="scan-thumbnail-options"
                                    @click.stop
                                    @pointerdown.stop
                                    @keydown.esc.stop.prevent="closeOptionsPopover(naturalPage(position))"
                                >
                                    <strong>{{ t('scanCleanup.pages.optionsTitle', {
                                        page: naturalPage(position),
                                    }) }}</strong>
                                    <p
                                        v-for="hint in attentionHints(naturalPage(position))"
                                        :key="hint"
                                        class="scan-thumbnail-options-notice"
                                    >
                                        <UIcon name="i-ph-warning" aria-hidden="true" />
                                        <span>{{ hint }}</span>
                                    </p>
                                    <div class="scan-thumbnail-options-field">
                                        <span>{{ t('scanCleanup.layout.label') }}</span>
                                        <USelect
                                            class="scan-thumbnail-layout-select"
                                            :model-value="pageOverride(naturalPage(position)).layoutOverride"
                                            :items="overrideItems"
                                            value-key="value"
                                            size="xs"
                                            portal="body"
                                            :content="{position: 'popper', side: 'bottom', align: 'start'}"
                                            :ui="overrideSelectUi"
                                            :aria-label="t('scanCleanup.pages.overrideFor', {page: naturalPage(position)})"
                                            :disabled="disabled"
                                            @update:model-value="updateOverride(naturalPage(position), {layoutOverride: $event})"
                                        />
                                    </div>
                                    <div class="scan-thumbnail-options-field">
                                        <span>{{ t('scanCleanup.settings.rotation') }}</span>
                                        <USelect
                                            class="scan-thumbnail-rotation-select"
                                            :model-value="pageOverride(naturalPage(position)).rotationDegrees"
                                            :items="rotationItems"
                                            value-key="value"
                                            size="xs"
                                            portal="body"
                                            :content="{position: 'popper', side: 'bottom', align: 'start'}"
                                            :ui="overrideSelectUi"
                                            :aria-label="t('scanCleanup.pages.rotationFor', {page: naturalPage(position)})"
                                            :disabled="disabled"
                                            @update:model-value="updateRotationOverride(naturalPage(position), $event)"
                                        />
                                    </div>
                                    <div class="scan-thumbnail-options-field">
                                        <span>{{ t('scanCleanup.output.pageLabel') }}</span>
                                        <USelect
                                            class="scan-thumbnail-output-mode-select"
                                            :model-value="pageOverride(naturalPage(position)).outputModeOverride ?? 'auto'"
                                            :items="outputModeItems"
                                            value-key="value"
                                            size="xs"
                                            portal="body"
                                            :content="{position: 'popper', side: 'bottom', align: 'start'}"
                                            :ui="overrideSelectUi"
                                            :aria-label="t('scanCleanup.pages.outputModeFor', {page: naturalPage(position)})"
                                            :disabled="disabled || preserveOriginalQuality"
                                            @update:model-value="updateOutputModeOverride(naturalPage(position), $event)"
                                        />
                                        <p class="scan-thumbnail-options-hint">{{ outputModeHint(naturalPage(position)) }}</p>
                                    </div>
                                    <details
                                        v-if="diagnosticGroups(naturalPage(position)).length > 0"
                                        class="scan-thumbnail-technical"
                                    >
                                        <summary>{{ t('scanCleanup.pages.technicalDetails') }}</summary>
                                        <dl>
                                            <div
                                                v-for="group in diagnosticGroups(naturalPage(position))"
                                                :key="group.title"
                                                class="scan-thumbnail-diagnostic-group"
                                            >
                                                <h4>{{ group.title }}</h4>
                                                <div
                                                    v-for="note in group.notes"
                                                    :key="note"
                                                    class="scan-thumbnail-diagnostic-note"
                                                >{{ note }}</div>
                                                <div
                                                    v-for="(row, rowIndex) in group.rows"
                                                    :key="`${group.title}-${rowIndex}`"
                                                    class="scan-thumbnail-diagnostic-row"
                                                >
                                                    <dt>{{ row.label }}</dt>
                                                    <dd>{{ row.value }}</dd>
                                                </div>
                                            </div>
                                        </dl>
                                    </details>
                                </div>
                            </template>
                        </UPopover>
                        <AppTooltip
                            :disabled="disabled"
                            :text="includeLabel(naturalPage(position))"
                            usefulness="always"
                        >
                            <UButton
                                type="button"
                                class="scan-thumbnail-exclude-toggle"
                                :color="pageOverride(naturalPage(position)).excluded ? 'neutral' : 'primary'"
                                variant="soft"
                                size="xs"
                                square
                                :icon="pageOverride(naturalPage(position)).excluded ? 'i-ph-eye-slash' : 'i-ph-eye'"
                                role="switch"
                                :aria-checked="!pageOverride(naturalPage(position)).excluded"
                                :aria-label="includeLabel(naturalPage(position))"
                                :disabled="disabled"
                                @click="updateOverride(naturalPage(position), {
                                    excluded: !pageOverride(naturalPage(position)).excluded,
                                })"
                            />
                        </AppTooltip>
                    </div>
                </div>
            </template>
            <template #label="{pageNumber: position}">
                <span class="scan-thumbnail-label-band">
                    <span class="scan-thumbnail-label-row">
                        <span
                            class="scan-thumbnail-page-number"
                            :class="{'is-excluded': pageOverride(naturalPage(position)).excluded}"
                        >{{ naturalPage(position) }}</span>
                        <UIcon
                            v-if="processedPages?.has(naturalPage(position))"
                            name="i-ph-check-circle"
                            class="scan-thumbnail-processed"
                            :aria-label="t('scanCleanup.pages.processed')"
                        />
                    </span>
                    <span
                        v-if="isDetectionPending(naturalPage(position))"
                        class="scan-thumbnail-status scan-thumbnail-detection-pending"
                        role="status"
                        :aria-label="t('scanCleanup.pages.detectionPending', {page: naturalPage(position)})"
                    >
                        <UIcon name="i-ph-circle-notch" class="is-spinning" aria-hidden="true" />
                        <span>{{ t('scanCleanup.pages.detecting') }}</span>
                    </span>
                    <span
                        v-else
                        class="scan-thumbnail-status"
                        :class="{'is-excluded': pageOverride(naturalPage(position)).excluded}"
                    >{{ statusSummary(naturalPage(position)) }}</span>
                </span>
            </template>
        </DocumentThumbnailList>
    </aside>
</template>

<script setup lang="ts">
import type {
    IScanCleanupPageOverride,
    IScanCleanupContentBlockEvidence,
    IScanCleanupContentAcceptedTrim,
    IScanCleanupPageOutputDiagnostics,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewPageMetadata,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageOverrides,
    TScanCleanupPageRotation,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeRecommendationReason,
    TScanCleanupOutputModeSetting,
    IScanCleanupTextAxis,
} from '@contracts/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
    isDefaultScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import type {
    IScanCleanupPageOrder,
    TScanCleanupOrderedPages,
    TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';
import {createScanCleanupSparsePageOrder} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';

type TScanCleanupRailSort = 'natural' | 'classification' | 'confidence';
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const PAGE_KEYBOARD_STEP = 5;

const props = defineProps<{
    source: IDocumentPageSource | null;
    totalPages: number;
    selectionLeader: number;
    selectedPages: ReadonlySet<number>;
    overrides: TScanCleanupPageOverrides;
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>;
    confidences: ReadonlyMap<number, number>;
    diagnostics?: ReadonlyMap<number, IScanCleanupPreviewPageMetadata>;
    documentOutputMode: TScanCleanupOutputModeSetting;
    preserveOriginalQuality: boolean;
    recommendedOutputModes?: ReadonlyMap<number, TScanCleanupOutputMode>;
    recommendedOutputModeConfidences?: ReadonlyMap<number, number>;
    recommendedOutputModeReasons?: ReadonlyMap<number, TScanCleanupOutputModeRecommendationReason>;
    textAxes?: ReadonlyMap<number, IScanCleanupTextAxis>;
    disabled: boolean;
    processedPages?: ReadonlySet<number>;
    sourcePending?: boolean;
    detectionActive?: boolean;
    settledPages?: ReadonlySet<number>;
}>();
const emit = defineEmits<{
    'select-page': [page: number, intent: TScanCleanupSelectionIntent, orderedPages: TScanCleanupOrderedPages];
    'update:override': [page: number, value: IScanCleanupPageOverride];
}>();
const {t} = useTypedI18n();
const sortMode = ref<TScanCleanupRailSort>('natural');
const optionsPopoverPage = ref<number | null>(null);
const sortItems = computed(() => [
    {
        value: 'natural' as const,
        label: t('scanCleanup.pages.sort.natural'),
    },
    {
        value: 'classification' as const,
        label: t('scanCleanup.pages.sort.classification'),
    },
    {
        value: 'confidence' as const,
        label: t('scanCleanup.pages.sort.confidence'),
    },
]);
const overrideItems = computed<Array<{
    label: string;
    value: TScanCleanupPageLayoutOverride
}>>(() => [
    {
        value: 'auto',
        label: t('scanCleanup.pages.override.auto'),
    },
    {
        value: 'single',
        label: t('scanCleanup.pages.override.single'),
    },
    {
        value: 'spread',
        label: t('scanCleanup.pages.override.spread'),
    },
    {
        value: 'keep-left',
        label: t('scanCleanup.pages.override.keepLeft'),
    },
    {
        value: 'keep-right',
        label: t('scanCleanup.pages.override.keepRight'),
    },
]);
const rotationItems = computed<Array<{
    label: string;
    value: TScanCleanupPageRotation
}>>(() => [
    0,
    90,
    180,
    270,
].map(value => ({
    value: value as TScanCleanupPageRotation,
    label: `${value}°`,
})));
const outputModeItems = computed<Array<{
    label: string;
    value: TScanCleanupOutputMode | 'auto'
}>>(() => [
    {
        value: 'auto',
        label: t('scanCleanup.pages.outputModeFollowDocument'),
    },
    {
        value: 'bw',
        label: t('scanCleanup.output.bw'),
    },
    {
        value: 'grayscale',
        label: t('scanCleanup.output.grayscale'),
    },
    {
        value: 'color',
        label: t('scanCleanup.output.color'),
    },
    {
        value: 'mixed',
        label: t('scanCleanup.output.mixed'),
    },
]);
const overrideSelectUi = {
    content: 'scan-thumbnail-override-menu w-auto min-w-(--reka-select-trigger-width)',
    itemLabel: 'overflow-visible whitespace-nowrap text-clip',
    itemWrapper: 'min-w-max',
};
const classificationRank: Record<IScanCleanupPreviewMetadata['layoutClassification'], number> = {
    'single-uncut-page': 0,
    'page-with-offcut': 1,
    'two-page-spread': 2,
};
const orderedPages = computed<IScanCleanupPageOrder>(() => {
    const pageCount = props.source?.pageCount ?? props.totalPages;
    if (sortMode.value === 'classification') {
        return createScanCleanupSparsePageOrder(
            pageCount,
            props.classifications.keys(),
            (left, right) => {
                const leftValue = props.classifications.get(left);
                const rightValue = props.classifications.get(right);
                return (leftValue === undefined ? Number.POSITIVE_INFINITY : classificationRank[leftValue])
                    - (rightValue === undefined ? Number.POSITIVE_INFINITY : classificationRank[rightValue])
                    || left - right;
            },
        );
    }
    if (sortMode.value === 'confidence') {
        return createScanCleanupSparsePageOrder(
            pageCount,
            props.confidences.keys(),
            (left, right) => {
                const leftValue = props.confidences.get(left);
                const rightValue = props.confidences.get(right);
                return (leftValue ?? Number.POSITIVE_INFINITY) - (rightValue ?? Number.POSITIVE_INFINITY)
                    || left - right;
            },
        );
    }
    return {
        length: pageCount,
        pageAt: position => position >= 1 && position <= pageCount ? position : undefined,
        positionOf: page => page >= 1 && page <= pageCount ? page : -1,
    };
});
const orderedSource = computed<IDocumentPageSource | null>(() => {
    const source = props.source;
    const order = orderedPages.value;
    if (!source) {
        return null;
    }
    function mapRequest(request: Parameters<IDocumentPageSource['renderPage']>[0]) {
        return {
            ...request,
            pageNumber: order.pageAt(request.pageNumber) ?? request.pageNumber,
        };
    }
    const thumbnailProvider = source.thumbnailProvider;
    return {
        kind: source.kind,
        documentRef: source.documentRef,
        pageCount: order.length,
        getPageMetrics(position, signal) {
            return source.getPageMetrics(order.pageAt(position) ?? position, signal);
        },
        renderPage(request) {
            return source.renderPage(mapRequest(request));
        },
        thumbnailProvider: thumbnailProvider ? {renderThumbnail(request) {
            return thumbnailProvider.renderThumbnail(mapRequest(request));
        }} : undefined,
        dispose() {},
    };
});
const leaderPosition = computed(() => Math.max(1, orderedPages.value.positionOf(props.selectionLeader)));
const selectedPositions = computed(() => {
    const positions = new Set<number>();
    for (const page of props.selectedPages) {
        const position = orderedPages.value.positionOf(page);
        if (position >= 1) positions.add(position);
    }
    return positions;
});

function naturalPage(position: number) {
    return orderedPages.value.pageAt(position) ?? position;
}

function pageOverride(page: number) {
    return getScanCleanupPageOverride(
        props.overrides,
        requirePageNumber(page, Math.max(1, props.totalPages)),
    );
}

function isCustomized(page: number) {
    return !isDefaultScanCleanupPageOverride(pageOverride(page));
}

function updateOverride(page: number, patch: Partial<IScanCleanupPageOverride>) {
    if (props.disabled) {
        return;
    }
    emit('update:override', page, createScanCleanupPageOverride({
        ...pageOverride(page),
        ...patch,
    }));
}

function updateRotationOverride(page: number, value: unknown) {
    const rotation = Number(value);
    if (![
        0,
        90,
        180,
        270,
    ].includes(rotation)) {
        return;
    }
    updateOverride(page, {rotationDegrees: rotation as TScanCleanupPageRotation});
}

function displayedOutputMode(page: number) {
    return resolveScanCleanupEffectiveOutputMode({
        options: {
            outputMode: props.documentOutputMode,
            preserveOriginalQuality: props.preserveOriginalQuality,
        },
        pageOverride: pageOverride(page),
        detectedOutputMode: props.recommendedOutputModes?.get(page),
    });
}

function outputModeShortLabel(mode: TScanCleanupOutputMode | undefined) {
    if (mode === undefined) {
        return '';
    }
    if (mode === 'bw') {
        return t('scanCleanup.output.bwShort');
    }
    if (mode === 'grayscale') {
        return t('scanCleanup.output.grayscaleShort');
    }
    if (mode === 'color') {
        return t('scanCleanup.output.colorShort');
    }
    return t('scanCleanup.output.mixedShort');
}

function outputModeHint(page: number) {
    if (props.preserveOriginalQuality) {
        return t('scanCleanup.pages.outputModeLosslessControlHint');
    }
    const override = pageOverride(page).outputModeOverride;
    if (override !== undefined) {
        return t('scanCleanup.pages.outputModeOverrideHint', {mode: outputModeLabel(override)});
    }
    if (props.documentOutputMode !== 'auto') {
        return t('scanCleanup.pages.outputModeDocumentHint', {mode: outputModeLabel(props.documentOutputMode)});
    }
    const recommended = props.recommendedOutputModes?.get(page);
    const confidence = props.recommendedOutputModeConfidences?.get(page);
    if (recommended === undefined) {
        return t('scanCleanup.pages.outputModeRecommendationPending');
    }
    if (confidence === undefined) {
        return t('scanCleanup.pages.outputModeRecommendationHintUnknown', {mode: outputModeLabel(recommended)});
    }
    return t('scanCleanup.pages.outputModeRecommendationHintKnown', {
        mode: outputModeLabel(recommended),
        confidence: `${Math.round(confidence * 100)}%`,
    });
}

function outputModeLabel(mode: TScanCleanupOutputMode) {
    if (mode === 'bw') {
        return t('scanCleanup.output.bw');
    }
    if (mode === 'grayscale') {
        return t('scanCleanup.output.grayscale');
    }
    if (mode === 'color') {
        return t('scanCleanup.output.color');
    }
    return t('scanCleanup.output.mixed');
}

function updateOutputModeOverride(page: number, value: unknown) {
    if (props.disabled) {
        return;
    }
    if (value === 'auto') {
        const {
            outputModeOverride: _outputModeOverride,
            ...withoutOutputMode
        } = pageOverride(page);
        emit('update:override', page, createScanCleanupPageOverride(withoutOutputMode));
        return;
    }
    if ([
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(String(value))) {
        updateOverride(page, {outputModeOverride: value as TScanCleanupOutputMode});
    }
}

function closeOptionsPopover(page: number) {
    if (optionsPopoverPage.value === page) {
        optionsPopoverPage.value = null;
    }
}

function updateOptionsPopover(page: number, open: boolean) {
    if (props.disabled) {
        optionsPopoverPage.value = null;
        return;
    }
    optionsPopoverPage.value = open ? page : null;
}

function classificationKind(page: number) {
    const classification = props.classifications.get(page);
    if (classification === 'two-page-spread') {
        return 'spread';
    }
    if (classification === 'page-with-offcut') {
        return 'offcut';
    }
    if (classification === 'single-uncut-page') {
        return 'single';
    }
    return 'unclassified';
}

function classificationValueLabel(
    classification: IScanCleanupPreviewMetadata['layoutClassification'] | undefined,
) {
    if (classification === 'two-page-spread') {
        return t('scanCleanup.pages.classification.spread');
    }
    if (classification === 'page-with-offcut') {
        return t('scanCleanup.pages.classification.offcut');
    }
    if (classification === 'single-uncut-page') {
        return t('scanCleanup.pages.classification.single');
    }
    return '—';
}

// The layout a page will actually be cut with: an explicit override wins over
// what detection reported, and a page detection has not reached yet has nothing
// truthful to say.
function layoutLabel(page: number) {
    const override = pageOverride(page).layoutOverride;
    if (override === 'single') {
        return t('scanCleanup.pages.override.single');
    }
    if (override === 'spread') {
        return t('scanCleanup.pages.override.spread');
    }
    if (override === 'keep-left') {
        return t('scanCleanup.pages.override.keepLeft');
    }
    if (override === 'keep-right') {
        return t('scanCleanup.pages.override.keepRight');
    }
    const classification = props.classifications.get(page);
    return classification === undefined ? null : classificationValueLabel(classification);
}

// One sentence per thumbnail instead of a strip of chips: what the page will be
// cut into, rendered as, and rotated by, dropped to "Excluded" when it will not
// reach the output at all.
function statusSummary(page: number) {
    const override = pageOverride(page);
    if (override.excluded) {
        return t('scanCleanup.pages.excludedBadge');
    }
    const rotation = override.rotationDegrees;
    return [
        layoutLabel(page),
        outputModeShortLabel(displayedOutputMode(page)),
        rotation === 0 ? '' : `${rotation}°`,
    ].filter(Boolean).join(' · ');
}

function diagnosticsFor(page: number) {
    return props.diagnostics?.get(page);
}

function formatConfidence(value: number | null | undefined) {
    return value === null || value === undefined ? t('scanCleanup.pages.diagnostics.unavailable') : `${Math.round(value * 100)}%`;
}

function diagnosticLayout(page: number) {
    const diagnostics = diagnosticsFor(page);
    return diagnostics
        ? t('scanCleanup.pages.diagnostics.layoutValue', {
            layout: classificationValueLabel(diagnostics.layoutClassification),
            confidence: formatConfidence(diagnostics.layoutConfidence),
        })
        : null;
}

function diagnosticDeskew(page: number) {
    const diagnostics = diagnosticsFor(page);
    if (diagnostics?.detectedSkewDegrees === undefined) {
        return null;
    }
    if (diagnostics.manualSkew === true) {
        return t('scanCleanup.pages.diagnostics.deskewManualValue', {angle: diagnostics.detectedSkewDegrees.toFixed(2)});
    }
    return t('scanCleanup.pages.diagnostics.deskewValue', {
        angle: diagnostics.detectedSkewDegrees.toFixed(2),
        confidence: formatConfidence(diagnostics.skewConfidence),
    });
}

function diagnosticBinarization(page: number) {
    const diagnostics = diagnosticsFor(page);
    const route = diagnostics?.binarizationMode ?? diagnostics?.binarizationDiagnostics?.route;
    return route ? t(`scanCleanup.advanced.binarization.${route}`) : null;
}

function diagnosticRecommendation(page: number) {
    const diagnostics = diagnosticsFor(page);
    const mode = props.recommendedOutputModes?.get(page) ?? diagnostics?.recommendedOutputMode;
    const confidence = props.recommendedOutputModeConfidences?.get(page)
        ?? diagnostics?.recommendedOutputModeConfidence;
    return mode === undefined
        ? null
        : t('scanCleanup.pages.diagnostics.recommendedModeValue', {
            mode: outputModeLabel(mode),
            confidence: formatConfidence(confidence),
        });
}

function diagnosticRecommendationReason(page: number) {
    const reason = props.recommendedOutputModeReasons?.get(page)
        ?? diagnosticsFor(page)?.recommendedOutputModeReason;
    return reason === undefined ? null : t(`scanCleanup.pages.diagnostics.modeReason.${reason}`);
}

function diagnosticBinarizationEvidence(page: number) {
    const evidence = diagnosticsFor(page)?.binarizationDiagnostics;
    if (!evidence) {
        return null;
    }
    return {
        contrast: t('scanCleanup.pages.diagnostics.contrastIlluminationValue', {
            contrast: evidence.robustContrast.toFixed(1),
            illumination: evidence.illuminationDeviation.toFixed(1),
        }),
        edge: t('scanCleanup.pages.diagnostics.edgeStrokeValue', {
            edge: formatConfidence(evidence.edgeDensity),
            stroke: evidence.estimatedStrokeWidthPx.toFixed(1),
        }),
        border: t('scanCleanup.pages.diagnostics.borderAgreementValue', {
            border: formatConfidence(evidence.darkBorderCoverage),
            agreement: formatConfidence(evidence.otsuAdaptiveAgreement),
        }),
    };
}

function diagnosticOutputs(page: number) {
    return diagnosticsFor(page)?.outputDiagnostics ?? [];
}

function removedBlocks(output: IScanCleanupPageOutputDiagnostics) {
    return (output.contentDiagnostics?.acceptedTrims ?? [])
        .flatMap(trim => trim.removedBlocks);
}

function diagnosticTrim(trim: IScanCleanupContentAcceptedTrim) {
    return t('scanCleanup.pages.diagnostics.acceptedTrimValue', {
        side: t(`scanCleanup.pages.diagnostics.trimSide.${trim.side}`),
        score: formatConfidence(trim.score),
        threshold: formatConfidence(trim.threshold),
    });
}

function diagnosticBlock(block: IScanCleanupContentBlockEvidence) {
    const evidence = [
        block.pictureMaskOverlapPixels > 0 ? t('scanCleanup.pages.diagnostics.pictureEvidence') : '',
        block.headingEvidence ? t('scanCleanup.pages.diagnostics.headingEvidence') : '',
        block.grayscaleEvidence ? t('scanCleanup.pages.diagnostics.grayscaleEvidence') : '',
        block.textEvidence ? t('scanCleanup.pages.diagnostics.textEvidence') : '',
    ].filter(Boolean).join(', ') || t('scanCleanup.pages.diagnostics.noProtectedEvidence');
    return t('scanCleanup.pages.diagnostics.boundsValue', {
        x: Math.round(block.bounds.xPx),
        y: Math.round(block.bounds.yPx),
        width: Math.round(block.bounds.widthPx),
        height: Math.round(block.bounds.heightPx),
        evidence,
    });
}

function outputHalfLabel(half: IScanCleanupPageOutputDiagnostics['half']) {
    return {
        full: t('scanCleanup.preview.outputHalf.full'),
        left: t('scanCleanup.preview.outputHalf.left'),
        right: t('scanCleanup.preview.outputHalf.right'),
    }[half];
}

function diagnosticSideConfidence(page: number) {
    const sideConfidence = diagnosticOutputs(page)[0]?.contentDiagnostics?.sideConfidence;
    if (!sideConfidence) {
        return null;
    }
    return ([
        'left',
        'top',
        'right',
        'bottom',
    ] as const).map(side => t('scanCleanup.pages.diagnostics.sideConfidenceValue', {
        side: t(`scanCleanup.pages.diagnostics.trimSide.${side}`),
        confidence: formatConfidence(sideConfidence[side]),
    })).join(' · ');
}

function diagnosticDespeckleFallback(page: number) {
    const fallback = diagnosticsFor(page)?.despeckleFallback;
    return fallback === undefined
        ? null
        : t(fallback
            ? 'scanCleanup.pages.diagnostics.fallbackUsed'
            : 'scanCleanup.pages.diagnostics.fallbackNotUsed');
}

function diagnosticDewarp(page: number) {
    const diagnostics = diagnosticsFor(page);
    if (diagnostics?.autoDewarpAttempted !== true) {
        return null;
    }
    return t(diagnostics.dewarpApplied
        ? 'scanCleanup.pages.diagnostics.dewarpApplied'
        : 'scanCleanup.pages.diagnostics.dewarpGated', {confidence: formatConfidence(diagnostics.dewarpConfidence)});
}

function definedRows(rows: ReadonlyArray<readonly [string, string | null]>) {
    return rows.flatMap(([
        label,
        value,
    ]) => (value === null ? [] : [{
        label,
        value,
    }]));
}

function trimRows(page: number) {
    const outputs = diagnosticOutputs(page);
    return outputs.flatMap(output => {
        const prefix = outputs.length > 1 ? `${outputHalfLabel(output.half)} · ` : '';
        const trims = output.contentDiagnostics?.acceptedTrims ?? [];
        const protectedBlocks = output.contentDiagnostics?.protectedBlocks ?? [];
        const rows = [
            ...trims.map(trim => ({
                label: `${prefix}${t('scanCleanup.pages.diagnostics.acceptedTrim')}`,
                value: diagnosticTrim(trim),
            })),
            ...removedBlocks(output).map(block => ({
                label: `${prefix}${t('scanCleanup.pages.diagnostics.removedBounds')}`,
                value: diagnosticBlock(block),
            })),
            ...protectedBlocks.map(block => ({
                label: `${prefix}${t('scanCleanup.pages.diagnostics.protectedBounds')}`,
                value: diagnosticBlock(block),
            })),
        ];
        return rows.length > 0
            ? rows
            : [{
                label: `${prefix}${t('scanCleanup.pages.diagnostics.trimResult')}`,
                value: t('scanCleanup.pages.diagnostics.noTrim'),
            }];
    });
}

// Only rows the analysis actually produced: an engineering dump three quarters
// of which reads "Unavailable" teaches nothing about this page.
function diagnosticGroups(page: number) {
    const diagnostics = diagnosticsFor(page);
    if (!diagnostics) {
        return [];
    }
    const evidence = diagnosticBinarizationEvidence(page);
    return [
        {
            title: t('scanCleanup.pages.diagnostics.modeDecision'),
            notes: [] as string[],
            rows: definedRows([
                [
                    t('scanCleanup.pages.diagnostics.recommendedMode'),
                    diagnosticRecommendation(page),
                ],
                [
                    t('scanCleanup.pages.diagnostics.reason'),
                    diagnosticRecommendationReason(page),
                ],
                [
                    t('scanCleanup.pages.diagnostics.binarization'),
                    diagnosticBinarization(page),
                ],
                [
                    t('scanCleanup.pages.diagnostics.contrastIllumination'),
                    evidence?.contrast ?? null,
                ],
                [
                    t('scanCleanup.pages.diagnostics.edgeStroke'),
                    evidence?.edge ?? null,
                ],
                [
                    t('scanCleanup.pages.diagnostics.borderAgreement'),
                    evidence?.border ?? null,
                ],
                [
                    t('scanCleanup.pages.diagnostics.despeckleFallback'),
                    diagnosticDespeckleFallback(page),
                ],
            ]),
        },
        {
            title: t('scanCleanup.pages.diagnostics.contentTrim'),
            notes: [] as string[],
            rows: trimRows(page),
        },
        {
            title: t('scanCleanup.pages.diagnostics.geometry'),
            notes: [
                diagnostics.reconciled === true ? t('scanCleanup.pages.diagnostics.reconciled') : '',
                diagnostics.splitAbstained === true ? t('scanCleanup.pages.diagnostics.splitAbstained') : '',
            ].filter(Boolean),
            rows: definedRows([
                [
                    t('scanCleanup.pages.diagnostics.layout'),
                    diagnosticLayout(page),
                ],
                [
                    t('scanCleanup.pages.diagnostics.deskew'),
                    diagnosticDeskew(page),
                ],
                [
                    t('scanCleanup.pages.diagnostics.sideConfidence'),
                    diagnosticSideConfidence(page),
                ],
                [
                    t('scanCleanup.pages.diagnostics.dewarp'),
                    diagnosticDewarp(page),
                ],
            ]),
        },
    ].filter(group => group.rows.length > 0 || group.notes.length > 0);
}

function isLowConfidence(page: number) {
    const confidence = props.confidences.get(page);
    return confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD;
}

function showsSidewaysHint(page: number) {
    return pageOverride(page).rotationDegrees === 0 && (props.textAxes?.get(page)?.sideways ?? false);
}

// The two conditions that used to sit on the thumbnail as separate mystery
// chips; both are now one marked button that opens the control that fixes them.
function attentionHints(page: number) {
    const layoutConfidence = props.confidences.get(page);
    const classification = [
        layoutLabel(page) ?? classificationValueLabel(undefined),
        formatConfidence(layoutConfidence),
    ].join(' · ');
    return [
        isLowConfidence(page)
            ? t('scanCleanup.pages.lowConfidenceHint', {classification})
            : '',
        showsSidewaysHint(page) ? t('scanCleanup.pages.textAxisHint') : '',
    ].filter(Boolean);
}

function needsAttention(page: number) {
    return attentionHints(page).length > 0;
}

// A page keeps its spinner only while its own detection work is outstanding:
// once the running job reports that page as read or analyzed it settles, even
// though the rest of the batch is still going.
function isDetectionPending(page: number) {
    return props.detectionActive === true
        && !props.classifications.has(page)
        && props.settledPages?.has(page) !== true;
}

function includeLabel(page: number) {
    return t(pageOverride(page).excluded
        ? 'scanCleanup.pages.excludedFromOutput'
        : 'scanCleanup.pages.includeInOutput');
}

function handleRowClick(position: number, event?: MouseEvent) {
    if (props.disabled) {
        return;
    }
    const intent: TScanCleanupSelectionIntent = event?.shiftKey
        ? 'range'
        : event?.ctrlKey || event?.metaKey ? 'toggle' : 'single';
    emit('select-page', naturalPage(position), intent, orderedPages.value);
}

function handleKeydown(event: KeyboardEvent) {
    if (props.disabled) {
        return;
    }
    if (
        event.target instanceof HTMLElement
        && [
            'BUTTON',
            'INPUT',
            'SELECT',
        ].includes(event.target.tagName)
    ) {
        return;
    }
    const currentPosition = Math.max(1, orderedPages.value.positionOf(props.selectionLeader));
    let nextIndex: number | null = null;
    if (event.key === 'ArrowUp') nextIndex = currentPosition - 1;
    else if (event.key === 'ArrowDown') nextIndex = currentPosition + 1;
    else if (event.key === 'Home') nextIndex = 1;
    else if (event.key === 'End') nextIndex = orderedPages.value.length;
    else if (event.key === 'PageUp') nextIndex = currentPosition - PAGE_KEYBOARD_STEP;
    else if (event.key === 'PageDown') nextIndex = currentPosition + PAGE_KEYBOARD_STEP;
    if (nextIndex === null || orderedPages.value.length === 0) {
        return;
    }
    event.preventDefault();
    const boundedPosition = Math.min(orderedPages.value.length, Math.max(1, nextIndex));
    const page = orderedPages.value.pageAt(boundedPosition);
    if (page === undefined) {
        return;
    }
    emit('select-page', page, 'single', orderedPages.value);
}

watch(() => props.disabled, disabled => {
    if (disabled) {
        optionsPopoverPage.value = null;
    }
});

</script>

<style scoped>
.scan-thumbnail-rail {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    border-inline-end: var(--app-hairline-height) solid var(--ui-border);
    background: var(--ui-bg);
    container-type: inline-size;
}

.scan-thumbnail-rail-header,
.scan-thumbnail-rail-heading,
.scan-thumbnail-rail-actions,
.scan-thumbnail-actions {
    display: flex;
    align-items: center;
}

.scan-thumbnail-rail-header {
    box-sizing: border-box;
    height: var(--app-scan-header-height);
    min-height: var(--app-scan-header-height);
    flex: 0 0 var(--app-scan-header-height);
    justify-content: space-between;
    gap: var(--app-space-sm);
    padding-inline: var(--app-space-5xl);
    border-block-end: var(--app-hairline-height) solid var(--ui-border);
}

.scan-thumbnail-rail-heading,
.scan-thumbnail-rail-actions {
    min-width: 0;
    gap: var(--app-space-3xl);
}

.scan-thumbnail-rail-heading strong {
    font-size: var(--app-text-size-secondary);
}

.scan-thumbnail-rail-heading span {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-variant-numeric: tabular-nums;
}

.scan-thumbnail-sort {
    min-width: 0;
    flex: 1;
}

.scan-thumbnail-list {
    min-height: 0;
    flex: 1;
}

.scan-thumbnail-source-state {
    display: grid;
    min-height: 0;
    flex: 1;
    place-content: center;
    justify-items: center;
    gap: var(--app-space-3xl);
    padding: var(--app-space-12xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    text-align: center;
}

.scan-thumbnail-source-state.is-error {
    color: var(--ui-error);
}

.scan-thumbnail-overlay {
    position: absolute;
    z-index: var(--app-z-local-raised);
    inset: var(--app-sidebar-row-padding-block);
    pointer-events: none;
}

.scan-thumbnail-overlay.is-excluded::after {
    position: absolute;
    inset: 0;
    border-radius: var(--app-thumbnail-row-radius);
    background: color-mix(in oklab, var(--ui-bg) 58%, transparent);
    content: '';
}

/* Two buttons, always in the same place: nothing appears or disappears under
   the pointer while a page is being edited. */
.scan-thumbnail-actions {
    position: relative;
    z-index: var(--app-z-local-raised);
    justify-content: flex-end;
    gap: var(--app-space-sm);
    padding: var(--app-space-sm);
}

.scan-thumbnail-options-toggle,
.scan-thumbnail-exclude-toggle {
    position: relative;
    flex: none;
    opacity: 0.55;
    pointer-events: auto;
    transition: opacity var(--app-transition-fast);
}

.scan-thumbnail-options-toggle.is-customized,
.scan-thumbnail-list :deep([data-document-thumbnail-item]:hover) .scan-thumbnail-options-toggle,
.scan-thumbnail-list :deep([data-document-thumbnail-item]:hover) .scan-thumbnail-exclude-toggle,
.scan-thumbnail-list :deep([data-document-thumbnail-item].is-selected) .scan-thumbnail-options-toggle,
.scan-thumbnail-list :deep([data-document-thumbnail-item].is-selected) .scan-thumbnail-exclude-toggle,
.scan-thumbnail-options-toggle:focus-visible,
.scan-thumbnail-exclude-toggle:focus-visible {
    opacity: 1;
}

.scan-thumbnail-list :deep([data-document-thumbnail-item].is-disabled:hover) .scan-thumbnail-options-toggle,
.scan-thumbnail-list :deep([data-document-thumbnail-item].is-disabled:hover) .scan-thumbnail-exclude-toggle {
    opacity: 0.55;
}

.scan-thumbnail-options-toggle.is-customized::after {
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: 0;
    width: var(--app-space-3xl);
    height: var(--app-space-3xl);
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
    content: '';
}

.scan-thumbnail-options {
    display: grid;
    width: var(--app-scan-low-confidence-popover-width);
    gap: var(--app-space-5xl);
    padding: var(--app-space-5xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-thumbnail-options-notice {
    display: flex;
    align-items: start;
    gap: var(--app-space-3xl);
    border-radius: var(--app-radius-md);
    background: color-mix(in srgb, var(--ui-warning) 12%, var(--ui-bg));
    padding: var(--app-space-3xl);
    margin: 0;
    color: var(--ui-text);
    line-height: var(--app-line-height-body);
}

.scan-thumbnail-options-notice > :first-child {
    flex: none;
    color: var(--ui-warning);
}

.scan-thumbnail-options-field {
    display: grid;
    gap: var(--app-space-sm);
}

.scan-thumbnail-options-field > span {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-thumbnail-options-hint {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    line-height: var(--app-line-height-body);
}

.scan-thumbnail-technical > summary {
    color: var(--ui-text-muted);
    cursor: pointer;
    font-size: var(--app-text-size-kicker);
}

.scan-thumbnail-technical dl {
    display: grid;
    gap: var(--app-space-5xl);
    padding-block-start: var(--app-space-3xl);
}

.scan-thumbnail-diagnostic-group {
    display: grid;
    gap: var(--app-space-3xl);
}

.scan-thumbnail-diagnostic-group h4 {
    margin: 0;
    color: var(--ui-text);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-heading);
    text-transform: uppercase;
}

.scan-thumbnail-diagnostic-row {
    display: flex;
    justify-content: space-between;
    gap: var(--app-space-3xl);
}

.scan-thumbnail-diagnostic-row dt,
.scan-thumbnail-diagnostic-note {
    color: var(--ui-text-muted);
}

.scan-thumbnail-diagnostic-row dd {
    max-width: 68%;
    margin-inline-start: var(--app-space-3xl);
    text-align: end;
    overflow-wrap: anywhere;
}

.scan-thumbnail-diagnostic-note {
    font-size: var(--app-text-size-kicker);
}

.scan-thumbnail-layout-select,
.scan-thumbnail-rotation-select,
.scan-thumbnail-output-mode-select {
    width: 100%;
}

/* Every row carries the same two label lines, so a page never changes height
   when it is selected, excluded, or finishes detection. */
.scan-thumbnail-label-band {
    display: grid;
    width: 100%;
    gap: var(--app-space-xs);
    line-height: var(--app-thumbnail-min-label-height);
}

.scan-thumbnail-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-sm);
}

.scan-thumbnail-page-number {
    font-weight: var(--app-font-weight-heading);
    font-variant-numeric: tabular-nums;
}

.scan-thumbnail-page-number.is-excluded {
    color: var(--ui-text-dimmed);
    text-decoration: line-through;
}

.scan-thumbnail-processed {
    flex: none;
    color: var(--ui-success);
}

.scan-thumbnail-status {
    display: flex;
    min-height: var(--app-thumbnail-min-label-height);
    align-items: center;
    gap: var(--app-space-xs);
    overflow: hidden;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scan-thumbnail-status.is-excluded {
    color: var(--ui-text-dimmed);
}

@container (width <= 10rem) {
    .scan-thumbnail-rail-header {
        gap: var(--app-space-xs);
        padding-inline: var(--app-space-lg);
    }

    .scan-thumbnail-rail-heading {
        flex: none;
    }

    .scan-thumbnail-rail-heading strong {
        display: none;
    }

    .scan-thumbnail-rail-actions {
        flex: 1;
    }

    .scan-thumbnail-actions {
        gap: var(--app-space-xs);
        padding: var(--app-space-xs);
    }

    .scan-thumbnail-source-state {
        padding: var(--app-space-lg);
    }
}
</style>
