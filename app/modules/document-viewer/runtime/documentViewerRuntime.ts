import type {
    IDocumentNavigationRequest,
    IDocumentNavigationTicket,
} from '@app/modules/document-viewer/navigation/documentNavigationRequest';
import type {
    HTMLAttributes,
    Ref,
    ShallowRef,
    StyleValue,
} from 'vue';
import {
    createDocumentPageSlotRegistry,
    type IDocumentPageSlotRegistry,
} from '@app/modules/document-viewer/page-slots/createDocumentPageSlotRegistry';
import type {
    IDocumentPageSource,
    TDocumentPageSourceKind,
} from '@app/modules/document-viewer/source/documentPageSource';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/public/workspaceSurfaceBudget';
import {
    createDocumentViewportWritePort,
    type IDocumentViewportWritePort,
} from '@app/modules/document-viewer/runtime/documentViewportWritePort';
import { createDocumentViewerRenderCoordinator } from '@app/modules/document-viewer/runtime/createDocumentViewerRenderCoordinator';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSession,
    type IDocumentViewportSessionState,
    resolveDocumentViewportCurrentPage,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type { IDocumentWheelInteraction } from '@app/modules/document-viewer/input/documentWheelInteraction';
import type { IDocumentViewportFlingBackdrop } from '@app/modules/document-viewer/runtime/documentViewportFlingBackdrop';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

export interface IDocumentViewerRuntime {
    readonly instanceId: string;
    readonly currentPage: Readonly<Ref<number>>;
    readonly navigationPage: Readonly<Ref<number>>;
    readonly navigationTicket: Readonly<Ref<IDocumentNavigationTicket | null>>;
    readonly pageCount: Ref<number>;
    readonly pageSlots: IDocumentPageSlotRegistry;
    readonly renderCoordinator: ReturnType<typeof createDocumentViewerRenderCoordinator>;
    readonly openSurface: ReturnType<typeof createDocumentOpenSurfaceSession>;
    readonly openingPageElement: Readonly<ShallowRef<HTMLElement | null>>;
    readonly openingPageVisual: Readonly<Ref<TDocumentOpeningPageVisual>>;
    readonly source: Readonly<ShallowRef<IDocumentPageSource | null>>;
    readonly sourceKind: Ref<TDocumentPageSourceKind>;
    readonly surfaceBudget: typeof workspaceSurfaceBudgetController;
    readonly viewportWritePort: IDocumentViewportWritePort;
    readonly viewportElement: Readonly<ShallowRef<HTMLElement | null>>;
    readonly viewportClass: Readonly<Ref<HTMLAttributes['class']>>;
    readonly viewportStyle: Readonly<Ref<StyleValue>>;
    readonly viewportFlingBackdrop: Readonly<Ref<IDocumentViewportFlingBackdrop | null>>;
    bindSource(source: IDocumentPageSource | null): void;
    bindOpeningPageElement(element: HTMLElement | null): void;
    commitOpeningPageVisual(
        generation: number,
        pageNumber: number,
        visual: TDocumentOpeningPageVisual,
    ): boolean;
    bindViewportElement(element: HTMLElement | null): void;
    bindViewportFeature(binding: IDocumentViewportFeatureBinding): () => void;
    dispatchViewportWheel(interaction: IDocumentWheelInteraction): void;
    dispatchViewportEvent(type: TDocumentViewportEventType, event?: Event): void;
    navigate(request: IDocumentNavigationRequest): IDocumentNavigationTicket | null;
    observePage(pageNumber: number, options?: {supersedeNavigation?: boolean}): number;
}

export type TDocumentViewportEventType = 'scroll' | 'mousedown' | 'mousemove' | 'mouseup'
    | 'mouseleave' | 'click' | 'dblclick' | 'contextmenu' | 'selectstart';
export type TDocumentOpeningPageVisual = 'none' | 'skeleton' | 'fresh';

export interface IDocumentViewportFeatureBinding {
    getClass: () => HTMLAttributes['class'];
    getStyle: () => StyleValue;
    getFlingBackdrop?: () => IDocumentViewportFlingBackdrop | null;
    events: Partial<Record<TDocumentViewportEventType, (event?: Event) => void>>;
    wheel?: (interaction: IDocumentWheelInteraction) => void;
}

export const documentViewerRuntimeKey = Symbol('document-viewer-runtime') as InjectionKey<
    IDocumentViewerRuntime
>;

let nextDocumentViewerChassisInstanceId = 0;

export function shouldAcceptFeaturePackRuntimePage(
    session: IDocumentViewportSessionState,
    pageNumber: number,
) {
    const normalizedPage = Math.max(1, Math.trunc(pageNumber));
    // A retained feature pack can finish projecting its previous page after
    // the document session has already closed.  An empty session has no
    // document whose scroll state is authoritative, so accepting that late
    // projection would queue it as pre-open navigation for the next file and
    // make the opening shell jump from page 1 to the stale page.
    if (session.identity === null) {
        return false;
    }
    // A claimed viewport session is the navigation authority. Feature packs
    // project the result of an already-requested viewport commit; they must
    // not turn a late projection from an older render into a new command.
    // Viewport commit boundaries request their page before emitting this
    // compatibility projection, so legitimate scroll/navigation updates still
    // match requestedPage while stale updates are rejected.
    return resolveDocumentViewportCurrentPage(session) === normalizedPage;
}

export function createDocumentViewerRuntime(
    sourceKind: Ref<TDocumentPageSourceKind>,
    _initialPage = 1,
    sharedOpenSurface?: IDocumentOpenSurfaceSession | undefined,
): IDocumentViewerRuntime {
    const instanceId = `document-viewer-runtime-${String(++nextDocumentViewerChassisInstanceId)}`;
    const pageCount = ref(0);
    const pageSlots = createDocumentPageSlotRegistry();
    const renderCoordinator = createDocumentViewerRenderCoordinator(pageSlots);
    const openSurface = sharedOpenSurface ?? createDocumentOpenSurfaceSession();
    const currentPage = computed(() => resolveDocumentViewportCurrentPage(openSurface.viewportSession.value));
    const navigationTicket = openSurface.navigationTicket;
    const navigationPage = computed(() => navigationTicket.value
        ? openSurface.viewportSession.value.viewportIntent?.pageNumber ?? currentPage.value
        : currentPage.value);
    const openingPageElement = shallowRef<HTMLElement | null>(null);
    const openingPageVisual = ref<TDocumentOpeningPageVisual>('none');
    const source = shallowRef<IDocumentPageSource | null>(null);
    const viewportElement = shallowRef<HTMLElement | null>(null);
    const viewportWritePort = createDocumentViewportWritePort();
    const viewportFeature = shallowRef<IDocumentViewportFeatureBinding | null>(null);
    const viewportClass = computed(() => viewportFeature.value?.getClass() ?? '');
    const viewportStyle = computed(() => viewportFeature.value?.getStyle() ?? {});
    const viewportFlingBackdrop = computed(() => viewportFeature.value?.getFlingBackdrop?.() ?? null);
    // Surface actions may enter through the shared session while the runtime
    // is still being mounted (for example a restored/full-target command).
    // Fence once per accepted ticket identity here so those actions invalidate
    // a live gesture just like runtime.navigate, without making navigate a
    // second fence point. Ticket refinements retain their id and therefore do
    // not restart the gesture fence.
    let lastFencedNavigationTicketId: string | null = null;
    watch(
        () => openSurface.navigationTicket.value?.id ?? null,
        (ticketId) => {
            if (ticketId === null || ticketId === lastFencedNavigationTicketId) {
                return;
            }
            lastFencedNavigationTicketId = ticketId;
            // A wheel ticket is authored by the physical gesture currently
            // being delivered. Fencing it would classify the remaining
            // packets of that gesture as command residue and make paged wheel
            // navigation stop after the first page. Toolbar, search, and
            // restore tickets still fence the older gesture tail.
            if (openSurface.navigationTicket.value?.request.source === 'wheel') {
                return;
            }
            viewportWritePort.fenceCommandAgainstLiveGesture();
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );
    watch(
        () => openSurface.viewportSession.value.visual,
        (visual) => {
            openingPageVisual.value = visual.kind === 'page' && visual.presentation === 'canvas'
                ? 'fresh'
                : visual.kind === 'page' && visual.presentation === 'skeleton'
                    ? 'skeleton'
                    : 'none';
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );
    let resetOpeningViewportGeneration = 0;
    watch(
        [
            () => openSurface.snapshot.value.generation,
            () => openSurface.snapshot.value.phase,
            () => viewportElement.value,
        ],
        ([
            generation,
            phase,
            viewport,
        ]) => {
            if (
                phase !== 'pending'
                || generation <= 0
                || generation === resetOpeningViewportGeneration
                || !viewport
            ) {
                return;
            }
            // A new document generation starts at the canonical viewport
            // origin. Reset it in the same synchronous transaction that
            // exposes the opening frame so a stale empty-state/native scroll
            // offset cannot move the shell before the renderer commits.
            const intent = viewportWritePort.beginIntent(`document-open:${String(generation)}`);
            const applied = viewportWritePort.apply(viewport, {
                intent,
                reason: 'document-open-origin',
                left: 0,
                top: 0,
            });
            logPdfRenderTrace('document-open-origin', {
                generation,
                applied,
                actualLeft: viewport.scrollLeft,
                actualTop: viewport.scrollTop,
            });
            if (applied) {
                resetOpeningViewportGeneration = generation;
            }
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );

    return {
        instanceId,
        currentPage,
        navigationPage,
        navigationTicket,
        pageCount,
        pageSlots,
        renderCoordinator,
        openSurface,
        openingPageElement,
        openingPageVisual,
        source,
        sourceKind,
        surfaceBudget: workspaceSurfaceBudgetController,
        viewportWritePort,
        viewportElement,
        viewportClass,
        viewportStyle,
        viewportFlingBackdrop,
        bindSource(nextSource) {
            if (nextSource && nextSource.kind !== sourceKind.value) {
                throw new TypeError(`Cannot bind ${nextSource.kind} source to ${sourceKind.value} chassis`);
            }
            if (source.value !== nextSource) {
                this.viewportWritePort.advanceDocumentRevision();
            }
            source.value = nextSource;
            pageCount.value = nextSource?.pageCount ?? 0;
            if (pageCount.value > 0) openSurface.metadataReady(pageCount.value);
        },
        bindOpeningPageElement(element) {
            openingPageElement.value = element;
            if (element === null) {
                openingPageVisual.value = 'none';
            }
        },
        commitOpeningPageVisual(generation, pageNumber, visual) {
            const snapshot = openSurface.snapshot.value;
            const frame = snapshot.openingPageFrame;
            const element = openingPageElement.value;
            if (
                snapshot.generation !== generation
                || frame?.generation !== generation
                || frame.pageNumber !== pageNumber
                || !element?.isConnected
                || element.dataset.pageNumber !== String(pageNumber)
                || element.dataset.openSurfaceGeneration !== String(generation)
                || element.dataset.openSurfaceFrameOwner !== frame.ownerId
            ) {
                return false;
            }
            openingPageVisual.value = visual;
            return true;
        },
        bindViewportElement(element) {
            viewportElement.value = element;
        },
        bindViewportFeature(binding) {
            viewportFeature.value = binding;
            return () => {
                if (viewportFeature.value === binding) {
                    viewportFeature.value = null;
                }
            };
        },
        dispatchViewportWheel(interaction) {
            viewportFeature.value?.wheel?.(interaction);
        },
        dispatchViewportEvent(type, event) {
            viewportFeature.value?.events[type]?.(event);
        },
        navigate(request) {
            return openSurface.navigate(request);
        },
        observePage(pageNumber, options) {
            return openSurface.observeViewportPage(pageNumber, options);
        },
    };
}

export function injectDocumentViewerRuntime() {
    return inject(documentViewerRuntimeKey, null);
}
