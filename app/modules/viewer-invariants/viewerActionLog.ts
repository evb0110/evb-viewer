/**
 * A bounded record of what the user did, kept so a bug report says how the
 * viewer got into the state it is in.
 *
 * Two things shape it. A wheel gesture arrives as hundreds of packets, and
 * keeping them raw evicted the click that caused the problem, so packets are
 * coalesced into one gesture entry and meaningful actions live in their own
 * queue that wheel volume cannot flush. And recording runs inside every input
 * event, so it measures nothing per packet: the one rect read a gesture needs
 * happens once, on the packet that starts it.
 *
 * Nothing here records content. No typed text, no selection, no file name, no
 * annotation text, and no free-text attribute of the control.
 */
const MAX_RETAINED_GESTURES = 20;
const MAX_RETAINED_ACTIONS = 40;
/** A pause this long ends a wheel gesture. */
const GESTURE_QUIET_MS = 220;
const OBSERVED_EVENT_TYPES = [
    'keydown',
    'pointerdown',
    'pointerup',
    'wheel',
] as const;
const PAGE_TRACK_SELECTOR = '[data-pdf-page-track]';
const VIEWPORT_SELECTOR = '[data-document-viewer-chassis-viewport], #pdf-viewer';
const CONTROL_DESCRIPTOR_LIMIT = 48;

/** The presentation modes the viewer publishes on its own page track. */
export interface IViewerActionViewerState {
    continuousScroll: boolean | null;
    viewMode: string | null;
    zoomMode: string | null;
}

export interface IViewerPoint {
    x: number;
    y: number;
}

interface IViewerActionBase {
    startedAt: number;
    /** Best available control identity: test id, role, id, or tag name. */
    target: string;
    viewerState: IViewerActionViewerState;
}

/** One continuous wheel gesture: many packets, one entry. */
export interface IViewerWheelGestureAction extends IViewerActionBase {
    /** True for a pinch or a ctrl-wheel zoom rather than a scroll. */
    ctrlKey: boolean;
    endedAt: number;
    firstDelta: IViewerPoint;
    lastDelta: IViewerPoint;
    packets: number;
    /** Where the gesture started, relative to the document viewport. */
    startPoint: IViewerPoint | null;
    summedDelta: IViewerPoint;
    type: 'wheel-gesture';
}

export interface IViewerPointerAction extends IViewerActionBase {
    button: number;
    /** Fractions of the target control's box, so it survives a resize. */
    pointInTarget: IViewerPoint | null;
    /** Relative to the document viewport, null when there is none on screen. */
    pointInViewport: IViewerPoint | null;
    type: 'pointerdown' | 'pointerup';
}

/** A navigation key, a shortcut or a function key. Never a typed character. */
export interface IViewerKeyAction extends IViewerActionBase {
    altKey: boolean;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    type: 'key';
}

/** That typing happened and how much of it. Never what was typed. */
export interface IViewerTypingAction extends IViewerActionBase {
    endedAt: number;
    keystrokes: number;
    type: 'typing';
}

export type IViewerUserAction =
    | IViewerKeyAction
    | IViewerPointerAction
    | IViewerTypingAction
    | IViewerWheelGestureAction;

let gestures: IViewerWheelGestureAction[] = [];
let actions: IViewerUserAction[] = [];
let openGesture: IViewerWheelGestureAction | null = null;
let openTyping: IViewerTypingAction | null = null;
let lastInputAt = 0;
let disposeListeners: (() => void) | null = null;

/**
 * Names the control the user acted on from authored identifiers only. Every
 * free-text source is excluded on purpose: an `aria-label`, a `title`, an
 * `alt`, a `placeholder` and the element's text all carry user content. A tab
 * is labelled with the open document's file name, so reading a label here
 * would put that name into a bug report and into the console.
 */
function describeTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) {
        return 'window';
    }
    const control = target.closest<HTMLElement>(
        '[data-testid], [role], button, input, textarea, a',
    ) ?? (target instanceof HTMLElement ? target : null);
    if (!control) {
        return target.tagName.toLowerCase();
    }
    const identity = [
        control.dataset.testid,
        control.getAttribute('role'),
        control.id,
        control.tagName.toLowerCase(),
    ].find(candidate => typeof candidate === 'string' && candidate.trim().length > 0) ?? 'unknown';
    return identity.trim().slice(0, CONTROL_DESCRIPTOR_LIMIT);
}

/**
 * Attribute reads on one element. This runs inside every wheel, pointer and
 * key event, so it must not measure: a rect read or a viewport size read here
 * forces layout on the gesture the monitor is trying to observe, and can
 * manufacture the very settle failure it would then report.
 */
function readViewerState(): IViewerActionViewerState {
    const pageTrack = document.querySelector<HTMLElement>(PAGE_TRACK_SELECTOR);
    if (!pageTrack) {
        return {
            continuousScroll: null,
            viewMode: null,
            zoomMode: null,
        };
    }
    return {
        continuousScroll: pageTrack.dataset.pdfContinuousScroll !== 'false',
        viewMode: pageTrack.dataset.pdfViewMode ?? null,
        zoomMode: pageTrack.dataset.pdfZoomMode ?? null,
    };
}

function pointInViewport(clientX: number, clientY: number) {
    const viewport = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!viewport) {
        return null;
    }
    const rect = viewport.getBoundingClientRect();
    return {
        x: Math.round(clientX - rect.left),
        y: Math.round(clientY - rect.top),
    };
}

function pushAction(action: IViewerUserAction) {
    actions.push(action);
    if (actions.length > MAX_RETAINED_ACTIONS) {
        actions.splice(0, actions.length - MAX_RETAINED_ACTIONS);
    }
}

function closeOpenEntries() {
    if (openGesture) {
        gestures.push(openGesture);
        if (gestures.length > MAX_RETAINED_GESTURES) {
            gestures.splice(0, gestures.length - MAX_RETAINED_GESTURES);
        }
        openGesture = null;
    }
    if (openTyping) {
        pushAction(openTyping);
        openTyping = null;
    }
}

/**
 * A gesture ends at a pause, at a direction reversal, when the modifier that
 * turns a scroll into a zoom changes, or when any other action happens.
 */
function continuesGesture(gesture: IViewerWheelGestureAction, event: WheelEvent, now: number) {
    if (now - gesture.endedAt > GESTURE_QUIET_MS || gesture.ctrlKey !== event.ctrlKey) {
        return false;
    }
    const previousY = gesture.lastDelta.y;
    const previousX = gesture.lastDelta.x;
    return (previousY === 0 || event.deltaY === 0 || Math.sign(previousY) === Math.sign(event.deltaY))
        && (previousX === 0 || event.deltaX === 0 || Math.sign(previousX) === Math.sign(event.deltaX));
}

function recordWheel(event: WheelEvent, now: number) {
    if (openTyping) {
        pushAction(openTyping);
        openTyping = null;
    }
    if (openGesture && continuesGesture(openGesture, event, now)) {
        openGesture.endedAt = now;
        openGesture.lastDelta = {
            x: event.deltaX,
            y: event.deltaY,
        };
        openGesture.packets += 1;
        openGesture.summedDelta = {
            x: openGesture.summedDelta.x + event.deltaX,
            y: openGesture.summedDelta.y + event.deltaY,
        };
        return;
    }
    closeOpenEntries();
    const delta = {
        x: event.deltaX ?? 0,
        y: event.deltaY ?? 0,
    };
    // The single rect read a gesture costs, on its first packet only.
    openGesture = {
        ctrlKey: event.ctrlKey,
        endedAt: now,
        firstDelta: delta,
        lastDelta: delta,
        packets: 1,
        startPoint: pointInViewport(event.clientX ?? 0, event.clientY ?? 0),
        startedAt: now,
        summedDelta: {...delta},
        target: describeTarget(event.target),
        type: 'wheel-gesture',
        viewerState: readViewerState(),
    };
}

function recordPointer(event: PointerEvent, now: number) {
    closeOpenEntries();
    const control = event.target instanceof Element ? event.target : null;
    const rect = control?.getBoundingClientRect() ?? null;
    const clientX = event.clientX ?? 0;
    const clientY = event.clientY ?? 0;
    pushAction({
        button: event.button ?? 0,
        pointInTarget: rect && rect.width > 0 && rect.height > 0
            ? {
                x: Number(((clientX - rect.left) / rect.width).toFixed(3)),
                y: Number(((clientY - rect.top) / rect.height).toFixed(3)),
            }
            : null,
        pointInViewport: pointInViewport(clientX, clientY),
        startedAt: now,
        target: describeTarget(event.target),
        type: event.type === 'pointerup' ? 'pointerup' : 'pointerdown',
        viewerState: readViewerState(),
    });
}

/**
 * A printable key without a command modifier is typing: the fact is recorded,
 * the character never is. Everything else is a navigation key, a shortcut or a
 * function key, and its `code` is what makes a sequence reproducible.
 */
function isTypedCharacter(event: KeyboardEvent) {
    return (event.key ?? '').length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

function recordKey(event: KeyboardEvent, now: number) {
    if (openGesture) {
        closeOpenEntries();
    }
    if (isTypedCharacter(event)) {
        if (openTyping) {
            openTyping.endedAt = now;
            openTyping.keystrokes += 1;
            return;
        }
        openTyping = {
            endedAt: now,
            keystrokes: 1,
            startedAt: now,
            target: describeTarget(event.target),
            type: 'typing',
            viewerState: readViewerState(),
        };
        return;
    }
    closeOpenEntries();
    pushAction({
        altKey: event.altKey,
        code: event.code ?? '',
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        startedAt: now,
        target: describeTarget(event.target),
        type: 'key',
        viewerState: readViewerState(),
    });
}

/**
 * Dispatch on the event's own type, not on its constructor. A trusted pointer
 * event is a `PointerEvent`, but automation and some hosts deliver a
 * `MouseEvent` under a pointer type, and dropping it would lose exactly the
 * click a bug report needs.
 */
function recordAction(event: Event) {
    lastInputAt = Date.now();
    if (event.type === 'wheel') {
        recordWheel(event as WheelEvent, lastInputAt);
        return;
    }
    if (event.type === 'keydown') {
        recordKey(event as KeyboardEvent, lastInputAt);
        return;
    }
    recordPointer(event as PointerEvent, lastInputAt);
}

export function installViewerActionLog() {
    if (disposeListeners || typeof window === 'undefined') {
        return;
    }
    for (const type of OBSERVED_EVENT_TYPES) {
        window.addEventListener(type, recordAction, {
            capture: true,
            passive: true,
        });
    }
    disposeListeners = () => {
        for (const type of OBSERVED_EVENT_TYPES) {
            window.removeEventListener(type, recordAction, {capture: true});
        }
    };
}

export function disposeViewerActionLog() {
    disposeListeners?.();
    disposeListeners = null;
    actions = [];
    gestures = [];
    openGesture = null;
    openTyping = null;
    lastInputAt = 0;
}

/**
 * The two queues merged by time. Meaningful actions are kept apart from wheel
 * gestures so a long fling cannot evict the click that caused the problem.
 */
export function readViewerUserActions(): readonly IViewerUserAction[] {
    const merged: IViewerUserAction[] = [
        ...actions,
        ...gestures,
        ...(openGesture ? [openGesture] : []),
        ...(openTyping ? [openTyping] : []),
    ];
    return merged.sort((left, right) => left.startedAt - right.startedAt);
}

export function readLastViewerInputAt() {
    return lastInputAt;
}
