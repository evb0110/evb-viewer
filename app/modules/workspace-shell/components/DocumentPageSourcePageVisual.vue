<template>
    <div
        v-if="visual === 'none'"
        class="document-source-viewer__pending-frame"
        data-document-page-visual="pending"
    />
    <div
        v-if="(visual === 'skeleton' || !surface) && visual !== 'error'"
        class="document-source-viewer__skeleton"
        data-document-page-visual="skeleton"
        aria-hidden="true"
    >
        <DocumentPageSkeleton
            :content-height="contentHeight"
        />
    </div>
    <div
        v-if="visual === 'error'"
        class="document-source-viewer__error"
        data-document-page-visual="error"
        role="alert"
    >
        {{ errorPresentation ? formatFailurePresentationDescription(errorPresentation) : errorMessage }}
    </div>
    <img
        v-if="surface"
        :key="surface"
        :src="surface"
        class="document-source-viewer__image"
        :class="{'document-page-visual--committed': visual === 'fresh'}"
        alt=""
        draggable="false"
        data-testid="document-page-source-image"
        :data-document-page-visual="visual === 'fresh' ? 'committed' : 'pending'"
        :data-page-render-generation="renderGeneration"
        :data-document-load-generation="documentLoadGeneration"
        :data-open-surface-generation="openSurfaceGeneration ?? ''"
        @load="emit('surfaceLoad', surface, $event)"
        @error="emit('surfaceError', surface, $event)"
    >
    <DocumentPageSourceSearchLayer
        v-if="visual === 'fresh'"
        :page-number="pageNumber"
        :results="searchResults"
        :current-result-index="currentSearchResultIndex"
    />
</template>

<script setup lang="ts">
import {
    formatFailurePresentationDescription,
    type FailurePresentation,
} from '@app/composables/useFailureToast';
import type { IDocumentSearchMatch } from '@app/utils/document-viewer/search/documentSearch';
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import DocumentPageSourceSearchLayer from '@app/modules/workspace-shell/components/DocumentPageSourceSearchLayer.vue';
import type { TDocumentPageSourceVisual } from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';

const {
    contentHeight,
    currentSearchResultIndex,
    documentLoadGeneration,
    errorMessage,
    errorPresentation = null,
    openSurfaceGeneration,
    pageNumber,
    renderGeneration,
    searchResults,
    surface,
    visual,
} = defineProps<{
    contentHeight: number;
    currentSearchResultIndex: number;
    documentLoadGeneration: number;
    errorMessage: string;
    errorPresentation?: FailurePresentation | null;
    hostOwnsSkeleton?: boolean;
    openSurfaceGeneration: number | null;
    pageNumber: number;
    renderGeneration: number | '';
    searchResults: readonly IDocumentSearchMatch[];
    surface: string | null;
    visual: TDocumentPageSourceVisual;
}>();

const emit = defineEmits<{
    surfaceLoad: [surface: string, event: Event];
    surfaceError: [surface: string, event: Event];
}>();
</script>

<style scoped>
.document-source-viewer__image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
    visibility: hidden;
}

.document-source-viewer__image.document-page-visual--committed {
    visibility: visible;
}

.document-source-viewer__pending-frame,
.document-source-viewer__skeleton,
.document-source-viewer__error {
    position: absolute;
    inset: 0;
    background: var(--app-document-page-bg);
    border-radius: inherit;
}

.document-source-viewer__pending-frame {
    z-index: var(--app-z-local-overlay);
}

.document-source-viewer__skeleton {
    box-shadow: none;
}

.document-source-viewer__error {
    z-index: var(--app-z-local-overlay);
    display: grid;
    place-items: center;
    padding: var(--app-document-page-error-padding);
    color: var(--ui-error);
    text-align: center;
}
</style>
