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
    >
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
                v-if="chassisOpeningPageShell && shouldRenderChassisOpeningPageShell"
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
                    <img
                        v-if="chassisAuthority.openSurface.snapshot.value.openingPageFrame?.preview"
                        class="document-viewer-chassis__opening-preview"
                        :src="chassisAuthority.openSurface.snapshot.value.openingPageFrame.preview.objectUrl"
                        alt=""
                        aria-hidden="true"
                        data-testid="document-opening-native-preview"
                    >
                    <DocumentPageSkeleton
                        v-else-if="chassisAuthority.openingPageVisual.value !== 'fresh'"
                        :content-height="chassisOpeningPageShell.height"
                    />
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
import { createDocumentViewerExposeForwarder } from '@app/modules/workspace-shell/viewers/createDocumentViewerExposeForwarder';
import {
    createDocumentViewerChassisAuthority,
    documentViewerChassisAuthorityKey,
    shouldAcceptFeaturePackChassisPage,
    shouldApplyExternalChassisPage,
} from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type {
    IDocumentPageSource,
    TDocumentPageSourceKind,
} from '@app/utils/document-viewer/source/documentPageSource';
import DocumentViewportHost from '@app/utils/document-viewer/chassis/DocumentViewportHost.vue';
import { workspaceViewerFeatureChunkLoaders } from '@app/modules/workspace-shell/viewers/workspaceViewerFeatureChunkLoaders';
import {
    injectDocumentOpenSurfaceSession,
    resolveDocumentOpenSurfaceViewportPolicy,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import {
    createDocumentOpeningPageFrameAuthority,
    resolveDocumentOpeningPageMargin,
    resolveDocumentOpeningPageShellId,
} from '@app/utils/document-viewer/chassis/documentOpeningPageFrameAuthority';
import { readPrevalidatedTrustedPdfOpenGeometry } from '@app/modules/pdf-viewer/public';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import { readPrevalidatedTrustedDjvuOpenGeometry } from '@app/modules/djvu-viewer/public';
import { resolveDocumentPageSourceOpeningFrame } from '@app/modules/workspace-shell/viewers/resolveDocumentPageSourceOpeningFrame';
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import {
    captureDocumentViewportResizeAnchor,
    resolveDocumentViewportResizeAnchorPosition,
    type IDocumentViewportResizeAnchor,
} from '@app/utils/document-viewer/chassis/documentViewportResizeAnchor';
import type { IDocumentWheelInteraction } from '@app/utils/document-viewer/input/documentWheelInteraction';
import { observeDocumentViewportWheelInteraction } from '@app/utils/document-viewer/chassis/documentViewportWritePort';
import { shouldRestoreDocumentViewerHandoffSnapshot } from '@app/modules/workspace-shell/viewers/shouldRestoreDocumentViewerHandoffSnapshot';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
    sourceKind: TDocumentPageSourceKind;
    rendererKind?: 'pdfjs' | 'native-pdf' | 'page-source';
    currentPage?: number;
    mountPresentation?: boolean;
    isResizing?: boolean;
}>();
const emit = defineEmits<{
    'feature-pack-ready': [authority: ReturnType<typeof createDocumentOpeningPageFrameAuthority>];
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
const NativePdfFeaturePack = defineAsyncComponent(
    () => workspaceViewerFeatureChunkLoaders['native-pdf']()
        .then(componentModule => componentModule.NativePdfViewer),
) as Component;
const activeFeaturePackRef = shallowRef<Record<PropertyKey, unknown> | null>(null);
const viewportId = computed(() => (
    sourceKind.value === 'pdf' && props.rendererKind !== 'native-pdf' ? 'pdf-viewer' : undefined
));
const activeFeaturePack = computed(() => (
    props.rendererKind === 'native-pdf'
        ? NativePdfFeaturePack
        : sourceKind.value === 'pdf' ? PdfFeaturePack : DocumentPageSourceFeaturePack
));
const sourceViewerRef = computed(() => activeFeaturePackRef.value);
const openingFrameLayoutRevision = ref(0);
let openingFrameResizeObserver: ResizeObserver | null = null;
const retainedResizeAnchor = shallowRef<IDocumentViewportResizeAnchor | null>(null);
let retainedResizeAnchorFence: {
    generation: number;
    interactionEpoch: number;
    viewportIntentId: string | null;
} | null = null;
const RESIZE_ANCHOR_QUIET_MS = 120;
let resizeAnchorReleaseTimer: ReturnType<typeof setTimeout> | null = null;
const documentOpenSurface = injectDocumentOpenSurfaceSession();
if (!documentOpenSurface) {
    throw new Error('DocumentViewerChassis requires the host-owned document open surface session');
}
const chassisAuthority = createDocumentViewerChassisAuthority(
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
        || fence.viewportIntentId !== (session.viewportIntent?.id ?? null)
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
    const viewport = chassisAuthority.viewportElement.value;
    if (!viewport) {
        return;
    }
    releaseRetainedResizeAnchor();
    retainedResizeAnchor.value = captureDocumentViewportResizeAnchor(viewport);
    const session = chassisAuthority.openSurface.viewportSession.value;
    retainedResizeAnchorFence = retainedResizeAnchor.value ? {
        generation: session.generation,
        interactionEpoch: chassisAuthority.viewportWritePort.getInteractionEpoch(),
        viewportIntentId: session.viewportIntent?.id ?? null,
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
    // browser mutates scrollTop. Zoom gestures instead need the layout
    // lifecycle's anchor restore; bumping the epoch on every streamed zoom
    // tick would cancel that restore one frame after it was captured.
    observeDocumentViewportWheelInteraction(
        chassisAuthority.viewportWritePort,
        interaction.intent,
        chassisAuthority.viewportElement.value ?? undefined,
    );
    chassisAuthority.dispatchViewportWheel(interaction);
}

function handleViewportInteraction(type: 'mousedown', event: Event) {
    releaseResizeAnchorForViewportInteraction();
    chassisAuthority.viewportWritePort.observeUserInteraction(chassisAuthority.viewportElement.value ?? undefined);
    chassisAuthority.dispatchViewportEvent(type, event);
}
function readNumericAttr(name: string, fallback: number) {
    const value = attrs[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function readStringAttr<T extends string>(name: string, values: readonly T[], fallback: T) {
    const value = attrs[name];
    return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
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
const openingPageFrameAuthority = createDocumentOpeningPageFrameAuthority({
    openSurface: documentOpenSurface,
    readLayoutRevision: () => openingFrameLayoutRevision.value,
    readPolicy: () => ({
        fitMode: readStringAttr('fitMode', [
            'width',
            'height',
        ] as const, 'width'),
        viewMode: readStringAttr('viewMode', [
            'single',
            'facing',
            'facing-first-single',
        ] as const, 'single'),
        zoom: readNumericAttr('zoom', 1),
        zoomMode: readStringAttr('zoomMode', [
            'custom',
            'fit-width',
            'fit-height',
        ] as const, 'fit-width'),
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
onBeforeUnmount(() => {
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
    const isPdf = sourceKind.value === 'pdf';
    const isOpening = snapshot.phase === 'pending'
        || snapshot.phase === 'geometry-committed'
        || snapshot.phase === 'canvas-committed'
        || snapshot.phase === 'viewport-committed';
    if (
        !isOpening
        || frame !== null && (
            frame.generation !== snapshot.generation
            || frame.pageNumber !== chassisAuthority.currentPage.value
                && frame.preview === undefined
        )
    ) {
        return null;
    }
    const viewport = readOpeningViewportSize();
    const provisionalWidth = viewport.width > 40 ? viewport.width - 40 : 612;
    const provisionalStyle = {
        width: `${String(provisionalWidth)}px`,
        height: `${String(provisionalWidth * (792 / 612))}px`,
    };
    const geometry = snapshot.openingPageGeometry;
    const policy = {
        zoom: readNumericAttr('zoom', 1),
        zoomMode: readStringAttr('zoomMode', [
            'custom',
            'fit-width',
            'fit-height',
        ] as const, 'fit-width'),
    };
    const liveFrame = !isPdf && geometry !== null ? resolveDocumentPageSourceOpeningFrame({
        geometry,
        viewportWidth: readOpeningViewportSize().width,
        viewportHeight: readOpeningViewportSize().height,
        ...policy,
    }) : null;
    const style = liveFrame?.style ?? frame?.style ?? provisionalStyle;
    const liveWidth = Number.parseFloat(style.width ?? '');
    const liveHeight = Number.parseFloat(style.height ?? '');
    if (
        !Number.isFinite(liveWidth)
        || liveWidth <= 0
        || !Number.isFinite(liveHeight)
        || liveHeight <= 0
    ) {
        return null;
    }
    const margin = resolveDocumentOpeningPageMargin(geometry, props.rendererKind);
    return {
        generation: snapshot.generation,
        height: liveHeight,
        id: resolveDocumentOpeningPageShellId(chassisAuthority.instanceId, snapshot.generation),
        isPdf,
        ownerId: frame?.ownerId ?? 'chassis-provisional',
        pageNumber: frame?.pageNumber ?? chassisAuthority.currentPage.value,
        provisional: frame === null,
        style: {
            ...style,
            top: `${String(margin)}px`,
            left: `max(${String(margin)}px, calc(50% - ${String(liveWidth / 2)}px))`,
        },
    };
});
const shouldRenderChassisOpeningPageShell = computed(() => chassisOpeningPageShell.value !== null);

watch(
    [
        () => chassisAuthority.openSurface.snapshot.value.generation,
        () => chassisAuthority.openSurface.snapshot.value.identity?.documentId ?? '',
        () => chassisAuthority.openSurface.snapshot.value.phase,
        () => chassisAuthority.openSurface.snapshot.value.openingPageGeometry,
        () => chassisAuthority.openSurface.snapshot.value.openingPageFrame?.preview?.pageNumber ?? null,
        () => attrs.fitMode,
        () => attrs.viewMode,
        () => attrs.zoom,
        () => attrs.zoomMode,
        // Frame preparation needs a measurable viewport. When geometry is already
        // known before this chassis lays out — a preflighted native-preview open
        // resolves it during setup — the first attempt has nothing to measure, so
        // the layout revision is the retry signal that lands the frame.
        () => openingFrameLayoutRevision.value,
    ],
    ([
        generation,
        documentId,
        phase,
    ]) => {
        const snapshot = chassisAuthority.openSurface.snapshot.value;
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
        if (snapshot.openingPageGeometry === null) {
            if (phase !== 'pending') {
                return;
            }
            const geometry = sourceKind.value === 'djvu'
                ? readPrevalidatedTrustedDjvuOpenGeometry(documentId, chassisAuthority.currentPage.value)
                : readPrevalidatedTrustedPdfOpenGeometry(documentId, chassisAuthority.currentPage.value);
            if (
                !geometry
                || geometry.pageNumber !== chassisAuthority.currentPage.value
                || !chassisAuthority.openSurface.commitOpeningPageGeometry(generation, geometry)
            ) {
                return;
            }
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
            overflow: policy.overflow,
            scrollbarGutter: policy.scrollbarGutter,
            '--document-open-surface-margin': policy.committedMargin === null
                ? undefined
                : `${String(policy.committedMargin)}px`,
        },
    ];
});
let handoffGeneration = 0;
provide(documentViewerChassisAuthorityKey, chassisAuthority);

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

watch(() => props.currentPage, (pageNumber) => {
    if (
        pageNumber !== undefined
        && shouldApplyExternalChassisPage(
            chassisAuthority.openSurface.viewportSession.value,
            pageNumber,
        )
    ) {
        chassisAuthority.navigate(pageNumber);
    }
}, {immediate: true});

function handleCurrentPageUpdate(pageNumber: number) {
    if (shouldAcceptFeaturePackChassisPage(
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
    chassisAuthority.navigate(chassisAuthority.currentPage.value);
    emit('update:total-pages', chassisAuthority.pageCount.value);
}

watch(() => [
    sourceKind.value,
    props.rendererKind,
] as const, async (nextIdentity, previousIdentity) => {
    if (nextIdentity[0] === previousIdentity?.[0] && nextIdentity[1] === previousIdentity?.[1]) {
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
        const session = chassisAuthority.openSurface.viewportSession.value;
        return session.identity !== null && session.requestedPage !== session.committedPage
            ? session.requestedPage
            : null;
    },
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => {
        const normalizedPage = chassisAuthority.navigate(pageNumber);
        const viewer = sourceViewerRef.value as {scrollToPage?: (page: number, options?: IScrollToPageOptions) => void;} | null;
        viewer?.scrollToPage?.(normalizedPage, options);
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

.document-viewer-chassis__opening-preview {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
}

/* The opening shell is the sole visible page-frame owner until commit. The
   renderer still mounts underneath so it can prepare pixels, but its matching
   shadow must not composite through the opening shell's translucent shadow. */
.document-viewer-chassis[data-open-surface-presentation='page-shell'] :deep(.page_canvas),
.document-viewer-chassis[data-open-surface-presentation='page-shell'] :deep(.native-pdf-page-shell),
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
