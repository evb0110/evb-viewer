<template>
    <Teleport to="body">
        <Transition name="modal">
            <div
                v-if="isOpen"
                class="modal-overlay"
                @click.self="handleOverlayClick"
            >
                <div class="modal-container">
                    <div class="modal-header">
                        <div class="modal-title-section">
                            <h2 class="modal-title">Process Scanned Pages</h2>
                            <div v-if="isProcessing" class="modal-processing-badge">
                                <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
                                <span>Processing...</span>
                            </div>
                        </div>
                        <UButton
                            icon="i-lucide-x"
                            variant="ghost"
                            color="neutral"
                            size="sm"
                            aria-label="Close modal"
                            @click="handleClose"
                        />
                    </div>

                    <StageNavigation
                        :current-stage="currentStage"
                        :stage-statuses="stageStatuses"
                        @select="handleStageSelect"
                    />

                    <div class="modal-body">
                        <div class="modal-sidebar">
                            <PageThumbnails
                                :pages="pagesArray"
                                :current-page="currentPageIndex"
                                :page-statuses="pageStatuses"
                                @select="handlePageSelect"
                            />
                        </div>

                        <div class="modal-content">
                            <PagePreview
                                :page-image-url="currentPagePreviewUrl"
                                :is-loading="isPreviewLoading"
                                :error="previewError"
                                :zoom="previewZoom"
                                @update:zoom="previewZoom = $event"
                                @retry="handlePreviewRetry"
                            >
                                <template #overlay>
                                    <slot name="preview-overlay" />
                                </template>
                            </PagePreview>
                        </div>

                        <div class="modal-controls">
                            <StageRotation
                                v-if="currentStage === 'rotation'"
                                :rotation="currentRotation"
                                :auto-detected-rotation="autoDetectedRotation"
                                :confidence="rotationConfidence"
                                :apply-to-all="applyRotationToAll"
                                @update:rotation="handleRotationChange"
                                @update:apply-to-all="applyRotationToAll = $event"
                            />

                            <StageSplit
                                v-else-if="currentStage === 'split'"
                                :split-mode="currentSplitMode"
                                :split-position="currentSplitPosition"
                                :auto-detected-position="autoDetectedSplitPosition"
                                :confidence="splitConfidence"
                                @update:split-mode="handleSplitModeChange"
                                @update:split-position="handleSplitPositionChange"
                                @apply-to-similar="handleApplyToSimilar"
                            />

                            <div v-else-if="currentStage === 'deskew'" class="stage-placeholder">
                                <UIcon name="i-lucide-scaling" class="size-8 text-muted" />
                                <span class="text-muted">Deskew controls coming soon</span>
                            </div>

                            <div v-else-if="currentStage === 'content'" class="stage-placeholder">
                                <UIcon name="i-lucide-layout-grid" class="size-8 text-muted" />
                                <span class="text-muted">Content detection controls coming soon</span>
                            </div>

                            <div v-else-if="currentStage === 'margins'" class="stage-placeholder">
                                <UIcon name="i-lucide-move-horizontal" class="size-8 text-muted" />
                                <span class="text-muted">Margin controls coming soon</span>
                            </div>

                            <div v-else-if="currentStage === 'output'" class="stage-placeholder">
                                <UIcon name="i-lucide-file-text" class="size-8 text-muted" />
                                <span class="text-muted">Output options coming soon</span>
                            </div>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <div class="modal-footer-status">
                            <span v-if="statusMessage" class="status-message">{{ statusMessage }}</span>
                        </div>
                        <div class="modal-footer-actions">
                            <UButton
                                v-if="isProcessing"
                                color="neutral"
                                variant="soft"
                                @click="handleCancel"
                            >
                                Cancel
                            </UButton>
                            <UButton
                                v-else
                                color="neutral"
                                variant="soft"
                                @click="handleClose"
                            >
                                Cancel
                            </UButton>
                            <UButton
                                color="primary"
                                :disabled="!canApply"
                                :loading="isProcessing"
                                @click="handleApply"
                            >
                                <UIcon name="i-lucide-check" class="size-4" />
                                Apply
                            </UButton>
                        </div>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup lang="ts">
import {
    computed,
    ref,
    watch,
} from 'vue';
import type {
    TProcessingStage,
    TStageStatus,
    TPageStatus,
    TSplitMode,
} from '@app/types/page-processing';
import StageNavigation from '@app/components/page-processing/StageNavigation.vue';
import PageThumbnails from '@app/components/page-processing/PageThumbnails.vue';
import PagePreview from '@app/components/page-processing/PagePreview.vue';
import StageRotation from '@app/components/page-processing/StageRotation.vue';
import StageSplit from '@app/components/page-processing/StageSplit.vue';

interface IProps {
    isOpen: boolean;
    pdfPath?: string;
    totalPages?: number;
    currentPage?: number;
}

const {
    isOpen,
    pdfPath: _pdfPath = '',
    totalPages = 0,
    currentPage = 1,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:isOpen', value: boolean): void;
    (e: 'close'): void;
    (e: 'apply'): void;
    (e: 'cancel'): void;
}>();

const currentStage = ref<TProcessingStage>('rotation');
const currentPageIndex = ref(0);
const previewZoom = ref<'fit' | '100%'>('fit');
const isProcessing = ref(false);
const isPreviewLoading = ref(false);
const previewError = ref<string | null>(null);
const statusMessage = ref('');

const currentRotation = ref(0);
const autoDetectedRotation = ref<number | null>(null);
const rotationConfidence = ref<number | null>(null);
const applyRotationToAll = ref(false);

const currentSplitMode = ref<TSplitMode>('auto');
const currentSplitPosition = ref(0.5);
const autoDetectedSplitPosition = ref<number | null>(null);
const splitConfidence = ref<number | null>(null);

const stageStatuses = ref<Record<TProcessingStage, TStageStatus>>({
    rotation: 'pending',
    split: 'pending',
    deskew: 'pending',
    dewarp: 'pending',
    content: 'pending',
    margins: 'pending',
    output: 'pending',
});

const pagesArray = computed(() => {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
});

const pageStatuses = computed<Record<number, TPageStatus>>(() => {
    const statuses: Record<number, TPageStatus> = {};
    for (let i = 1; i <= totalPages; i++) {
        statuses[i] = 'pending';
    }
    return statuses;
});

const currentPagePreviewUrl = computed(() => {
    return '';
});

const canApply = computed(() => {
    return !isProcessing.value && totalPages > 0;
});

watch(() => currentPage, (page) => {
    if (page !== undefined) {
        currentPageIndex.value = page - 1;
    }
});

watch(() => isOpen, (open) => {
    if (open) {
        currentStage.value = 'rotation';
        currentPageIndex.value = Math.max(0, (currentPage ?? 1) - 1);
    }
});

function handleStageSelect(stage: TProcessingStage) {
    currentStage.value = stage;
}

function handlePageSelect(pageIndex: number) {
    currentPageIndex.value = pageIndex;
}

function handleRotationChange(rotation: number) {
    currentRotation.value = rotation;
}

function handleSplitModeChange(mode: TSplitMode) {
    currentSplitMode.value = mode;
}

function handleSplitPositionChange(position: number) {
    currentSplitPosition.value = position;
}

function handleApplyToSimilar() {
    statusMessage.value = 'Applied split settings to similar pages';
    setTimeout(() => {
        statusMessage.value = '';
    }, 3000);
}

function handlePreviewRetry() {
    previewError.value = null;
    isPreviewLoading.value = true;
}

function handleOverlayClick() {
    if (!isProcessing.value) {
        handleClose();
    }
}

function handleClose() {
    emit('update:isOpen', false);
    emit('close');
}

function handleCancel() {
    isProcessing.value = false;
    emit('cancel');
}

function handleApply() {
    emit('apply');
}
</script>

<style scoped>
.modal-overlay {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
}

.modal-container {
    background-color: var(--ui-bg);
    border-radius: 12px;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    width: 90vw;
    max-width: 1200px;
    height: 85vh;
    max-height: 800px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--ui-border);
}

.modal-title-section {
    display: flex;
    align-items: center;
    gap: 12px;
}

.modal-title {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0;
}

.modal-processing-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background-color: var(--ui-primary-alpha);
    color: var(--ui-primary);
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
}

.modal-body {
    display: flex;
    flex: 1;
    overflow: hidden;
}

.modal-sidebar {
    width: 140px;
    border-right: 1px solid var(--ui-border);
    overflow-y: auto;
    flex-shrink: 0;
}

.modal-content {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: hidden;
    background-color: var(--ui-bg-muted);
}

.modal-controls {
    width: 280px;
    border-left: 1px solid var(--ui-border);
    overflow-y: auto;
    flex-shrink: 0;
}

.modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-top: 1px solid var(--ui-border);
}

.modal-footer-status {
    flex: 1;
}

.status-message {
    font-size: 0.8125rem;
    color: var(--ui-text-muted);
}

.modal-footer-actions {
    display: flex;
    gap: 8px;
}

.stage-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 40px 20px;
    text-align: center;
}

.text-muted {
    color: var(--ui-text-muted);
    font-size: 0.875rem;
}

.animate-spin {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from {
        transform: rotate(0deg);
    }

    to {
        transform: rotate(360deg);
    }
}

.modal-enter-active,
.modal-leave-active {
    transition: opacity 0.2s ease;
}

.modal-enter-active .modal-container,
.modal-leave-active .modal-container {
    transition: transform 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
    opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
    transform: scale(0.95);
}
</style>
