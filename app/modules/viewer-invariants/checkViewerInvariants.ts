import { HORIZONTAL_SCROLL_CLAMP_EPSILON_PX } from '@app/modules/pdf-viewer/public/domContracts';
import { readViewerSurface } from '@app/modules/viewer-invariants/readViewerSurface';
import {
    clearViewerDiagnosticNotices,
    ensureViewerDiagnosticLog,
    readViewerDiagnosticNotices,
} from '@app/modules/viewer-invariants/viewerDiagnosticLog';
import type {
    IViewerConsoleAllowlistEntry,
    IViewerInvariantNoteWindow,
    IViewerInvariantOptions,
    IViewerInvariantOverlay,
    IViewerInvariantPage,
    IViewerInvariantReport,
    IViewerInvariantSkip,
    IViewerInvariantUnresolved,
    IViewerInvariantViolation,
    IViewerObservedIdentities,
    IViewerRect,
    IViewerSurface,
} from '@app/modules/viewer-invariants/viewerInvariantTypes';

/** Device-pixel rounding at DPR 2 costs at most one CSS pixel. */
const GEOMETRY_TOLERANCE_PX = 1;
/** A page counts as visible once a reader could act on it. */
const MIN_VISIBLE_PAGE_FRACTION = 0.25;
/** Strokes, decorations and selection chrome legitimately overhang the page. */
const OVERLAY_CENTER_SLACK_PX = 24;
/** Normalized drift a settled annotation may not exceed between observations. */
const MAX_NORMALIZED_DRIFT = 0.005;
/** A note window must track its anchor to within a rounding error. */
const NOTE_WINDOW_FOLLOW_TOLERANCE_PX = 2;

/**
 * Renderer diagnostics that are expected during ordinary use. Every entry
 * needs a narrow signature and a written reason; a broad substring is not an
 * allowlist entry. The renderer error guard's own ignore filter already drops
 * known-benign runtime errors before they reach a notice, so this list stays
 * empty until a real repeat offender is identified and justified.
 */
export const VIEWER_INVARIANT_CONSOLE_ALLOWLIST: readonly IViewerConsoleAllowlistEntry[] = [];

interface IRememberedOverlay {
    centerX: number;
    centerY: number;
    height: number;
    pageNumber: number;
    screenSized: boolean;
    viewRotation: number;
    width: number;
}

interface IRememberedNoteWindow {
    anchorHeight: number;
    anchorLeft: number;
    anchorPageNumber: number;
    anchorTop: number;
    anchorVisible: boolean;
    anchorWidth: number;
    clamped: boolean;
    left: number;
    top: number;
    userPlacementSequence: number;
}

interface IViewerInvariantMemory {
    noteWindows: Map<string, IRememberedNoteWindow>;
    overlays: Map<string, IRememberedOverlay>;
    workspaceTabId: string | null;
}

const memory: IViewerInvariantMemory = {
    noteWindows: new Map(),
    overlays: new Map(),
    workspaceTabId: null,
};

/** Drops the two-observation memory, for a test that starts a new sequence. */
export function resetViewerInvariantMemory() {
    memory.noteWindows.clear();
    memory.overlays.clear();
    memory.workspaceTabId = null;
    clearViewerDiagnosticNotices();
}

/**
 * A remembered observation belongs to the workspace it was taken in. Annotation
 * ids are only unique inside one document, so comparing across a tab switch or
 * a document change would invent drift out of two unrelated documents that
 * happen to number their annotations the same way.
 */
function forgetOtherWorkspace(surface: IViewerSurface, remember: boolean) {
    if (memory.workspaceTabId === surface.workspaceTabId) {
        return;
    }
    memory.noteWindows.clear();
    memory.overlays.clear();
    if (remember) {
        memory.workspaceTabId = surface.workspaceTabId;
    }
}

function right(rect: IViewerRect) {
    return rect.left + rect.width;
}

function bottom(rect: IViewerRect) {
    return rect.top + rect.height;
}

function verticalOverlap(first: IViewerRect, second: IViewerRect) {
    return Math.max(0, Math.min(bottom(first), bottom(second)) - Math.max(first.top, second.top));
}

function intersects(first: IViewerRect, second: IViewerRect) {
    return right(first) > second.left
        && first.left < right(second)
        && bottom(first) > second.top
        && first.top < bottom(second);
}

function roundRect(rect: IViewerRect) {
    return {
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
    };
}

function findVisiblePages(surface: IViewerSurface) {
    return surface.pages.filter((page) => {
        const overlap = verticalOverlap(page.rect, surface.viewportRect);
        const threshold = MIN_VISIBLE_PAGE_FRACTION
            * Math.min(page.rect.height, surface.viewportRect.height);
        return threshold > 0
            && overlap >= threshold
            && right(page.rect) > surface.viewportRect.left
            && page.rect.left < right(surface.viewportRect);
    });
}

/**
 * R1: the page number the toolbar renders must be a page a reader can actually
 * see. Which of two visible pages should win is an undecided product rule, so
 * the invariant deliberately accepts any visible page, including either page
 * of a facing spread. It still catches a frozen or desynced counter.
 */
function checkToolbarPageVisible(
    surface: IViewerSurface,
    visiblePages: readonly IViewerInvariantPage[],
    violations: IViewerInvariantViolation[],
    skipped: IViewerInvariantSkip[],
) {
    if (surface.toolbarPageNumber === null) {
        skipped.push({
            id: 'R1-toolbar-page-visible',
            reason: surface.toolbarPageText === null
                ? 'the toolbar page control is not on screen'
                : `the toolbar page reads "${surface.toolbarPageText}", which is not a physical page number`,
        });
        return;
    }
    if (visiblePages.length === 0) {
        skipped.push({
            id: 'R1-toolbar-page-visible',
            reason: 'no page covers enough of the viewport yet',
        });
        return;
    }
    if (visiblePages.some(page => page.pageNumber === surface.toolbarPageNumber)) {
        return;
    }
    violations.push({
        evidence: {
            toolbarPageNumber: surface.toolbarPageNumber,
            toolbarPageText: surface.toolbarPageText,
            viewMode: surface.viewMode,
            viewportRect: roundRect(surface.viewportRect),
            visiblePages: visiblePages.map(page => ({
                pageNumber: page.pageNumber,
                rect: roundRect(page.rect),
            })),
        },
        id: 'R1-toolbar-page-visible',
        message: `the toolbar reads page ${String(surface.toolbarPageNumber)}`
            + ` while the viewport shows ${visiblePages.map(page => page.pageNumber).join(', ')}`,
    });
}

function resolveCurrentUnit(
    surface: IViewerSurface,
    visiblePages: readonly IViewerInvariantPage[],
) {
    const currentPage = visiblePages.find(page => page.pageNumber === surface.toolbarPageNumber)
        ?? [...visiblePages].sort((left, rightPage) => (
            verticalOverlap(rightPage.rect, surface.viewportRect)
            - verticalOverlap(left.rect, surface.viewportRect)
        ))[0];
    return currentPage ?? null;
}

/**
 * L1: fit-width constrains the current page or spread, not the document. A
 * mixed-width document may legitimately need a horizontal range for a wider
 * page elsewhere, so the invariant only applies when nothing visible is wider
 * than the current unit. Fit-height applies to the current page in paged mode.
 */
function checkFitModeScrollRange(
    surface: IViewerSurface,
    visiblePages: readonly IViewerInvariantPage[],
    violations: IViewerInvariantViolation[],
    skipped: IViewerInvariantSkip[],
) {
    if (surface.zoomMode === 'custom') {
        skipped.push({
            id: 'L1-fit-mode-scroll-range',
            reason: 'the viewer is at a custom zoom, not a fit mode',
        });
        return;
    }
    const currentPage = resolveCurrentUnit(surface, visiblePages);
    if (!currentPage) {
        skipped.push({
            id: 'L1-fit-mode-scroll-range',
            reason: 'no page covers enough of the viewport yet',
        });
        return;
    }

    if (surface.zoomMode === 'fit-width') {
        const currentWidth = (currentPage.rowRect ?? currentPage.rect).width;
        const widerPage = visiblePages.find(page => (
            (page.rowRect ?? page.rect).width > currentWidth + GEOMETRY_TOLERANCE_PX
        ));
        if (widerPage) {
            skipped.push({
                id: 'L1-fit-mode-scroll-range',
                reason: `page ${String(widerPage.pageNumber)} is wider than the current page,`
                    + ' so a horizontal range is expected',
            });
            return;
        }
        if (surface.horizontalScrollRangePx > HORIZONTAL_SCROLL_CLAMP_EPSILON_PX) {
            violations.push({
                evidence: {
                    currentPageNumber: currentPage.pageNumber,
                    currentUnitWidth: Math.round(currentWidth),
                    horizontalScrollRangePx: Math.round(surface.horizontalScrollRangePx),
                    viewportWidth: Math.round(surface.viewportRect.width),
                },
                id: 'L1-fit-mode-scroll-range',
                message: `fit-width left ${surface.horizontalScrollRangePx.toFixed(1)}px of horizontal`
                    + ' scroll range while no visible page is wider than the current one',
            });
        }
        return;
    }

    if (surface.continuousScroll) {
        skipped.push({
            id: 'L1-fit-mode-scroll-range',
            reason: 'fit-height bounds one page, which only holds in paged mode',
        });
        return;
    }
    if (surface.verticalScrollRangePx > GEOMETRY_TOLERANCE_PX) {
        violations.push({
            evidence: {
                currentPageNumber: currentPage.pageNumber,
                currentPageHeight: Math.round((currentPage.rowRect ?? currentPage.rect).height),
                verticalScrollRangePx: Math.round(surface.verticalScrollRangePx),
                viewportHeight: Math.round(surface.viewportRect.height),
            },
            id: 'L1-fit-mode-scroll-range',
            message: `fit-height in paged mode left ${surface.verticalScrollRangePx.toFixed(1)}px`
                + ' of vertical scroll range',
        });
    }
}

/**
 * A1 stateless: an overlay belongs to its page. Containment is not literal,
 * because a stroke or decoration drawn at the edge paints outside it, so the
 * box has to intersect the page and its centre has to stay within a small
 * margin of it.
 */
function checkOverlayContainment(
    surface: IViewerSurface,
    pagesByNumber: Map<number, IViewerInvariantPage>,
    violations: IViewerInvariantViolation[],
    skipped: IViewerInvariantSkip[],
) {
    const checkable = surface.overlays.filter(overlay => (
        !overlay.outsidePage && pagesByNumber.has(overlay.pageNumber)
    ));
    if (checkable.length === 0) {
        skipped.push({
            id: 'A1-annotation-page-containment',
            reason: surface.overlays.length === 0
                ? 'no annotation overlay is mounted'
                : 'every mounted overlay is marked as drawn past the page edge',
        });
        return;
    }

    for (const overlay of checkable) {
        const page = pagesByNumber.get(overlay.pageNumber)!;
        const centerX = overlay.rect.left + overlay.rect.width / 2;
        const centerY = overlay.rect.top + overlay.rect.height / 2;
        const centerInside = centerX >= page.rect.left - OVERLAY_CENTER_SLACK_PX
            && centerX <= right(page.rect) + OVERLAY_CENTER_SLACK_PX
            && centerY >= page.rect.top - OVERLAY_CENTER_SLACK_PX
            && centerY <= bottom(page.rect) + OVERLAY_CENTER_SLACK_PX;
        if (intersects(overlay.rect, page.rect) && centerInside) {
            continue;
        }
        violations.push({
            evidence: {
                annotationId: overlay.annotationId,
                center: {
                    x: Math.round(centerX),
                    y: Math.round(centerY),
                },
                kind: overlay.kind,
                overlayRect: roundRect(overlay.rect),
                pageNumber: overlay.pageNumber,
                pageRect: roundRect(page.rect),
            },
            id: 'A1-annotation-page-containment',
            message: `${overlay.kind} overlay on page ${String(overlay.pageNumber)} is not on its page box`,
        });
    }
}

function toNormalizedOverlay(
    overlay: IViewerInvariantOverlay,
    page: IViewerInvariantPage,
): IRememberedOverlay {
    return {
        centerX: (overlay.rect.left + overlay.rect.width / 2 - page.rect.left) / page.rect.width,
        centerY: (overlay.rect.top + overlay.rect.height / 2 - page.rect.top) / page.rect.height,
        height: overlay.rect.height / page.rect.height,
        pageNumber: overlay.pageNumber,
        screenSized: overlay.screenSized,
        viewRotation: page.viewRotation,
        width: overlay.rect.width / page.rect.width,
    };
}

/**
 * A1 names the annotation's position, so the comparison is anchored on the
 * centre. The box is compared too, except for a marker the viewer draws at a
 * fixed size in screen pixels: its box relative to the page legitimately
 * changes with zoom while the point it marks does not move.
 */
function measureNormalizedDrift(previous: IRememberedOverlay, observation: IRememberedOverlay) {
    const positionDrift = Math.max(
        Math.abs(previous.centerX - observation.centerX),
        Math.abs(previous.centerY - observation.centerY),
    );
    if (previous.screenSized || observation.screenSized) {
        return positionDrift;
    }
    return Math.max(
        positionDrift,
        Math.abs(previous.width - observation.width),
        Math.abs(previous.height - observation.height),
    );
}

/**
 * A1 stateful: between two settled observations of the same annotation on the
 * same page and rotation, its position normalized to the page box may not
 * move. Normalizing by the page box makes the comparison zoom independent,
 * which is what makes drift on zoom or resize observable.
 *
 * The centre is the position. A marker the viewer draws at a fixed screen size
 * keeps its centre through a zoom while its normalized box changes, and
 * reporting that as drift was a false alarm the monitor raised on the note
 * icon during ordinary zooming.
 */
function checkOverlayDrift(
    surface: IViewerSurface,
    pagesByNumber: Map<number, IViewerInvariantPage>,
    options: IViewerInvariantOptions,
    violations: IViewerInvariantViolation[],
    skipped: IViewerInvariantSkip[],
) {
    const edited = new Set(options.editedAnnotationIds ?? []);
    const remember = options.remember ?? true;
    const seen = new Set<string>();
    let compared = 0;

    for (const overlay of surface.overlays) {
        seen.add(overlay.annotationId);
        const page = pagesByNumber.get(overlay.pageNumber);
        if (!page || page.rect.width <= 0 || page.rect.height <= 0) {
            continue;
        }
        const observation = toNormalizedOverlay(overlay, page);
        const previous = memory.overlays.get(overlay.annotationId);
        const comparable = previous !== undefined
            && !edited.has(overlay.annotationId)
            && !overlay.selected
            && previous.pageNumber === observation.pageNumber
            && previous.viewRotation === observation.viewRotation;
        if (comparable) {
            compared += 1;
            const drift = measureNormalizedDrift(previous, observation);
            if (drift > MAX_NORMALIZED_DRIFT) {
                violations.push({
                    evidence: {
                        annotationId: overlay.annotationId,
                        driftFraction: Number(drift.toFixed(4)),
                        kind: overlay.kind,
                        observed: observation,
                        pageNumber: overlay.pageNumber,
                        previous,
                    },
                    id: 'A1-annotation-normalized-drift',
                    message: `${overlay.kind} overlay on page ${String(overlay.pageNumber)} moved`
                        + ` ${(drift * 100).toFixed(2)}% of the page box between settled observations`,
                });
            }
        }
        if (remember) {
            memory.overlays.set(overlay.annotationId, observation);
        }
    }

    // An annotation whose page is mounted and which no longer draws an overlay
    // was deleted or belongs to a document that is no longer open. One whose
    // page is not mounted was only virtualized away, and its normalized
    // position is still the one to compare against when it comes back.
    if (remember) {
        for (const [
            annotationId,
            remembered,
        ] of [...memory.overlays]) {
            if (!seen.has(annotationId) && pagesByNumber.has(remembered.pageNumber)) {
                memory.overlays.delete(annotationId);
            }
        }
    }

    if (compared === 0) {
        skipped.push({
            id: 'A1-annotation-normalized-drift',
            reason: 'no annotation had a comparable earlier observation on the same page and rotation',
        });
    }
}

function isClampedToPane(noteWindow: IViewerInvariantNoteWindow, viewport: IViewerRect) {
    return Math.abs(noteWindow.rect.left - viewport.left) <= GEOMETRY_TOLERANCE_PX
        || Math.abs(right(noteWindow.rect) - right(viewport)) <= GEOMETRY_TOLERANCE_PX
        || Math.abs(noteWindow.rect.top - viewport.top) <= GEOMETRY_TOLERANCE_PX
        || Math.abs(bottom(noteWindow.rect) - bottom(viewport)) <= GEOMETRY_TOLERANCE_PX;
}

function overlapsWithTolerance(first: IViewerRect, second: IViewerRect) {
    return right(first) > second.left + GEOMETRY_TOLERANCE_PX
        && first.left < right(second) - GEOMETRY_TOLERANCE_PX
        && bottom(first) > second.top + GEOMETRY_TOLERANCE_PX
        && first.top < bottom(second) - GEOMETRY_TOLERANCE_PX;
}

/**
 * A2 one observation, the part the contract has settled: while the anchor page
 * is on screen the note window belongs to the document area. It may not cover
 * the toolbar, a sidebar, the tab bar, the status bar or another pane, and it
 * has to reach the pane it belongs to.
 *
 * What should happen once the anchor leaves the viewport is open question 3 of
 * the behavior contract: hide, dock to the pane edge, or stay. That case is
 * reported as unresolved, never as a violation, so the checker does not decide
 * a product rule the owner has not decided.
 */
function checkNoteWindowPlacement(
    surface: IViewerSurface,
    violations: IViewerInvariantViolation[],
    skipped: IViewerInvariantSkip[],
    unresolved: IViewerInvariantUnresolved[],
) {
    if (surface.noteWindows.length === 0) {
        skipped.push({
            id: 'A2-note-window-over-chrome',
            reason: 'no note window is open',
        });
        return;
    }

    let applicable = 0;
    for (const noteWindow of surface.noteWindows) {
        const anchorVisible = noteWindow.anchorRect !== null
            && intersects(noteWindow.anchorRect, surface.viewportRect);
        if (!anchorVisible) {
            unresolved.push({
                evidence: {
                    anchorPageNumber: noteWindow.anchorPageNumber,
                    anchorRect: noteWindow.anchorRect ? roundRect(noteWindow.anchorRect) : null,
                    annotationId: noteWindow.annotationId,
                    noteWindowRect: roundRect(noteWindow.rect),
                    viewportRect: roundRect(surface.viewportRect),
                },
                id: 'A2-anchor-offscreen',
                question: 'behavior contract A2 and open question 3: when the anchor page leaves the'
                    + ' viewport, should the note window hide, dock to the pane edge, or stay?',
            });
            continue;
        }

        applicable += 1;
        const covered = surface.chrome.filter(chrome => overlapsWithTolerance(noteWindow.rect, chrome.rect));
        if (covered.length > 0) {
            violations.push({
                evidence: {
                    annotationId: noteWindow.annotationId,
                    coveredChrome: covered.map(chrome => ({
                        name: chrome.name,
                        rect: roundRect(chrome.rect),
                    })),
                    noteWindowRect: roundRect(noteWindow.rect),
                },
                id: 'A2-note-window-over-chrome',
                message: `the note window for ${noteWindow.annotationId} covers`
                    + ` ${covered.map(chrome => chrome.name).join(', ')} while its anchor page is on screen`,
            });
            continue;
        }
        if (!intersects(noteWindow.rect, surface.viewportRect)) {
            violations.push({
                evidence: {
                    annotationId: noteWindow.annotationId,
                    noteWindowRect: roundRect(noteWindow.rect),
                    viewportRect: roundRect(surface.viewportRect),
                },
                id: 'A2-note-window-over-chrome',
                message: `the note window for ${noteWindow.annotationId} does not reach its pane`
                    + ' while its anchor page is on screen',
            });
        }
    }

    if (applicable === 0) {
        skipped.push({
            id: 'A2-note-window-over-chrome',
            reason: 'no open note window has its anchor page on screen',
        });
    }
}

/**
 * A2 stateful: a note window is attached to a place on its page, so while the
 * anchor stays visible and the window is not clamped to a pane edge, the
 * window has to move with the anchor. This is the property whose absence shows
 * up as a note window standing still while its page scrolls away.
 *
 * A window the reader dragged between the two observations is not comparable:
 * the viewer suspends page following during a drag by design, so the broken
 * anchor delta is the user's own placement, not a defect. The window publishes
 * a placement sequence that changes while it is being dragged.
 */
function checkNoteWindowFollowsAnchor(
    surface: IViewerSurface,
    options: IViewerInvariantOptions,
    violations: IViewerInvariantViolation[],
    skipped: IViewerInvariantSkip[],
) {
    const remember = options.remember ?? true;
    const seen = new Set<string>();
    let compared = 0;

    for (const noteWindow of surface.noteWindows) {
        seen.add(noteWindow.annotationId);
        const anchorRect = noteWindow.anchorRect;
        const anchorPageNumber = noteWindow.anchorPageNumber;
        if (!anchorRect || anchorPageNumber === null) {
            continue;
        }
        const clamped = isClampedToPane(noteWindow, surface.viewportRect);
        const anchorVisible = intersects(anchorRect, surface.viewportRect);
        const previous = memory.noteWindows.get(noteWindow.annotationId);
        const comparable = previous !== undefined
            && !previous.clamped
            && !clamped
            && previous.anchorVisible
            && anchorVisible
            && previous.userPlacementSequence === noteWindow.userPlacementSequence
            && previous.anchorPageNumber === anchorPageNumber
            && Math.abs(previous.anchorWidth - anchorRect.width) <= GEOMETRY_TOLERANCE_PX
            && Math.abs(previous.anchorHeight - anchorRect.height) <= GEOMETRY_TOLERANCE_PX;
        if (comparable) {
            compared += 1;
            const anchorDeltaX = anchorRect.left - previous.anchorLeft;
            const anchorDeltaY = anchorRect.top - previous.anchorTop;
            const windowDeltaX = noteWindow.rect.left - previous.left;
            const windowDeltaY = noteWindow.rect.top - previous.top;
            const errorX = Math.abs(windowDeltaX - anchorDeltaX);
            const errorY = Math.abs(windowDeltaY - anchorDeltaY);
            if (Math.max(errorX, errorY) > NOTE_WINDOW_FOLLOW_TOLERANCE_PX) {
                violations.push({
                    evidence: {
                        anchorDelta: {
                            x: Math.round(anchorDeltaX),
                            y: Math.round(anchorDeltaY),
                        },
                        anchorPageNumber,
                        annotationId: noteWindow.annotationId,
                        noteWindowDelta: {
                            x: Math.round(windowDeltaX),
                            y: Math.round(windowDeltaY),
                        },
                    },
                    id: 'A2-note-window-follows-anchor',
                    message: `the note window for ${noteWindow.annotationId} moved`
                        + ` (${Math.round(windowDeltaX)}, ${Math.round(windowDeltaY)})px while its`
                        + ` anchor page moved (${Math.round(anchorDeltaX)}, ${Math.round(anchorDeltaY)})px`,
                });
            }
        }
        if (remember) {
            memory.noteWindows.set(noteWindow.annotationId, {
                anchorHeight: anchorRect.height,
                anchorLeft: anchorRect.left,
                anchorPageNumber,
                anchorTop: anchorRect.top,
                anchorVisible,
                anchorWidth: anchorRect.width,
                clamped,
                left: noteWindow.rect.left,
                top: noteWindow.rect.top,
                userPlacementSequence: noteWindow.userPlacementSequence,
            });
        }
    }

    if (remember) {
        for (const annotationId of [...memory.noteWindows.keys()]) {
            if (!seen.has(annotationId)) {
                memory.noteWindows.delete(annotationId);
            }
        }
    }
    if (compared === 0) {
        skipped.push({
            id: 'A2-note-window-follows-anchor',
            reason: 'no open note window had a comparable unclamped earlier observation'
                + ' with its anchor on screen both times and the same user placement',
        });
    }
}

/**
 * C2 is diagnostic policy, not a universal invariant: a malformed input
 * document may legitimately produce diagnostics, so it only applies once a
 * caller declares the open document well formed.
 */
function checkRendererDiagnostics(
    options: IViewerInvariantOptions,
    violations: IViewerInvariantViolation[],
    skipped: IViewerInvariantSkip[],
) {
    if (options.documentWellFormed !== true) {
        skipped.push({
            id: 'C2-renderer-diagnostics-clean',
            reason: 'the caller did not declare the open document well formed',
        });
        return;
    }
    const allowlist = [
        ...VIEWER_INVARIANT_CONSOLE_ALLOWLIST,
        ...(options.consoleAllowlist ?? []),
    ];
    const notices = readViewerDiagnosticNotices();
    for (const notice of notices) {
        const allowed = allowlist.find(entry => notice.signature.startsWith(entry.pattern));
        if (allowed) {
            continue;
        }
        violations.push({
            evidence: {
                occurredAt: notice.occurredAt,
                signature: notice.signature,
                source: notice.source,
            },
            id: 'C2-renderer-diagnostics-clean',
            message: `the renderer reported a ${notice.source} diagnostic: ${notice.signature}`,
        });
    }
    if (options.remember ?? true) {
        clearViewerDiagnosticNotices();
    }
}

/**
 * What this observation actually saw. The checks judge the things that are
 * there; only the scenario knows what should still be there, so the identities
 * are reported and a caller with a task in mind decides.
 */
function describeObservedIdentities(surface: IViewerSurface | null): IViewerObservedIdentities {
    return {
        annotationIds: (surface?.overlays ?? []).map(overlay => overlay.annotationId),
        mountedPageNumbers: (surface?.pages ?? []).map(page => page.pageNumber),
        noteWindowAnnotationIds: (surface?.noteWindows ?? []).map(noteWindow => noteWindow.annotationId),
        pageIndicator: surface?.toolbarPageNumber ?? null,
    };
}

/**
 * Reads the rendered viewer once and judges every implemented invariant
 * against it. Cheap enough to run on every settled state.
 */
export function checkViewerInvariants(options: IViewerInvariantOptions = {}): IViewerInvariantReport {
    ensureViewerDiagnosticLog();
    const violations: IViewerInvariantViolation[] = [];
    const skipped: IViewerInvariantSkip[] = [];
    const unresolved: IViewerInvariantUnresolved[] = [];

    if (options.settleFailure) {
        violations.push({
            evidence: {reason: options.settleFailure},
            id: 'S0-viewer-settled',
            message: `the viewer did not settle: ${options.settleFailure}`,
        });
    }

    const {
        surface,
        unavailableReason,
    } = readViewerSurface();
    if (!surface) {
        const reason = unavailableReason ?? 'the viewer surface was unreadable';
        for (const id of [
            'R1-toolbar-page-visible',
            'L1-fit-mode-scroll-range',
            'A1-annotation-page-containment',
            'A1-annotation-normalized-drift',
            'A2-note-window-over-chrome',
            'A2-note-window-follows-anchor',
        ] as const) {
            skipped.push({
                id,
                reason,
            });
        }
        checkRendererDiagnostics(options, violations, skipped);
        return {
            observed: describeObservedIdentities(null),
            observedAt: Date.now(),
            skipped,
            unresolved,
            violations,
        };
    }

    forgetOtherWorkspace(surface, options.remember ?? true);
    const visiblePages = findVisiblePages(surface);
    const pagesByNumber = new Map(surface.pages.map(page => [
        page.pageNumber,
        page,
    ]));

    checkToolbarPageVisible(surface, visiblePages, violations, skipped);
    checkFitModeScrollRange(surface, visiblePages, violations, skipped);
    checkOverlayContainment(surface, pagesByNumber, violations, skipped);
    checkOverlayDrift(surface, pagesByNumber, options, violations, skipped);
    checkNoteWindowPlacement(surface, violations, skipped, unresolved);
    checkNoteWindowFollowsAnchor(surface, options, violations, skipped);
    checkRendererDiagnostics(options, violations, skipped);

    return {
        observed: describeObservedIdentities(surface),
        observedAt: Date.now(),
        skipped,
        unresolved,
        violations,
    };
}

export function formatViewerInvariantViolations(report: IViewerInvariantReport) {
    return report.violations
        .map(violation => `${violation.id}: ${violation.message}\n    ${JSON.stringify(violation.evidence)}`)
        .join('\n');
}
