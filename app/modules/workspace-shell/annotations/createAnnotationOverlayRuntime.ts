import { clamp } from 'es-toolkit/math';
import {
    useEventListener,
    useMutationObserver,
} from '@vueuse/core';
import type { IAnnotationNotePosition } from '@app/types/annotationNoteWindow';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import {
    normalizeMarkerRect,
    escapeCssAttr,
} from '@app/modules/pdf-viewer/public';
import {
    NOTE_WINDOW,
    resolveNoteWindowAnchorZIndex,
} from '@app/constants/pdfLayout';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createRafBurstScheduler } from '@app/modules/workspace-shell/scheduling/createRafBurstScheduler';
import type { IAnnotationNoteWindowEntry } from '@app/modules/workspace-shell/annotations/annotationNoteWindowEntry';

const INLINE_NOTE_SUBTYPES = new Set([
    'text',
    'note-linked',
    'note-inline',
]);
const FREE_TEXT_NOTE_SUBTYPES = new Set([
    'freetext',
    'typewriter',
]);
const INLINE_MARKER_PROXIMITY = 0.08;

interface IInlineTriggerIdentity {
    annotationIds: Set<string>;
    notePoints: Array<{
        pageNumber: number;
        x: number;
        y: number;
    }>;
}

interface IViewportDomSnapshot { pageContainers: Map<number, HTMLElement> }

interface IConnectorLine {
    annotationId: string;
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
}

function getNoteMarkerRect(note: IAnnotationNoteWindowEntry) {
    return normalizeMarkerRect(note.markerRect);
}

function resolveKnownFloatingEligibility(note: IAnnotationNoteWindowEntry, subtype: string) {
    if (isTextMarkupSubtype(note.subtype) && note.hasNote) {
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

function collectViewportDomSnapshot(viewportRoot: HTMLElement | null): IViewportDomSnapshot | null {
    if (!viewportRoot) {
        return null;
    }

    const pageContainers = new Map<number, HTMLElement>();
    viewportRoot.querySelectorAll<HTMLElement>('.page_container').forEach((pageContainer) => {
        const pageNumberRaw = Number(pageContainer.dataset.page ?? '');
        if (!Number.isFinite(pageNumberRaw) || pageNumberRaw <= 0) {
            return;
        }
        pageContainers.set(pageNumberRaw, pageContainer);
    });

    return { pageContainers };
}

function collectRenderedInlineAnchorIdentity(snapshot: IViewportDomSnapshot | null): IInlineTriggerIdentity {
    const identity: IInlineTriggerIdentity = {
        annotationIds: new Set<string>(),
        notePoints: [],
    };
    if (!snapshot) {
        return identity;
    }

    snapshot.pageContainers.forEach((pageContainer, pageNumber) => {
        const pageRect = pageContainer.getBoundingClientRect();
        pageContainer
            .querySelectorAll<HTMLElement>('.pdf-annotation-editor-note[data-annotation-id]')
            .forEach((noteElement) => {
                const annotationId = noteElement.dataset.annotationId;
                if (annotationId) {
                    identity.annotationIds.add(annotationId);
                }

                const noteRect = noteElement.getBoundingClientRect();
                if (
                    pageRect.width <= 0
                    || pageRect.height <= 0
                    || noteRect.width <= 0
                    || noteRect.height <= 0
                ) {
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

function inlineIdentityMatchesNote(
    inlineIdentity: IInlineTriggerIdentity,
    note: IAnnotationNoteWindowEntry,
) {
    if (inlineIdentity.annotationIds.has(note.annotationId)) {
        return true;
    }
    const markerRect = getNoteMarkerRect(note);
    if (!markerRect) {
        return false;
    }
    const noteAnchorX = clamp(markerRect.left + markerRect.width, 0, 1);
    const noteAnchorY = clamp(markerRect.top, 0, 1);
    return inlineIdentity.notePoints.some(point => (
        point.pageNumber === note.pageNumber
        && Math.hypot(point.x - noteAnchorX, point.y - noteAnchorY) <= INLINE_MARKER_PROXIMITY
    ));
}

function rectsIntersect(rect: TViewportBounds, bounds: TViewportBounds) {
    return (
        rect.right >= bounds.left
        && rect.left <= bounds.right
        && rect.bottom >= bounds.top
        && rect.top <= bounds.bottom
    );
}

function pointInRect(x: number, y: number, rect: TViewportBounds) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function getNotePointFromElement(
    noteElement: HTMLElement,
    viewportBounds: TViewportBounds,
): IConnectorMarkerPoint | null {
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

function getRenderedNoteCenter(
    pageContainer: HTMLElement,
    annotationId: string,
    viewportBounds: TViewportBounds,
) {
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

function getMarkerAnchorInPage(
    pageContainer: HTMLElement,
    note: IAnnotationNoteWindowEntry,
    viewportBounds: TViewportBounds,
) {
    const markerRect = getNoteMarkerRect(note);
    if (!markerRect) {
        return null;
    }
    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0 || !rectsIntersect(pageRect, viewportBounds)) {
        return null;
    }
    const cx = pageRect.left + (clamp(markerRect.left + markerRect.width, 0, 1) * pageRect.width);
    const cy = pageRect.top + (clamp(markerRect.top, 0, 1) * pageRect.height);
    if (!pointInRect(cx, cy, viewportBounds)) {
        return null;
    }
    return {
        cx,
        cy,
        radius: 0,
    };
}

function getRenderedNoteRect(
    overlayRoot: HTMLElement | null,
    annotationId: string,
): INoteViewportRect | null {
    if (!overlayRoot) {
        return null;
    }
    const noteElement = overlayRoot.querySelector<HTMLElement>(
        `.note-window[data-annotation-id="${escapeCssAttr(annotationId)}"]`,
    );
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

function getNoteViewportRect(
    overlayRoot: HTMLElement | null,
    annotationId: string,
    position: IAnnotationNotePosition,
): INoteViewportRect {
    return getRenderedNoteRect(overlayRoot, annotationId) ?? {
        left: position.x,
        top: position.y,
        width: position.width ?? NOTE_WINDOW.DEFAULT_WIDTH,
        height: position.height ?? NOTE_WINDOW.DEFAULT_HEIGHT,
    };
}

function getNoteConnectorAnchor(noteRect: INoteViewportRect, marker: IConnectorMarkerPoint) {
    const {
        left,
        top,
    } = noteRect;
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

    const scaleToVerticalEdge = dx === 0 ? Number.POSITIVE_INFINITY : (noteRect.width / 2) / Math.abs(dx);
    const scaleToHorizontalEdge = dy === 0 ? Number.POSITIVE_INFINITY : (noteRect.height / 2) / Math.abs(dy);
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
        rect?.left ?? '',
        rect?.top ?? '',
        rect?.width ?? '',
        rect?.height ?? '',
    ].join(':');
}

function mapNotesToPageTargets(
    notes: readonly IAnnotationNoteWindowEntry[],
    snapshot: IViewportDomSnapshot | null,
) {
    if (!snapshot) {
        return {};
    }
    const targets: Record<string, HTMLElement> = {};
    notes.forEach((note) => {
        const pageContainer = snapshot.pageContainers.get(note.pageNumber);
        if (pageContainer) {
            targets[note.annotationId] = pageContainer;
        }
    });
    return targets;
}

/**
 * Overlay runtime for the annotation note windows, anchors and connectors.
 *
 * Every binding below is created inside this invocation, so the refs, burst
 * schedulers, drag-suppression timer, computeds, watchers and DOM listeners all
 * belong to the calling component instance and its effect scope — exactly as
 * they did while they lived in the SFC's `<script setup>` body. Nothing here is
 * module-scoped mutable state, so two mounted overlays never share a tick
 * counter, a connector list or a pending timer.
 */
export function createAnnotationOverlayRuntime(options: IAnnotationOverlayRuntimeOptions) {
    const indicatorDomTick = ref(0);
    const connectorLines = shallowRef<IConnectorLine[]>([]);

    const viewportRootElement = computed(() => options.getViewportRoot());
    const viewportDomSnapshot = computed<IViewportDomSnapshot | null>(() => {
        void indicatorDomTick.value;
        return collectViewportDomSnapshot(options.getViewportRoot());
    });
    const renderedInlineAnchorIdentity = computed(() =>
        collectRenderedInlineAnchorIdentity(viewportDomSnapshot.value));

    const visibleAnnotationNoteWindows = computed(() =>
        options.getNoteWindows().filter(note => !note.isMinimized));
    const openNoteAnchors = computed(() => visibleAnnotationNoteWindows.value.filter(note => (
        isFloatingIndicatorEligible(note) && Boolean(getNoteMarkerRect(note))
    )));
    const openAnchorHiddenKeys = computed(() => new Set(
        openNoteAnchors.value
            .filter(note => inlineIdentityMatchesNote(renderedInlineAnchorIdentity.value, note))
            .map(note => note.annotationId),
    ));
    const anchoredAnnotationNoteWindows = computed(() => options.getNoteWindows().filter(note => (
        note.isMinimized
        && isFloatingIndicatorEligible(note)
        && Boolean(getNoteMarkerRect(note))
        && !inlineIdentityMatchesNote(renderedInlineAnchorIdentity.value, note)
    )));
    const minimizedIndicatorTargets = computed(() =>
        mapNotesToPageTargets(anchoredAnnotationNoteWindows.value, viewportDomSnapshot.value));
    const openNoteAnchorTargets = computed(() =>
        mapNotesToPageTargets(openNoteAnchors.value, viewportDomSnapshot.value));

    function getConnectorViewportBounds(): TViewportBounds {
        const rootRect = options.getViewportRoot()?.getBoundingClientRect() ?? null;
        if (rootRect && rootRect.width > 0 && rootRect.height > 0) {
            return rootRect;
        }
        return {
            left: 0,
            top: 0,
            right: typeof window === 'undefined' ? 0 : window.innerWidth,
            bottom: typeof window === 'undefined' ? 0 : window.innerHeight,
        };
    }

    function computeConnectorLines(): IConnectorLine[] {
        const snapshot = viewportDomSnapshot.value;
        if (!snapshot) {
            return [];
        }
        const positions = options.getNotePositions();
        const viewportBounds = getConnectorViewportBounds();
        return openNoteAnchors.value.flatMap((note) => {
            const position = positions[note.annotationId];
            const pageContainer = snapshot.pageContainers.get(note.pageNumber) ?? null;
            if (!position || !pageContainer) {
                return [];
            }
            const marker = getRenderedNoteCenter(pageContainer, note.annotationId, viewportBounds)
                ?? getMarkerAnchorInPage(pageContainer, note, viewportBounds);
            if (!marker) {
                return [];
            }
            const noteAnchor = getNoteConnectorAnchor(
                getNoteViewportRect(options.getWorkspaceRoot(), note.annotationId, position),
                marker,
            );
            const markerStart = getConnectorStart(marker, noteAnchor);
            return [{
                annotationId: note.annotationId,
                path: `M ${markerStart.x} ${markerStart.y} L ${noteAnchor.x} ${noteAnchor.y}`,
            }];
        });
    }

    const indicatorDomRefreshScheduler = createRafBurstScheduler(() => {
        indicatorDomTick.value += 1;
        connectorLines.value = computeConnectorLines();
    });
    const connectorRefreshScheduler = createRafBurstScheduler(() => {
        connectorLines.value = computeConnectorLines();
    });

    function scheduleOverlayRefreshBurst(frames = 6) {
        indicatorDomRefreshScheduler.request(frames);
    }

    function scheduleConnectorRefreshBurst(frames = 2) {
        connectorRefreshScheduler.request(frames);
    }

    function getMinimizedIndicatorStyle(note: IAnnotationNoteWindowEntry) {
        void options.getZoom();

        const markerRect = getNoteMarkerRect(note);
        if (!markerRect) {
            return {display: 'none'};
        }
        return {
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

    onMounted(() => scheduleOverlayRefreshBurst(10));
    onBeforeUnmount(() => {
        indicatorDomRefreshScheduler.cancel();
        connectorRefreshScheduler.cancel();
        connectorLines.value = [];
    });

    useEventListener(viewportRootElement, 'scroll', () => scheduleConnectorRefreshBurst(1), { passive: true });
    useEventListener(
        import.meta.client ? window : undefined,
        'resize',
        () => scheduleConnectorRefreshBurst(1),
        { passive: true },
    );
    useMutationObserver(viewportRootElement, () => scheduleOverlayRefreshBurst(4), {
        childList: true,
        subtree: true,
    });

    watch(viewportRootElement, () => scheduleOverlayRefreshBurst(12));
    watch(() => options.getZoom(), () => scheduleConnectorRefreshBurst(1));
    watch(
        () => anchoredAnnotationNoteWindows.value.map(getNoteRenderSignature),
        () => scheduleOverlayRefreshBurst(6),
    );
    watch(
        () => visibleAnnotationNoteWindows.value.map(getNoteRenderSignature),
        () => scheduleOverlayRefreshBurst(6),
    );
    watch(
        () => Object.entries(options.getNotePositions())
            .map(([
                annotationId,
                position,
            ]) => [
                annotationId,
                position.x,
                position.y,
                position.width ?? '',
                position.height ?? '',
            ].join(':'))
            .sort(),
        () => scheduleConnectorRefreshBurst(1),
    );

    return {
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
        scheduleConnectorRefreshBurst,
    };
}
