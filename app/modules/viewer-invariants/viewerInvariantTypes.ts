/**
 * User-level invariants for the viewer, read from the rendered document rather
 * than from the app's own view model. Internal state may be compared against
 * the screen, never substituted for it.
 *
 * Every invariant carries an applicability predicate and reports
 * "not applicable" instead of guessing. Geometry is in CSS pixels of the
 * unobscured document viewport.
 */
export type TViewerInvariantId =
    | 'A1-annotation-normalized-drift'
    | 'A1-annotation-page-containment'
    | 'A2-note-window-follows-anchor'
    | 'A2-note-window-inside-pane'
    | 'C2-renderer-diagnostics-clean'
    | 'L1-fit-mode-scroll-range'
    | 'R1-toolbar-page-visible'
    | 'S0-viewer-settled';

export type TViewerViewMode = 'facing' | 'facing-first-single' | 'single';
export type TViewerZoomMode = 'custom' | 'fit-height' | 'fit-width';

export interface IViewerRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

export interface IViewerInvariantPage {
    pageNumber: number;
    rect: IViewerRect;
    rendered: boolean;
    /** The facing-mode row this page shares, when the viewer laid one out. */
    rowRect: IViewerRect | null;
    viewRotation: number;
}

export interface IViewerInvariantOverlay {
    annotationId: string;
    /** `data-annotation-kind`: text-markup, shape, placed-image, text-box, note. */
    kind: string;
    /** The app marked this overlay as legitimately drawn past the page edge. */
    outsidePage: boolean;
    pageNumber: number;
    rect: IViewerRect;
    selected: boolean;
    subtype: string | null;
}

export interface IViewerInvariantNoteWindow {
    anchorPageNumber: number | null;
    anchorRect: IViewerRect | null;
    annotationId: string;
    rect: IViewerRect;
}

export interface IViewerSurface {
    continuousScroll: boolean;
    horizontalScrollRangePx: number;
    noteWindows: IViewerInvariantNoteWindow[];
    overlays: IViewerInvariantOverlay[];
    pages: IViewerInvariantPage[];
    /** Physical page number as rendered by the toolbar, null when unreadable. */
    toolbarPageNumber: number | null;
    toolbarPageText: string | null;
    toolbarTotalPages: number | null;
    verticalScrollRangePx: number;
    viewMode: TViewerViewMode;
    /** Client box of the scroller, which excludes a classic scrollbar. */
    viewportRect: IViewerRect;
    zoomMode: TViewerZoomMode;
}

export interface IViewerInvariantViolation {
    evidence: Record<string, unknown>;
    id: TViewerInvariantId;
    message: string;
}

export interface IViewerInvariantSkip {
    id: TViewerInvariantId;
    reason: string;
}

export interface IViewerInvariantReport {
    observedAt: number;
    skipped: IViewerInvariantSkip[];
    violations: IViewerInvariantViolation[];
}

export interface IViewerConsoleAllowlistEntry {
    /** Narrow signature prefix or pattern; a bare substring is not enough. */
    pattern: string;
    /** Why this diagnostic is expected. Required for every entry. */
    reason: string;
}

export interface IViewerInvariantOptions {
    /**
     * Extra diagnostics allowed for this observation, merged with the built-in
     * list. Each entry states its own reason.
     */
    consoleAllowlist?: readonly IViewerConsoleAllowlistEntry[];
    /**
     * Declares the open document well formed. C2 is a diagnostic policy, not a
     * universal invariant: a malformed input document may legitimately produce
     * diagnostics, so C2 stays not applicable until a caller declares this.
     */
    documentWellFormed?: boolean;
    /**
     * Annotations the caller just edited. Their stateful comparison is skipped
     * once and their memory is refreshed from this observation.
     */
    editedAnnotationIds?: readonly string[];
    /** Keeps this observation for the next stateful comparison. Default true. */
    remember?: boolean;
    /** A settle wait that timed out, reported as an S0 violation. */
    settleFailure?: string | null;
}
