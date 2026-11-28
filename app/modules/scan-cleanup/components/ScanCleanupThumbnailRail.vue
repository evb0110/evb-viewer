<template>
    <aside
        class="scan-thumbnail-rail"
        :aria-label="t('scanCleanup.pages.title')"
    >
        <header class="scan-thumbnail-rail-header">
            <div class="scan-thumbnail-rail-heading">
                <strong>{{ t('scanCleanup.pages.title') }}</strong>
                <span :aria-label="t('scanCleanup.pages.count', {count: railPageCount})">{{ railPageCount }}</span>
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
                <AppTooltip
                    :text="t('scanCleanup.detectAll.action')"
                    usefulness="always"
                >
                    <UButton
                        class="scan-thumbnail-redetect"
                        type="button"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        square
                        icon="i-ph-arrows-clockwise"
                        :aria-label="t('scanCleanup.detectAll.action')"
                        :disabled="disabled || !canRedetect"
                        @click="emit('redetect')"
                    />
                </AppTooltip>
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
            <strong>{{ sourcePending ? t('scanCleanup.pages.sourceLoading') : t('scanCleanup.pages.sourceUnavailable') }}</strong>
            <span v-if="!sourcePending">{{ t('scanCleanup.pages.sourceUnavailableHint') }}</span>
        </div>

        <DocumentThumbnailList
            v-else
            class="scan-thumbnail-list"
            :source="orderedSource"
            :is-active="active"
            :current-page="leaderPosition"
            :selected-pages="selectedPositions"
            :document-page="naturalPage"
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
                <template
                    v-for="overlay in [resolveOverlayProjection(position)]"
                    :key="position"
                >
                    <div v-bind="overlay.containerAttrs">
                        <div
                            class="scan-thumbnail-actions"
                            @click.stop
                            @pointerdown.stop
                        >
                            <AppTooltip
                                :disabled="disabled"
                                :text="overlay.includeLabel"
                                usefulness="always"
                            >
                                <UButton
                                    v-bind="overlay.toggleProps"
                                    @click="toggleExcluded(position)"
                                />
                            </AppTooltip>
                        </div>
                    </div>
                </template>
            </template>
            <template #label="{pageNumber: position}">
                <template
                    v-for="label in [resolveLabelProjection(position)]"
                    :key="position"
                >
                    <span class="scan-thumbnail-label-band">
                        <span class="scan-thumbnail-label-row">
                            <span
                                class="scan-thumbnail-page-number"
                                :class="{'is-excluded': label.excluded}"
                                >{{ label.page }}</span
                            >
                            <span class="scan-thumbnail-markers">
                                <span
                                    v-if="label.customized"
                                    class="scan-thumbnail-customized"
                                    role="img"
                                    :aria-label="t('scanCleanup.settings.scope.pageCustomized')"
                                />
                                <UIcon
                                    v-if="label.active"
                                    name="i-ph-circle-notch"
                                    class="scan-thumbnail-active is-spinning"
                                    data-page-active="true"
                                    :aria-label="label.activeLabel"
                                />
                                <UIcon
                                    v-else-if="label.processed"
                                    name="i-ph-check-circle"
                                    class="scan-thumbnail-processed"
                                    :aria-label="t('scanCleanup.pages.processed')"
                                />
                                <AppTooltip
                                    v-else-if="label.attentionText"
                                    :text="label.attentionText"
                                    usefulness="always"
                                >
                                    <button
                                        type="button"
                                        class="scan-thumbnail-attention"
                                        :aria-label="label.attentionText"
                                        :disabled="disabled"
                                        @click.stop="emit('inspect-page', label.page)"
                                        @pointerdown.stop
                                    >
                                        <UIcon
                                            name="i-ph-warning"
                                            aria-hidden="true"
                                        />
                                    </button>
                                </AppTooltip>
                            </span>
                        </span>
                        <span
                            v-if="label.detectionPending"
                            class="scan-thumbnail-status scan-thumbnail-detection-pending"
                            role="status"
                            :aria-label="label.detectionPendingLabel"
                        >
                            <UIcon
                                name="i-ph-circle-notch"
                                class="is-spinning"
                                aria-hidden="true"
                            />
                            <span>{{ t('scanCleanup.pages.detecting') }}</span>
                        </span>
                        <span
                            v-else
                            class="scan-thumbnail-status"
                            :class="{'is-excluded': label.excluded}"
                            >{{ label.summary }}</span
                        >
                    </span>
                </template>
            </template>
        </DocumentThumbnailList>
    </aside>
</template>

<script setup lang="ts">
import type {
    IScanCleanupMarginsMm,
    IScanCleanupPageOverride,
    IScanCleanupPreviewMetadata,
    IScanCleanupTextAxis,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
    isScanCleanupPageOverrideInherited,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';
import type {IDocumentPageSource} from '@app/modules/document-viewer/public';
import {
    scanCleanupLayoutLabel,
    scanCleanupOutputModeShortLabel,
    scanCleanupPageAttentionHints,
} from '@app/modules/scan-cleanup/runtime/describeScanCleanupPage';
import type {
    IScanCleanupPageOrder,
    TScanCleanupOrderedPages,
    TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';
import {createScanCleanupSparsePageOrder} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';

type TScanCleanupRailSort = 'natural' | 'classification' | 'confidence';
const PAGE_KEYBOARD_STEP = 5;

const {
    source,
    totalPages,
    selectionLeader,
    selectedPages,
    overrides,
    pageOverrideDefaults = undefined,
    marginsMm = undefined,
    classifications,
    confidences,
    documentOutputMode,
    preserveOriginalQuality,
    recommendedOutputModes = undefined,
    textAxes = undefined,
    disabled,
    canRedetect = false,
    processedPages = undefined,
    activePages = undefined,
    sourcePending = false,
    detectionActive = false,
    settledPages = undefined,
    active = false,
} = defineProps<{
    source: IDocumentPageSource | null;
    totalPages: number;
    selectionLeader: number;
    selectedPages: ReadonlySet<number>;
    overrides: TScanCleanupPageOverrides;
    pageOverrideDefaults?: IScanCleanupPageOverride | undefined;
    marginsMm?: IScanCleanupMarginsMm;
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>;
    confidences: ReadonlyMap<number, number>;
    documentOutputMode: TScanCleanupOutputModeSetting;
    preserveOriginalQuality: boolean;
    recommendedOutputModes?: ReadonlyMap<number, TScanCleanupOutputMode>;
    textAxes?: ReadonlyMap<number, IScanCleanupTextAxis>;
    disabled: boolean;
    canRedetect?: boolean;
    processedPages?: ReadonlySet<number>;
    activePages?: ReadonlySet<number>;
    sourcePending?: boolean;
    detectionActive?: boolean;
    settledPages?: ReadonlySet<number>;
    /** Whether this workspace is the visible tab; thumbnails render only then. */
    active?: boolean;
}>();
const emit = defineEmits<{
    'inspect-page': [page: number];
    redetect: [];
    'select-page': [page: number, intent: TScanCleanupSelectionIntent, orderedPages: TScanCleanupOrderedPages];
    'update:override': [page: number, value: IScanCleanupPageOverride];
}>();
const {t} = useTypedI18n();
const sortMode = ref<TScanCleanupRailSort>('natural');
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
const classificationRank: Record<IScanCleanupPreviewMetadata['layoutClassification'], number> = {
    'single-uncut-page': 0,
    'page-with-offcut': 1,
    'two-page-spread': 2,
};
// The rendered rows come from the source document, so its page count is the
// one every row, its order and its override lookup are validated against;
// while a restored tab reloads, `totalPages` can still describe another state.
const railPageCount = computed(() => source?.pageCount ?? totalPages);
const orderedPages = computed<IScanCleanupPageOrder>(() => {
    const pageCount = railPageCount.value;
    if (sortMode.value === 'classification') {
        return createScanCleanupSparsePageOrder(pageCount, classifications.keys(), (left, right) => {
            const leftValue = classifications.get(left);
            const rightValue = classifications.get(right);
            return (
                (leftValue === undefined ? Number.POSITIVE_INFINITY : classificationRank[leftValue]) -
                    (rightValue === undefined ? Number.POSITIVE_INFINITY : classificationRank[rightValue]) || left - right
            );
        });
    }
    if (sortMode.value === 'confidence') {
        return createScanCleanupSparsePageOrder(pageCount, confidences.keys(), (left, right) => {
            const leftValue = confidences.get(left);
            const rightValue = confidences.get(right);
            return (leftValue ?? Number.POSITIVE_INFINITY) - (rightValue ?? Number.POSITIVE_INFINITY) || left - right;
        });
    }
    return {
        length: pageCount,
        pageAt: (position) => (position >= 1 && position <= pageCount ? position : undefined),
        positionOf: (page) => (page >= 1 && page <= pageCount ? page : -1),
    };
});
const orderedSource = computed<IDocumentPageSource | null>(() => {
    const currentSource = source;
    const order = orderedPages.value;
    if (!currentSource) {
        return null;
    }
    function mapRequest(request: Parameters<IDocumentPageSource['renderPage']>[0]) {
        return {
            ...request,
            pageNumber: order.pageAt(request.pageNumber) ?? request.pageNumber,
        };
    }
    const thumbnailProvider = currentSource.thumbnailProvider;
    return {
        kind: currentSource.kind,
        documentRef: currentSource.documentRef,
        pageCount: order.length,
        getPageMetrics(position, signal) {
            return currentSource.getPageMetrics(order.pageAt(position) ?? position, signal);
        },
        renderPage(request) {
            return currentSource.renderPage(mapRequest(request));
        },
        thumbnailProvider: thumbnailProvider
            ? {
                  renderThumbnail(request) {
                      return thumbnailProvider.renderThumbnail(mapRequest(request));
                  },
              }
            : undefined,
        dispose() {},
    };
});
const leaderPosition = computed(() => Math.max(1, orderedPages.value.positionOf(selectionLeader)));
const selectedPositions = computed(() => {
    const positions = new Set<number>();
    for (const page of selectedPages) {
        const position = orderedPages.value.positionOf(page);
        if (position >= 1) {
            positions.add(position);
        }
    }
    return positions;
});

function naturalPage(position: number) {
    return orderedPages.value.pageAt(position) ?? position;
}

function pageOverride(page: number) {
    return getScanCleanupPageOverride(overrides, requirePageNumber(page), pageOverrideDefaults, marginsMm);
}

function isCustomized(override: IScanCleanupPageOverride) {
    return !isScanCleanupPageOverrideInherited(overrides, override);
}

function updateOverride(page: number, patch: Partial<IScanCleanupPageOverride>, currentOverride = pageOverride(page)) {
    if (disabled) {
        return;
    }
    emit(
        'update:override',
        page,
        createScanCleanupPageOverride({
            ...currentOverride,
            ...patch,
        }),
    );
}

function toggleExcluded(position: number) {
    const page = naturalPage(position);
    const override = pageOverride(page);
    updateOverride(
        page,
        {
            excluded: !override.excluded,
        },
        override,
    );
}

function displayedOutputMode(page: number, override: IScanCleanupPageOverride) {
    return resolveScanCleanupEffectiveOutputMode({
        options: {
            outputMode: documentOutputMode,
            preserveOriginalQuality,
        },
        pageOverride: override,
        detectedOutputMode: recommendedOutputModes?.get(page),
    });
}

function classificationKind(page: number) {
    const classification = classifications.get(page);
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

// One sentence per thumbnail instead of a strip of chips: what the page will be
// cut into, rendered as, and rotated by, dropped to "Excluded" when it will not
// reach the output at all. Original images keeps every scan as it is, so no
// page has an output mode to name.
function statusSummary(page: number, override: IScanCleanupPageOverride) {
    if (override.excluded) {
        return t('scanCleanup.pages.excludedBadge');
    }
    const rotation = override.rotationDegrees;
    return [
        scanCleanupLayoutLabel(t, override, classifications.get(page)),
        preserveOriginalQuality ? '' : scanCleanupOutputModeShortLabel(t, displayedOutputMode(page, override)),
        rotation === 0 ? '' : `${rotation}°`,
    ]
        .filter(Boolean)
        .join(' · ');
}

function attentionText(page: number, override: IScanCleanupPageOverride) {
    return scanCleanupPageAttentionHints(t, {
        classification: classifications.get(page),
        layoutConfidence: confidences.get(page),
        override,
        textAxis: textAxes?.get(page),
    }).join(' ');
}

function isPageActive(page: number, override: IScanCleanupPageOverride) {
    return activePages?.has(page) === true && processedPages?.has(page) !== true && !override.excluded;
}

// A page keeps its spinner only while its own detection work is outstanding:
// once the running job reports that page as read or analyzed it settles, even
// though the rest of the batch is still going.
function isDetectionPending(page: number) {
    return detectionActive && !classifications.has(page) && settledPages?.has(page) !== true;
}

function includeLabel(override: IScanCleanupPageOverride) {
    return t(override.excluded ? 'scanCleanup.pages.excludedFromOutput' : 'scanCleanup.pages.includeInOutput');
}

function resolveOverlayProjection(position: number) {
    const page = naturalPage(position);
    const override = pageOverride(page);
    const label = includeLabel(override);
    return {
        containerAttrs: {
            class: ['scan-thumbnail-overlay', {'is-excluded': override.excluded}],
            'data-page-number': page,
            'data-classification': classificationKind(page),
        },
        includeLabel: label,
        toggleProps: {
            type: 'button' as const,
            class: ['scan-thumbnail-exclude-toggle', {'is-excluded': override.excluded}],
            color: (override.excluded ? 'neutral' : 'primary') as 'neutral' | 'primary',
            variant: 'soft' as const,
            size: 'xs' as const,
            square: true,
            icon: override.excluded ? 'i-ph-eye-slash' : 'i-ph-eye',
            role: 'switch',
            'aria-checked': !override.excluded,
            'aria-label': label,
            disabled,
        },
    };
}

function resolveLabelProjection(position: number) {
    const page = naturalPage(position);
    const override = pageOverride(page);
    const isActive = isPageActive(page, override);
    const processed = !isActive && processedPages?.has(page) === true;
    const detectionPending = isDetectionPending(page);
    return {
        page,
        excluded: override.excluded,
        customized: isCustomized(override),
        active: isActive,
        activeLabel: isActive ? t('scanCleanup.pages.processing', {page}) : undefined,
        processed,
        attentionText: !isActive && !processed ? attentionText(page, override) : '',
        detectionPending,
        detectionPendingLabel: detectionPending ? t('scanCleanup.pages.detectionPending', {page}) : undefined,
        summary: detectionPending ? '' : statusSummary(page, override),
    };
}

function handleRowClick(position: number, event?: MouseEvent) {
    if (disabled) {
        return;
    }
    const intent: TScanCleanupSelectionIntent = event?.shiftKey ? 'range' : event?.ctrlKey || event?.metaKey ? 'toggle' : 'single';
    emit('select-page', naturalPage(position), intent, orderedPages.value);
}

const KEY_TARGETS: Readonly<Record<string, (position: number, count: number) => number>> = {
    ArrowUp: (position) => position - 1,
    ArrowDown: (position) => position + 1,
    Home: () => 1,
    End: (_, count) => count,
    PageUp: (position) => position - PAGE_KEYBOARD_STEP,
    PageDown: (position) => position + PAGE_KEYBOARD_STEP,
};
function handleKeydown(event: KeyboardEvent) {
    if (disabled || (event.target instanceof Element && event.target.closest('button, input, select'))) {
        return;
    }
    const pages = orderedPages.value;
    if (event.key === ' ') {
        event.preventDefault();
        if (!event.repeat) {
            emit('select-page', selectionLeader, 'toggle', pages);
        }
        return;
    }
    const target = KEY_TARGETS[event.key]?.(Math.max(1, pages.positionOf(selectionLeader)), pages.length);
    const page = target === undefined ? undefined : pages.pageAt(Math.min(pages.length, Math.max(1, target)));
    if (page === undefined) {
        return;
    }
    event.preventDefault();
    emit('select-page', page, event.shiftKey ? 'range' : 'single', pages);
}
</script>

<style lang="scss" scoped>
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

.scan-thumbnail-rail-heading {
    flex: none;
}

/* The sort menu gives way first, so the header never spills into the preview. */
.scan-thumbnail-rail-actions {
    flex: 1 1 auto;
    justify-content: flex-end;
}

.scan-thumbnail-rail-heading strong {
    font-size: var(--app-text-size-secondary);
    white-space: nowrap;
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
    --document-thumbnail-disabled-action-opacity: var(--app-scan-disabled-opacity);

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

/* The include switch sits in one place on every page. It stays quiet until the
   page is hovered, focused or selected, and stays visible on an excluded page
   so the page says how to bring it back. */
.scan-thumbnail-actions {
    position: relative;
    z-index: var(--app-z-local-raised);
    justify-content: flex-end;
    padding: var(--app-space-sm);
}

.scan-thumbnail-exclude-toggle {
    position: relative;
    flex: none;
    opacity: var(--document-thumbnail-action-opacity, 0);
    pointer-events: auto;
    transition: opacity $ease-fast;
}

.scan-thumbnail-exclude-toggle[aria-checked='false'],
.scan-thumbnail-exclude-toggle:focus-visible {
    opacity: var(--document-thumbnail-action-active-opacity, 1);
}

.scan-thumbnail-markers {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
}

.scan-thumbnail-customized {
    width: var(--app-space-3xl);
    height: var(--app-space-3xl);
    flex: none;
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
}

.scan-thumbnail-attention {
    display: inline-flex;
    border: 0;
    border-radius: var(--app-radius-sm);
    background: transparent;
    padding: 0;
    color: var(--ui-warning);
    cursor: pointer;
}

.scan-thumbnail-attention:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-3xs);
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

.scan-thumbnail-active {
    flex: none;
    color: var(--ui-primary);
}

@media (prefers-reduced-motion: reduce) {
    .scan-thumbnail-active.is-spinning,
    .scan-thumbnail-source-state .is-spinning,
    .scan-thumbnail-detection-pending .is-spinning {
        animation: none;
    }
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
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);

    @include app.truncate-single-line;
}

.scan-thumbnail-status.is-excluded {
    color: var(--ui-text-dimmed);
}

@container (width <= 16rem) {
    .scan-thumbnail-rail-heading strong {
        display: none;
    }
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
        padding: var(--app-space-xs);
    }

    .scan-thumbnail-source-state {
        padding: var(--app-space-lg);
    }
}
</style>
