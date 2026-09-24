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
        :data-viewport-visual-page="chassisAuthority.openSurface.viewportSession.value.visual.kind === 'page' ? chassisAuthority.openSurface.viewportSession.value.visual.pageNumber : ''"
        :data-viewport-visual-presentation="chassisAuthority.openSurface.viewportSession.value.visual.kind === 'page' ? chassisAuthority.openSurface.viewportSession.value.visual.presentation : ''"
        :data-chassis-current-page="chassisAuthority.currentPage.value"
        :data-chassis-resize-anchor-page="retainedResizeAnchor?.pageNumber ?? ''"
        :data-chassis-resizing="props.isResizing === true"
        :class="{'document-viewer-chassis--fling-backdrop': chassisAuthority.viewportFlingBackdrop.value !== null}"
    >
        <DocumentViewerFlingBackdrop
            v-if="chassisAuthority.viewportFlingBackdrop.value"
            :backdrop="chassisAuthority.viewportFlingBackdrop.value"
            :viewport="chassisAuthority.viewportElement.value"
        />
        <DocumentViewportHost
            :viewport-id="viewportId"
            :set-viewport="chassisAuthority.bindViewportElement"
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
            <div
                v-if="chassisOpeningPageShell && shouldShowChassisOpeningPageSkeleton"
                class="document-viewer-chassis__opening-layer"
            >
                <section
                    :id="chassisOpeningPageShell.id"
                    :ref="bindChassisOpeningPageElement"
                    class="document-viewer-chassis__opening-page"
                    :style="chassisOpeningPageShell.style"
                    :data-page-number="chassisOpeningPageShell.pageNumber"
                    :data-document-page-number="chassisOpeningPageShell.pageNumber"
                    :data-document-opening-shell-id="chassisOpeningPageShell.id"
                    :data-open-surface-generation="chassisOpeningPageShell.generation"
                    :data-open-surface-frame-owner="chassisOpeningPageShell.ownerId"
                    :data-page-source-visual="chassisAuthority.openingPageVisual.value"
                    data-testid="document-page-source-page"
                >
                    <DocumentPageSkeleton :content-height="chassisOpeningPageShell.height" />
                </section>
            </div>
            <component
                :is="activeFeaturePack"
                ref="activeFeaturePackRef"
                v-bind="$attrs"
                :current-page="chassisAuthority.currentPage.value"
                :mount-presentation="props.mountPresentation"
                :is-resizing="props.isResizing"
                @update:current-page="handleCurrentPageUpdate"
                @update:total-pages="handleTotalPagesUpdate"
            />
        </DocumentViewportHost>
    </div>
</template>

<script setup lang="ts">
import type {
    Component,
    ComponentPublicInstance,
} from 'vue';
import {
    FIT_WIDTH_ZOOM_STATE,
    getZoomMode,
    type TPdfZoomState,
} from '@contracts/shared';
import { getHostCapability } from '@app/utils/getHostCapability';
import { createDocumentViewerExposeForwarder } from '@app/modules/workspace-shell/viewers/createDocumentViewerExposeForwarder';
import {
    createDocumentViewerRuntime,
    documentViewerRuntimeKey,
    shouldAcceptFeaturePackRuntimePage,
    DocumentViewportHost ,
    injectDocumentOpenSurfaceSession,
    resolveDocumentOpenSurfaceViewportPolicy,
    createDocumentOpeningPageFrame,
    resolveDocumentOpeningPageMargin,
    resolveDocumentOpeningPageShellId, resolveDocumentPageSourceOpeningFrame , observeDocumentViewportWheelInteraction,
    captureDocumentViewportResizeAnchor,
    resolveDocumentViewportResizeAnchorPosition, 
} from '@app/modules/document-viewer/public';
import type {
    IDocumentPageSource,
    TDocumentPageSourceKind,
    IDocumentViewportResizeAnchor,
    IDocumentWheelInteraction,
} from '@app/modules/document-viewer/public';
import { workspaceViewerFeatureChunkLoaders } from '@app/modules/workspace-shell/viewers/workspaceViewerFeatureChunkLoaders';
import DocumentViewerFlingBackdrop from '@app/modules/workspace-shell/components/DocumentViewerFlingBackdrop.vue';
import { createPdfPageNavigationRequest } from '@app/modules/pdf-viewer/public';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import { shouldRestoreDocumentViewerHandoffSnapshot } from '@app/modules/workspace-shell/viewers/shouldRestoreDocumentViewerHandoffSnapshot';

defineOptions({ inheritAttrs: false });

type TDocumentViewerRendererKind = 'pdfjs' | 'page-source';

const props = defineProps<{
    sourceKind: TDocumentPageSourceKind;
    rendererKind?: TDocumentViewerRendererKind;
    currentPage?: number;
    mountPresentation?: boolean;
    isResizing?: boolean;
}>();
const emit = defineEmits<{
    'feature-pack-ready': [authority: ReturnType<typeof createDocumentOpeningPageFrame>];
    'update:current-page': [pageNumber: number];
    'update:pageSource': [source: IDocumentPageSource | null];
    'update:total-pages': [pageCount: number];
}>();
const sourceKind = toRef(props, 'sourceKind');
const attrs = useAttrs();

const PdfFeaturePack = defineAsyncComponent(
    () => workspaceViewerFeatureChunkLoaders.pdfjs()
        .then(componentModule => componentModule.PdfViewer),
) as Component;
const DocumentPageSourceFeaturePack = defineAsyncComponent(
    () => workspaceViewerFeatureChunkLoaders['page-source']()
        .then(componentModule => componentModule.default),
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
const rendererKind = computed<TDocumentViewerRendererKind>(() => (
    props.rendererKind ?? 'pdfjs'
));
const viewportId = computed(() => viewportIds[rendererKind.value]);
const activeFeaturePack = computed(() => featurePacks[rendererKind.value]);
const sourceViewerRef = computed(() => activeFeaturePackRef.value);
const openingFrameLayoutRevision = ref(0);
let openingFrameResizeObserver: ResizeObserver | null = null;
const retainedResizeAnchor = shallowRef<IDocumentViewportResizeAnchor | null>(null);
let retainedResizeAnchorFence: {
    generation: number;
    interactionEpoch: number;
} | null = null;
const RESIZE_ANCHOR_QUIET_MS = 120;
let resizeAnchorReleaseTimer: ReturnType<typeof setTimeout> | null = null;
const documentOpenSurface = injectDocumentOpenSurfaceSession();
if (!documentOpenSurface) {
    throw new Error('DocumentViewerChassis requires the host-owned document open surface session');
}
const chassisAuthority = createDocumentViewerRuntime(
    sourceKind,
    props.currentPage ?? 1,
    documentOpenSurface,
);
function applyRetainedResizeAnchor(reason: string) {
    const viewport = chassisAuthority.viewportElement.value;
    const anchor = retainedResizeAnchor.value;
    const fence = retainedResizeAnchorFence;
    const session = chassisAuthority.openSurface.viewportSession.value;
    if (
        !viewport
        || !anchor
    ) {
        return false;
    }
    if (
        !fence
        || session.lifecycle !== 'ready'
        || session.requestedPage !== session.committedPage
        || fence.generation !== session.generation
        || session.committedPage !== anchor.pageNumber
        || fence.interactionEpoch !== chassisAuthority.viewportWritePort.getInteractionEpoch()
    ) {
        releaseRetainedResizeAnchor();
        return false;
    }
    const position = resolveDocumentViewportResizeAnchorPosition(viewport, anchor);
    if (!position) {
        return false;
    }
    if (
        Math.abs(position.left - viewport.scrollLeft) < 0.5
        && Math.abs(position.top - viewport.scrollTop) < 0.5
    ) {
        return true;
    }
    const intent = chassisAuthority.viewportWritePort.beginIntent(
        `chassis-resize-anchor:${anchor.pageNumber}:${reason}`,
    );
    return chassisAuthority.viewportWritePort.apply(viewport, {
        intent,
        reason: 'chassis-resize-anchor',
        left: position.left,
        top: position.top,
    });
}

function releaseRetainedResizeAnchor() {
    if (resizeAnchorReleaseTimer !== null) {
        clearTimeout(resizeAnchorReleaseTimer);
        resizeAnchorReleaseTimer = null;
    }
    if (retainedResizeAnchor.value) {
        openingFrameResizeObserver?.unobserve(retainedResizeAnchor.value.element);
    }
    retainedResizeAnchor.value = null;
    retainedResizeAnchorFence = null;
}

function retainCurrentResizeAnchor() {
    // PDF.js owns semantic resize projection together with its virtual page
    // geometry. A second DOM anchor here races that projection and can restore
    // a different page between preview and raster commit.
    if (rendererKind.value === 'pdfjs') {
        return;
    }
    const viewport = chassisAuthority.viewportElement.value;
    if (!viewport) {
        return;
    }
    const session = chassisAuthority.openSurface.viewportSession.value;
    releaseRetainedResizeAnchor();
    retainedResizeAnchor.value = captureDocumentViewportResizeAnchor(viewport, {preferredPageNumber: session.committedPage ?? session.requestedPage});
    retainedResizeAnchorFence = retainedResizeAnchor.value ? {
        generation: session.generation,
        interactionEpoch: chassisAuthority.viewportWritePort.getInteractionEpoch(),
    } : null;
    if (retainedResizeAnchor.value) {
        openingFrameResizeObserver?.observe(retainedResizeAnchor.value.element);
    }
}

function scheduleResizeAnchorRelease() {
    if (!retainedResizeAnchor.value || props.isResizing === true) {
        return;
    }
    if (resizeAnchorReleaseTimer !== null) {
        clearTimeout(resizeAnchorReleaseTimer);
    }
    resizeAnchorReleaseTimer = setTimeout(() => {
        resizeAnchorReleaseTimer = null;
        applyRetainedResizeAnchor('quiet-settle');
        releaseRetainedResizeAnchor();
    }, RESIZE_ANCHOR_QUIET_MS);
}

function releaseResizeAnchorForViewportInteraction() {
    if (retainedResizeAnchor.value && props.isResizing !== true) {
        releaseRetainedResizeAnchor();
    }
}

function handleViewportWheel(interaction: IDocumentWheelInteraction) {
    releaseResizeAnchorForViewportInteraction();
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
    chassisAuthority.dispatchViewportWheel(interaction);
}

function handleViewportInteraction(type: 'mousedown', event: Event) {
    releaseResizeAnchorForViewportInteraction();
    chassisAuthority.viewportWritePort.observeUserInteraction(chassisAuthority.viewportElement.value ?? undefined);
    chassisAuthority.dispatchViewportEvent(type, event);
}
function readStringAttr<T extends string>(name: string, values: readonly T[], fallback: T) {
    const value = attrs[name];
    return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}
function readZoomPolicy() {
    const state = attrs.zoomState as TPdfZoomState | undefined ?? FIT_WIDTH_ZOOM_STATE;
    return {
        fitMode: state.kind === 'fit' ? state.axis : 'width' as const,
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
    openSurface: documentOpenSurface,
    readLayoutRevision: () => openingFrameLayoutRevision.value,
    readPolicy: () => ({
        ...readZoomPolicy(),
        viewMode: readStringAttr('viewMode', [
            'single',
            'facing',
            'facing-first-single',
        ] as const, 'single'),
        continuousScroll: attrs.continuousScroll !== false,
    }),
    readViewportSize: readOpeningViewportSize,
});
watch(
    () => chassisAuthority.viewportElement.value,
    (viewport) => {
        openingFrameResizeObserver?.disconnect();
        openingFrameResizeObserver = null;
        if (!viewport || typeof ResizeObserver === 'undefined') {
            openingFrameLayoutRevision.value += 1;
            return;
        }
        openingFrameResizeObserver = new ResizeObserver(() => {
            openingFrameLayoutRevision.value += 1;
            applyRetainedResizeAnchor('resize-observer');
            scheduleResizeAnchorRelease();
        });
        openingFrameResizeObserver.observe(viewport);
        const layoutHost = viewport.closest<HTMLElement>('.workspace-viewer-host');
        if (layoutHost) {
            openingFrameResizeObserver.observe(layoutHost);
        }
        if (retainedResizeAnchor.value) {
            openingFrameResizeObserver.observe(retainedResizeAnchor.value.element);
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
    unsubscribeWheelScrollSequenceChange();
    releaseRetainedResizeAnchor();
    openingFrameResizeObserver?.disconnect();
    openingFrameResizeObserver = null;
});
watch(
    () => props.isResizing === true,
    (isResizing, wasResizing) => {
        if (isResizing && !wasResizing) {
            retainCurrentResizeAnchor();
            return;
        }
        if (!isResizing && wasResizing && retainedResizeAnchor.value) {
            applyRetainedResizeAnchor('resize-end-sync');
            // Split removal changes the viewport and page track in Vue's next
            // patch. Reapply in that same microtask so the browser never paints
            // the track at its reset scroll origin before ResizeObserver runs.
            void nextTick(() => {
                if (!retainedResizeAnchor.value || props.isResizing === true) {
                    return;
                }
                applyRetainedResizeAnchor('resize-end-post-layout');
                scheduleResizeAnchorRelease();
            });
        }
    },
    {flush: 'sync'},
);
watch(
    () => chassisAuthority.openSurface.viewportSession.value.lifecycle,
    (lifecycle) => {
        if (lifecycle !== 'ready' && retainedResizeAnchor.value) {
            releaseRetainedResizeAnchor();
        }
    },
    {flush: 'sync'},
);
function bindChassisOpeningPageElement(element: Element | ComponentPublicInstance | null) {
    chassisAuthority.bindOpeningPageElement(element instanceof HTMLElement ? element : null);
}
const chassisOpeningPageShell = computed(() => {
    void openingFrameLayoutRevision.value;
    const snapshot = chassisAuthority.openSurface.snapshot.value;
    const frame = snapshot.openingPageFrame;
    const isPdf = rendererKind.value !== 'page-source';
    const isOpening = snapshot.phase === 'pending'
        || snapshot.phase === 'geometry-committed'
        || snapshot.phase === 'canvas-committed'
        || snapshot.phase === 'viewport-committed';
    if (!isOpening || frame?.generation !== undefined && frame.generation !== snapshot.generation) {
        return null;
    }
    const currentPage = chassisAuthority.currentPage.value;
    const hasStaleFrame = frame !== null && frame.pageNumber !== currentPage;
    const viewport = readOpeningViewportSize();
    const provisionalWidth = viewport.width > 40 ? viewport.width - 40 : 612;
    const provisionalStyle = {
        width: `${String(provisionalWidth)}px`,
        height: `${String(provisionalWidth * (792 / 612))}px`,
    };
    const geometry = snapshot.openingPageGeometry;
    const {
        zoom,
        zoomMode,
    } = readZoomPolicy();
    const policy = {
        zoom,
        zoomMode,
    };
    const liveFrame = !isPdf && geometry !== null ? resolveDocumentPageSourceOpeningFrame({
        geometry,
        viewportWidth: readOpeningViewportSize().width,
        viewportHeight: readOpeningViewportSize().height,
        ...policy,
    }) : null;
    // A queued navigation can supersede the page-1 opening frame while the
    // viewport is still opening. Keep one host-owned skeleton in that gap,
    // but do not reuse page 1's dimensions for the requested page.
    const style = liveFrame?.style ?? (
        hasStaleFrame ? provisionalStyle : frame?.style ?? provisionalStyle
    );
    const liveWidth = Number.parseFloat(style.width);
    const liveHeight = Number.parseFloat(style.height);
    if (
        !Number.isFinite(liveWidth)
        || liveWidth <= 0
        || !Number.isFinite(liveHeight)
        || liveHeight <= 0
    ) {
        return null;
    }
    const margin = resolveDocumentOpeningPageMargin(geometry, rendererKind.value);
    return {
        generation: snapshot.generation,
        height: liveHeight,
        id: resolveDocumentOpeningPageShellId(chassisAuthority.instanceId, snapshot.generation),
        isPdf,
        ownerId: frame?.ownerId ?? 'chassis-provisional',
        pageNumber: currentPage,
        provisional: frame === null,
        style: {
            ...style,
            top: `${String(margin)}px`,
            left: `max(${String(margin)}px, calc(50% - ${String(liveWidth / 2)}px))`,
        },
    };
});
const shouldShowChassisOpeningPageSkeleton = computed(() => chassisAuthority.openingPageVisual.value !== 'fresh');

watch(
    [
        () => chassisAuthority.openSurface.snapshot.value.generation,
        () => chassisAuthority.openSurface.snapshot.value.identity?.documentId ?? '',
        () => chassisAuthority.openSurface.snapshot.value.phase,
        () => chassisAuthority.openSurface.snapshot.value.openingPageGeometry,
        () => attrs.zoomState,
        () => attrs.viewMode,
        () => attrs.continuousScroll,
        () => rendererKind.value,
        // Frame preparation needs a measurable viewport. When geometry is already
        // known before this chassis lays out, the first attempt has nothing to
        // measure, so the layout revision is the retry signal that lands the frame.
        () => openingFrameLayoutRevision.value,
    ],
    ([
        generation,
        documentId,
        phase,
    ]) => {
        if (
            ![
                'pending',
                'geometry-committed',
                'canvas-committed',
                'viewport-committed',
            ].includes(phase)
            || !documentId
        ) {
            return;
        }
        if (
            chassisAuthority.openSurface.snapshot.value.openingPageGeometry?.pageNumber
            !== chassisAuthority.currentPage.value
        ) {
            return;
        }
        openingPageFrameAuthority.prepareOpeningPageFrame(generation);
    },
    {
        flush: 'sync',
        immediate: true,
    },
);
watch(activeFeaturePackRef, (featurePack) => {
    if (featurePack) {
        emit('feature-pack-ready', openingPageFrameAuthority);
    }
}, {flush: 'sync'});
const chassisViewportStyle = computed(() => {
    const policy = resolveDocumentOpenSurfaceViewportPolicy(chassisAuthority.openSurface.snapshot.value);
    return [
        chassisAuthority.viewportStyle.value,
        {
            // The opening shell may suppress scrolling, but once ready the
            // renderer owns axis overflow (including fit-width scrollbar lock).
            // Residue of a superseded wheel gesture must not move the viewport.
            // The stable gutter keeps this from changing the layout width.
            overflow: policy.overflow === 'hidden' || chassisAuthority.viewportWritePort.userScrollSuppressed.value
                ? 'hidden'
                : undefined,
            scrollbarGutter: policy.scrollbarGutter,
            '--document-open-surface-margin': policy.committedMargin === null
                ? undefined
                : `${String(policy.committedMargin)}px`,
        },
    ];
});
let handoffGeneration = 0;
provide(documentViewerRuntimeKey, chassisAuthority);

// Feature packs publish their render source through the chassis authority. Keep
// the compatibility event as a projection of that authoritative state so a
// parent mounting later in the lifecycle still receives the current source.
watch(
    () => chassisAuthority.source.value,
    source => emit('update:pageSource', source),
    {
        flush: 'sync',
        immediate: true,
    },
);

// The authority's semantic page follows the shared surface, including
// pre-mount navigation intent. Feature packs only emit page events on later
// changes, so a renderer initialized directly at the target page would leave
// the parent's projection behind without this authoritative projection.
watch(
    () => chassisAuthority.currentPage.value,
    (pageNumber) => {
        if (pageNumber !== props.currentPage) {
            emit('update:current-page', pageNumber);
        }
    },
    {
        flush: 'sync',
        immediate: true,
    },
);

function handleCurrentPageUpdate(pageNumber: number) {
    if (shouldAcceptFeaturePackRuntimePage(
        chassisAuthority.openSurface.viewportSession.value,
        pageNumber,
    )) {
        emit('update:current-page', pageNumber);
    }
}

function handleTotalPagesUpdate(pageCount: number) {
    chassisAuthority.pageCount.value = Math.max(0, Math.trunc(pageCount));
    if (chassisAuthority.pageCount.value > 0) {
        chassisAuthority.openSurface.metadataReady(chassisAuthority.pageCount.value);
    }
    emit('update:total-pages', chassisAuthority.pageCount.value);
}

watch(() => [
    sourceKind.value,
    rendererKind.value,
] as const, async (nextIdentity, previousIdentity) => {
    if (nextIdentity[0] === previousIdentity[0] && nextIdentity[1] === previousIdentity[1]) {
        return;
    }
    const generation = ++handoffGeneration;
    const previousViewer = sourceViewerRef.value as {
        captureScrollSnapshot?: () => unknown;
        getCurrentPage?: () => number;
    } | null;
    const snapshot = previousViewer?.captureScrollSnapshot?.() ?? null;
    const fallbackPage = previousViewer?.getCurrentPage?.() ?? 1;
    await nextTick();
    if (generation !== handoffGeneration) {
        return;
    }
    const nextViewer = sourceViewerRef.value as {
        waitForViewerLoadSettled?: () => Promise<void>;
        restoreScrollSnapshot?: (snapshot: unknown, options: {fallbackPage: number}) => void;
        scrollToPage?: (pageNumber: number, options?: IScrollToPageOptions) => void;
    } | null;
    await nextViewer?.waitForViewerLoadSettled?.();
    if (generation !== handoffGeneration || sourceViewerRef.value !== nextViewer) {
        return;
    }
    const viewportSession = chassisAuthority.openSurface.viewportSession.value;
    const shouldRestoreSnapshot = shouldRestoreDocumentViewerHandoffSnapshot({
        fallbackPage,
        currentPage: chassisAuthority.currentPage.value,
        pendingNavigationPage: viewportSession.identity !== null
                && viewportSession.requestedPage !== viewportSession.committedPage
            ? viewportSession.requestedPage
            : null,
    });
    if (shouldRestoreSnapshot && nextViewer?.restoreScrollSnapshot) {
        nextViewer.restoreScrollSnapshot(snapshot, {fallbackPage});
    } else if (shouldRestoreSnapshot) {
        nextViewer?.scrollToPage?.(fallbackPage);
    }
}, {flush: 'pre'});

// Navigation belongs to the stable chassis, so commands remain durable while
// the async feature pack is absent or swapping. When a renderer is mounted it
// must also project that request into the viewport; recording the requested
// page alone does not create or commit a scroll intent.
defineExpose(createDocumentViewerExposeForwarder(sourceViewerRef, {
    getCurrentPage: () => chassisAuthority.currentPage.value,
    getPendingNavigationTargetPage: () => {
        const ticket = chassisAuthority.navigationTicket.value;
        const target = ticket?.request.target;
        return target && 'page' in target ? target.page : null;
    },
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => {
        const request = createPdfPageNavigationRequest(pageNumber, options);
        chassisAuthority.navigate(request);
    },
}));
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

.document-viewer-chassis__opening-page {
    position: absolute;

    /* This is the sole visible owner until the joined canvas/viewport commit.
       Keep the mounted live page track underneath so it can render without
       occluding the shell before the atomic ready handoff. */
    z-index: var(--app-workspace-transition-overlay-z-index);
    overflow: hidden;
    pointer-events: none;
    background: var(--app-document-page-bg);
    border-radius: var(--app-document-page-radius);
    box-shadow: var(--app-document-page-shadow);
}

/* The opening shell is the sole visible page-frame owner until commit. The
   renderer still mounts underneath so it can prepare pixels, but its matching
   shadow must not composite through the opening shell's translucent shadow. */
.document-viewer-chassis[data-open-surface-presentation='page-shell'] :deep(.page_canvas),
.document-viewer-chassis[data-open-surface-presentation='page-shell'] :deep(.document-source-viewer__page) {
    box-shadow: none;
}

.document-viewer-chassis__opening-layer {
    position: sticky;
    top: 0;
    left: 0;
    z-index: var(--app-workspace-transition-overlay-z-index);
    width: 100%;
    height: 0;
    overflow: visible;
    pointer-events: none;
}

</style>
