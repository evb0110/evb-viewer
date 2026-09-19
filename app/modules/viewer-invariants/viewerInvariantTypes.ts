/**
 * Checkable forms of the statements in
 * `docs/architecture/behavior-contract.md`, read from the rendered document
 * rather than from the app's own view model. Internal state may be compared
 * against the screen, never substituted for it.
 *
 * Each id names the contract statement it checks. `S0-viewer-settled` is the
 * contract's Settled definition: a viewer that does not settle within the
 * bound has failed, and checking is not skipped.
 */
export type TViewerInvariantId =
    | 'A1-annotation-normalized-drift'
    | 'A1-annotation-page-containment'
    | 'A2-note-window-follows-anchor'
    | 'A2-note-window-over-chrome'
    | 'C2-renderer-diagnostics-clean'
    | 'L1-fit-mode-scroll-range'
    | 'R1-toolbar-page-visible'
    | 'S0-viewer-settled';

/**
 * An observation the contract has not decided yet. It is reported so a reader
 * of a bug bundle can see it, and it is never a violation: an undecided rule
 * cannot establish a defect.
 */
export type TViewerUnresolvedId = 'A2-anchor-offscreen';

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
    /**
     * A marker drawn at a fixed size in screen pixels, such as the note icon.
     * Its box relative to the page box legitimately changes with zoom, so only
     * its centre is comparable between two observations.
     */
    screenSized: boolean;
    selected: boolean;
    subtype: string | null;
}

export interface IViewerInvariantNoteWindow {
    anchorPageNumber: number | null;
    anchorRect: IViewerRect | null;
    annotationId: string;
    /**
     * The layout box narrowed to what the window's own `inset()` clip path
     * paints. The window clips itself to its pane, so its layout box reaches
     * over the toolbar while nothing of it is drawn there; what covers chrome
     * is decided on this rect, and how far the window moved on its page is
     * still decided on `rect`, which is the box that follows the anchor.
     */
    paintedRect: IViewerRect;
    rect: IViewerRect;
    /**
     * `data-user-placement`: changes while the reader drags the window. A drag
     * suspends anchor following on purpose, so two observations that disagree
     * here are not comparable.
     */
    userPlacementSequence: number;
}

/** A painted application surface a document overlay must not cover. */
export interface IViewerChromeRect {
    name: string;
    rect: IViewerRect;
}

export interface IViewerSurface {
    /** Toolbars, sidebars, the tab bar, the status bar and inactive panes. */
    chrome: IViewerChromeRect[];
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
    /** `data-workspace-tab-id` of the active workspace, null when unlabelled. */
    workspaceTabId: string | null;
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

/** A recorded observation whose expected behavior is an open product question. */
export interface IViewerInvariantUnresolved {
    evidence: Record<string, unknown>;
    id: TViewerUnresolvedId;
    /** The open question in the behavior contract this observation belongs to. */
    question: string;
}

/**
 * The identities this observation actually saw on screen. A scenario that
 * created an annotation can require it to still be there, which the checks
 * themselves cannot judge: deleting is legitimate and a checker cannot know
 * what the user meant to do.
 */
export interface IViewerObservedIdentities {
    /** Annotation ids with a mounted overlay, by the page they are on. */
    annotationIds: string[];
    /** Annotation ids with an open note window. */
    noteWindowAnnotationIds: string[];
    /** Page numbers of the mounted page containers. */
    mountedPageNumbers: number[];
    /** The physical page number the toolbar rendered, null when unreadable. */
    pageIndicator: number | null;
}

export interface IViewerInvariantReport {
    observed: IViewerObservedIdentities;
    observedAt: number;
    skipped: IViewerInvariantSkip[];
    /** Never a failure. Carried so a bug bundle shows what was seen. */
    unresolved: IViewerInvariantUnresolved[];
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
