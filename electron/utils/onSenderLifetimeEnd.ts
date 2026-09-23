import type {WebContents} from 'electron';

export type TSenderLifetimeEnd = 'destroyed' | 'render-process-gone' | 'main-frame-navigation';

export type TSenderLifetimeTarget = Pick<WebContents, 'on' | 'removeListener'>;

type TSenderLifetimeListener = (end: TSenderLifetimeEnd) => void;

/** `navigation` also ends on a cross-document navigation of the main frame. */
interface ISenderLifetimeOptions {readonly navigation?: boolean;}

interface ISenderLifetimeSubscription {
    readonly listener: TSenderLifetimeListener;
    readonly navigation: boolean;
}

interface ISenderLifetimeHub {
    readonly subscriptions: Set<ISenderLifetimeSubscription>;
    readonly destroyed: () => void;
    readonly gone: () => void;
    readonly navigation: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void;
    navigationSubscribers: number;
}

const hubs = new WeakMap<TSenderLifetimeTarget, ISenderLifetimeHub>();

function dispatch(hub: ISenderLifetimeHub, end: TSenderLifetimeEnd) {
    for (const subscription of [...hub.subscriptions]) {
        if (!hub.subscriptions.has(subscription)) {
            continue;
        }
        if (end === 'main-frame-navigation' && !subscription.navigation) {
            continue;
        }
        try {
            subscription.listener(end);
        } catch (error) {
            // One failing owner must not strand the others' cleanup; the
            // error still reaches the process-level exception handler.
            queueMicrotask(() => {
                throw error;
            });
        }
    }
}

function createHub(): ISenderLifetimeHub {
    const hub: ISenderLifetimeHub = {
        subscriptions: new Set(),
        destroyed: () => dispatch(hub, 'destroyed'),
        gone: () => dispatch(hub, 'render-process-gone'),
        navigation: (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) {
                dispatch(hub, 'main-frame-navigation');
            }
        },
        navigationSubscribers: 0,
    };
    return hub;
}

/**
 * Calls `listener` when the renderer behind `sender` ends: the WebContents is
 * destroyed, its render process is gone or, with `navigation`, its main frame
 * navigates to another document. The subscription stays until the returned
 * function is called.
 *
 * Every owner of per-sender state subscribes here instead of attaching its own
 * WebContents listeners, so a window holds one listener per event however many
 * jobs, previews and bridges track it.
 */
export function onSenderLifetimeEnd(
    sender: TSenderLifetimeTarget,
    listener: TSenderLifetimeListener,
    options: ISenderLifetimeOptions = {},
) {
    let hub = hubs.get(sender);
    if (!hub) {
        hub = createHub();
        hubs.set(sender, hub);
        sender.on('destroyed', hub.destroyed);
        sender.on('render-process-gone', hub.gone);
    }
    const subscription: ISenderLifetimeSubscription = {
        listener,
        navigation: options.navigation === true,
    };
    hub.subscriptions.add(subscription);
    if (subscription.navigation) {
        hub.navigationSubscribers += 1;
        if (hub.navigationSubscribers === 1) {
            sender.on('did-start-navigation', hub.navigation);
        }
    }

    const ownHub = hub;
    return () => {
        if (!ownHub.subscriptions.delete(subscription)) {
            return;
        }
        if (subscription.navigation) {
            ownHub.navigationSubscribers -= 1;
            if (ownHub.navigationSubscribers === 0) {
                sender.removeListener('did-start-navigation', ownHub.navigation);
            }
        }
        if (ownHub.subscriptions.size === 0 && hubs.get(sender) === ownHub) {
            hubs.delete(sender);
            sender.removeListener('destroyed', ownHub.destroyed);
            sender.removeListener('render-process-gone', ownHub.gone);
        }
    };
}
