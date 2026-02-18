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
                        :disabled="!hasPdf || !canExportDocx || isExportingDocx"
                        @click="emit('export-docx'); close()"
                    >
                        <UIcon name="i-lucide-file-text" class="overflow-menu-icon" />
                        <span class="overflow-menu-label">{{ t('toolbar.exportDocx') }}</span>
                    </button>
                    <button
                        class="overflow-menu-item"
                        :disabled="!hasPdf || isDjvuMode"
                        @click="emit('open-ocr'); close()"
                    >
                        <UIcon name="i-lucide-scan-text" class="overflow-menu-icon" />
                        <span class="overflow-menu-label">{{ t('ocr.button') }}</span>
                    </button>
                    <button
                        :class="['overflow-menu-item', { 'is-active': continuousScroll }]"
                        :disabled="!hasPdf"
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
                    <button
                        class="overflow-menu-item"
                        @click="emit('open-settings'); close()"
                    >
                        <UIcon name="i-lucide-settings" class="overflow-menu-icon" />
                        <span class="overflow-menu-label">{{ t('toolbar.settings') }}</span>
                    </button>
                </div>

                <!-- Tier 2: FitW/FitH, Hand/TextSelect -->
                <template v-if="collapseTier >= 2">
                    <div class="overflow-menu-divider" />
                    <div class="overflow-menu-section">
                        <button
                            :class="['overflow-menu-item', { 'is-active': viewMode === 'single' }]"
                            :disabled="!hasPdf"
                            @click="emit('set-view-mode', 'single'); close()"
                        >
                            <UIcon name="i-lucide-file" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.singlePage') }}</span>
                            <UIcon
                                v-if="viewMode === 'single'"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            :class="['overflow-menu-item', { 'is-active': viewMode === 'facing' }]"
                            :disabled="!hasPdf"
                            @click="emit('set-view-mode', 'facing'); close()"
                        >
                            <UIcon name="i-lucide-book-open" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.facingPages') }}</span>
                            <UIcon
                                v-if="viewMode === 'facing'"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            :class="['overflow-menu-item', { 'is-active': viewMode === 'facing-first-single' }]"
                            :disabled="!hasPdf"
                            @click="emit('set-view-mode', 'facing-first-single'); close()"
                        >
                            <span class="overflow-menu-icon overflow-menu-icon--facing-first-single">
                                <UIcon name="i-lucide-book-open" class="size-[1.125rem]" />
                                <span class="overflow-menu-icon-badge">1</span>
                            </span>
                            <span class="overflow-menu-label">{{ t('zoom.facingWithFirstSingle') }}</span>
                            <UIcon
                                v-if="viewMode === 'facing-first-single'"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <div class="overflow-menu-divider" />
                        <button
                            :class="['overflow-menu-item', { 'is-active': isFitWidthActive }]"
                            :disabled="!hasPdf"
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
                            :disabled="!hasPdf"
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
                            :disabled="!hasPdf"
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
                            :disabled="!hasPdf"
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
                            :disabled="!hasPdf || !canSave || isAnySaving || isHistoryBusy"
                            @click="emit('save'); close()"
                        >
                            <UIcon name="i-lucide-save" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.save') }}</span>
                        </button>
                        <button
                            class="overflow-menu-item"
                            :disabled="!hasPdf || isAnySaving || isHistoryBusy"
                            @click="emit('save-as'); close()"
                        >
                            <UIcon name="i-lucide-save-all" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.saveAs') }}</span>
                        </button>
                        <button
                            class="overflow-menu-item"
                            :disabled="!hasPdf || !canUndo || isHistoryBusy || isAnySaving"
                            @click="emit('undo'); close()"
                        >
                            <UIcon name="i-lucide-undo-2" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.undo') }}</span>
                        </button>
                        <button
                            class="overflow-menu-item"
                            :disabled="!hasPdf || !canRedo || isHistoryBusy || isAnySaving"
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
import type { TPdfViewMode } from '@app/types/shared';

const { t } = useTypedI18n();

interface IProps {
    open: boolean
    collapseTier: number
    hasPdf: boolean
    canSave: boolean
    canUndo: boolean
    canRedo: boolean
    isAnySaving: boolean
    isHistoryBusy: boolean
    isExportingDocx: boolean
    canExportDocx: boolean
    dragMode: boolean
    continuousScroll: boolean
    viewMode: TPdfViewMode
    isDjvuMode: boolean
    isFitWidthActive: boolean
    isFitHeightActive: boolean
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
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
    (e: 'set-view-mode', mode: TPdfViewMode): void
    (e: 'toggle-continuous-scroll'): void
    (e: 'open-settings'): void
}>();

const isOpen = computed({
    get: () => props.open,
    set: (value: boolean) => emit('update:open', value),
});

function close() {
    isOpen.value = false;
}
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

.overflow-menu-icon--facing-first-single {
    position: relative;
}

.overflow-menu-icon-badge {
    position: absolute;
    top: -0.125rem;
    right: -0.3125rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0.75rem;
    height: 0.75rem;
    padding: 0 0.125rem;
    border-radius: 999px;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 0.5625rem;
    line-height: 1;
    font-weight: 700;
}

.overflow-menu-item.is-active .overflow-menu-icon-badge {
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
