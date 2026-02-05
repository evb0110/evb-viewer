<template>
    <div class="pdf-annotations-panel">
        <section class="annotation-section">
            <h3 class="annotation-section-title">Tools</h3>
            <div class="annotation-tool-grid">
                <UButton
                    icon="i-lucide-mouse-pointer"
                    :ui="toolButtonUi"
                    :variant="tool === 'none' ? 'soft' : 'ghost'"
                    :color="tool === 'none' ? 'primary' : 'neutral'"
                    :class="tool === 'none' ? 'is-active' : ''"
                    class="annotation-tool"
                    aria-label="Select"
                    @click="emit('set-tool', 'none')"
                />
                <UButton
                    icon="i-lucide-highlighter"
                    :ui="toolButtonUi"
                    :variant="tool === 'highlight' ? 'soft' : 'ghost'"
                    :color="tool === 'highlight' ? 'primary' : 'neutral'"
                    :class="tool === 'highlight' ? 'is-active' : ''"
                    class="annotation-tool"
                    aria-label="Highlight"
                    @click="emit('set-tool', 'highlight')"
                />
                <UButton
                    icon="i-lucide-type"
                    :ui="toolButtonUi"
                    :variant="tool === 'text' ? 'soft' : 'ghost'"
                    :color="tool === 'text' ? 'primary' : 'neutral'"
                    :class="tool === 'text' ? 'is-active' : ''"
                    class="annotation-tool"
                    aria-label="Text"
                    @click="emit('set-tool', 'text')"
                />
                <UButton
                    icon="i-lucide-pen-tool"
                    :ui="toolButtonUi"
                    :variant="tool === 'draw' ? 'soft' : 'ghost'"
                    :color="tool === 'draw' ? 'primary' : 'neutral'"
                    :class="tool === 'draw' ? 'is-active' : ''"
                    class="annotation-tool"
                    aria-label="Draw"
                    @click="emit('set-tool', 'draw')"
                />
            </div>
        </section>

        <section class="annotation-section">
            <h3 class="annotation-section-title">Quick Actions</h3>
            <div class="annotation-actions">
                <UButton
                    icon="i-lucide-highlighter"
                    variant="soft"
                    color="primary"
                    class="annotation-action"
                    @pointerdown.prevent
                    @mousedown.prevent
                    @click="emit('highlight-selection')"
                >
                    Highlight Selection
                </UButton>
                <UButton
                    icon="i-lucide-message-square"
                    variant="soft"
                    color="primary"
                    class="annotation-action"
                    @pointerdown.prevent
                    @mousedown.prevent
                    @click="emit('comment-selection')"
                >
                    Comment Selection
                </UButton>
            </div>
        </section>

        <section class="annotation-section">
            <h3 class="annotation-section-title">Highlight</h3>
            <div class="annotation-control">
                <label class="annotation-label">Color</label>
                <input
                    class="annotation-color"
                    type="color"
                    :value="settings.highlightColor"
                    @input="updateSetting('highlightColor', ($event.target as HTMLInputElement).value)"
                />
            </div>
            <div class="annotation-control">
                <label class="annotation-label">
                    Opacity
                    <span class="annotation-value">{{ Math.round(settings.highlightOpacity * 100) }}%</span>
                </label>
                <input
                    class="annotation-range"
                    type="range"
                    min="0.1"
                    max="1"
                    step="0.05"
                    :value="settings.highlightOpacity"
                    @input="updateSetting('highlightOpacity', Number(($event.target as HTMLInputElement).value))"
                />
            </div>
            <label class="annotation-toggle">
                <input
                    type="checkbox"
                    :checked="settings.highlightFree"
                    @change="updateSetting('highlightFree', ($event.target as HTMLInputElement).checked)"
                />
                Freehand highlight
            </label>
        </section>

        <section class="annotation-section">
            <h3 class="annotation-section-title">Draw</h3>
            <div class="annotation-control">
                <label class="annotation-label">Color</label>
                <input
                    class="annotation-color"
                    type="color"
                    :value="settings.inkColor"
                    @input="updateSetting('inkColor', ($event.target as HTMLInputElement).value)"
                />
            </div>
            <div class="annotation-control">
                <label class="annotation-label">
                    Thickness
                    <span class="annotation-value">{{ settings.inkThickness }}</span>
                </label>
                <input
                    class="annotation-range"
                    type="range"
                    min="1"
                    max="12"
                    step="1"
                    :value="settings.inkThickness"
                    @input="updateSetting('inkThickness', Number(($event.target as HTMLInputElement).value))"
                />
            </div>
            <div class="annotation-control">
                <label class="annotation-label">
                    Opacity
                    <span class="annotation-value">{{ Math.round(settings.inkOpacity * 100) }}%</span>
                </label>
                <input
                    class="annotation-range"
                    type="range"
                    min="0.1"
                    max="1"
                    step="0.05"
                    :value="settings.inkOpacity"
                    @input="updateSetting('inkOpacity', Number(($event.target as HTMLInputElement).value))"
                />
            </div>
            <p class="annotation-hint">
                Use Draw for lines, boxes, arrows, and freehand markup.
            </p>
        </section>

        <section class="annotation-section">
            <h3 class="annotation-section-title">Text</h3>
            <div class="annotation-control">
                <label class="annotation-label">Color</label>
                <input
                    class="annotation-color"
                    type="color"
                    :value="settings.textColor"
                    @input="updateSetting('textColor', ($event.target as HTMLInputElement).value)"
                />
            </div>
            <div class="annotation-control">
                <label class="annotation-label">
                    Size
                    <span class="annotation-value">{{ settings.textSize }}pt</span>
                </label>
                <input
                    class="annotation-range"
                    type="range"
                    min="8"
                    max="32"
                    step="1"
                    :value="settings.textSize"
                    @input="updateSetting('textSize', Number(($event.target as HTMLInputElement).value))"
                />
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';

interface IProps {
    tool: TAnnotationTool;
    settings: IAnnotationSettings;
}

defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
    (e: 'update-setting', payload: { key: keyof IAnnotationSettings; value: IAnnotationSettings[keyof IAnnotationSettings] }): void;
    (e: 'highlight-selection'): void;
    (e: 'comment-selection'): void;
}>();

const toolButtonUi = {
    base: 'justify-center px-0 py-2',
};

function updateSetting(
    key: keyof IAnnotationSettings,
    value: IAnnotationSettings[keyof IAnnotationSettings],
) {
    emit('update-setting', {
        key,
        value,
    });
}
</script>

<style scoped>
.pdf-annotations-panel {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1rem 0.75rem 1.5rem;
    color: var(--ui-text);
}

.annotation-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.annotation-section-title {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ui-text-muted);
    margin: 0;
}

.annotation-tool-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
}

.annotation-tool {
    width: 100%;
    height: 2.5rem;
    justify-content: center !important;
    align-items: center !important;
}

.annotation-tool.is-active {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ui-primary) 35%, transparent);
}

.annotation-actions {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.5rem;
}

.annotation-action {
    justify-content: flex-start;
}

.annotation-control {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}

.annotation-label {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    color: var(--ui-text);
}

.annotation-value {
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}

.annotation-color {
    width: 100%;
    height: 2rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg-elevated);
    padding: 0.1rem 0.25rem;
}

.annotation-range {
    width: 100%;
}

.annotation-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--ui-text);
}

.annotation-hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--ui-text-muted);
}
</style>
