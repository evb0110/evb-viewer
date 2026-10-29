<template>
    <aside class="scan-thumbnail-rail" :aria-label="t('scanCleanup.pages.title')">
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
                <AppTooltip :text="t('scanCleanup.detectAll.action')" usefulness="always">
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
            <strong>{{ sourcePending
                ? t('scanCleanup.pages.sourceLoading')
                : t('scanCleanup.pages.sourceUnavailable') }}</strong>
            <span v-if="!sourcePending">{{ t('scanCleanup.pages.sourceUnavailableHint') }}</span>
        </div>

        <DocumentThumbnailList
            v-else
            class="scan-thumbnail-list"
            :source="orderedSource"
            :is-active="active"
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
                        <AppTooltip
                            :disabled="disabled"
                            :text="includeLabel(naturalPage(position))"
                            usefulness="always"
                        >
                            <UButton
                                type="button"
                                class="scan-thumbnail-exclude-toggle"
                                :class="{'is-excluded': pageOverride(naturalPage(position)).excluded}"
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
                        <span class="scan-thumbnail-markers">
                            <span
                                v-if="isCustomized(naturalPage(position))"
                                class="scan-thumbnail-customized"
                                role="img"
                                :aria-label="t('scanCleanup.settings.scope.pageCustomized')"
                            />
                            <UIcon
                                v-if="processedPages?.has(naturalPage(position))"
                                name="i-ph-check-circle"
                                class="scan-thumbnail-processed"
                                :aria-label="t('scanCleanup.pages.processed')"
                            />
                            <AppTooltip
                                v-else-if="needsAttention(naturalPage(position))"
                                :text="attentionHints(naturalPage(position)).join(' ')"
                                usefulness="always"
                            >
                                <button
                                    type="button"
                                    class="scan-thumbnail-attention"
                                    :aria-label="attentionHints(naturalPage(position)).join(' ')"
                                    :disabled="disabled"
                                    @click.stop="emit('inspect-page', naturalPage(position))"
                                    @pointerdown.stop
                                >
                                    <UIcon name="i-ph-warning" aria-hidden="true" />
                                </button>
                            </AppTooltip>
                        </span>
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

const props = defineProps<{
    source: IDocumentPageSource | null;
    totalPages: number;
    selectionLeader: number;
    selectedPages: ReadonlySet<number>;
    overrides: TScanCleanupPageOverrides;
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>;
    confidences: ReadonlyMap<number, number>;
    documentOutputMode: TScanCleanupOutputModeSetting;
    preserveOriginalQuality: boolean;
    recommendedOutputModes?: ReadonlyMap<number, TScanCleanupOutputMode>;
    textAxes?: ReadonlyMap<number, IScanCleanupTextAxis>;
    disabled: boolean;
    canRedetect?: boolean;
    processedPages?: ReadonlySet<number>;
    sourcePending?: boolean;
    detectionActive?: boolean;
    settledPages?: ReadonlySet<number>;
    /** Whether this workspace is the visible tab; thumbnails render only then. */
    active?: boolean;
}>();
const emit = defineEmits<{
    'inspect-page': [page: number];
    'redetect': [];
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
const railPageCount = computed(() => props.source?.pageCount ?? props.totalPages);
const orderedPages = computed<IScanCleanupPageOrder>(() => {
    const pageCount = railPageCount.value;
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
        requirePageNumber(page, Math.max(1, railPageCount.value)),
    );
}

function isCustomized(page: number) {
    return !isScanCleanupPageOverrideInherited(props.overrides, pageOverride(page));
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
        scanCleanupLayoutLabel(t, override, props.classifications.get(page)),
        scanCleanupOutputModeShortLabel(t, displayedOutputMode(page)),
        rotation === 0 ? '' : `${rotation}°`,
    ].filter(Boolean).join(' · ');
}

function attentionHints(page: number) {
    return scanCleanupPageAttentionHints(t, {
        classification: props.classifications.get(page),
        layoutConfidence: props.confidences.get(page),
        override: pageOverride(page),
        textAxis: props.textAxes?.get(page),
    });
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
    opacity: 0;
    pointer-events: auto;
    transition: opacity var(--app-transition-fast);
}

.scan-thumbnail-exclude-toggle.is-excluded,
.scan-thumbnail-list :deep([data-document-thumbnail-item]:hover) .scan-thumbnail-exclude-toggle,
.scan-thumbnail-list :deep([data-document-thumbnail-item].is-selected) .scan-thumbnail-exclude-toggle,
.scan-thumbnail-exclude-toggle:focus-visible {
    opacity: 1;
}

.scan-thumbnail-list :deep([data-document-thumbnail-item].is-disabled:hover) .scan-thumbnail-exclude-toggle {
    opacity: var(--app-scan-disabled-opacity);
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
