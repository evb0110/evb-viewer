<template>
    <section class="start-recent" :aria-labelledby="recentFilesHeadingId">
        <header class="recent-header">
            <h3 :id="recentFilesHeadingId" class="recent-title">
                {{ t('emptyState.recentFiles') }}
            </h3>
            <div class="recent-controls">
                <AppSearchInput
                    v-model="recentSearch"
                    class="recent-search"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    type="search"
                    icon="i-ph-magnifying-glass"
                    :placeholder="t('emptyState.searchPlaceholder')"
                    :aria-label="t('emptyState.searchRecentFiles')"
                />
                <UButton
                    class="recent-clear"
                    color="neutral"
                    variant="ghost"
                    icon="i-ph-trash"
                    :disabled="recentFiles.length === 0"
                    :aria-label="t('emptyState.clearRecentFiles')"
                    :label="t('emptyState.clearHistory')"
                    :ui="{ label: 'recent-clear-label' }"
                    @click="requestClearRecent"
                />
            </div>
        </header>

        <div
            v-if="shouldShowRecentTable"
            class="recent-table app-scrollbar app-scroll-region--balanced"
            :class="{ 'recent-table--compact': !shouldShowRecentLocationColumn }"
            role="table"
            :aria-busy="!recentFilesResolved"
        >
            <div class="recent-row recent-row--head" role="row">
                <span role="columnheader" class="recent-col recent-col--name">{{ t('emptyState.columnName') }}</span>
                <span
                    v-if="shouldShowRecentLocationColumn"
                    role="columnheader"
                    class="recent-col recent-col--location"
                >
                    {{ t('emptyState.columnLocation') }}
                </span>
                <span role="columnheader" class="recent-col recent-col--time">{{ t('emptyState.columnOpened') }}</span>
                <span class="recent-col recent-col--actions" aria-hidden="true" />
            </div>
            <template v-if="!recentFilesResolved">
                <div
                    v-for="index in recentSkeletonRows"
                    :key="`recent-skeleton-${index}`"
                    class="recent-row recent-row--data recent-row--skeleton"
                    role="row"
                >
                    <span class="recent-col recent-col--name" role="cell">
                        <span class="recent-skeleton-icon" aria-hidden="true" />
                        <span
                            class="recent-skeleton-line recent-skeleton-line--name"
                            aria-hidden="true"
                        />
                    </span>
                    <span
                        v-if="shouldShowRecentLocationColumn"
                        class="recent-col recent-col--location"
                        role="cell"
                    >
                        <span
                            class="recent-skeleton-line recent-skeleton-line--location"
                            aria-hidden="true"
                        />
                    </span>
                    <span class="recent-col recent-col--time" role="cell">
                        <span
                            class="recent-skeleton-line recent-skeleton-line--time"
                            aria-hidden="true"
                        />
                    </span>
                    <span class="recent-col recent-col--actions" role="cell" />
                </div>
            </template>
            <!-- eslint-disable custom/app-tooltip-only -- Recent rows use native titles without per-row tooltip lifecycles. -->
            <div
                v-for="file in filteredRecentFiles"
                v-else
                :key="file.originalPath"
                class="recent-row recent-row--data"
                role="row"
                :class="{ 'is-disabled': isRecentRowDisabled(file) }"
                :data-recent-open-actionable="isRecentOpenReady(file) ? 'true' : 'false'"
                :data-recent-open-ready="isRecentOpenReady(file) ? 'true' : 'false'"
                :data-recent-source="String(file.originalPath)"
                @pointerdown="pressRecent(file, $event)"
                @click="openRecentFromRow(file, $event)"
            >
                <span class="recent-col recent-col--name" role="cell">
                    <button
                        type="button"
                        class="recent-open"
                        :title="file.fileName"
                        :disabled="isRecentRowDisabled(file)"
                        @click.stop="openRecent(file, $event)"
                    >
                        <span class="recent-file-icon" aria-hidden="true">
                            <FileTypeIcon :kind="getFileKind(file)" />
                        </span>
                        <span class="recent-file-name">
                            <span class="recent-file-name-prefix">{{ displayRecentFileName(file.fileName).prefix }}</span>
                            <span class="recent-file-name-suffix">{{ displayRecentFileName(file.fileName).suffix }}</span>
                        </span>
                    </button>
                </span>
                <span
                    v-if="shouldShowRecentLocationColumn"
                    class="recent-col recent-col--location"
                    role="cell"
                >
                    <button
                        v-if="canRevealInFolder(file)"
                        type="button"
                        class="recent-location recent-location--reveal"
                        :aria-label="t('status.showInFolder')"
                        :title="t('status.showInFolder')"
                        @click.stop="revealRecent(file)"
                    >
                        <UIcon name="i-ph-folder" class="recent-location-icon" aria-hidden="true" />
                        <span class="recent-location-path">{{ getParentFolder(file.originalPath) }}</span>
                    </button>
                    <span v-else class="recent-location recent-location--static">
                        <UIcon name="i-ph-globe" class="recent-location-icon" aria-hidden="true" />
                        <span class="recent-location-path">{{ t('emptyState.locationBrowser') }}</span>
                    </span>
                </span>
                <span class="recent-col recent-col--time" role="cell">
                    {{ formatRelativeTimeLocalized(file.timestamp) }}
                </span>
                <span class="recent-col recent-col--actions" role="cell">
                    <button
                        type="button"
                        class="recent-action recent-action--remove"
                        :aria-label="t('emptyState.removeFromRecent')"
                        :title="t('emptyState.removeFromRecent')"
                        @click.stop="removeRecent(file)"
                    >
                        <UIcon name="i-ph-x" />
                    </button>
                </span>
            </div>
            <!-- eslint-enable custom/app-tooltip-only -->
        </div>

        <!-- A list that could not load says so in its own box, where its rows would be. -->
        <div
            v-else-if="recentFilesError"
            class="recent-empty"
            data-testid="recent-load-error"
        >
            <UIcon name="i-ph-warning-circle" class="recent-empty-icon" />
            <p>{{ t('errors.recent.load') }}</p>
            <UButton
                color="neutral"
                variant="outline"
                size="sm"
                :label="t('common.retry')"
                @click="emit('retry-recent')"
            />
        </div>
        <div v-else class="recent-empty">
            <UIcon
                :name="recentFiles.length === 0 ? 'i-ph-folder-open' : 'i-ph-magnifying-glass'"
                class="recent-empty-icon"
            />
            <p>{{ recentFiles.length === 0 ? t('emptyState.noRecentFiles') : t('emptyState.noSearchResults') }}</p>
        </div>

        <footer v-if="shouldShowRecentTable" class="recent-footer">
            <span class="recent-count">{{ recentItemsLabel }}</span>
            <!-- A refresh that failed while older rows still show says so here, in the list's own footer. -->
            <span
                v-if="recentFilesResolved && recentFilesError"
                class="recent-refresh-failed"
                data-testid="recent-refresh-error"
            >
                <UIcon name="i-ph-warning-circle" class="recent-refresh-failed-icon" />
                <span>{{ t('errors.recent.load') }}</span>
                <UButton
                    color="neutral"
                    variant="link"
                    size="xs"
                    :label="t('common.retry')"
                    @click="emit('retry-recent')"
                />
            </span>
        </footer>
    </section>

    <UModal
        :open="clearHistoryDialogOpen"
        :title="t('emptyState.clearHistoryConfirmTitle')"
        :ui="{ footer: 'justify-end gap-2' }"
        @update:open="clearHistoryDialogOpen = $event"
    >
        <template #description>
            <span class="sr-only">
                {{ t('emptyState.clearHistoryConfirmDescription') }}
            </span>
        </template>

        <template #body>
            <div class="clear-history-confirm">
                <span class="clear-history-confirm-icon" aria-hidden="true">
                    <UIcon name="i-ph-warning" />
                </span>
                <p class="text-sm text-muted">
                    {{ t('emptyState.clearHistoryConfirmDescription') }}
                </p>
            </div>
        </template>

        <template #footer="{ close }">
            <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="outline"
                @click="close"
            />
            <UButton
                :label="t('emptyState.clearHistoryConfirmAction')"
                color="error"
                @click="confirmClearRecent"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type { IRecentFile } from '@contracts/shared';
import { formatRelativeTime } from '@app/utils/formatters';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { isBrowserPlatformActive } from '@app/utils/platform';
import FileTypeIcon from '@app/components/icons/FileTypeIcon.vue';
import { getDocumentKindFromPath } from '@app/utils/supportedDocumentPaths';
import AppSearchInput from '@app/components/AppSearchInput.vue';

// Start's Recent Files list: search, rows and the clear-history confirmation.
// Opening, removing and revealing go to the host through Start.
const {
    recentFiles,
    recentFilesResolved = true,
    recentFilesError = null,
    openInProgress = false,
    isRecentOpenReady = () => true,
} = defineProps<{
    recentFiles: IRecentFile[];
    recentFilesResolved?: boolean | undefined;
    recentFilesError?: string | null | undefined;
    openInProgress?: boolean | undefined;
    isRecentOpenReady?: ((file: IRecentFile) => boolean) | undefined;
}>();
const emit = defineEmits<{
    'press-recent': [file: IRecentFile];
    'open-recent': [file: IRecentFile, pressed: boolean];
    'remove-recent': [file: IRecentFile];
    'reveal-recent': [file: IRecentFile];
    'clear-recent': [];
    'retry-recent': [];
}>();
const { t } = useTypedI18n();
// As many as the list can hold; the count the head script found shows that many.
const recentSkeletonRows = 30;
const RECENT_FILE_TAIL_LENGTH = 24;

const recentFilesHeadingId = useId();

// Start owns the query, so it survives a visit to Combine or Settings.
const recentSearch = defineModel<string>('search', {default: ''});

const clearHistoryDialogOpen = ref(false);
const recentFilesBeforeOpen = shallowRef<readonly IRecentFile[] | null>(null);

function displayRecentFileName(fileName: string) {
    if (fileName.length <= RECENT_FILE_TAIL_LENGTH + 8) {
        return {
            prefix: fileName,
            suffix: '',
        };
    }

    return {
        prefix: fileName.slice(0, -RECENT_FILE_TAIL_LENGTH),
        suffix: fileName.slice(-RECENT_FILE_TAIL_LENGTH),
    };
}
const displayedRecentFiles = computed(() => recentFilesBeforeOpen.value ?? recentFiles);
const filteredRecentFiles = computed(() => {
    const query = recentSearch.value.trim().toLocaleLowerCase();
    if (!query) {
        return displayedRecentFiles.value;
    }
    return displayedRecentFiles.value.filter((file) => {
        const haystack = `${file.fileName} ${String(file.originalPath)}`.toLocaleLowerCase();
        return haystack.includes(query);
    });
});
const shouldShowRecentTable = computed(() => !recentFilesResolved || filteredRecentFiles.value.length > 0);
const shouldShowRecentLocationColumn = computed(() => !isBrowserPlatformActive());
const recentItemsLabel = computed(() => (
    recentFilesResolved
        ? t('emptyState.itemsCount', { count: filteredRecentFiles.value.length })
        : t('common.loading')
));

function formatRelativeTimeLocalized(timestamp: number) {
    return formatRelativeTime(timestamp, {
        yesterday: t('relativeTime.yesterday'),
        daysAgo: (count: number) => t('relativeTime.daysAgo', { count }),
        oneHourAgo: t('relativeTime.oneHourAgo'),
        hoursAgo: (count: number) => t('relativeTime.hoursAgo', { count }),
        oneMinuteAgo: t('relativeTime.oneMinuteAgo'),
        minutesAgo: (count: number) => t('relativeTime.minutesAgo', { count }),
        justNow: t('relativeTime.justNow'),
    });
}

function getParentFolder(filePath: string) {
    const parts = filePath.split(/[\\/]/);
    parts.pop();
    const folderParts = parts.slice(-2);
    return folderParts.join('/');
}

function canRevealInFolder(file: IRecentFile) {
    return !isBrowserDocumentRef(file.originalPath);
}

function getFileKind(file: IRecentFile) {
    return getDocumentKindFromPath(file.fileName);
}


const pendingRecentOpenPath = ref<string | null>(null);

// A click opens on release; the press lets the host start work for that open
// sooner. A keyboard activation has no press, and its click's detail is 0.
// The row's other buttons reveal or remove the file, so their presses open
// nothing.
function pressRecent(file: IRecentFile, event: PointerEvent) {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (event.button === 0 && !isRecentRowDisabled(file) && (!button || button.classList.contains('recent-open'))) {
        emit('press-recent', file);
    }
}

function openRecent(file: IRecentFile, event: MouseEvent) {
    // The host registers its open transaction asynchronously, so a rapid
    // second click can slip through before eligibility flips; dedupe here.
    if (pendingRecentOpenPath.value === file.originalPath) {
        return;
    }
    pendingRecentOpenPath.value = file.originalPath;
    recentFilesBeforeOpen.value ??= recentFiles.slice();
    emit('open-recent', file, event.detail > 0);
    void nextTick().then(() => {
        if (!openInProgress) {
            recentFilesBeforeOpen.value = null;
            pendingRecentOpenPath.value = null;
        }
    });
}

function openRecentFromRow(file: IRecentFile, event: MouseEvent) {
    if (!isRecentRowDisabled(file)) {
        openRecent(file, event);
    }
}

function isRecentRowDisabled(file: IRecentFile) {
    // `openInProgress` drives the picker CTA, not Recent command eligibility.
    // The host's row-specific predicate owns transaction conflicts; owner
    // readiness is an open-path concern, never a disabled-command gate.
    return !isRecentOpenReady(file);
}

function revealRecent(file: IRecentFile) {
    emit('reveal-recent', file);
}

function removeRecent(file: IRecentFile) {
    emit('remove-recent', file);
}

function requestClearRecent() {
    if (recentFiles.length === 0) {
        return;
    }
    clearHistoryDialogOpen.value = true;
}

function confirmClearRecent() {
    clearHistoryDialogOpen.value = false;
    emit('clear-recent');
}


watch(() => openInProgress, (isOpening) => {
    if (!isOpening) {
        recentFilesBeforeOpen.value = null;
        pendingRecentOpenPath.value = null;
    }
});
</script>

<style lang="scss" scoped>
/* On a phone or tablet Start scrolls as one page (PdfEmptyState): the list
   takes the height of its rows instead of scrolling inside the page. */
@mixin recent-single-scroll {
    .start-recent,
    .recent-table {
        height: auto;
        flex: 0 0 auto;
        overflow: visible;
    }
}

.clear-history-confirm {
    display: flex;
    align-items: flex-start;
    gap: var(--app-space-9xl);
}

.clear-history-confirm-icon {
    display: inline-flex;
    width: var(--app-control-height-sm);
    height: var(--app-control-height-sm);
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border-radius: var(--app-radius-2xl);
    background: var(--ui-error-50);
    color: var(--ui-error-600);
}

.dark .clear-history-confirm-icon {
    background: color-mix(in oklab, var(--ui-error) 18%, transparent);
    color: var(--ui-error-400);
}

.start-recent {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--app-start-card-border);
    border-radius: var(--app-start-panel-radius);
    background: var(--app-start-card-bg);
    overflow: hidden;
    flex: 1 1 0;
    min-height: 0;
}

.recent-header {
    display: flex;
    align-items: center;
    gap: var(--app-start-recent-header-gap);
    flex: 0 0 auto;
    flex-wrap: wrap;
    justify-content: space-between;
    padding: var(--app-start-recent-header-padding);
}

.recent-title {
    margin: 0;
    flex: 0 0 auto;
    color: var(--ui-text-highlighted);
    font-size: var(--app-text-size-title-sm);
    font-weight: var(--app-font-weight-heading);
    white-space: nowrap;
}

.recent-controls {
    display: flex;
    align-items: center;
    gap: var(--app-start-recent-controls-gap);
    flex: 1 1 auto;
    min-width: 0;
    justify-content: flex-end;
}

.recent-search {
    width: var(--app-start-search-width);
}

.recent-table {
    display: grid;
    grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr) auto var(--app-start-table-time-width);
    grid-auto-rows: min-content;
    align-content: start;
    border-top: 1px solid var(--app-start-row-divider);
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
}

.recent-table--compact {
    grid-template-columns: minmax(0, 1fr) auto var(--app-start-table-time-width);
}

.recent-row {
    display: grid;
    grid-template-columns: subgrid;
    grid-column: 1 / -1;
    column-gap: var(--app-start-row-column-gap);
    align-items: center;
    width: 100%;
    padding: var(--app-start-row-padding);
    border-bottom: 1px solid var(--app-start-row-divider);
    text-align: left;
    background: transparent;
    transition: background-color var(--app-transition-fast);
}

.recent-row:last-child {
    border-bottom: 0;
}

.recent-row--head {
    position: sticky;
    top: 0;
    z-index: var(--app-z-local-raised);
    padding-block: var(--app-start-row-head-padding-block);
    background: color-mix(in oklab, var(--ui-bg) 92%, var(--ui-bg-muted) 8%);
}

.recent-row--head .recent-col {
    color: var(--ui-text-dimmed);
    font-size: var(--app-text-size-caption);
    font-weight: var(--app-font-weight-semibold);
    letter-spacing: 0;
    text-transform: none;
}

/* A data row draws its divider as an inset shadow, so a row is equally tall
   whether or not it is the last one: a placeholder row followed by hidden
   placeholders and the real row that replaces it measure the same. */
.recent-row--data {
    border: 0;
    box-shadow: inset 0 -1px var(--app-start-row-divider);
    cursor: default;
    color: var(--ui-text);
}

.recent-row--data:last-child {
    box-shadow: none;
}

@media (hover: hover) {
    .recent-row--data:hover:not(.is-disabled, :has(.recent-action:hover), :has(.recent-location--reveal:hover)) {
        background: var(--app-start-row-hover-bg);
    }
}

.recent-open:focus-visible {
    outline: 2px solid color-mix(in oklab, var(--ui-primary) 55%, transparent);
    outline-offset: 1px;
}

.recent-row--data.is-disabled {
    cursor: default;
    opacity: var(--app-opacity-muted);
}

.recent-row--skeleton {
    cursor: default;
    pointer-events: none;
}

/* Until the list is read, Start shows one placeholder row per recent file
   the head script counted (recentFilesPrepaintScript.ts), so the rows take their
   place without moving the page. Without a count (Electron, which reads its
   list from main) it shows five. The header row is the table's first child. */
html:not([data-recent-count]) .recent-row--skeleton:nth-child(n + 7) {
    display: none;
}

@for $count from 0 through 29 {
    html[data-recent-count='#{$count}'] .recent-row--skeleton:nth-child(n + #{$count + 2}) {
        display: none;
    }
}

/* No recent files: the loading list already has the empty list's shape. */
html[data-recent-count='0'] .recent-table[aria-busy='true'] {
    min-height: var(--app-start-empty-min-height);
}

html[data-recent-count='0'] .recent-table[aria-busy='true'] .recent-row--head,
html[data-recent-count='0'] .recent-table[aria-busy='true'] ~ .recent-footer {
    display: none;
}

.recent-col {
    min-width: 0;
}

.recent-col--name {
    display: flex;
    align-items: center;
    gap: var(--app-start-recent-header-gap);
    min-width: 0;
}

.recent-open {
    display: flex;
    align-items: center;
    gap: var(--app-start-recent-header-gap);
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
}

.recent-open:disabled {
    cursor: default;
}

.recent-col--location {
    display: flex;
    align-items: center;
    min-width: 0;
}

.recent-row--data .recent-col--location {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-secondary);
}

.recent-location {
    display: inline-flex;
    align-items: center;
    gap: var(--app-start-control-gap);
    min-width: 0;
    max-width: 100%;
    margin-left: var(--app-start-location-margin);
    padding: var(--app-start-location-padding);
    border: 0;
    border-radius: var(--app-control-radius);
    background: transparent;
    color: var(--ui-text-muted);
}

.recent-location--reveal {
    cursor: pointer;
    transition:
        background-color var(--app-transition-quick),
        color var(--app-transition-quick);
}

@media (hover: hover) {
    .recent-location--reveal:hover {
        background: var(--app-start-row-action-hover-bg);
        color: var(--ui-text);
    }
}

.recent-location--reveal:focus-visible {
    outline: 2px solid var(--app-toolbar-focus-ring);
    outline-offset: 1px;
}

.recent-location-icon {
    width: var(--app-icon-size-md);
    height: var(--app-icon-size-md);
    flex: 0 0 auto;
    color: currentcolor;
}

.recent-location-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.recent-col--time {
    white-space: nowrap;
    text-align: right;
}

.recent-row--data .recent-col--time {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-meta);
}

.recent-col--actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--app-start-control-gap);
    padding-right: var(--app-start-row-actions-padding-right);
}

.recent-file-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--app-document-icon-width);
    height: var(--app-document-icon-height);
    flex: 0 0 auto;
}

.recent-file-name {
    display: flex;
    min-width: 0;
    color: var(--ui-text);
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-semibold);
}

.recent-file-name-prefix {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.recent-file-name-suffix {
    flex: 0 0 auto;
    white-space: nowrap;
}

.recent-skeleton-icon,
.recent-skeleton-line {
    position: relative;
    display: block;
    overflow: hidden;
    border-radius: var(--app-action-radius);
    background: color-mix(in oklab, var(--ui-bg-muted) 86%, var(--ui-border) 14%);
}

.recent-skeleton-icon::after,
.recent-skeleton-line::after {
    position: absolute;
    inset: 0;
    content: '';
    background: linear-gradient(
        90deg,
        transparent,
        color-mix(in oklab, var(--ui-bg) 54%, transparent),
        transparent
    );
    animation: recent-skeleton-shimmer 1.2s ease-in-out infinite;
    transform: translateX(-100%);
}

.recent-skeleton-icon {
    width: var(--app-document-icon-width);
    height: var(--app-document-icon-height);
    flex: 0 0 auto;
}

.recent-skeleton-line {
    height: var(--app-space-9xl);
}

.recent-skeleton-line--name {
    width: var(--app-start-skeleton-name-width);
}

.recent-skeleton-line--location {
    width: var(--app-start-skeleton-location-width);
}

.recent-skeleton-line--time {
    width: var(--app-start-skeleton-time-width);
    margin-left: auto;
}

.recent-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--app-action-size-sm);
    height: var(--app-action-size-sm);
    border: 0;
    border-radius: var(--app-action-radius);
    background: transparent;
    color: var(--ui-text-dimmed);
    cursor: pointer;
    transition:
        background-color var(--app-transition-quick),
        color var(--app-transition-quick);
}

.recent-action :deep(.iconify) {
    width: var(--app-icon-size-md);
    height: var(--app-icon-size-md);
}

@media (hover: hover) {
    .recent-action:hover {
        background: var(--app-start-row-action-hover-bg);
        color: var(--app-start-row-remove-hover-fg);
    }
}

.recent-action:focus-visible {
    outline: 2px solid var(--app-toolbar-focus-ring);
    outline-offset: 1px;
}

.recent-action--remove {
    color: var(--app-start-row-remove-fg);
}

@media (hover: hover) {
    .recent-action--remove:hover {
        background: var(--app-start-row-remove-hover-bg);
        color: var(--app-start-row-remove-hover-fg);
    }
}

.recent-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--app-start-empty-gap);
    flex: 1 1 auto;
    min-height: var(--app-start-empty-min-height);
    border-top: 1px solid var(--app-start-row-divider);
    color: var(--ui-text-muted);
    text-align: center;
}

.recent-empty p {
    margin: 0;
    font-size: var(--app-text-size-body);
}

.recent-empty-icon {
    width: var(--app-start-empty-icon-size);
    height: var(--app-start-empty-icon-size);
    color: var(--ui-text-dimmed);
    opacity: var(--app-opacity-faint);
}

.recent-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-start-footer-gap);
    flex: 0 0 auto;
    padding: var(--app-start-footer-padding);
    border-top: 1px solid var(--app-start-row-divider);
    background: color-mix(in oklab, var(--ui-bg) 96%, var(--ui-bg-muted) 4%);
}

.recent-count {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-secondary);
}

.recent-refresh-failed {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
    min-width: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-secondary);
}

.recent-refresh-failed-icon {
    flex: none;
    color: var(--ui-warning);
}

@keyframes recent-skeleton-shimmer {
    100% {
        transform: translateX(100%);
    }
}

html.app-low-graphics .recent-skeleton-icon::after,
html.app-low-graphics .recent-skeleton-line::after {
    animation: none;
}

@media (prefers-reduced-motion: reduce) {
    .recent-skeleton-icon::after,
    .recent-skeleton-line::after {
        animation: none;
    }
}

@container (max-width: 640px) {
    .recent-table {
        grid-template-columns: minmax(0, 1fr) auto var(--app-start-table-time-width-compact);
    }

    .recent-row {
        column-gap: var(--app-start-row-column-gap-compact);
    }

    .recent-col--location {
        display: none;
    }

    .recent-row--head .recent-col--location {
        display: none;
    }

    @include recent-single-scroll;

    /* Rows are a list, not a table: the file name takes the width and the
       time sits under it. The column header stays for screen readers only. */
    .recent-table {
        position: relative;
    }

    .recent-row--head {
        position: absolute;
        width: var(--app-divider-width);
        height: var(--app-hairline-height);
        padding: 0;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }

    .recent-table,
    .recent-table--compact {
        grid-template-columns: minmax(0, 1fr) auto;
    }

    .recent-row--data {
        grid-template-areas: 'name actions';
    }

    .recent-row--data .recent-col--name {
        grid-area: name;
    }

    /* The name sits at the top of the icon and the time at the bottom of the
       row, in a line the name leaves free, so a row is no taller than its
       icon unless large text needs more and the two never overlap. Taps on
       the time reach the row. */
    .recent-row--data .recent-open {
        align-items: flex-start;
    }

    .recent-row--data .recent-file-name {
        padding-block-end: calc(var(--app-text-size-meta) * var(--app-line-height-text));
        line-height: var(--app-line-height-body);
    }

    /* Placeholder and real rows share the two text lines' height. */
    .recent-row--data .recent-col--name {
        min-height: calc(var(--app-text-size-body) * var(--app-line-height-body) + var(--app-text-size-meta) * var(--app-line-height-text));
    }

    .recent-row--data .recent-col--time {
        grid-area: name;
        align-self: end;
        padding-inline-start: calc(var(--app-document-icon-width) + var(--app-start-recent-header-gap));
        line-height: var(--app-line-height-text);
        text-align: start;
        pointer-events: none;
    }

    .recent-row--data .recent-col--actions {
        grid-area: actions;
    }

    /* The Start rail already shows the count. */
    .recent-footer:not(:has(.recent-refresh-failed)) {
        display: none;
    }
}

@container (max-width: 520px) {
    /* The trash icon alone; its accessible name stays. */
    .recent-clear :deep(.recent-clear-label) {
        display: none;
    }

    .recent-search {
        flex: 1 1 var(--app-start-search-min-width);
        width: auto;
        min-width: 0;
    }

    .recent-clear {
        flex: 0 0 auto;
    }
}

@media (pointer: coarse) {
    @include recent-single-scroll;
}
</style>
