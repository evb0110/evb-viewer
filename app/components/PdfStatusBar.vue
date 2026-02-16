<template>
    <footer class="status-bar">
        <div class="status-bar-file">
            <UTooltip :text="showInFolderTooltip" :delay-duration="800">
                <button
                    type="button"
                    class="status-folder-button"
                    :class="{ 'is-actionable': canShowInFolder }"
                    :disabled="!canShowInFolder"
                    :aria-label="showInFolderAriaLabel"
                    @click="emit('showInFolder')"
                >
                    <UIcon name="i-lucide-folder-open" class="status-folder-icon" />
                </button>
            </UTooltip>
            <div class="status-bar-path" :title="filePath">
                {{ filePath }}
            </div>
        </div>
        <div class="status-bar-metrics">
            <span class="status-bar-item">{{ fileSizeLabel }}</span>
            <span class="status-bar-item">{{ zoomLabel }}</span>
            <UTooltip :text="saveDotTooltip" :delay-duration="800">
                <button
                    type="button"
                    class="status-save-dot-button"
                    :class="[saveDotClass, { 'is-actionable': canSave }]"
                    :disabled="!canSave"
                    :aria-label="saveDotAriaLabel"
                    @click="emit('save')"
                >
                    <span class="status-save-dot" />
                </button>
            </UTooltip>
        </div>
    </footer>
</template>

<script setup lang="ts">
defineProps<{
    filePath: string;
    fileSizeLabel: string;
    zoomLabel: string;
    canShowInFolder: boolean;
    showInFolderTooltip: string;
    showInFolderAriaLabel: string;
    saveDotClass: string;
    saveDotTooltip: string;
    saveDotAriaLabel: string;
    canSave: boolean;
}>();

const emit = defineEmits<{
    showInFolder: [];
    save: [];
}>();
</script>

<style scoped>
.status-bar {
    min-height: 1.9rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.3rem 0.75rem;
    border-top: 1px solid var(--ui-border);
    background: var(--app-status-bar-bg);
    color: var(--ui-text-dimmed);
    font-size: 0.74rem;
    line-height: 1.2;
    transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.status-bar-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0.01em;
}

.status-bar-file {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
}

.status-bar-metrics {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.875rem;
}

.status-bar-metrics > * + * {
    position: relative;
}

.status-bar-metrics > * + *::before {
    content: "";
    position: absolute;
    left: -0.5rem;
    top: 50%;
    width: 1px;
    height: 0.76rem;
    transform: translateY(-50%);
    background: var(--app-status-bar-divider);
}

.status-bar-item {
    white-space: nowrap;
}

.status-save-dot-button {
    width: 1.1rem;
    height: 1.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    padding: 0;
    border-radius: 999px;
    cursor: default;
}

.status-folder-button {
    width: 1.1rem;
    height: 1.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    background: transparent;
    color: var(--ui-text-dimmed);
    padding: 0;
    border-radius: 0.25rem;
    cursor: default;
    transition: color 0.14s ease, background-color 0.14s ease, border-color 0.14s ease;
}

.status-folder-icon {
    width: 0.82rem;
    height: 0.82rem;
}

.status-folder-button.is-actionable {
    cursor: pointer;
}

.status-folder-button.is-actionable:hover {
    color: var(--ui-text);
    background: var(--app-status-folder-hover-bg);
    border-color: var(--app-status-folder-hover-border);
}

.status-save-dot-button.is-actionable {
    cursor: pointer;
}

.status-save-dot {
    width: 0.56rem;
    height: 0.56rem;
    border-radius: 999px;
    background: var(--app-status-save-dot-idle-bg);
    box-shadow: 0 0 0 1px var(--app-status-save-dot-idle-ring);
    transition: transform 0.14s ease, background-color 0.14s ease, box-shadow 0.14s ease;
}

.status-save-dot-button.is-dirty .status-save-dot {
    background: var(--app-status-save-dot-dirty-bg);
    box-shadow: 0 0 0 1px var(--app-status-save-dot-dirty-ring);
}

.status-save-dot-button.is-clean .status-save-dot {
    background: var(--app-status-save-dot-clean-bg);
    box-shadow: 0 0 0 1px var(--app-status-save-dot-clean-ring);
}

.status-save-dot-button.is-saving .status-save-dot {
    background: var(--app-status-save-dot-saving-bg);
    box-shadow: 0 0 0 1px var(--app-status-save-dot-saving-ring);
    animation: status-save-dot-pulse 1s ease-in-out infinite;
}

.status-save-dot-button.is-actionable:hover .status-save-dot {
    transform: scale(1.15);
}

@keyframes status-save-dot-pulse {
    0%,
    100% {
        transform: scale(1);
        opacity: 1;
    }

    50% {
        transform: scale(1.15);
        opacity: 0.72;
    }
}
</style>
