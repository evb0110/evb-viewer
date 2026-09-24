<template>
    <div
        class="document-source-feature-pack"
        data-document-feature-pack="page-source"
        data-testid="document-page-source-viewer"
    >
        <div
            class="document-source-viewer__surface"
            :style="runtime.surfaceStyle"
        >
            <template
                v-for="pageNumber in runtime.mountedPages"
                :key="pageNumber"
            >
                <Teleport
                    v-if="runtime.getChassisOpeningShellTarget(pageNumber)"
                    :to="runtime.getChassisOpeningShellTarget(pageNumber)!"
                >
                    <DocumentPageSourcePageVisual
                        v-bind="getPageVisualProps(pageNumber, true)"
                    />
                </Teleport>
                <section
                    v-else
                    :ref="element => runtime.setPageElement(pageNumber, element)"
                    class="document-source-viewer__page"
                    :style="runtime.getPageStyle(pageNumber)"
                    :data-page-number="pageNumber"
                    :data-document-page-number="pageNumber"
                    :data-page-source-visual="runtime.getVisual(pageNumber)"
                    data-testid="document-page-source-page"
                >
                    <DocumentPageSourcePageVisual
                        v-bind="getPageVisualProps(pageNumber)"
                    />
                </section>
            </template>
        </div>
    </div>
</template>
<script setup lang="ts">
import {
    FIT_WIDTH_ZOOM_STATE,
    getZoomMode,
} from '@contracts/shared';
import DocumentPageSourcePageVisual from '@app/modules/workspace-shell/components/DocumentPageSourcePageVisual.vue';
import type {
    IDocumentPageSourceFeaturePackEmit,
    IDocumentPageSourceFeaturePackProps,
} from '@app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState';
import { useDocumentPageSourceRuntime } from '@app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';

defineOptions({inheritAttrs: false});
const {
    continuousScroll = true,
    currentPage = 1,
    currentSearchResultIndex = -1,
    documentRevisionToken = null,
    isActive = true,
    isInteractionActive = undefined,
    isResizing = false,
    searchResults = [],
    src,
    viewMode = 'single',
    zoomState = FIT_WIDTH_ZOOM_STATE,
} = defineProps<IDocumentPageSourceFeaturePackProps>();
const emit = defineEmits<IDocumentPageSourceFeaturePackEmit>();
const runtime = reactive(useDocumentPageSourceRuntime({
    emit,
    readProps: () => ({
        continuousScroll,
        currentPage,
        documentRevisionToken,
        isActive,
        isInteractionActive: isInteractionActive ?? isActive,
        isResizing,
        src,
        viewMode,
        zoom: zoomState.kind === 'custom' ? zoomState.scale : 1,
        zoomMode: getZoomMode(zoomState),
    }),
}));
function getPageVisualProps(pageNumber: number, hostOwnsSkeleton = false) {
    return {
        contentHeight: runtime.pageLayouts[pageNumber - 1]?.height ?? 760,
        currentSearchResultIndex,
        documentLoadGeneration: runtime.loadGeneration,
        errorMessage: runtime.getVisualError(pageNumber),
        errorPresentation: runtime.getVisualFailurePresentation(pageNumber),
        hostOwnsSkeleton,
        onSurfaceError: (surface: string, event: Event) => runtime.handleSurfaceError(pageNumber, surface, event),
        onSurfaceLoad: (surface: string, event: Event) => runtime.handleSurfaceLoad(pageNumber, surface, event),
        openSurfaceGeneration: runtime.activeOpenSurfaceGeneration,
        pageNumber,
        renderGeneration: runtime.getRenderGeneration(pageNumber),
        searchResults,
        surface: runtime.getSurface(pageNumber),
        visual: runtime.getVisual(pageNumber),
    };
}

defineExpose<IDocumentViewerExpose & {
    captureScrollSnapshot: () => unknown;
    restoreScrollSnapshot: (snapshot: unknown, options: {fallbackPage: number}) => void;
}>(runtime.viewerExpose);
</script>

<style scoped src="./DocumentPageSourceFeaturePack.css"></style>
