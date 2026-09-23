<template>
    <div ref="rootRef" class="empty-state">
        <PdfOpenBatchProgress
            v-if="openBatchProgress"
            :progress="openBatchProgress"
        />

        <div v-else class="start-shell">
            <aside class="start-rail" :aria-label="t('emptyState.start')">
                <nav class="rail-section" :aria-label="t('emptyState.start')">
                    <button
                        type="button"
                        class="rail-item"
                        :class="{ 'is-active': activeSection === 'recent' }"
                        :aria-current="activeSection === 'recent' ? 'page' : undefined"
                        @click="showRecentFiles"
                    >
                        <UIcon name="i-ph-clock" class="rail-item-icon" />
                        <span>{{ t('emptyState.recentFiles') }}</span>
                        <span v-if="recentFiles.length > 0" class="rail-count">{{ recentFiles.length }}</span>
                    </button>
                </nav>

                <nav class="rail-section" :aria-label="t('menu.file')">
                    <button
                        v-if="canCombineFiles"
                        type="button"
                        class="rail-item"
                        :class="{ 'is-active': activeSection === 'combine' }"
                        :aria-current="activeSection === 'combine' ? 'page' : undefined"
                        :disabled="openInProgress"
                        @click="showCombinePage"
                    >
                        <UIcon name="i-ph-stack-plus" class="rail-item-icon" />
                        <span>{{ t('dialogs.combineFiles') }}</span>
                    </button>
                </nav>

                <nav class="rail-section" :aria-label="t('emptyState.workspace')">
                    <button
                        type="button"
                        class="rail-item"
                        :class="{ 'is-active': activeSection === 'settings' }"
                        :aria-current="activeSection === 'settings' ? 'page' : undefined"
                        @click="showSettingsPage"
                    >
                        <UIcon name="i-ph-gear" class="rail-item-icon" />
                        <span>{{ t('toolbar.settings') }}</span>
                    </button>
                </nav>
            </aside>

            <main class="start-main">
                <AppFailureAlert
                    v-if="openFailurePresentation"
                    :presentation="openFailurePresentation"
                    class="start-open-failure"
                    data-testid="start-open-failure"
                />
                <UAlert
                    v-else-if="openFailure"
                    color="neutral"
                    variant="soft"
                    icon="i-ph-warning"
                    class="start-open-failure"
                    data-testid="start-open-failure"
                    :title="t('errors.file.open')"
                    :description="openFailureDescription"
                    :actions="[openFailureDismissAction]"
                />

                <template v-if="activeSection === 'recent'">
                    <section class="start-open-panel" :aria-labelledby="openPanelButtonId">
                        <span class="open-panel-art" aria-hidden="true">
                            <FileTypeIcon kind="document" class="open-panel-art-icon" />
                        </span>
                        <span class="open-panel-copy">
                            <span>{{ t('emptyState.openSubtitle') }}</span>
                        </span>
                        <UButton
                            :id="openPanelButtonId"
                            class="open-panel-cta"
                            color="primary"
                            icon="i-ph-folder-open"
                            :label="t('emptyState.openFileEllipsis')"
                            :loading="openInProgress"
                            :disabled="openInProgress"
                            :aria-label="t('toolbar.openPdf')"
                            @click="openFile"
                        />
                    </section>

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
                                    v-bind="recentClearLabelProps"
                                    @click="requestClearRecent"
                                />
                            </div>
                        </header>

                        <div
                            v-if="recentFilesResolved && recentFilesError"
                            class="recent-load-error"
                            role="alert"
                        >
                            <span>{{ t('errors.recent.load') }}: {{ recentFilesError }}</span>
                            <UButton
                                color="neutral"
                                variant="soft"
                                size="sm"
                                :label="t('common.retry')"
                                @click="emit('retry-recent')"
                            />
                        </div>

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
                            <div
                                v-for="file in filteredRecentFiles"
                                v-else
                                :key="file.originalPath"
                                class="recent-row recent-row--data"
                                role="row"
                                :class="{ 'is-disabled': isRecentRowDisabled(file) }"
                                :data-recent-open-actionable="isRecentOpenReady(file) ? 'true' : 'false'"
                                :data-recent-open-exact-frame-ready="isRecentOpenExactFrameReady(file) ? 'true' : 'false'"
                                :data-recent-open-ready="isRecentOpenReady(file) ? 'true' : 'false'"
                                :data-recent-source="String(file.originalPath)"
                                @click="openRecentFromRow(file)"
                            >
                                <span class="recent-col recent-col--name" role="cell">
                                    <AppTooltip :text="file.fileName" :delay-duration="800" usefulness="always">
                                        <button
                                            type="button"
                                            class="recent-open"
                                            :disabled="isRecentRowDisabled(file)"
                                            @click.stop="openRecent(file)"
                                        >
                                            <span class="recent-file-icon" aria-hidden="true">
                                                <FileTypeIcon :kind="getFileKind(file)" />
                                            </span>
                                            <span class="recent-file-name">
                                                <span class="recent-file-name-prefix">{{ displayRecentFileName(file.fileName).prefix }}</span>
                                                <span class="recent-file-name-suffix">{{ displayRecentFileName(file.fileName).suffix }}</span>
                                            </span>
                                        </button>
                                    </AppTooltip>
                                </span>
                                <span
                                    v-if="shouldShowRecentLocationColumn"
                                    class="recent-col recent-col--location"
                                    role="cell"
                                >
                                    <AppTooltip
                                        v-if="canRevealInFolder(file)"
                                        :text="t('status.showInFolder')"
                                        :delay-duration="600"
                                        usefulness="always"
                                    >
                                        <button
                                            type="button"
                                            class="recent-location recent-location--reveal"
                                            :aria-label="t('status.showInFolder')"
                                            @click.stop="revealRecent(file)"
                                        >
                                            <UIcon name="i-ph-folder" class="recent-location-icon" aria-hidden="true" />
                                            <span class="recent-location-path">{{ getParentFolder(file.originalPath) }}</span>
                                        </button>
                                    </AppTooltip>
                                    <span v-else class="recent-location recent-location--static">
                                        <UIcon name="i-ph-globe" class="recent-location-icon" aria-hidden="true" />
                                        <span class="recent-location-path">{{ t('emptyState.locationBrowser') }}</span>
                                    </span>
                                </span>
                                <span class="recent-col recent-col--time" role="cell">
                                    {{ formatRelativeTimeLocalized(file.timestamp) }}
                                </span>
                                <span class="recent-col recent-col--actions" role="cell">
                                    <AppTooltip :text="t('emptyState.removeFromRecent')" :delay-duration="1200">
                                        <button
                                            type="button"
                                            class="recent-action recent-action--remove"
                                            :aria-label="t('emptyState.removeFromRecent')"
                                            @click.stop="removeRecent(file)"
                                        >
                                            <UIcon name="i-ph-x" />
                                        </button>
                                    </AppTooltip>
                                </span>
                            </div>
                        </div>

                        <div v-else-if="!recentFilesError" class="recent-empty">
                            <UIcon
                                :name="recentFiles.length === 0 ? 'i-ph-folder-open' : 'i-ph-magnifying-glass'"
                                class="recent-empty-icon"
                            />
                            <p>{{ recentFiles.length === 0 ? t('emptyState.noRecentFiles') : t('emptyState.noSearchResults') }}</p>
                        </div>

                        <footer v-if="shouldShowRecentTable" class="recent-footer">
                            <span class="recent-count">{{ recentItemsLabel }}</span>
                        </footer>
                    </section>
                </template>

                <CombinePdfPage
                    v-else-if="activeSection === 'combine'"
                    class="start-tool-page"
                    :show-back="false"
                    :show-eyebrow="false"
                    :show-header="false"
                    :open-result="openCombineResult"
                    @close="showRecentFiles"
                />
                <SettingsPage
                    v-else
                    class="start-tool-page"
                    :show-back="false"
                    :show-eyebrow="false"
                    :show-header="false"
                    @close="showRecentFiles"
                />
            </main>
        </div>

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
    </div>
</template>

<script setup lang="ts">
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type {
    FailurePresentation,
    IFailureToastAction,
} from '@app/composables/useFailureToast';
import AppFailureAlert from '@app/components/AppFailureAlert.vue';
import { useElementSize } from '@vueuse/core';
import { formatRelativeTime } from '@app/utils/formatters';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { isBrowserPlatformActive } from '@app/utils/platform';
import FileTypeIcon from '@app/components/icons/FileTypeIcon.vue';
import SettingsPage from '@app/components/settings/SettingsPage.vue';
import type {
    IStartOpenFailure,
    TStartSection,
} from '@app/types/startSection';
import { getDocumentKindFromPath } from '@app/utils/supportedDocumentPaths';
import PdfOpenBatchProgress from '@app/modules/pdf-viewer/components/PdfOpenBatchProgress.vue';
import type { IPdfOpenBatchProgress } from '@app/modules/pdf-viewer/runtime/contracts/pdfOpenBatchProgress.types';
import AppSearchInput from '@app/components/AppSearchInput.vue';

// User-initiated surface: stays out of the startup chunk and loads on first open,
// matching the split policy documented in warmupDesktopViewerChunks.ts.
const CombinePdfPage = defineAsyncComponent(
    () => import('@app/components/combine/CombinePdfPage.vue'),
);

const {
    recentFiles,
    recentFilesResolved = true,
    recentFilesError = null,
    openFailure = null,
    openBatchProgress = null,
    openInProgress = false,
    isRecentOpenReady = () => true,
    isRecentOpenExactFrameReady = () => false,
    canCombineFiles = false,
    startSection = 'recent',
    openCombineResult = undefined,
} = defineProps<{
    recentFiles: IRecentFile[];
    recentFilesResolved?: boolean | undefined;
    recentFilesError?: string | null | undefined;
    openFailure?: IStartOpenFailure | null | undefined;
    openBatchProgress?: IPdfOpenBatchProgress | null | undefined;
    openInProgress?: boolean | undefined;
    isRecentOpenReady?: ((file: IRecentFile) => boolean) | undefined;
    isRecentOpenExactFrameReady?: ((file: IRecentFile) => boolean) | undefined;
    canCombineFiles?: boolean | undefined;
    startSection?: TStartSection | undefined;
    openCombineResult?: (result: TOpenFileResult) => Promise<boolean>;
}>();
const emit = defineEmits<{
    'update:start-section': [section: TStartSection];
    'open-file': [];
    'open-recent': [file: IRecentFile];
    'remove-recent': [file: IRecentFile];
    'reveal-recent': [file: IRecentFile];
    'clear-recent': [];
    'retry-recent': [];
    'dismiss-open-failure': [];
}>();
const { t } = useTypedI18n();
const recentSkeletonRows = 5;
const RECENT_FILE_TAIL_LENGTH = 24;
const recentFilesHeadingId = useId();
const openPanelButtonId = useId();
const recentSearch = ref('');
const activeSection = ref<TStartSection>(startSection);
const clearHistoryDialogOpen = ref(false);
const recentFilesBeforeOpen = shallowRef<readonly IRecentFile[] | null>(null);
const rootRef = ref<HTMLElement | null>(null);
const { width: rootWidth } = useElementSize(rootRef);
const isRecentControlsCompact = computed(() => rootWidth.value > 0 && rootWidth.value <= 520);
const recentClearLabelProps = computed(() => (
    isRecentControlsCompact.value ? {} : { label: t('emptyState.clearHistory') }
));
const openFailureDescription = computed(() => (
    openFailure?.fileName ? `${openFailure.fileName}: ${openFailure.message}` : openFailure?.message ?? ''
));
const openFailureDismissAction: IFailureToastAction = {
    label: t('errors.runtime.dismiss'),
    color: 'neutral',
    variant: 'outline',
    onClick: () => emit('dismiss-open-failure'),
};
const openFailurePresentation = computed<FailurePresentation | null>(() => (
    openFailure?.failure
        ? {
            failure: openFailure.failure,
            title: t('errors.file.open'),
            description: openFailureDescription.value,
            actions: [openFailureDismissAction],
        }
        : null
));

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

function showRecentFiles() {
    setActiveSection('recent');
}

function showCombinePage() {
    setActiveSection('combine');
}

function showSettingsPage() {
    setActiveSection('settings');
}

function openFile() {
    emit('open-file');
}

const pendingRecentOpenPath = ref<string | null>(null);

function openRecent(file: IRecentFile) {
    // The host registers its open transaction asynchronously, so a rapid
    // second click can slip through before eligibility flips; dedupe here.
    if (pendingRecentOpenPath.value === file.originalPath) {
        return;
    }
    pendingRecentOpenPath.value = file.originalPath;
    recentFilesBeforeOpen.value ??= recentFiles.slice();
    emit('open-recent', file);
    void nextTick().then(() => {
        if (!openInProgress) {
            recentFilesBeforeOpen.value = null;
            pendingRecentOpenPath.value = null;
        }
    });
}

function openRecentFromRow(file: IRecentFile) {
    if (!isRecentRowDisabled(file)) {
        openRecent(file);
    }
}

function isRecentRowDisabled(file: IRecentFile) {
    // `openInProgress` drives the picker CTA, not Recent command eligibility.
    // The host's row-specific predicate owns transaction conflicts; owner
    // readiness and prewarmed geometry are open-path concerns, never a
    // disabled-command gate.
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

function setActiveSection(section: TStartSection) {
    activeSection.value = section;
    emit('update:start-section', section);
}

watch(() => startSection, (section) => {
    activeSection.value = section;
}, { immediate: true });
watch(() => openInProgress, (isOpening) => {
    if (!isOpening) {
        recentFilesBeforeOpen.value = null;
        pendingRecentOpenPath.value = null;
    }
});

</script>

<style lang="scss" scoped>
.empty-state {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--app-start-bg);
    color: var(--ui-text);
    container-type: inline-size;
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

:global(.dark) .clear-history-confirm-icon {
    background: color-mix(in oklab, var(--ui-error) 18%, transparent);
    color: var(--ui-error-400);
}

.start-shell {
    display: grid;
    grid-template-columns: var(--app-start-shell-rail-width) minmax(0, 1fr);
    gap: var(--app-start-shell-gap);
    width: 100%;
    max-width: var(--app-content-width-2xl);
    height: 100%;
    min-height: 0;
    margin: 0 auto;
    padding: var(--app-start-shell-padding);
}

.start-rail {
    display: flex;
    flex-direction: column;
    gap: var(--app-start-rail-gap);
    padding: var(--app-start-rail-padding);
}

.rail-section {
    display: flex;
    flex-direction: column;
    gap: var(--app-start-rail-section-gap);
}

.rail-item {
    display: flex;
    align-items: center;
    gap: var(--app-start-rail-item-gap);
    width: 100%;
    height: var(--app-start-rail-item-height);
    padding: 0 var(--app-start-rail-item-padding-x);
    border: 1px solid transparent;
    border-radius: var(--app-start-rail-item-radius);
    background: transparent;
    color: var(--app-start-rail-item-fg);
    font-size: var(--app-start-rail-item-font-size);
    font-weight: var(--app-font-weight-medium);
    text-align: left;
    cursor: pointer;
    transition:
        background-color var(--app-transition-quick),
        border-color var(--app-transition-quick),
        color var(--app-transition-quick);
}

.rail-item span:not(.rail-shortcut, .rail-count) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.rail-item:hover:not(.is-active, :disabled) {
    background: var(--app-start-rail-item-hover-bg);
    color: var(--app-start-rail-item-active-fg);
}

.rail-item.is-active {
    background: var(--app-start-rail-item-active-bg);
    border-color: var(--app-start-rail-item-active-border);
    color: var(--app-start-rail-item-active-fg);
}

.rail-item.is-active:hover:not(:disabled) {
    background: var(--app-start-rail-item-active-hover-bg);
}

.rail-item:disabled {
    opacity: var(--app-opacity-muted);
    cursor: default;
}

.rail-item-icon {
    width: var(--app-start-rail-item-icon-size);
    height: var(--app-start-rail-item-icon-size);
    flex: 0 0 auto;
    color: currentcolor;
    opacity: 1;
}

.rail-shortcut {
    margin-left: auto;
    color: var(--ui-text-dimmed);
    font-size: var(--app-start-rail-shortcut-font-size);
    line-height: var(--app-line-height-tight);
    white-space: nowrap;
}

.rail-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--app-start-rail-badge-size);
    height: var(--app-start-rail-badge-size);
    margin-left: auto;
    padding: 0 var(--app-start-rail-badge-padding-x);
    border-radius: var(--app-radius-full);
    border: 1px solid transparent;
    background: var(--app-start-rail-item-hover-bg);
    color: var(--ui-text-muted);
    font-size: var(--app-start-rail-badge-font-size);
    font-weight: var(--app-font-weight-semibold);
    line-height: var(--app-line-height-tight);
}

.rail-item.is-active .rail-count {
    border-color: var(--app-start-rail-item-active-border);
}

.start-main {
    display: flex;
    flex-direction: column;
    gap: var(--app-start-main-gap);
    min-width: 0;
    height: 100%;
    min-height: 0;
}

.start-open-failure {
    flex: none;
}

.start-tool-page {
    height: 100%;
    min-height: 0;
}

.start-open-panel {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--app-start-panel-gap);
    width: 100%;
    padding: var(--app-start-panel-padding);
    border: 1px solid var(--app-start-card-border);
    border-radius: var(--app-start-panel-radius);
    background: var(--app-start-card-bg);
    color: var(--ui-text);
    flex: 0 0 auto;
}

.open-panel-art {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--app-document-icon-width);
    height: var(--app-document-icon-height);
    flex: 0 0 auto;
}

.open-panel-art-icon {
    width: 100%;
    height: 100%;
}

.open-panel-copy {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--app-start-panel-copy-gap);
    min-width: 0;
    flex: 1 1 auto;
}

.open-panel-copy span {
    color: var(--ui-text-muted);
    font-size: var(--app-start-panel-copy-font-size);
}

.open-panel-cta {
    flex: 0 0 auto;
    min-width: var(--app-start-cta-min-width);
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

.recent-load-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-start-recent-header-gap);
    flex: 0 0 auto;
    padding: var(--app-start-recent-header-padding);
    border-top: 1px solid var(--app-start-row-divider);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-secondary);
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

.recent-row--data {
    border: 0;
    border-bottom: 1px solid var(--app-start-row-divider);
    cursor: default;
    color: var(--ui-text);
}

.recent-row--data:hover:not(.is-disabled, :has(.recent-action:hover), :has(.recent-location--reveal:hover)) {
    background: var(--app-start-row-hover-bg);
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

.recent-location--reveal:hover {
    background: var(--app-start-row-action-hover-bg);
    color: var(--ui-text);
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

.recent-action:hover {
    background: var(--app-start-row-action-hover-bg);
    color: var(--app-start-row-remove-hover-fg);
}

.recent-action:focus-visible {
    outline: 2px solid var(--app-toolbar-focus-ring);
    outline-offset: 1px;
}

.recent-action--remove {
    color: var(--app-start-row-remove-fg);
}

.recent-action--remove:hover {
    background: var(--app-start-row-remove-hover-bg);
    color: var(--app-start-row-remove-hover-fg);
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

@keyframes recent-skeleton-shimmer {
    100% {
        transform: translateX(100%);
    }
}

:global(html.app-low-graphics) .recent-skeleton-icon::after,
:global(html.app-low-graphics) .recent-skeleton-line::after {
    animation: none;
}

@media (prefers-reduced-motion: reduce) {
    .recent-skeleton-icon::after,
    .recent-skeleton-line::after {
        animation: none;
    }
}

@container (max-width: 880px) {
    .start-shell {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto minmax(0, 1fr);
        gap: var(--app-start-responsive-gap);
    }

    .start-rail {
        flex-flow: row nowrap;
        align-items: center;
        gap: var(--app-start-responsive-rail-gap);
        padding: var(--app-start-responsive-rail-padding);
        min-width: 0;
    }

    .rail-section {
        flex: 0 1 auto;
        min-width: 0;
    }

    .rail-item {
        width: auto;
        min-width: 0;
    }

    .rail-count,
    .rail-shortcut {
        margin-left: var(--app-start-responsive-rail-gap);
        flex: 0 0 auto;
    }
}

@container (max-width: 640px) {
    .start-open-panel {
        flex-direction: column;
        align-items: stretch;
        padding: var(--app-start-responsive-panel-padding);
        gap: var(--app-start-responsive-panel-gap);
        text-align: center;
    }

    .open-panel-art {
        align-self: center;
    }

    .open-panel-copy {
        align-items: center;
    }

    .open-panel-cta {
        width: 100%;
        justify-content: center;
    }

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
}

@container (max-width: 520px) {
    .recent-search {
        flex: 1 1 var(--app-start-search-min-width);
        width: auto;
        min-width: 0;
    }

    .recent-clear {
        flex: 0 0 auto;
    }
}
</style>
