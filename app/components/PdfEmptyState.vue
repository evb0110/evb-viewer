<template>
    <div class="empty-state">
        <div
            v-if="recentFiles.length > 0"
            class="recent-files"
        >
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
        </div>

        <p class="empty-state-hint text-sm text-[var(--ui-text-muted)]">
            {{ recentFiles.length > 0 ? t('emptyState.openAnother') : t('emptyState.openPdf') }}
        </p>
        <UTooltip :text="t('toolbar.openPdf')" :delay-duration="1200">
            <button
                class="open-file-action group"
                :aria-label="t('toolbar.openPdf')"
                @click="emit('open-file')"
            >
                <UIcon
                    name="i-lucide-folder-open"
                    class="size-8 text-[var(--ui-text-dimmed)] group-hover:text-[var(--ui-primary)] transition-colors"
                />
            </button>
        </UTooltip>
    </div>
</template>

<script setup lang="ts">
import { formatRelativeTime } from '@app/utils/formatters';

interface IRecentFile {
    originalPath: string;
    fileName: string;
    timestamp: number;
}

defineProps<{recentFiles: IRecentFile[];}>();

const emit = defineEmits<{
    'open-file': [];
    'open-recent': [file: IRecentFile];
    'remove-recent': [file: IRecentFile];
    'clear-recent': [];
}>();

const { t } = useI18n();

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
</script>

<style scoped>
.empty-state {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    gap: 1rem;
    padding: clamp(1rem, 2.6vh, 1.8rem) clamp(1rem, 2.2vw, 2rem);
    overflow: auto;
}

.empty-state-hint {
    margin: 0;
    text-align: center;
}

.open-file-action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    margin: 0 auto;
    padding: 1rem 1.5rem;
    border-radius: 0.5rem;
    border: 1px dashed var(--ui-border);
    background: transparent;
    cursor: pointer;
    transition: all 0.15s ease;
}

.open-file-action:hover {
    border-color: var(--ui-primary);
    background: color-mix(in oklab, var(--ui-bg) 95%, var(--ui-primary) 5%);
}

.open-file-action:hover :deep(.iconify) {
    color: var(--ui-primary);
}

.open-file-action:active {
    transform: scale(0.98);
}

.recent-files {
    width: min(100%, 640px);
    margin: 0 auto;
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
    max-height: min(60vh, 34rem);
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
</style>
