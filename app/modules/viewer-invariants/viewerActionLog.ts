import { getAutomationEvents } from '@app/modules/workspace-shell/public';
import { readViewerSurface } from '@app/modules/viewer-invariants/readViewerSurface';

const MAX_RETAINED_ACTIONS = 40;
const OBSERVED_EVENT_TYPES = [
    'keydown',
    'pointerdown',
    'pointerup',
    'wheel',
] as const;

/**
 * A short description of what the user acted on. Control identity only: never
 * document text, a file path, or annotation content.
 */
export interface IViewerUserAction {
    /** Best available control identity: test id, aria-label, role, or tag. */
    target: string;
    timestamp: number;
    type: string;
    viewerState: IViewerActionViewerState;
    viewportSize: {
        height: number;
        width: number;
    };
}

export interface IViewerActionViewerState {
    continuousScroll: boolean | null;
    currentPage: number | null;
    viewMode: string | null;
    zoomMode: string | null;
}

let actions: IViewerUserAction[] = [];
let lastInputAt = 0;
let disposeListeners: (() => void) | null = null;

const CONTROL_DESCRIPTOR_LIMIT = 48;

function describeTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) {
        return 'window';
    }
    const control = target.closest<HTMLElement>(
        '[data-testid], [aria-label], button, [role], input, textarea, a',
    ) ?? (target instanceof HTMLElement ? target : null);
    if (!control) {
        return target.tagName.toLowerCase();
    }
    const identity = [
        control.dataset.testid,
        control.getAttribute('aria-label'),
        control.getAttribute('role'),
        control.id,
        control.tagName.toLowerCase(),
    ].find(candidate => typeof candidate === 'string' && candidate.trim().length > 0) ?? 'unknown';
    return identity.trim().slice(0, CONTROL_DESCRIPTOR_LIMIT);
}

function readViewerState(): IViewerActionViewerState {
    const {surface} = readViewerSurface();
    return {
        continuousScroll: surface?.continuousScroll ?? null,
        currentPage: surface?.toolbarPageNumber ?? null,
        viewMode: surface?.viewMode ?? null,
        zoomMode: surface?.zoomMode ?? null,
    };
}

function recordAction(event: Event) {
    lastInputAt = Date.now();
    actions.push({
        target: describeTarget(event.target),
        timestamp: lastInputAt,
        type: event.type,
        viewerState: readViewerState(),
        viewportSize: {
            height: window.innerHeight,
            width: window.innerWidth,
        },
    });
    if (actions.length > MAX_RETAINED_ACTIONS) {
        actions.splice(0, actions.length - MAX_RETAINED_ACTIONS);
    }
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
    lastInputAt = 0;
}

export function readViewerUserActions(): readonly IViewerUserAction[] {
    return actions;
}

export function readLastViewerInputAt() {
    return lastInputAt;
}

/**
 * True when the app's own automation event stream is publishing. It is gated
 * by the automation preload bridge, so a plain dev session has no
 * `navigation-idle` to wait for and settle falls back to screen quiet.
 */
export function isAutomationEventStreamActive() {
    return getAutomationEvents().length > 0;
}
