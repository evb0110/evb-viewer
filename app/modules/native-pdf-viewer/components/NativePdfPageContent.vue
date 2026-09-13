<template>
    <div
        v-if="pageState?.objectUrl"
        class="native-pdf-page-content"
        :class="{'document-page-visual--committed': visualCommitted}"
    >
        <img
            :src="pageState.objectUrl"
            :alt="t('common.pdfPage', {page: pageNumber})"
            class="native-pdf-page-image"
            decoding="async"
            draggable="false"
            @load="handleImageLoad(pageState.objectUrl)"
            @error="handleImageError(pageState.objectUrl)"
        >
    </div>
    <div
        v-if="pageState?.status === 'error'"
        class="native-pdf-page-placeholder"
    >
        <UIcon
            name="i-ph-warning-circle"
            class="size-5 text-muted"
        />
        <span class="text-sm text-muted">
            {{ t('common.pageRenderFailed') }}
        </span>
        <UButton
            size="xs"
            variant="soft"
            color="neutral"
            :label="t('common.retry')"
            @click="emit('retry')"
        />
    </div>
    <div
        v-else-if="!visualCommitted && showSkeleton"
        aria-hidden="true"
    >
        <DocumentPageSkeleton
            :content-height="skeletonContentHeight"
        />
    </div>
    <div
        v-else-if="!visualCommitted"
        class="native-pdf-page-pending-frame"
        aria-hidden="true"
    />
    <div
        v-if="showPageNumber"
        class="native-pdf-page-number"
    >
        {{ pageNumber }}
    </div>
</template>

<script setup lang="ts">
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import type { IDocumentPreviewPageState } from '@app/modules/document-viewer/public';

const props = defineProps<{
    pageNumber: number;
    pageState: IDocumentPreviewPageState | undefined;
    skeletonContentHeight?: number | null;
    showSkeleton?: boolean;
    visualCommitted?: boolean;
}>();

const emit = defineEmits<{
    retry: [];
    'visual-ready': [payload: {
        objectUrl: string;
        pageNumber: number;
    }];
    'visual-error': [payload: {
        objectUrl: string;
        pageNumber: number;
    }];
}>();

const { t } = useTypedI18n();

const skeletonContentHeight = computed(() => props.skeletonContentHeight ?? 760);
const showPageNumber = computed(() => (
    props.visualCommitted === true
    || props.pageState?.status === 'error'
));

async function emitVisualReadyAfterPaint(objectUrl: string) {
    await waitForVisualFrames({ frames: 2 });
    if (
        props.pageState?.objectUrl !== objectUrl
    ) {
        return;
    }

    emit('visual-ready', {
        objectUrl,
        pageNumber: props.pageNumber,
    });
}

function handleImageLoad(objectUrl: string | null) {
    if (!objectUrl) {
        return;
    }
    void emitVisualReadyAfterPaint(objectUrl);
}

function handleImageError(objectUrl: string | null) {
    if (!objectUrl || props.pageState?.objectUrl !== objectUrl) {
        return;
    }
    emit('visual-error', {
        objectUrl,
        pageNumber: props.pageNumber,
    });
}

</script>

<style scoped>
.native-pdf-page-content {
    position: relative;
    width: 100%;
    height: 100%;
    visibility: hidden;
    background: var(--ui-bg);
}

.native-pdf-page-content.document-page-visual--committed {
    visibility: visible;
}

.native-pdf-page-image {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    user-select: none;
    object-fit: contain;
}

.native-pdf-page-placeholder {
    display: flex;
    height: 100%;
    width: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--app-native-pdf-placeholder-gap);
    background: color-mix(in oklab, var(--ui-bg) 92%, var(--ui-bg-muted) 8%);
}

.native-pdf-page-pending-frame {
    position: absolute;
    inset: 0;
    background: var(--ui-bg);
}

.native-pdf-page-number {
    position: absolute;
    right: var(--app-native-pdf-page-number-offset);
    bottom: var(--app-native-pdf-page-number-offset);
    border-radius: var(--app-radius-full);
    background: color-mix(in oklab, var(--ui-bg-elevated) 88%, transparent);
    padding: var(--app-native-pdf-page-number-padding);
    font-size: var(--app-native-pdf-page-number-font-size);
    color: var(--ui-text-muted);
    backdrop-filter: blur(var(--app-backdrop-blur-sm));
}

:global(html.app-low-graphics) .native-pdf-page-number {
    backdrop-filter: none;
}

</style>
