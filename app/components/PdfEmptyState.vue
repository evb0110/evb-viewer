<template>
    <div class="empty-state">
        <div class="empty-state-content">
            <div
                v-if="props.openBatchProgress"
                class="w-full mb-4 rounded-lg border border-[var(--ui-border)] bg-[var(--ui-bg-elevated)] px-4 py-3"
                role="status"
                aria-live="polite"
            >
                <div class="flex items-center gap-2 text-sm text-[var(--ui-text)]">
                    <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
                    <span>{{ t('emptyState.preparingBatch') }}</span>
                </div>
                <p class="mt-2 text-xs text-[var(--ui-text-muted)]">
                    {{ t('emptyState.preparingBatchProgress', {
                        processed: displayProcessedCount(props.openBatchProgress.processed, props.openBatchProgress.total),
                        total: props.openBatchProgress.total,
                    }) }}
                </p>
                <UProgress :value="props.openBatchProgress.percent" class="mt-2" />
                <p v-if="batchEtaText" class="mt-2 text-xs text-[var(--ui-text-dimmed)]">
                    {{ t('emptyState.preparingBatchEta', { eta: batchEtaText }) }}
                </p>
            </div>

            <!-- No recent files: centered standalone prompt -->
            <div v-if="recentFiles.length === 0" class="open-file-section">
                <UTooltip :text="t('toolbar.openPdf')" :delay-duration="1200">
                    <button
                        class="open-file-action group"
                        :aria-label="t('toolbar.openPdf')"
                        @click="emit('open-file')"
                    >
                        <UIcon
                            name="i-lucide-folder-open"
                            class="open-file-icon text-[var(--ui-text-dimmed)] group-hover:text-[var(--ui-primary)] transition-colors"
                        />
                    </button>
                </UTooltip>
                <p class="empty-state-hint text-[var(--ui-text-muted)]">
                    {{ t('emptyState.openPdf') }}
                </p>
            </div>

            <!-- Recent files: unified block with open-file integrated as last row -->
            <div v-else class="recent-files">
                <div class="recent-files-header">
                    <h3 class="text-sm font-medium text-[var(--ui-text-muted)]">
                        {{ t('emptyState.recentFiles') }}
                    </h3>
                    <UTooltip :text="t('emptyState.clearRecentFiles')" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-trash-2"
                            variant="ghost"
                            size="xs"
                            color="neutral"
                            class="text-[var(--ui-text-dimmed)] hover:text-[var(--ui-text-muted)]"
                            :aria-label="t('emptyState.clearRecentFiles')"
                            @click="emit('clear-recent')"
                        />
                    </UTooltip>
                </div>
                <ul class="recent-files-list">
                    <li
                        v-for="file in recentFiles"
                        :key="file.originalPath"
                        class="recent-file-item"
                        @click="emit('open-recent', file)"
                    >
                        <UIcon
                            name="i-lucide-file-text"
                            class="size-5 text-[var(--ui-text-dimmed)] flex-shrink-0"
                        />
                        <div class="recent-file-info">
                            <span class="recent-file-name">{{ file.fileName }}</span>
                            <span class="recent-file-path">{{ getParentFolder(file.originalPath) }}</span>
                        </div>
                        <span class="recent-file-time">{{ formatRelativeTimeLocalized(file.timestamp) }}</span>
                        <UTooltip :text="t('emptyState.removeFromRecent')" :delay-duration="1200">
                            <UButton
                                icon="i-lucide-x"
                                size="xs"
                                variant="ghost"
                                color="neutral"
                                class="recent-file-remove"
                                :aria-label="t('emptyState.removeFromRecent')"
                                @click.stop="emit('remove-recent', file)"
                            />
                        </UTooltip>
                    </li>
                </ul>
                <button
                    class="open-file-row group"
                    :aria-label="t('toolbar.openPdf')"
                    @click="emit('open-file')"
                >
                    <UIcon
                        name="i-lucide-folder-open"
                        class="size-5 text-[var(--ui-text-dimmed)] group-hover:text-[var(--ui-primary)] flex-shrink-0 transition-colors"
                    />
                    <span class="open-file-row-label group-hover:text-[var(--ui-primary)] transition-colors">
                        {{ t('emptyState.openAnother') }}
                    </span>
                </button>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { formatRelativeTime } from '@app/utils/formatters';

interface IRecentFile {
    originalPath: string;
    fileName: string;
    timestamp: number;
}

interface IOpenBatchProgress {
    processed: number;
    total: number;
    percent: number;
    estimatedRemainingMs: number | null;
}

const props = defineProps<{
    recentFiles: IRecentFile[];
    openBatchProgress?: IOpenBatchProgress | null;
}>();

const emit = defineEmits<{
    'open-file': [];
    'open-recent': [file: IRecentFile];
    'remove-recent': [file: IRecentFile];
    'clear-recent': [];
}>();

const { t } = useTypedI18n();

const batchEtaText = computed(() => formatEtaDuration(props.openBatchProgress?.estimatedRemainingMs ?? null));

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

function displayProcessedCount(processed: number, total: number) {
    if (total <= 0) {
        return 0;
    }

    return Math.min(Math.max(0, Math.round(processed)), total);
}

function formatEtaDuration(etaMs: number | null) {
    if (!Number.isFinite(etaMs) || etaMs === null || etaMs <= 0) {
        return null;
    }

    const totalSeconds = Math.max(1, Math.round(etaMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    return `0:${String(seconds).padStart(2, '0')}`;
}
</script>

<style scoped>
.empty-state {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(1.5rem, 3vh, 2.5rem) clamp(1rem, 2.2vw, 2rem);
    overflow: auto;
}

.empty-state-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: min(100%, 640px);
}

/* Standalone open-file prompt (no recent files) */

.open-file-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
}

.empty-state-hint {
    margin: 0;
    text-align: center;
    font-size: 0.8125rem;
}

.open-file-action {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.25rem 1.75rem;
    border-radius: 0.75rem;
    border: 1px dashed var(--ui-border);
    background: transparent;
    cursor: pointer;
    transition: all 0.15s ease;
}

.open-file-icon {
    width: 2rem;
    height: 2rem;
}

.open-file-action:hover {
    border-color: var(--ui-primary);
    background: color-mix(in oklab, var(--ui-bg) 95%, var(--ui-primary) 5%);
}

.open-file-action:active {
    transform: scale(0.97);
}

/* Recent files block */

.recent-files {
    width: 100%;
    min-height: 0;
}

.recent-files-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
    padding: 0 0.5rem;
}

.recent-files-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: min(50vh, 28rem);
    overflow-y: auto;
}

.recent-file-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: background-color 0.15s ease;
}

.recent-file-item:hover {
    background: var(--ui-bg-elevated);
}

.recent-file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.recent-file-name {
    color: var(--ui-text);
    font-size: 0.875rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.recent-file-path {
    font-size: 0.7rem;
    color: var(--ui-text-dimmed);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.recent-file-time {
    font-size: 0.7rem;
    color: var(--ui-text-muted);
    flex-shrink: 0;
    margin-left: auto;
}

.recent-file-remove {
    opacity: 0;
    transition: opacity 0.15s ease;
}

.recent-file-item:hover .recent-file-remove {
    opacity: 1;
}

/* Open-file row integrated into the list */

.open-file-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    margin-top: 2px;
    border: none;
    border-top: 1px dashed var(--ui-border);
    border-radius: 0 0 0.375rem 0.375rem;
    background: transparent;
    cursor: pointer;
    transition: background-color 0.15s ease;
}

.open-file-row:hover {
    background: var(--ui-bg-elevated);
}

.open-file-row:active {
    transform: scale(0.995);
}

.open-file-row-label {
    font-size: 0.875rem;
    color: var(--ui-text-muted);
}
</style>
