<template>
    <UPopover v-model:open="isOpen" mode="click">
        <UTooltip :text="t('toolbar.moreTools')" :delay-duration="1200">
            <UButton
                icon="i-lucide-ellipsis"
                variant="ghost"
                color="neutral"
                class="toolbar-icon-button"
                :aria-label="t('toolbar.moreTools')"
            />
        </UTooltip>

        <template #content>
            <div class="overflow-menu">
                <!-- Tier 1: ExportDocx, OCR, Continuous Scroll -->
                <div v-if="collapseTier >= 1" class="overflow-menu-section">
                    <button
                        class="overflow-menu-item"
                        :disabled="!canExportDocx || isExportingDocx"
                        @click="emit('export-docx'); close()"
                    >
                        <UIcon name="i-lucide-file-text" class="overflow-menu-icon" />
                        <span class="overflow-menu-label">{{ t('toolbar.exportDocx') }}</span>
                    </button>
                    <button
                        class="overflow-menu-item"
                        :disabled="isDjvuMode"
                        @click="emit('open-ocr'); close()"
                    >
                        <UIcon name="i-lucide-scan-text" class="overflow-menu-icon" />
                        <span class="overflow-menu-label">{{ t('ocr.button') }}</span>
                    </button>
                    <button
                        :class="['overflow-menu-item', { 'is-active': continuousScroll }]"
                        @click="emit('toggle-continuous-scroll'); close()"
                    >
                        <UIcon name="i-lucide-scroll" class="overflow-menu-icon" />
                        <span class="overflow-menu-label">{{ t('zoom.continuousScroll') }}</span>
                        <UIcon
                            v-if="continuousScroll"
                            name="i-lucide-check"
                            class="overflow-menu-check"
                        />
                    </button>
                </div>

                <!-- Tier 2: FitW/FitH, Hand/TextSelect -->
                <template v-if="collapseTier >= 2">
                    <div class="overflow-menu-divider" />
                    <div class="overflow-menu-section">
                        <button
                            :class="['overflow-menu-item', { 'is-active': isFitWidthActive }]"
                            @click="emit('fit-width'); close()"
                        >
                            <UIcon name="i-lucide-move-horizontal" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.fitWidth') }}</span>
                            <UIcon
                                v-if="isFitWidthActive"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            :class="['overflow-menu-item', { 'is-active': isFitHeightActive }]"
                            @click="emit('fit-height'); close()"
                        >
                            <UIcon name="i-lucide-move-vertical" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.fitHeight') }}</span>
                            <UIcon
                                v-if="isFitHeightActive"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            :class="['overflow-menu-item', { 'is-active': dragMode }]"
                            @click="emit('enable-drag'); close()"
                        >
                            <UIcon name="i-lucide-hand" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.handTool') }}</span>
                            <UIcon
                                v-if="dragMode"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            :class="['overflow-menu-item', { 'is-active': !dragMode }]"
                            @click="emit('disable-drag'); close()"
                        >
                            <UIcon name="i-lucide-text-cursor" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.textSelect') }}</span>
                            <UIcon
                                v-if="!dragMode"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                    </div>
                </template>

                <!-- Tier 3: Save, SaveAs, Undo/Redo -->
                <template v-if="collapseTier >= 3">
                    <div class="overflow-menu-divider" />
                    <div class="overflow-menu-section">
                        <button
                            class="overflow-menu-item"
                            :disabled="!canSave || isAnySaving || isHistoryBusy"
                            @click="emit('save'); close()"
                        >
                            <UIcon name="i-lucide-save" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.save') }}</span>
                        </button>
                        <button
                            class="overflow-menu-item"
                            :disabled="isAnySaving || isHistoryBusy"
                            @click="emit('save-as'); close()"
                        >
                            <UIcon name="i-lucide-save-all" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.saveAs') }}</span>
                        </button>
                        <button
                            class="overflow-menu-item"
                            :disabled="!canUndo || isHistoryBusy || isAnySaving"
                            @click="emit('undo'); close()"
                        >
                            <UIcon name="i-lucide-undo-2" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.undo') }}</span>
                        </button>
                        <button
                            class="overflow-menu-item"
                            :disabled="!canRedo || isHistoryBusy || isAnySaving"
                            @click="emit('redo'); close()"
                        >
                            <UIcon name="i-lucide-redo-2" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.redo') }}</span>
                        </button>
                    </div>
                </template>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
const { t } = useI18n();

interface IProps {
    collapseTier: number
    canSave: boolean
    canUndo: boolean
    canRedo: boolean
    isAnySaving: boolean
    isHistoryBusy: boolean
    isExportingDocx: boolean
    canExportDocx: boolean
    dragMode: boolean
    continuousScroll: boolean
    isDjvuMode: boolean
    isFitWidthActive: boolean
    isFitHeightActive: boolean
}

defineProps<IProps>();

const emit = defineEmits<{
    (e: 'save'): void
    (e: 'save-as'): void
    (e: 'export-docx'): void
    (e: 'open-ocr'): void
    (e: 'undo'): void
    (e: 'redo'): void
    (e: 'fit-width'): void
    (e: 'fit-height'): void
    (e: 'enable-drag'): void
    (e: 'disable-drag'): void
    (e: 'toggle-continuous-scroll'): void
}>();

const isOpen = ref(false);

function close() {
    isOpen.value = false;
}

defineExpose({ close });
</script>

<style scoped>
.overflow-menu {
    padding: 0.25rem;
    min-width: 14rem;
}

.overflow-menu-section {
    display: flex;
    flex-direction: column;
}

.overflow-menu-divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.25rem 0;
}

.overflow-menu-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 0.375rem;
    color: var(--ui-text);
    font-size: 0.875rem;
    text-align: left;
    transition: background-color 150ms ease;
}

.overflow-menu-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.overflow-menu-item:hover:not(:disabled) {
    background-color: var(--ui-bg-elevated);
}

.overflow-menu-item.is-active {
    color: var(--ui-text);
}

.overflow-menu-icon {
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    color: var(--ui-text-muted);
}

.overflow-menu-item.is-active .overflow-menu-icon {
    color: var(--ui-text);
}

.overflow-menu-label {
    flex: 1;
}

.overflow-menu-check {
    width: 1rem;
    height: 1rem;
    color: var(--ui-text);
    flex-shrink: 0;
}
</style>
