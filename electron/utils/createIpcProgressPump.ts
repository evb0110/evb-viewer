export interface IProgressPumpTarget<TPayload> {
    key?: string;
    isDestroyed?: () => boolean;
    send: (channel: string, payload: TPayload) => void;
}

export type TIpcProgressReplayMode<TPayload> =
    // Remove internal job retention when every job feature uses the main job registry.
    | {kind: 'internal'}
    | {
        kind: 'external';
        getReplayPayloads: (target: IProgressPumpTarget<TPayload>) => Iterable<TPayload>;
    };

export interface IIpcProgressPumpOptions<TPayload> {
    channel: string;
    getTarget: () => IProgressPumpTarget<TPayload> | null | undefined;
    getKey: (payload: TPayload) => string;
    isTerminal?: (payload: TPayload) => boolean;
    intervalMs?: number;
    terminalRetentionMs?: number;
    replayMode?: TIpcProgressReplayMode<TPayload>;
    onError?: (error: unknown) => void;
    onIdle?: () => void;
}

const DEFAULT_PROGRESS_PUMP_INTERVAL_MS = 50;
const DEFAULT_TERMINAL_PROGRESS_RETENTION_MS = 30_000;

interface IRetainedProgress<TPayload> {
    payload: TPayload;
    terminal: boolean;
    timer: ReturnType<typeof setTimeout> | null;
}

export function createIpcProgressPump<TPayload>(options: IIpcProgressPumpOptions<TPayload>) {
    const pendingByKey = new Map<string, TPayload>();
    const pendingTargetsByKey = new Map<string, IProgressPumpTarget<TPayload> | null | undefined>();
    const timersByKey = new Map<string, ReturnType<typeof setTimeout>>();
    const keyedSubscribers = new Map<string, Set<IProgressPumpTarget<TPayload>>>();
    const unkeyedSubscribers = new Set<IProgressPumpTarget<TPayload>>();
    const retainedByKey = new Map<string, IRetainedProgress<TPayload>>();
    const replayMode = options.replayMode ?? {kind: 'internal'};
    const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_PROGRESS_PUMP_INTERVAL_MS);
    const terminalRetentionMs = Math.max(0, options.terminalRetentionMs ?? DEFAULT_TERMINAL_PROGRESS_RETENTION_MS);

    function notifyIdleIfEmpty() {
        if (pendingByKey.size === 0 && timersByKey.size === 0 && retainedByKey.size === 0) {
            options.onIdle?.();
        }
    }

    function sendToTarget(target: IProgressPumpTarget<TPayload> | null | undefined, payload: TPayload) {
        if (!target || target.isDestroyed?.() === true) {
            return;
        }
        try {
            target.send(options.channel, payload);
        } catch (error) {
            options.onError?.(error);
        }
    }

    function getTargetKey(target: IProgressPumpTarget<TPayload> | null | undefined) {
        const key = target?.key?.trim();
        return key && key.length > 0
            ? key
            : null;
    }

    function send(
        payload: TPayload,
        primaryTarget: IProgressPumpTarget<TPayload> | null | undefined = options.getTarget(),
    ) {
        const primaryTargetKey = getTargetKey(primaryTarget);
        sendToTarget(primaryTarget, payload);
        for (const subscribers of keyedSubscribers.values()) {
            for (const subscriber of subscribers) {
                if (primaryTargetKey !== null && getTargetKey(subscriber) === primaryTargetKey) {
                    continue;
                }
                sendToTarget(subscriber, payload);
            }
        }
        for (const subscriber of unkeyedSubscribers) {
            sendToTarget(subscriber, payload);
        }
    }

    function clearRetainedTimer(key: string) {
        const retained = retainedByKey.get(key);
        if (retained?.timer) {
            clearTimeout(retained.timer);
            retained.timer = null;
        }
    }

    function retain(key: string, payload: TPayload) {
        if (replayMode.kind === 'external') {
            return;
        }
        const terminal = options.isTerminal?.(payload) === true;
        clearRetainedTimer(key);

        let timer: ReturnType<typeof setTimeout> | null = null;
        if (terminal) {
            timer = setTimeout(() => {
                retainedByKey.delete(key);
                notifyIdleIfEmpty();
            }, terminalRetentionMs);
            timer.unref();
        }

        retainedByKey.set(key, {
            payload,
            terminal,
            timer,
        });
    }

    function clearTimer(key: string) {
        const timer = timersByKey.get(key);
        if (timer) {
            clearTimeout(timer);
            timersByKey.delete(key);
        }
    }

    function flush(key: string) {
        timersByKey.delete(key);
        const payload = pendingByKey.get(key);
        if (payload === undefined) {
            return;
        }
        const target = pendingTargetsByKey.get(key);
        pendingByKey.delete(key);
        pendingTargetsByKey.delete(key);
        retain(key, payload);
        send(payload, target);
        if (pendingByKey.has(key)) {
            scheduleFlush(key);
        }
    }

    function scheduleFlush(key: string) {
        const timer = setTimeout(() => {
            flush(key);
        }, intervalMs);
        timer.unref();
        timersByKey.set(key, timer);
    }

    function enqueue(
        payload: TPayload,
        target: IProgressPumpTarget<TPayload> | null | undefined = options.getTarget(),
    ) {
        const key = options.getKey(payload);
        if (options.isTerminal?.(payload) === true) {
            pendingByKey.delete(key);
            pendingTargetsByKey.delete(key);
            clearTimer(key);
            retain(key, payload);
            send(payload, target);
            return;
        }

        pendingByKey.set(key, payload);
        pendingTargetsByKey.set(key, target);
        if (timersByKey.has(key)) {
            retain(key, payload);
            return;
        }
        pendingByKey.delete(key);
        pendingTargetsByKey.delete(key);
        retain(key, payload);
        send(payload, target);
        scheduleFlush(key);
    }

    function clearKey(key: string) {
        pendingByKey.delete(key);
        pendingTargetsByKey.delete(key);
        clearTimer(key);
        const retained = retainedByKey.get(key);
        if (retained && !retained.terminal) {
            clearRetainedTimer(key);
            retainedByKey.delete(key);
        }
        notifyIdleIfEmpty();
    }

    function clear() {
        for (const timer of timersByKey.values()) {
            clearTimeout(timer);
        }
        timersByKey.clear();
        pendingByKey.clear();
        pendingTargetsByKey.clear();
        keyedSubscribers.clear();
        unkeyedSubscribers.clear();
        for (const [
            key,
            retained,
        ] of retainedByKey.entries()) {
            if (!retained.terminal) {
                clearRetainedTimer(key);
                retainedByKey.delete(key);
            }
        }
        notifyIdleIfEmpty();
    }

    function dispose() {
        clear();
        for (const key of retainedByKey.keys()) {
            clearRetainedTimer(key);
        }
        retainedByKey.clear();
        notifyIdleIfEmpty();
    }

    function subscribe(target: IProgressPumpTarget<TPayload>) {
        if (target.isDestroyed?.() === true) {
            return;
        }
        const targetKey = getTargetKey(target);
        if (targetKey) {
            const subscribers = keyedSubscribers.get(targetKey) ?? new Set<IProgressPumpTarget<TPayload>>();
            subscribers.add(target);
            keyedSubscribers.set(targetKey, subscribers);
        } else {
            unkeyedSubscribers.add(target);
        }
        const replayPayloads = replayMode.kind === 'external'
            ? replayMode.getReplayPayloads(target)
            : [...retainedByKey.values()].map(({payload}) => payload);
        for (const payload of replayPayloads) {
            sendToTarget(target, payload);
        }

        return () => {
            if (targetKey) {
                const subscribers = keyedSubscribers.get(targetKey);
                subscribers?.delete(target);
                if (subscribers?.size === 0) {
                    keyedSubscribers.delete(targetKey);
                }
                return;
            }
            unkeyedSubscribers.delete(target);
        };
    }

    return {
        enqueue,
        flush,
        subscribe,
        clearKey,
        clear,
        dispose,
    };
}
