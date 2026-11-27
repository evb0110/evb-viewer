import type {RouterConfig} from '@nuxt/schema';
import type {HistoryState, RouterHistory} from 'vue-router';
import {BROWSER_EXTENSION_VIEWER_PAGE} from '@contracts/browserExtensionLaunch';
import {isBrowserExtensionPage} from '@app/utils/isBrowserExtensionPage';

const EXTENSION_VIEWER_PATH = `/${BROWSER_EXTENSION_VIEWER_PAGE}`;

type TExtensionHistoryLocation = RouterHistory['location'];
type TExtensionNavigationCallback = Parameters<RouterHistory['listen']>[0];
type TExtensionNavigationInfo = Parameters<TExtensionNavigationCallback>[2];

interface IExtensionRouterStateFields {
    back: TExtensionHistoryLocation | null;
    current: TExtensionHistoryLocation;
    forward: TExtensionHistoryLocation | null;
    position: number;
    replaced: boolean;
    scroll: HistoryState | null;
}

type TExtensionHistoryState = HistoryState & IExtensionRouterStateFields;

const ROUTER_HISTORY_STATE_KEYS = new Set(['back', 'current', 'forward', 'position', 'replaced', 'scroll']);

function readHistoryStateRecord(state: unknown = window.history.state): HistoryState {
    return typeof state === 'object' && state !== null ? {...(state as HistoryState)} : {};
}

function readForeignHistoryState(state: unknown = window.history.state): HistoryState {
    const foreign: HistoryState = {};
    for (const [key, value] of Object.entries(readHistoryStateRecord(state))) {
        if (!ROUTER_HISTORY_STATE_KEYS.has(key)) {
            foreign[key] = value;
        }
    }
    return foreign;
}

function isRouterHistoryState(state: unknown): state is TExtensionHistoryState {
    if (typeof state !== 'object' || state === null) {
        return false;
    }
    const candidate = state as Record<string, unknown>;
    return typeof candidate.current === 'string' && typeof candidate.position === 'number';
}

function computeScrollPosition(): HistoryState {
    return {
        left: window.scrollX,
        top: window.scrollY,
    };
}

function buildRouterHistoryState(
    back: TExtensionHistoryLocation | null,
    current: TExtensionHistoryLocation,
    forward: TExtensionHistoryLocation | null,
    replaced: boolean,
    position: number,
): TExtensionHistoryState {
    return {
        back,
        current,
        forward,
        position,
        replaced,
        scroll: null,
    };
}

function normalizeRouteLocation(to: TExtensionHistoryLocation): TExtensionHistoryLocation {
    if (!to || to === '/') {
        return '/';
    }
    return to.startsWith('/') ? to : `/${to}`;
}

function resolveExtensionFragmentLocation(hash: string): TExtensionHistoryLocation {
    if (!hash.startsWith('#/')) {
        return '/';
    }
    return normalizeRouteLocation(hash.slice(1));
}

function parseExtensionFragmentRedirect(hash: string) {
    if (!hash.startsWith('#/')) {
        return {
            path: '/',
            query: {},
            hash: '',
        };
    }
    const raw = hash.slice(1);
    const hashIndex = raw.indexOf('#');
    const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const innerHash = hashIndex >= 0 ? raw.slice(hashIndex) : '';
    const queryIndex = beforeHash.indexOf('?');
    const path = normalizeRouteLocation(queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash);
    const query: Record<string, string | string[]> = {};
    if (queryIndex >= 0) {
        const searchParams = new URLSearchParams(beforeHash.slice(queryIndex + 1));
        for (const [key, value] of searchParams.entries()) {
            const existing = query[key];
            if (existing === undefined) {
                query[key] = value;
            } else if (Array.isArray(existing)) {
                existing.push(value);
            } else {
                query[key] = [existing, value];
            }
        }
    }
    return {
        path,
        query,
        hash: innerHash,
    };
}

function formatExtensionUrl(to: TExtensionHistoryLocation, search = ''): string {
    const normalized = normalizeRouteLocation(to);
    return normalized === '/' ? `${EXTENSION_VIEWER_PATH}${search}` : `${EXTENSION_VIEWER_PATH}${search}#${normalized}`;
}

/**
 * Browser-backed history for Chrome extension pages: keeps the viewer root at
 * hash-free `/index.html` (preserving any raw `?file=<url>` query and existing
 * `history.state` fields such as `evbExtensionDocument`), routes secondary
 * pages through `/index.html#/privacy` and `/index.html#/about` so normal
 * clicks participate in Chrome's Back/Forward history and Ctrl-clicks open a
 * packaged HTML shell, and reads those `#/` fragments on startup.
 */
function createBrowserExtensionHistory(base = '/'): RouterHistory {
    const currentLocation = {value: resolveExtensionFragmentLocation(window.location.hash)};
    const existingState = readHistoryStateRecord();
    const initialState: TExtensionHistoryState = isRouterHistoryState(existingState)
        ? existingState
        : {
              ...existingState,
              ...buildRouterHistoryState(null, currentLocation.value, null, true, Math.max(0, window.history.length - 1)),
          };
    const historyState = {value: initialState};
    let listeners: TExtensionNavigationCallback[] = [];
    let pauseState: TExtensionHistoryLocation | null = null;

    function changeLocation(to: TExtensionHistoryLocation, state: TExtensionHistoryState, isReplace: boolean) {
        const url = formatExtensionUrl(to, window.location.search);
        try {
            window.history[isReplace ? 'replaceState' : 'pushState'](state, '', url);
            historyState.value = state;
        } catch {
            window.location[isReplace ? 'replace' : 'assign'](url);
        }
    }

    if (!isRouterHistoryState(existingState) || window.location.hash === '#/') {
        changeLocation(currentLocation.value, initialState, true);
    }

    function replace(to: TExtensionHistoryLocation, data?: HistoryState) {
        const normalized = normalizeRouteLocation(to);
        const nextState: TExtensionHistoryState = {
            ...readHistoryStateRecord(),
            ...buildRouterHistoryState(historyState.value.back, normalized, historyState.value.forward, true, historyState.value.position),
            ...data,
            position: historyState.value.position,
        };
        changeLocation(normalized, nextState, true);
        currentLocation.value = normalized;
    }

    function push(to: TExtensionHistoryLocation, data?: HistoryState) {
        const normalized = normalizeRouteLocation(to);
        const currentState: TExtensionHistoryState = {
            ...readHistoryStateRecord(),
            back: historyState.value.back,
            current: currentLocation.value,
            forward: normalized,
            position: historyState.value.position,
            replaced: historyState.value.replaced,
            scroll: computeScrollPosition(),
        };
        changeLocation(currentLocation.value, currentState, true);

        const foreignState = readForeignHistoryState();
        const nextState: TExtensionHistoryState = {
            ...foreignState,
            ...buildRouterHistoryState(currentLocation.value, normalized, null, false, currentState.position + 1),
            ...data,
        };
        changeLocation(normalized, nextState, false);
        currentLocation.value = normalized;
    }

    const popStateHandler = ({state}: PopStateEvent) => {
        const to = resolveExtensionFragmentLocation(window.location.hash);
        const from = currentLocation.value;
        const fromState = historyState.value;
        let delta = 0;

        if (isRouterHistoryState(state)) {
            currentLocation.value = to;
            historyState.value = state;
            if (pauseState && pauseState === from) {
                pauseState = null;
                return;
            }
            delta = state.position - fromState.position;
        } else {
            replace(to);
            if (pauseState && pauseState === from) {
                pauseState = null;
                return;
            }
        }

        const direction = (delta ? (delta > 0 ? 'forward' : 'back') : '') as TExtensionNavigationInfo['direction'];
        for (const listener of listeners) {
            listener(currentLocation.value, from, {
                delta,
                direction,
                type: 'pop' as TExtensionNavigationInfo['type'],
            });
        }
    };

    const pageHideHandler = () => {
        if (!window.history.state) {
            return;
        }
        try {
            window.history.replaceState(
                {
                    ...readHistoryStateRecord(),
                    scroll: computeScrollPosition(),
                },
                '',
            );
        } catch {
            // Ignore restricted history mutations during page teardown.
        }
    };

    window.addEventListener('popstate', popStateHandler);
    window.addEventListener('pagehide', pageHideHandler);

    const routerHistory: RouterHistory = {
        base,
        createHref: (to) => formatExtensionUrl(to),
        destroy() {
            listeners = [];
            window.removeEventListener('popstate', popStateHandler);
            window.removeEventListener('pagehide', pageHideHandler);
        },
        go(delta, triggerListeners = true) {
            if (!triggerListeners) {
                pauseState = currentLocation.value;
            }
            window.history.go(delta);
        },
        listen(callback) {
            listeners.push(callback);
            return () => {
                const index = listeners.indexOf(callback);
                if (index > -1) {
                    listeners.splice(index, 1);
                }
            };
        },
        get location() {
            return currentLocation.value;
        },
        push,
        replace,
        get state() {
            return historyState.value;
        },
    };

    return routerHistory;
}

/**
 * The Chrome extension loads the workspace from `/index.html?file=<url>` and
 * keeps that URL readable and hash-free in the address bar while routing
 * secondary pages (`/about`, `/privacy`) through browser-backed `#/` fragments.
 */
export function resolveAppRouterOptions(): RouterConfig {
    if (!isBrowserExtensionPage()) {
        return {};
    }

    return {
        history: (base) => createBrowserExtensionHistory(base),
        routes: (scannedRoutes) => [
            ...scannedRoutes,
            {
                path: EXTENSION_VIEWER_PATH,
                redirect: (to) => parseExtensionFragmentRedirect(window.location.hash.startsWith('#/') ? window.location.hash : to.hash),
            },
        ],
    };
}

export default resolveAppRouterOptions();
