<template>
    <footer class="status-bar">
        <div class="status-bar-file">
            <AppTooltip :text="showInFolderTooltip" :delay-duration="800">
                <button
                    type="button"
                    class="status-folder-button"
                    :class="{ 'is-actionable': canShowInFolder }"
                    :disabled="!canShowInFolder"
                    :aria-label="showInFolderAriaLabel"
                    @click="onShowInFolder"
                >
                    <UIcon name="i-ph-folder-open" class="status-folder-icon" />
                </button>
            </AppTooltip>
            <AppTooltip :text="filePath" :delay-duration="800">
                <div class="status-bar-path">
                    {{ filePath }}
                </div>
            </AppTooltip>
        </div>
        <div class="status-bar-metrics">
            <span
                v-if="materializationLabel"
                class="status-materialization"
                role="status"
            >
                <UIcon
                    name="i-ph-circle-notch"
                    class="status-materialization-icon animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                />
                <span>{{ materializationLabel }}</span>
            </span>
            <span v-if="fileSizeLabel" class="status-bar-item">{{ fileSizeLabel }}</span>
            <span v-if="zoomLabel" class="status-bar-item">{{ zoomLabel }}</span>
            <AppTooltip :text="saveDotTooltip" :delay-duration="800">
                <button
                    type="button"
                    class="status-save-dot-button"
                    :class="[saveDotClass, { 'is-actionable': canSave }]"
                    :disabled="!canSave"
                    :aria-label="saveDotAriaLabel"
                    @click="onSave"
                >
                    <span class="status-save-dot" />
                </button>
            </AppTooltip>
        </div>
    </footer>
</template>

<script setup lang="ts">
defineProps<{
    filePath: string;
    fileSizeLabel: string;
    zoomLabel: string;
    materializationLabel: string | null;
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

function onShowInFolder() {
    emit('showInFolder');
}

function onSave() {
    emit('save');
}
</script>

<style scoped>
.status-bar {
    height: var(--app-statusbar-height);
    min-height: var(--app-statusbar-height);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-statusbar-gap);
    padding: var(--app-statusbar-padding);
    border-top: 1px solid var(--ui-border);
    background: var(--app-status-bar-bg);
    color: var(--ui-text-dimmed);
    font-size: var(--app-statusbar-font-size);
    line-height: var(--app-line-height-snug);
    transition:
        background-color var(--app-transition-standard),
        border-color var(--app-transition-standard),
        color var(--app-transition-standard);
}

.status-bar-path {
    flex: 0 1 auto;
    min-width: 0;
    max-width: var(--app-statusbar-path-max-width);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0.01em;
}

.status-bar-file {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--app-statusbar-file-gap);
    min-width: 0;
}

.status-bar-metrics {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: var(--app-statusbar-metrics-gap);
}

.status-bar-metrics > * + * {
    position: relative;
}

.status-bar-metrics > * + *::before {
    content: "";
    position: absolute;
    left: var(--app-statusbar-divider-offset);
    top: 50%;
    width: var(--app-statusbar-divider-width);
    height: var(--app-statusbar-divider-height);
    transform: translateY(-50%);
    background: var(--app-status-bar-divider);
}

.status-bar-item {
    white-space: nowrap;
}

.status-materialization {
    display: inline-flex;
    align-items: center;
    gap: var(--app-statusbar-file-gap);
    white-space: nowrap;
}

.status-materialization-icon {
    width: var(--app-statusbar-folder-icon-size);
    height: var(--app-statusbar-folder-icon-size);
}

.status-save-dot-button {
    width: var(--app-statusbar-action-size);
    height: var(--app-statusbar-action-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    padding: 0;
    border-radius: var(--app-radius-full);
    cursor: default;
}

.status-folder-button {
    width: var(--app-statusbar-action-size);
    height: var(--app-statusbar-action-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    background: transparent;
    color: var(--ui-text-dimmed);
    padding: 0;
    border-radius: var(--app-statusbar-folder-radius);
    cursor: default;
    transition:
        color var(--app-transition-standard),
        background-color var(--app-transition-standard),
        border-color var(--app-transition-standard);
}

.status-folder-icon {
    width: var(--app-statusbar-folder-icon-size);
    height: var(--app-statusbar-folder-icon-size);
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
    width: var(--app-statusbar-save-dot-size);
    height: var(--app-statusbar-save-dot-size);
    border-radius: var(--app-radius-full);
    background: var(--app-status-save-dot-idle-bg);
    box-shadow: 0 0 0 1px var(--app-status-save-dot-idle-ring);
    transition:
        transform var(--app-transition-standard),
        background-color var(--app-transition-standard),
        box-shadow var(--app-transition-standard);
}

.status-save-dot-button.is-dirty .status-save-dot {
    background: var(--app-status-save-dot-dirty-bg);
    box-shadow: 0 0 0 1px var(--app-status-save-dot-dirty-ring);
}

.status-save-dot-button.is-clean .status-save-dot {
    background: var(--app-status-save-dot-clean-bg);
    box-shadow: 0 0 0 1px var(--app-status-save-dot-clean-ring);
}

.status-save-dot-button.is-failed .status-save-dot {
    background: var(--app-status-save-dot-failed-bg);
    box-shadow: 0 0 0 1px var(--app-status-save-dot-failed-ring);
}

.status-save-dot-button.is-saving .status-save-dot {
    background: var(--app-status-save-dot-saving-bg);
    box-shadow: 0 0 0 1px var(--app-status-save-dot-saving-ring);
    animation: status-save-dot-pulse 1s ease-in-out infinite;
}

.status-save-dot-button.is-actionable:hover .status-save-dot {
    transform: scale(1.15);
}

html.app-low-graphics .status-save-dot-button.is-saving .status-save-dot {
    animation: none;
}

@media (prefers-reduced-motion: reduce) {
    .status-save-dot-button.is-saving .status-save-dot {
        animation: none;
    }
}

@keyframes status-save-dot-pulse {
    0%,
    100% {
        transform: scale(1);
        opacity: 1;
    }

    50% {
        transform: scale(1.15);
        opacity: var(--app-statusbar-pulse-opacity);
    }
}
</style>
