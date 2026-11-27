<template>
    <div
        class="document-viewer-chassis"
        :data-open-surface-presentation="chassisAuthority.openSurface.snapshot.value.presentation"
        :data-open-surface-generation="chassisAuthority.openSurface.snapshot.value.generation"
        :data-open-surface-document-id="chassisAuthority.openSurface.snapshot.value.identity?.documentId ?? ''"
        :data-open-surface-document-revision="chassisAuthority.openSurface.snapshot.value.identity?.documentRevision ?? ''"
        :data-open-surface-has-opening-geometry="chassisAuthority.openSurface.snapshot.value.openingPageGeometry !== null"
        :data-open-surface-has-opening-frame="chassisAuthority.openSurface.snapshot.value.openingPageFrame !== null"
        :data-open-surface-opening-frame-page="chassisAuthority.openSurface.snapshot.value.openingPageFrame?.pageNumber ?? ''"
        :data-open-surface-opening-frame-owner="chassisAuthority.openSurface.snapshot.value.openingPageFrame?.ownerId ?? ''"
        :data-open-surface-has-geometry="chassisAuthority.openSurface.snapshot.value.geometry !== null"
        :data-open-surface-has-render="chassisAuthority.openSurface.snapshot.value.committedRender !== null"
        :data-open-surface-has-viewport="chassisAuthority.openSurface.snapshot.value.committedViewport !== null"
        :data-viewport-requested-page="chassisAuthority.openSurface.viewportSession.value.requestedPage"
        :data-viewport-committed-page="chassisAuthority.openSurface.viewportSession.value.committedPage ?? ''"
        :data-viewport-observed-page="chassisAuthority.openSurface.viewportSession.value.observedPage ?? ''"
        :data-viewport-lifecycle="chassisAuthority.openSurface.viewportSession.value.lifecycle"
        :data-viewport-staged-render-page="chassisAuthority.openSurface.viewportSession.value.stagedRenderFence?.pageNumber ?? ''"
        :data-viewport-staged-viewport-page="chassisAuthority.openSurface.viewportSession.value.stagedViewportFence?.pageNumber ?? ''"
        :data-viewport-visual-kind="chassisAuthority.openSurface.viewportSession.value.visual.kind"
        :data-viewport-visual-page="
            chassisAuthority.openSurface.viewportSession.value.visual.kind === 'page'
                ? chassisAuthority.openSurface.viewportSession.value.visual.pageNumber
                : ''
        "
        :data-viewport-visual-presentation="
            chassisAuthority.openSurface.viewportSession.value.visual.kind === 'page'
                ? chassisAuthority.openSurface.viewportSession.value.visual.presentation
                : ''
        "
        :data-chassis-current-page="chassisAuthority.currentPage.value"
        :data-chassis-resizing="isResizing === true"
        :aria-busy="isOpening ? 'true' : undefined"
        :class="{'document-viewer-chassis--fling-backdrop': hasViewportFlingBackdrop}"
    >
        <DocumentViewerFlingBackdrop v-if="hasViewportFlingBackdrop" />
        <DocumentViewportHost
            :viewport-id="viewportId"
            :set-viewport="chassisAuthority.bindViewportElement"
            :opening-page-shell="openingPageFrameAuthority.shell.value"
            :opening-page-visual="chassisAuthority.openingPageVisual.value"
            :set-opening-page="chassisAuthority.bindOpeningPageElement"
            :class="chassisAuthority.viewportClass.value"
            :style="chassisViewportStyle"
            :data-open-surface-phase="chassisAuthority.openSurface.snapshot.value.phase"
            @scroll="chassisAuthority.dispatchViewportEvent('scroll', $event)"
            @wheel="handleViewportWheel"
            @mousedown="handleViewportInteraction('mousedown', $event)"
            @mousemove="chassisAuthority.dispatchViewportEvent('mousemove', $event)"
            @mouseup="chassisAuthority.dispatchViewportEvent('mouseup', $event)"
            @mouseleave="chassisAuthority.dispatchViewportEvent('mouseleave')"
            @click="chassisAuthority.dispatchViewportEvent('click', $event)"
            @dblclick="chassisAuthority.dispatchViewportEvent('dblclick', $event)"
            @contextmenu="chassisAuthority.dispatchViewportEvent('contextmenu', $event)"
            @selectstart="chassisAuthority.dispatchViewportEvent('selectstart', $event)"
        >
            <component
                :is="activeFeaturePack"
                ref="activeFeaturePackRef"
                v-bind="attrs"
                :mount-presentation="mountPresentation"
                :is-resizing="isResizing"
                @update:total-pages="handleTotalPagesUpdate"
            />
        </DocumentViewportHost>
    </div>
</template>

<script setup lang="ts">
import type {Component} from 'vue';
import {useResizeObserver} from '@vueuse/core';
import {DETACHED_ZOOM_ACCESS, getZoomMode, type IZoomStateAccess, type TPdfViewRotation} from '@contracts/shared';
import {getHostCapability} from '@app/utils/getHostCapability';
import {createDocumentViewerExposeForwarder} from '@app/modules/workspace-shell/viewers/createDocumentViewerExposeForwarder';
import {
    createDocumentViewerRuntime,
    documentViewerRuntimeKey,
    DocumentViewportHost,
    injectDocumentOpenSurfaceSession,
    isDocumentOpenEmptySurfaceTransition,
    resolveDocumentOpenSurfaceViewportPolicy,
    createDocumentOpeningPageFrame,
    observeDocumentViewportWheelInteraction,
} from '@app/modules/document-viewer/public';
import type {TDocumentPageSourceKind, IDocumentWheelInteraction} from '@app/modules/document-viewer/public';
import {workspaceViewerFeatureChunkLoaders} from '@app/modules/workspace-shell/viewers/workspaceViewerFeatureChunkLoaders';
import DocumentViewerFlingBackdrop from '@app/modules/workspace-shell/components/DocumentViewerFlingBackdrop.vue';
import {createPdfPageNavigationRequest} from '@app/modules/pdf-viewer/public';
import type {IScrollToPageOptions} from '@app/modules/pdf-viewer/public';

defineOptions({inheritAttrs: false});

type TDocumentViewerRendererKind = 'pdfjs' | 'page-source';

const {
    sourceKind,
    rendererKind = 'pdfjs',
    mountPresentation,
    isResizing,
} = defineProps<{
    sourceKind: TDocumentPageSourceKind;
    rendererKind?: TDocumentViewerRendererKind;
    mountPresentation?: boolean;
    isResizing?: boolean;
}>();
const sourceKindRef = computed(() => sourceKind);
const attrs = useAttrs();

const PdfFeaturePack = defineAsyncComponent(() =>
    workspaceViewerFeatureChunkLoaders.pdfjs().then((componentModule) => componentModule.PdfViewer),
) as Component;
const DocumentPageSourceFeaturePack = defineAsyncComponent(() =>
    workspaceViewerFeatureChunkLoaders['page-source']().then((componentModule) => componentModule.default),
) as Component;
const featurePacks: Record<TDocumentViewerRendererKind, Component> = {
    pdfjs: PdfFeaturePack,
    'page-source': DocumentPageSourceFeaturePack,
};
const viewportIds: Record<TDocumentViewerRendererKind, string | undefined> = {
    pdfjs: 'pdf-viewer',
    'page-source': undefined,
};
const activeFeaturePackRef = shallowRef<Record<PropertyKey, unknown> | null>(null);
const viewportId = computed(() => viewportIds[rendererKind]);
const activeFeaturePack = computed(() => featurePacks[rendererKind]);
const openingFrameLayoutRevision = ref(0);
const documentOpenSurface = injectDocumentOpenSurfaceSession();
if (!documentOpenSurface) {
    throw new Error('DocumentViewerChassis requires the host-owned document open surface session');
}
const chassisAuthority = createDocumentViewerRuntime(sourceKindRef, documentOpenSurface);
function handleViewportWheel(interaction: IDocumentWheelInteraction) {
    // Physical scrolling must fence pending authored restores before the
    // browser mutates scrollTop. The inertial tail of a gesture that a newer
    // command superseded is not physical input and reaches no renderer.
    const owner = observeDocumentViewportWheelInteraction(
        chassisAuthority.viewportWritePort,
        interaction,
        chassisAuthority.viewportElement.value ?? undefined,
    );
    if (owner === 'command-residue') {
        return;
    }
    if (interaction.intent === 'zoom' && openingPageFrameAuthority.shell.value) {
        interaction.event.preventDefault();
        openingPageFrameAuthority.zoomOpeningShell(interaction);
        return;
    }
    chassisAuthority.dispatchViewportWheel(interaction);
}

function handleViewportInteraction(type: 'mousedown', event: Event) {
    chassisAuthority.viewportWritePort.observeUserInteraction(chassisAuthority.viewportElement.value ?? undefined);
    chassisAuthority.dispatchViewportEvent(type, event);
}
function readStringAttr<T extends string>(name: string, values: readonly T[], fallback: T) {
    const value = attrs[name];
    return typeof value === 'string' && values.includes(value as T) ? (value as T) : fallback;
}
// The view's zoom owner, passed through to the feature pack as it is.
const readZoom = () => (attrs.zoom as IZoomStateAccess | undefined) ?? DETACHED_ZOOM_ACCESS;
function readZoomPolicy() {
    const {state} = readZoom();
    return {
        fitMode: state.kind === 'fit' ? state.axis : ('width' as const),
        zoom: state.kind === 'custom' ? state.scale : 1,
        zoomMode: getZoomMode(state),
    };
}
function readOpeningViewportSize() {
    const viewport = chassisAuthority.viewportElement.value;
    const viewportWidth = viewport?.clientWidth ?? 0;
    const viewportHeight = viewport?.clientHeight ?? 0;
    if (viewportWidth > 0 && viewportHeight > 0) {
        return {
            width: viewportWidth,
            height: viewportHeight,
        };
    }
    const visibleHost = viewport?.closest<HTMLElement>('.workspace-viewer-host');
    const hostRect = visibleHost?.getBoundingClientRect();
    return {
        width: hostRect?.width ?? 0,
        height: hostRect?.height ?? 0,
    };
}
const openingPageFrameAuthority = createDocumentOpeningPageFrame({
    instanceId: chassisAuthority.instanceId,
    openSurface: documentOpenSurface,
    readLayoutRevision: () => openingFrameLayoutRevision.value,
    readPolicy: () => ({
        ...readZoomPolicy(),
        viewMode: readStringAttr('viewMode', ['single', 'facing', 'facing-first-single'] as const, 'single'),
        continuousScroll: attrs.continuousScroll !== false,
        viewRotation: attrs.viewRotation as TPdfViewRotation | undefined,
    }),
    readViewportSize: readOpeningViewportSize,
    readViewport: () => chassisAuthority.viewportElement.value,
    readZoom,
});
const openingFrameResizeTargets = computed(() => {
    const viewport = chassisAuthority.viewportElement.value;
    if (!viewport) {
        return [];
    }
    const layoutHost = viewport.closest<HTMLElement>('.workspace-viewer-host');
    return layoutHost ? [viewport, layoutHost] : [viewport];
});
useResizeObserver(openingFrameResizeTargets, () => {
    openingFrameLayoutRevision.value += 1;
});
watch(
    () => chassisAuthority.viewportElement.value,
    (viewport) => {
        if (!viewport || typeof ResizeObserver === 'undefined') {
            openingFrameLayoutRevision.value += 1;
        }
    },
    {
        flush: 'post',
        immediate: true,
    },
);
// The host knows when a wheel scroll sequence is live. Without it the write
// port infers that from packet timing, which a busy main thread distorts.
const unsubscribeWheelScrollSequenceChange = getHostCapability().onWheelScrollSequenceChange((boundary) => {
    chassisAuthority.viewportWritePort.observeWheelScrollSequence(boundary);
});
onBeforeUnmount(() => {
    // The view is gone. A pane relocation moves it under Teleport instead.
    chassisAuthority.viewportWritePort.retire();
    unsubscribeWheelScrollSequenceChange();
});
const isOpening = computed(() => isDocumentOpenEmptySurfaceTransition(chassisAuthority.openSurface.snapshot.value));

watch(
    [
        () => chassisAuthority.openSurface.snapshot.value.generation,
        () => chassisAuthority.openSurface.snapshot.value.identity?.documentId ?? '',
        () => chassisAuthority.openSurface.snapshot.value.phase,
        () => chassisAuthority.openSurface.snapshot.value.openingPageGeometry,
        () => chassisAuthority.openSurface.navigationTicket.value,
        () => readZoom().state,
        () => attrs.viewMode,
        () => attrs.viewRotation,
        () => attrs.continuousScroll,
        () => rendererKind,
        // Frame preparation needs a measurable viewport. When geometry is already
        // known before this chassis lays out, the first attempt has nothing to
        // measure, so the layout revision is the retry signal that lands the frame.
        () => openingFrameLayoutRevision.value,
    ],
    ([generation]) => {
        openingPageFrameAuthority.prepareOpeningPageFrame(generation);
    },
    {
        flush: 'sync',
        immediate: true,
    },
);
const chassisViewportStyle = computed(() => {
    const policy = resolveDocumentOpenSurfaceViewportPolicy(chassisAuthority.openSurface.snapshot.value);
    return [
        chassisAuthority.viewportStyle.value,
        {
            // The opening shell may suppress scrolling, but once ready the
            // renderer owns axis overflow (including fit-width scrollbar lock).
            // Residue of a superseded wheel gesture must not move the viewport.
            // The stable gutter keeps this from changing the layout width.
            overflow: policy.overflow === 'hidden' || chassisAuthority.viewportWritePort.userScrollSuppressed.value ? 'hidden' : undefined,
            scrollbarGutter: policy.scrollbarGutter,
            '--document-open-surface-margin': policy.committedMargin === null ? undefined : `${String(policy.committedMargin)}px`,
        },
    ];
});
provide(documentViewerRuntimeKey, chassisAuthority);
// The backdrop's row geometry follows every zoom and pane resize; the chassis
// reads only whether there is one, and the backdrop reads the rest itself.
const hasViewportFlingBackdrop = computed(() => chassisAuthority.viewportFlingBackdrop.value !== null);

function handleTotalPagesUpdate(pageCount: number) {
    chassisAuthority.pageCount.value = Math.max(0, Math.trunc(pageCount));
    if (chassisAuthority.pageCount.value > 0) {
        chassisAuthority.openSurface.metadataReady(chassisAuthority.pageCount.value);
    }
}

// Navigation belongs to the stable chassis, so commands remain durable while
// the async feature pack is absent or swapping. When a renderer is mounted it
// must also project that request into the viewport; recording the requested
// page alone does not create or commit a scroll intent. The shell reads the
// source feature packs bind here, and their page count, live.
defineExpose(
    createDocumentViewerExposeForwarder(activeFeaturePackRef, {
        getPageSource: () => chassisAuthority.source.value,
        getPageCount: () => chassisAuthority.pageCount.value,
        getCurrentPage: () => chassisAuthority.currentPage.value,
        getReaderInteractionEpoch: () => chassisAuthority.viewportWritePort.getInteractionEpoch(),
        observeReaderCommand: () =>
            chassisAuthority.viewportWritePort.observeUserInteraction(chassisAuthority.viewportElement.value ?? undefined),
        scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => {
            const request = createPdfPageNavigationRequest(pageNumber, options);
            chassisAuthority.navigate(request);
        },
    }),
);
</script>

<style scoped>
.document-viewer-chassis {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
}

[data-document-viewer-chassis-viewport] {
    position: relative;
    display: block;
    box-sizing: border-box;
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    gap: 0;
    background: var(--app-document-viewer-bg);

    /* A scroll container from the start, as every renderer's viewport is, so
       its stable gutter is reserved before a renderer binds. An open that
       knows its page's shape sizes the opening skeleton from this width in the
       claim, before a new tab's renderer exists. */
    overflow: auto;

    /* The viewport authority is the only owner of document position. Chromium's
       scroll anchoring must not move the track while an async feature pack
       replaces provisional geometry with its live page layout. */
    overflow-anchor: none;
}

/* The fling backdrop paints the viewer background and the page shells behind
   the viewport, so tiles the compositor has not rasterized yet stay
   transparent instead of drawing the viewport's own background. */
.document-viewer-chassis--fling-backdrop > [data-document-viewer-chassis-viewport] {
    background: transparent;
}
</style>
