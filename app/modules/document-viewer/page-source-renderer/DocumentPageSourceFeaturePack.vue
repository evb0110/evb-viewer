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
                    :class="{
                        'document-source-viewer__page--hidden': pagePaintMode === 'hidden',
                        'document-source-viewer__page--shell-owned': pagePaintMode === 'shell-owned',
                    }"
                    :style="runtime.getPageStyle(pageNumber)"
                    :data-page-number="pageNumber"
                    :data-document-page-number="pageNumber"
                    :data-page-source-visual="runtime.presentation.getVisual(pageNumber)"
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
    DETACHED_ZOOM_ACCESS,
    getZoomMode,
} from '@contracts/shared';
import DocumentPageSourcePageVisual from '@app/modules/document-viewer/page-source-renderer/DocumentPageSourcePageVisual.vue';
import type {
    IDocumentPageSourceFeaturePackEmit,
    IDocumentPageSourceFeaturePackProps,
} from '@app/modules/document-viewer/page-source-renderer/documentPageSourceFeaturePackState';
import { useDocumentPageSourceRuntime } from '@app/modules/document-viewer/page-source-renderer/useDocumentPageSourceRuntime';
import { isDocumentOpenEmptySurfaceTransition } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import { injectDocumentViewerRuntime } from '@app/modules/document-viewer/runtime/documentViewerRuntime';

defineOptions({inheritAttrs: false});
const {
    continuousScroll = true,
    currentSearchResultIndex = -1,
    documentRevisionToken = null,
    isActive = true,
    isInteractionActive = undefined,
    isResizing = false,
    searchResults = [],
    src,
    viewMode = 'single',
    zoom = DETACHED_ZOOM_ACCESS,
} = defineProps<IDocumentPageSourceFeaturePackProps>();
const emit = defineEmits<IDocumentPageSourceFeaturePackEmit>();
const runtime = reactive(useDocumentPageSourceRuntime({
    emit,
    readProps: () => ({
        continuousScroll,
        documentRevisionToken,
        isActive,
        isInteractionActive: isInteractionActive ?? isActive,
        isResizing,
        src,
        viewMode,
        zoom: zoom.state.kind === 'custom' ? zoom.state.scale : 1,
        zoomMode: getZoomMode(zoom.state),
    }),
    readZoom: () => zoom,
}));
const viewerRuntime = injectDocumentViewerRuntime();
const pagePaintMode = computed<'normal' | 'hidden' | 'shell-owned'>(() => {
    const snapshot = viewerRuntime?.openSurface.snapshot.value;
    if (!snapshot) {
        return 'normal';
    }
    if (isDocumentOpenEmptySurfaceTransition(snapshot) && snapshot.presentation === 'idle') {
        return 'hidden';
    }
    return snapshot.presentation === 'page-shell' ? 'shell-owned' : 'normal';
});
function shouldDeferSkeleton(pageNumber: number) {
    const visual = viewerRuntime?.openSurface.viewportSession.value.visual;
    return visual?.kind === 'page'
        && visual.pageNumber === pageNumber
        && visual.presentation === 'skeleton'
        && visual.deferSkeleton === true;
}
function getPageVisualProps(pageNumber: number, hostOwnsSkeleton = false) {
    return {
        contentHeight: runtime.pageLayouts[pageNumber - 1]?.height ?? 760,
        currentSearchResultIndex,
        deferSkeleton: shouldDeferSkeleton(pageNumber),
        documentLoadGeneration: runtime.loadGeneration,
        errorMessage: runtime.presentation.getVisualError(pageNumber),
        errorPresentation: runtime.presentation.getVisualFailurePresentation(pageNumber),
        hostOwnsSkeleton,
        onRetry: () => runtime.presentation.retryPage(pageNumber),
        onSurfaceError: (surface: string, event: Event) => runtime.presentation.handleSurfaceError(pageNumber, surface, event),
        onSurfaceLoad: (surface: string, event: Event) => runtime.presentation.handleSurfaceLoad(pageNumber, surface, event),
        openSurfaceGeneration: runtime.activeOpenSurfaceGeneration,
        pageNumber,
        renderGeneration: runtime.presentation.getRenderGeneration(pageNumber),
        searchResults,
        surface: runtime.presentation.getSurface(pageNumber),
        visual: runtime.presentation.getVisual(pageNumber),
    };
}

defineExpose(runtime.viewerExpose);
</script>

<style scoped src="./DocumentPageSourceFeaturePack.css"></style>
