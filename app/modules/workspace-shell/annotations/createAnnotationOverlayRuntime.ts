import {clamp} from 'es-toolkit/math';
import {useEventListener, useMutationObserver, useResizeObserver} from '@vueuse/core';
import type {IAnnotationNotePosition} from '@app/types/annotationNoteWindow';
import {isTextMarkupSubtype} from '@app/services/pdf/annotationSubtype';
import {normalizeMarkerRect, escapeCssAttr} from '@app/modules/pdf-viewer/public';
import {NOTE_WINDOW, resolveNoteWindowAnchorZIndex} from '@app/constants/pdfLayout';
import {BrowserLogger} from '@app/utils/browserLogger';
import {createRafBurstScheduler} from '@app/modules/workspace-shell/scheduling/createRafBurstScheduler';
import type {IAnnotationNoteWindowEntry} from '@app/modules/workspace-shell/annotations/annotationNoteWindowEntry';

const INLINE_NOTE_SUBTYPES = new Set(['text', 'note-linked', 'note-inline']);
const FREE_TEXT_NOTE_SUBTYPES = new Set(['freetext', 'typewriter']);
const INLINE_MARKER_PROXIMITY = 0.08;
// Open/inline note markers sit at the page edge with translate(-50%, -50%),
// so allow a small overflow margin before treating the page as offscreen.
const CONNECTOR_PAGE_OVERFLOW_MARGIN_PX = 32;

interface IInlineTriggerIdentity {
    annotationIds: Set<string>;
    notePoints: Array<{
        pageNumber: number;
        x: number;
        y: number;
    }>;
}

interface IViewportDomSnapshot {
    bounds: DOMRect;
    pageContainers: Map<
        number,
        {
            element: HTMLElement;
            rect: DOMRect | null;
        }
    >;
}

interface IConnectorLine {
    annotationId: string;
    color: string | null;
    path: string;
}

interface IConnectorMarkerPoint {
    cx: number;
    cy: number;
    radius: number;
}

interface INoteViewportRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

type TViewportBounds = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

export interface IAnnotationOverlayRuntimeOptions {
    getNoteWindows: () => IAnnotationNoteWindowEntry[];
    getNotePositions: () => Record<string, IAnnotationNotePosition>;
    getWorkspaceRoot: () => HTMLElement | null;
    getViewportRoot: () => HTMLElement | null;
    getZoom: () => number | undefined;
    getEmptyNoteLabel: () => string;
    isVisible?: () => boolean;
    /** Whether the view paints a page's annotations, inline note markers included. */
    paintsPage: (pageIndex: number) => boolean;
}

function getNoteMarkerRect(note: IAnnotationNoteWindowEntry) {
    return normalizeMarkerRect(note.markerRect);
}

function resolveKnownFloatingEligibility(note: IAnnotationNoteWindowEntry, subtype: string) {
    // A minimized window is what the indicator stands for, so a markup keeps
    // it while its note text is empty.
    if (isTextMarkupSubtype(note.subtype)) {
        return true;
    }
    if (INLINE_NOTE_SUBTYPES.has(subtype)) {
        return note.hasNote;
    }
    if (FREE_TEXT_NOTE_SUBTYPES.has(subtype)) {
        return true;
    }
    return null;
}

function isFloatingIndicatorEligible(note: IAnnotationNoteWindowEntry) {
    const subtype = (note.subtype ?? '').trim().toLowerCase();
    if (subtype === 'link') {
        return false;
    }
    return resolveKnownFloatingEligibility(note, subtype) ?? note.source === 'editor';
}

function parsePageContainerNumber(element: HTMLElement) {
    const pageNumber = Number(element.dataset.page ?? '');
    return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

function reuseEqualPageSet(previous: ReadonlySet<number> | undefined, next: Set<number>): ReadonlySet<number> {
    if (previous && previous.size === next.size) {
        for (const page of next) {
            if (!previous.has(page)) {
                return next;
            }
        }
        return previous;
    }
    return next;
}

function collectTrackedPageElements(viewportRoot: HTMLElement | null, trackedPages: ReadonlySet<number>): Map<number, HTMLElement> {
    const pageContainers = new Map<number, HTMLElement>();
    if (!viewportRoot || trackedPages.size === 0) {
        return pageContainers;
    }

    viewportRoot.querySelectorAll<HTMLElement>('.page_container').forEach((pageContainer) => {
        const pageNumber = parsePageContainerNumber(pageContainer);
        if (pageNumber !== null && trackedPages.has(pageNumber)) {
            pageContainers.set(pageNumber, pageContainer);
        }
    });

    return pageContainers;
}

function collectViewportDomSnapshot(
    viewportRoot: HTMLElement | null,
    trackedPageElements: ReadonlyMap<number, HTMLElement>,
    openPages: ReadonlySet<number>,
): IViewportDomSnapshot | null {
    if (!viewportRoot || openPages.size === 0) {
        return null;
    }

    const pageContainers = new Map<
        number,
        {
            element: HTMLElement;
            rect: DOMRect | null;
        }
    >();
    openPages.forEach((pageNumber) => {
        const pageContainer = trackedPageElements.get(pageNumber);
        if (!pageContainer || !pageContainer.isConnected) {
            return;
        }
        const rect = pageContainer.getBoundingClientRect();
        pageContainers.set(pageNumber, {
            element: pageContainer,
            rect: rect.width > 0 && rect.height > 0 ? rect : null,
        });
    });

    const bounds = viewportRoot.getBoundingClientRect();
    const viewportWindow = viewportRoot.ownerDocument.defaultView;
    return {
        bounds:
            bounds.width > 0 && bounds.height > 0
                ? bounds
                : new DOMRect(0, 0, viewportWindow?.innerWidth ?? 0, viewportWindow?.innerHeight ?? 0),
        pageContainers,
    };
}

function collectRenderedInlineAnchorIdentity(
    trackedPageElements: ReadonlyMap<number, HTMLElement>,
    eligibleNotes: readonly IAnnotationNoteWindowEntry[],
): IInlineTriggerIdentity {
    const identity: IInlineTriggerIdentity = {
        annotationIds: new Set<string>(),
        notePoints: [],
    };
    if (trackedPageElements.size === 0 || eligibleNotes.length === 0) {
        return identity;
    }

    const notesByPage = new Map<number, IAnnotationNoteWindowEntry[]>();
    for (const note of eligibleNotes) {
        if (!trackedPageElements.has(note.pageNumber)) {
            continue;
        }
        let pageNotes = notesByPage.get(note.pageNumber);
        if (!pageNotes) {
            pageNotes = [];
            notesByPage.set(note.pageNumber, pageNotes);
        }
        pageNotes.push(note);
    }

    notesByPage.forEach((pageNotes, pageNumber) => {
        const pageContainer = trackedPageElements.get(pageNumber);
        if (!pageContainer || !pageContainer.isConnected) {
            return;
        }

        const noteElements = pageContainer.querySelectorAll<HTMLElement>('.pdf-annotation-editor-note[data-annotation-id]');
        if (noteElements.length === 0) {
            return;
        }

        noteElements.forEach((noteElement) => {
            const annotationId = noteElement.dataset.annotationId;
            if (annotationId) {
                identity.annotationIds.add(annotationId);
            }
        });

        // Proximity coordinates are only consulted when an eligible note on
        // this page did not already match a rendered editor note by ID.
        if (!pageNotes.some((note) => !identity.annotationIds.has(note.annotationId))) {
            return;
        }

        const pageRect = pageContainer.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
            return;
        }

        noteElements.forEach((noteElement) => {
            const noteRect = noteElement.getBoundingClientRect();
            if (noteRect.width <= 0 || noteRect.height <= 0) {
                return;
            }
            identity.notePoints.push({
                pageNumber,
                x: clamp((noteRect.left + noteRect.width / 2 - pageRect.left) / pageRect.width, 0, 1),
                y: clamp((noteRect.top + noteRect.height / 2 - pageRect.top) / pageRect.height, 0, 1),
            });
        });
    });

    return identity;
}

function nodeContainsTrackedPage(node: Node, trackedPages: ReadonlySet<number>): boolean {
    if (!(node instanceof Element)) {
        return false;
    }
    if (node.classList.contains('page_container')) {
        const pageNumber = parsePageContainerNumber(node as HTMLElement);
        return pageNumber !== null && trackedPages.has(pageNumber);
    }
    for (const pageContainer of node.querySelectorAll<HTMLElement>('.page_container')) {
        const pageNumber = parsePageContainerNumber(pageContainer);
        if (pageNumber !== null && trackedPages.has(pageNumber)) {
            return true;
        }
    }
    return false;
}

function mutationAffectsTrackedPages(records: readonly MutationRecord[], trackedPages: ReadonlySet<number>): boolean {
    if (trackedPages.size === 0) {
        return false;
    }
    for (const record of records) {
        const hostPage = record.target instanceof Element ? record.target.closest<HTMLElement>('.page_container') : null;
        if (hostPage) {
            const pageNumber = parsePageContainerNumber(hostPage);
            if (pageNumber !== null && trackedPages.has(pageNumber)) {
                return true;
            }
            continue;
        }
        for (const node of record.addedNodes) {
            if (nodeContainsTrackedPage(node, trackedPages)) {
                return true;
            }
        }
        for (const node of record.removedNodes) {
            if (nodeContainsTrackedPage(node, trackedPages)) {
                return true;
            }
        }
    }
    return false;
}

function inlineIdentityMatchesNote(inlineIdentity: IInlineTriggerIdentity, note: IAnnotationNoteWindowEntry) {
    if (inlineIdentity.annotationIds.has(note.annotationId)) {
        return true;
    }
    const markerRect = getNoteMarkerRect(note);
    if (!markerRect) {
        return false;
    }
    const noteAnchorX = clamp(markerRect.left + markerRect.width, 0, 1);
    const noteAnchorY = clamp(markerRect.top, 0, 1);
    return inlineIdentity.notePoints.some(
        (point) =>
            point.pageNumber === note.pageNumber && Math.hypot(point.x - noteAnchorX, point.y - noteAnchorY) <= INLINE_MARKER_PROXIMITY,
    );
}

function rectsIntersect(rect: TViewportBounds, bounds: TViewportBounds) {
    return rect.right >= bounds.left && rect.left <= bounds.right && rect.bottom >= bounds.top && rect.top <= bounds.bottom;
}

function rectsIntersectWithMargin(rect: TViewportBounds, bounds: TViewportBounds, margin: number) {
    return (
        rect.right + margin >= bounds.left &&
        rect.left - margin <= bounds.right &&
        rect.bottom + margin >= bounds.top &&
        rect.top - margin <= bounds.bottom
    );
}

function pointInRect(x: number, y: number, rect: TViewportBounds) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function getNotePointFromElement(noteElement: HTMLElement, viewportBounds: TViewportBounds): IConnectorMarkerPoint | null {
    const noteRect = noteElement.getBoundingClientRect();
    if (noteRect.width <= 0 || noteRect.height <= 0 || !rectsIntersect(noteRect, viewportBounds)) {
        return null;
    }
    return {
        cx: noteRect.left + noteRect.width / 2,
        cy: noteRect.top + noteRect.height / 2,
        radius: Math.min(noteRect.width, noteRect.height) / 2,
    };
}

function getRenderedNoteCenter(pageContainer: HTMLElement, annotationId: string, viewportBounds: TViewportBounds) {
    const escapedId = escapeCssAttr(annotationId);
    const noteSelectors = [
        `.pdf-annotation-editor-note[data-annotation-id="${escapedId}"]`,
        `.pdf-note-open-anchor[data-annotation-id="${escapedId}"]`,
    ];

    for (const selector of noteSelectors) {
        for (const noteElement of pageContainer.querySelectorAll<HTMLElement>(selector)) {
            const point = getNotePointFromElement(noteElement, viewportBounds);
            if (point) {
                return point;
            }
        }
    }

    return null;
}

function getMarkerAnchorInPage(pageRect: DOMRect | null, note: IAnnotationNoteWindowEntry, viewportBounds: TViewportBounds) {
    const markerRect = getNoteMarkerRect(note);
    if (!markerRect) {
        return null;
    }
    if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0 || !rectsIntersect(pageRect, viewportBounds)) {
        return null;
    }
    const cx = pageRect.left + clamp(markerRect.left + markerRect.width, 0, 1) * pageRect.width;
    const cy = pageRect.top + clamp(markerRect.top, 0, 1) * pageRect.height;
    if (!pointInRect(cx, cy, viewportBounds)) {
        return null;
    }
    return {
        cx,
        cy,
        radius: 0,
    };
}

function getRenderedNoteRect(overlayRoot: HTMLElement | null, annotationId: string): INoteViewportRect | null {
    if (!overlayRoot) {
        return null;
    }
    const noteElement = overlayRoot.querySelector<HTMLElement>(`.note-window[data-annotation-id="${escapeCssAttr(annotationId)}"]`);
    const rect = noteElement?.getBoundingClientRect() ?? null;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
    };
}

function getNoteViewportRect(overlayRoot: HTMLElement | null, annotationId: string, position: IAnnotationNotePosition): INoteViewportRect {
    return (
        getRenderedNoteRect(overlayRoot, annotationId) ?? {
            left: position.x,
            top: position.y,
            width: position.width ?? NOTE_WINDOW.DEFAULT_WIDTH,
            height: position.height ?? NOTE_WINDOW.DEFAULT_HEIGHT,
        }
    );
}

function getNoteConnectorAnchor(noteRect: INoteViewportRect, marker: IConnectorMarkerPoint) {
    const {left, top} = noteRect;
    const right = left + noteRect.width;
    const bottom = top + noteRect.height;
    const centerX = left + noteRect.width / 2;
    const centerY = top + noteRect.height / 2;
    const dx = marker.cx - centerX;
    const dy = marker.cy - centerY;
    if (dx === 0 && dy === 0) {
        return {
            x: centerX,
            y: top,
        };
    }

    const scaleToVerticalEdge = dx === 0 ? Number.POSITIVE_INFINITY : noteRect.width / 2 / Math.abs(dx);
    const scaleToHorizontalEdge = dy === 0 ? Number.POSITIVE_INFINITY : noteRect.height / 2 / Math.abs(dy);
    if (scaleToVerticalEdge < scaleToHorizontalEdge) {
        return {
            x: dx < 0 ? left : right,
            y: clamp(centerY + dy * scaleToVerticalEdge, top + NOTE_WINDOW.MARGIN, bottom - NOTE_WINDOW.MARGIN),
        };
    }

    return {
        x: clamp(centerX + dx * scaleToHorizontalEdge, left + NOTE_WINDOW.MARGIN, right - NOTE_WINDOW.MARGIN),
        y: dy < 0 ? top : bottom,
    };
}

function getConnectorStart(
    marker: IConnectorMarkerPoint,
    noteAnchor: {
        x: number;
        y: number;
    },
) {
    const dx = noteAnchor.x - marker.cx;
    const dy = noteAnchor.y - marker.cy;
    const distance = Math.hypot(dx, dy);
    if (marker.radius <= 0 || distance <= 0) {
        return {
            x: marker.cx,
            y: marker.cy,
        };
    }
    const offset = Math.min(marker.radius, distance / 2);
    return {
        x: marker.cx + (dx / distance) * offset,
        y: marker.cy + (dy / distance) * offset,
    };
}

function getNoteRenderSignature(note: IAnnotationNoteWindowEntry) {
    const rect = getNoteMarkerRect(note);
    return [
        note.annotationId,
        note.pageNumber,
        note.color ?? '',
        rect?.left ?? '',
        rect?.top ?? '',
        rect?.width ?? '',
        rect?.height ?? '',
    ].join(':');
}

function mapNotesToPageTargets(notes: readonly IAnnotationNoteWindowEntry[], pageElements: ReadonlyMap<number, HTMLElement>) {
    if (notes.length === 0 || pageElements.size === 0) {
        return {};
    }
    const targets: Record<string, HTMLElement> = {};
    notes.forEach((note) => {
        const pageContainer = pageElements.get(note.pageNumber);
        if (pageContainer) {
            targets[note.annotationId] = pageContainer;
        }
    });
    return targets;
}

/**
 * Overlay runtime for the annotation note windows, anchors and connectors.
 *
 * Every binding below is created inside this invocation, so the refs, frame
 * scheduler, computeds, watchers and DOM listeners all
 * belong to the calling component instance and its effect scope — exactly as
 * they did while they lived in the SFC's `<script setup>` body. Nothing here is
 * module-scoped mutable state, so two mounted overlays never share a tick
 * counter, a connector list or a pending timer.
 */
export function createAnnotationOverlayRuntime(options: IAnnotationOverlayRuntimeOptions) {
    const structureDomTick = ref(0);
    const geometryDomTick = ref(0);
    const connectorLines = shallowRef<IConnectorLine[]>([]);

    const viewportRootElement = computed(() => options.getViewportRoot());
    const noteWindows = computed(() => options.getNoteWindows());
    const visibleAnnotationNoteWindows = computed(() => noteWindows.value.filter((note) => !note.isMinimized));
    const floatingEligibleNotes = computed(() =>
        noteWindows.value.filter((note) => isFloatingIndicatorEligible(note) && Boolean(getNoteMarkerRect(note))),
    );
    const openNoteAnchors = computed(() =>
        visibleAnnotationNoteWindows.value.filter((note) => isFloatingIndicatorEligible(note) && Boolean(getNoteMarkerRect(note))),
    );

    const openNotePageNumbers = computed<ReadonlySet<number>>((previous) => {
        const pages = new Set<number>();
        for (const note of visibleAnnotationNoteWindows.value) {
            pages.add(note.pageNumber);
        }
        return reuseEqualPageSet(previous, pages);
    });
    const trackedPageNumbers = computed<ReadonlySet<number>>((previous) => {
        const pages = new Set<number>(openNotePageNumbers.value);
        for (const note of floatingEligibleNotes.value) {
            pages.add(note.pageNumber);
        }
        return reuseEqualPageSet(previous, pages);
    });
    const hasOpenNoteWindows = computed(() => visibleAnnotationNoteWindows.value.length > 0);
    const hasTrackedNotes = computed(() => trackedPageNumbers.value.size > 0);

    const trackedPageElements = computed<Map<number, HTMLElement>>(() => {
        void structureDomTick.value;
        return collectTrackedPageElements(viewportRootElement.value, trackedPageNumbers.value);
    });
    const viewportDomSnapshot = computed<IViewportDomSnapshot | null>(() => {
        if (!hasOpenNoteWindows.value) {
            return null;
        }
        void geometryDomTick.value;
        return collectViewportDomSnapshot(viewportRootElement.value, trackedPageElements.value, openNotePageNumbers.value);
    });
    const renderedInlineAnchorIdentity = computed(() =>
        collectRenderedInlineAnchorIdentity(trackedPageElements.value, floatingEligibleNotes.value),
    );
    // A page waiting for its re-read paints neither the inline marker nor a fallback for it.
    const hasInlineMarker = (note: IAnnotationNoteWindowEntry) =>
        !options.paintsPage(note.pageIndex) || inlineIdentityMatchesNote(renderedInlineAnchorIdentity.value, note);

    const openAnchorHiddenKeys = computed(() => new Set(openNoteAnchors.value.filter(hasInlineMarker).map((note) => note.annotationId)));
    const anchoredAnnotationNoteWindows = computed(() =>
        floatingEligibleNotes.value.filter((note) => note.isMinimized && !hasInlineMarker(note)),
    );
    const minimizedIndicatorTargets = computed(() => mapNotesToPageTargets(anchoredAnnotationNoteWindows.value, trackedPageElements.value));
    const openNoteAnchorTargets = computed(() => mapNotesToPageTargets(openNoteAnchors.value, trackedPageElements.value));

    function computeConnectorLines(): IConnectorLine[] {
        const anchors = openNoteAnchors.value;
        if (anchors.length === 0) {
            return [];
        }
        const snapshot = viewportDomSnapshot.value;
        if (!snapshot) {
            return [];
        }
        const positions = options.getNotePositions();
        const viewportBounds = snapshot.bounds;
        return anchors.flatMap((note) => {
            const position = positions[note.annotationId];
            const page = snapshot.pageContainers.get(note.pageNumber);
            if (
                !position ||
                !page ||
                !page.rect ||
                !rectsIntersectWithMargin(page.rect, viewportBounds, CONNECTOR_PAGE_OVERFLOW_MARGIN_PX)
            ) {
                return [];
            }
            const marker =
                getRenderedNoteCenter(page.element, note.annotationId, viewportBounds) ??
                getMarkerAnchorInPage(page.rect, note, viewportBounds);
            if (!marker) {
                return [];
            }
            const noteAnchor = getNoteConnectorAnchor(getNoteViewportRect(options.getWorkspaceRoot(), note.annotationId, position), marker);
            const markerStart = getConnectorStart(marker, noteAnchor);
            return [
                {
                    annotationId: note.annotationId,
                    color: note.color ?? null,
                    path: `M ${markerStart.x} ${markerStart.y} L ${noteAnchor.x} ${noteAnchor.y}`,
                },
            ];
        });
    }

    // Scroll, resize, zoom, tracked viewport DOM changes and the positions note
    // windows report as applied refresh only the needed layer in the next frame.
    let pendingStructureRefresh = false;
    let pendingGeometryRefresh = false;
    const indicatorDomRefreshScheduler = createRafBurstScheduler(() => {
        const shouldRefreshStructure = pendingStructureRefresh;
        const shouldRefreshGeometry = pendingGeometryRefresh;
        pendingStructureRefresh = false;
        pendingGeometryRefresh = false;
        if (shouldRefreshStructure && hasTrackedNotes.value) {
            structureDomTick.value += 1;
        }
        if (shouldRefreshGeometry && hasOpenNoteWindows.value) {
            geometryDomTick.value += 1;
        }
    });
    const requestDomRefresh = (flags: {structure?: boolean; geometry?: boolean}) => {
        const nextStructure = Boolean(flags.structure) && hasTrackedNotes.value;
        const nextGeometry = Boolean(flags.geometry) && hasOpenNoteWindows.value;
        if (!nextStructure && !nextGeometry) {
            return;
        }
        pendingStructureRefresh ||= nextStructure;
        pendingGeometryRefresh ||= nextGeometry;
        indicatorDomRefreshScheduler.request();
    };
    const refreshViewportDom = () => requestDomRefresh({geometry: true});
    const handleViewportMutations = (records: MutationRecord[]) => {
        if (!mutationAffectsTrackedPages(records, trackedPageNumbers.value)) {
            return;
        }
        requestDomRefresh({
            structure: true,
            geometry: hasOpenNoteWindows.value,
        });
    };

    // Note followers apply the shared geometry before connector DOM readings.
    watch(
        [
            () => (openNoteAnchors.value.length > 0 ? viewportDomSnapshot.value : null),
            () => openNoteAnchors.value.map(getNoteRenderSignature).join('|'),
        ],
        () => {
            if (openNoteAnchors.value.length === 0) {
                if (connectorLines.value.length > 0) {
                    connectorLines.value = [];
                }
                return;
            }
            connectorLines.value = computeConnectorLines();
        },
        {flush: 'post'},
    );

    function getMinimizedIndicatorStyle(note: IAnnotationNoteWindowEntry) {
        void options.getZoom();

        const markerRect = getNoteMarkerRect(note);
        if (!markerRect) {
            return {display: 'none'};
        }
        return {
            '--annotation-note-color': note.color ?? 'var(--ui-warning)',
            left: `${clamp((markerRect.left + markerRect.width) * 100, 1, 99)}%`,
            top: `${clamp(markerRect.top * 100, 1, 99)}%`,
            zIndex: String(resolveNoteWindowAnchorZIndex(note.order)),
        };
    }

    function getMinimizedNotePreview(note: IAnnotationNoteWindowEntry) {
        const text = note.draftText.trim();
        if (!text) {
            return options.getEmptyNoteLabel();
        }
        return text.length <= 180 ? text : `${text.slice(0, 177)}...`;
    }

    function traceAnchorInteraction(message: string, note: IAnnotationNoteWindowEntry) {
        BrowserLogger.debug('note-anchor', message, () => ({
            annotationId: note.annotationId,
            pageNumber: note.pageNumber,
            markerRect: getNoteMarkerRect(note),
            isMinimized: note.isMinimized,
        }));
    }

    onBeforeUnmount(() => {
        pendingStructureRefresh = false;
        pendingGeometryRefresh = false;
        indicatorDomRefreshScheduler.cancel();
        connectorLines.value = [];
    });

    const openNoteScrollTarget = computed(() => (hasOpenNoteWindows.value ? viewportRootElement.value : null));
    const openNoteWindowTarget = computed(() => (import.meta.client && hasOpenNoteWindows.value ? window : undefined));
    const mutationObserverTarget = computed(() => (hasTrackedNotes.value ? viewportRootElement.value : null));

    useEventListener(openNoteScrollTarget, 'scroll', refreshViewportDom, {passive: true});
    useEventListener(openNoteWindowTarget, 'resize', refreshViewportDom, {passive: true});
    const resizeTargets = computed<HTMLElement[]>((previous) => {
        if (!hasOpenNoteWindows.value) {
            return [];
        }
        const root = viewportRootElement.value;
        if (!root) {
            return [];
        }
        const targets: HTMLElement[] = [root.ownerDocument.documentElement, root];
        const pageTrack = root.querySelector<HTMLElement>('[data-pdf-page-track]');
        if (pageTrack && pageTrack !== root) {
            targets.push(pageTrack);
        }
        openNotePageNumbers.value.forEach((pageNumber) => {
            const pageContainer = trackedPageElements.value.get(pageNumber);
            if (pageContainer) {
                targets.push(pageContainer);
            }
        });
        return previous && targets.length === previous.length && targets.every((target, index) => target === previous[index])
            ? previous
            : targets;
    });
    useResizeObserver(resizeTargets, refreshViewportDom);
    useMutationObserver(mutationObserverTarget, handleViewportMutations, {
        childList: true,
        subtree: true,
    });
    watch(
        () => options.getZoom(),
        () => {
            requestDomRefresh({
                structure: hasTrackedNotes.value,
                geometry: hasOpenNoteWindows.value,
            });
        },
    );
    watch(
        () => options.isVisible?.() ?? true,
        (nextVisible, previousVisible) => {
            if (nextVisible && previousVisible === false) {
                requestDomRefresh({
                    structure: hasTrackedNotes.value,
                    geometry: hasOpenNoteWindows.value,
                });
            }
        },
    );
    watch(hasTrackedNotes, (active) => {
        if (!active) {
            pendingStructureRefresh = false;
            pendingGeometryRefresh = false;
            indicatorDomRefreshScheduler.cancel();
        }
    });
    watch(hasOpenNoteWindows, (active) => {
        if (!active) {
            pendingGeometryRefresh = false;
            if (!pendingStructureRefresh) {
                indicatorDomRefreshScheduler.cancel();
            }
        }
    });

    return {
        viewportDomSnapshot,
        visibleAnnotationNoteWindows,
        anchoredAnnotationNoteWindows,
        openNoteAnchors,
        openAnchorHiddenKeys,
        minimizedIndicatorTargets,
        openNoteAnchorTargets,
        connectorLines,
        getMinimizedIndicatorStyle,
        getMinimizedNotePreview,
        traceAnchorInteraction,
        refreshViewportDom,
    };
}
