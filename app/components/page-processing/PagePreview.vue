<template>
    <div class="page-preview">
        <div class="preview-toolbar">
            <div class="zoom-controls">
                <UButton
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    :class="{ 'is-active': zoom === 'fit' }"
                    @click="handleZoomChange('fit')"
                >
                    Fit
                </UButton>
                <UButton
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    :class="{ 'is-active': zoom === '100%' }"
                    @click="handleZoomChange('100%')"
                >
                    100%
                </UButton>
            </div>
        </div>

        <div
            ref="canvasContainerRef"
            class="preview-canvas-container"
            :class="{
                'is-fit': zoom === 'fit',
                'is-actual': zoom === '100%',
            }"
        >
            <div v-if="isLoading" class="preview-loading">
                <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin" />
                <span class="loading-text">Loading preview...</span>
            </div>

            <div v-else-if="error" class="preview-error">
                <UIcon name="i-lucide-circle-alert" class="size-8 error-icon" />
                <span class="error-text">{{ error }}</span>
                <UButton
                    size="sm"
                    variant="soft"
                    color="neutral"
                    @click="handleRetry"
                >
                    <UIcon name="i-lucide-refresh-cw" class="size-4" />
                    Retry
                </UButton>
            </div>

            <div v-else-if="!pageImageUrl" class="preview-empty">
                <UIcon name="i-lucide-file" class="size-10 empty-icon" />
                <span class="empty-text">No page selected</span>
            </div>

            <div v-else class="preview-image-wrapper">
                <img
                    ref="imageRef"
                    :src="pageImageUrl"
                    class="preview-image"
                    alt="Page preview"
                    @load="handleImageLoad"
                    @error="handleImageError"
                >
                <div class="preview-overlay">
                    <slot name="overlay" />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    ref,
    watch,
} from 'vue';

type TZoomLevel = 'fit' | '100%';

interface IProps {
    pageImageUrl?: string;
    isLoading?: boolean;
    error?: string | null;
    zoom?: TZoomLevel;
}

const {
    pageImageUrl = '',
    isLoading = false,
    error = null,
    zoom = 'fit',
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:zoom', value: TZoomLevel): void;
    (e: 'retry'): void;
    (e: 'imageLoaded', dimensions: {
        width: number;
        height: number 
    }): void;
}>();

const canvasContainerRef = ref<HTMLElement | null>(null);
const imageRef = ref<HTMLImageElement | null>(null);
const imageLoaded = ref(false);

function handleZoomChange(level: TZoomLevel) {
    emit('update:zoom', level);
}

function handleRetry() {
    emit('retry');
}

function handleImageLoad() {
    imageLoaded.value = true;

    if (imageRef.value) {
        emit('imageLoaded', {
            width: imageRef.value.naturalWidth,
            height: imageRef.value.naturalHeight,
        });
    }
}

function handleImageError() {
    imageLoaded.value = false;
}

watch(() => pageImageUrl, () => {
    imageLoaded.value = false;
});
</script>

<style scoped>
.page-preview {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
}

.preview-toolbar {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
    background-color: var(--ui-bg);
    border-bottom: 1px solid var(--ui-border);
    flex-shrink: 0;
}

.zoom-controls {
    display: flex;
    gap: 4px;
    padding: 2px;
    background-color: var(--ui-bg-muted);
    border-radius: 6px;
}

.zoom-controls .is-active {
    background-color: var(--ui-bg);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.preview-canvas-container {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 16px;
}

.preview-canvas-container.is-fit {
    overflow: hidden;
}

.preview-canvas-container.is-actual {
    overflow: auto;
}

.preview-loading,
.preview-error,
.preview-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--ui-text-muted);
}

.loading-text,
.error-text,
.empty-text {
    font-size: 0.875rem;
}

.error-icon {
    color: var(--ui-error);
}

.empty-icon {
    opacity: 0.5;
}

.preview-image-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
}

.is-fit .preview-image-wrapper {
    max-width: 100%;
    max-height: 100%;
}

.is-actual .preview-image-wrapper {
    width: max-content;
    height: max-content;
}

.preview-image {
    display: block;
    background-color: var(--ui-bg);
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    border-radius: 4px;
}

.is-fit .preview-image {
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
}

.is-actual .preview-image {
    max-width: none;
    max-height: none;
}

.preview-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
}

.preview-overlay > :deep(*) {
    pointer-events: auto;
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
</style>
