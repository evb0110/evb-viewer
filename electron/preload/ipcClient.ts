import {getErrorMessage} from '@electron/utils/error';
import type {IpcRenderer, IpcRendererEvent} from 'electron';
import type {TMenuEventUnsubscribe} from '@contracts/electronApiCommon';
import type {IIpcInvokeSpec} from '@contracts/ipcMain';
import type {
    TAnyDefinedPlatformFeature,
    TFeatureCapability,
    TFeatureDirectBindings,
    TPlatformIpcAbortSubscription,
} from '@contracts/platformFeature';
import {createRequestId} from '@contracts/shared';
import {isAbortError} from '@contracts/isAbortError';
import {isRecord} from '@contracts/runtimeGuards';
import {CORE_IPC_SEND_CHANNELS, IPC_INVOKE_CANCEL_REASON_FIELD, IPC_INVOKE_REQUEST_ID_FIELD} from '@electron/platform-ipc/coreContract';

type TNoArgEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Extract<
    {
        [TChannel in keyof TEventMap]: TEventMap[TChannel] extends undefined ? TChannel : never;
    }[keyof TEventMap],
    string
>;

type TPayloadEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Exclude<
    Extract<keyof TEventMap, string>,
    TNoArgEventChannel<TEventMap>
>;

type TIpcPayloadDecoder<TPayload> = (value: unknown) => TPayload | null;
type TIpcInvokeTimeoutMap<TChannel extends string = string> = Readonly<Partial<Record<TChannel, number>>>;

interface IIpcInvokerOptions<TChannel extends string = string> {
    invokeTimeoutMsByChannel?: TIpcInvokeTimeoutMap<TChannel>;
    subscribeToAbort?: TPlatformIpcAbortSubscription;
}

interface IDecodedEventFailureState {
    lastLoggedAt: number;
    suppressedCount: number;
}

const DECODED_EVENT_FAILURE_LOG_INTERVAL_MS = 5_000;
function logDecodedEventValidationFailure(
    ipcRenderer: Partial<Pick<IpcRenderer, 'send'>>,
    channel: string,
    payload: unknown,
    decoderError: unknown,
    failureStates: Map<string, IDecodedEventFailureState>,
) {
    const decoderErrorMessage =
        decoderError === undefined ? 'decoder returned null' : getErrorMessage(decoderError) || 'unknown decoder error';
    const now = Date.now();
    const previous = failureStates.get(channel);
    if (previous && now - previous.lastLoggedAt < DECODED_EVENT_FAILURE_LOG_INTERVAL_MS) {
        previous.suppressedCount += 1;
        return;
    }
    const suppressedCount = previous?.suppressedCount ?? 0;
    failureStates.set(channel, {
        lastLoggedAt: now,
        suppressedCount: 0,
    });
    const message = `Dropped invalid decoded IPC event payload for ${channel}`;
    if (process.env.NODE_ENV !== 'production') {
        console.warn(message, payload);
    }
    try {
        ipcRenderer.send?.(CORE_IPC_SEND_CHANNELS.rendererLog, {
            level: 'warn',
            section: 'ipc-client',
            message,
            timestamp: new Date().toISOString(),
            data: {
                channel,
                decoderError: decoderErrorMessage,
                ...(suppressedCount === 0 ? {} : {suppressedCount}),
            },
        });
    } catch {
        // Ignore logging failures in preload.
    }
}

export class IpcInvokeTimeoutError extends Error {
    readonly channel: string;
    readonly timeoutMs: number;

    constructor(channel: string, timeoutMs: number) {
        super(`IPC invoke timed out after ${timeoutMs}ms for ${channel}`);
        this.name = 'IpcInvokeTimeoutError';
        this.channel = channel;
        this.timeoutMs = timeoutMs;
    }
}

class PlatformIpcInvokeError extends Error {
    readonly channel: string;
    override readonly cause: unknown;

    constructor(channel: string, cause: unknown) {
        const message = cause instanceof Error && getErrorMessage(cause) ? getErrorMessage(cause) : `IPC invoke failed for ${channel}`;
        super(message);
        this.name = 'PlatformIpcInvokeError';
        this.channel = channel;
        this.cause = cause;
    }
}

export async function invokeWithChannelContext<TResult>(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'send'>,
    channel: string,
    args: readonly unknown[],
    options?: IIpcInvokerOptions,
) {
    let timeoutHandle = null as ReturnType<typeof setTimeout> | null;
    let unsubscribe: (() => void) | undefined;
    const timeoutMs = options?.invokeTimeoutMsByChannel?.[channel];
    const timed = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
    const requestId = timed || options?.subscribeToAbort ? createRequestId('ipc-invoke') : null;
    try {
        const invokeArgs = requestId === null ? args : [...args, {[IPC_INVOKE_REQUEST_ID_FIELD]: requestId}];
        const invokePromise = ipcRenderer.invoke(channel, ...invokeArgs) as Promise<TResult>;
        if (requestId === null) {
            return await invokePromise;
        }

        return await Promise.race([
            invokePromise,
            new Promise<never>((_resolve, reject) => {
                const cancel = (error: Error, timedOut = false) => {
                    try {
                        ipcRenderer.send(
                            CORE_IPC_SEND_CHANNELS.ipcInvokeCanceled,
                            timedOut
                                ? {
                                      [IPC_INVOKE_REQUEST_ID_FIELD]: requestId,
                                      [IPC_INVOKE_CANCEL_REASON_FIELD]: 'timeout',
                                  }
                                : {[IPC_INVOKE_REQUEST_ID_FIELD]: requestId},
                        );
                    } catch {
                        // Preserve cancellation identity while the transport is closing.
                    }
                    reject(error);
                };
                if (timed) {
                    timeoutHandle = setTimeout(() => cancel(new IpcInvokeTimeoutError(channel, timeoutMs), true), timeoutMs);
                    timeoutHandle.unref?.();
                }
                unsubscribe = options?.subscribeToAbort?.(() => cancel(new DOMException('IPC invoke aborted', 'AbortError')));
            }),
        ]);
    } catch (error) {
        if (error instanceof IpcInvokeTimeoutError || isAbortError(error)) {
            throw error;
        }
        throw new PlatformIpcInvokeError(channel, error);
    } finally {
        unsubscribe?.();
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

export function createIpcInvoker<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}>(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'send'>,
    options?: IIpcInvokerOptions<Extract<keyof TMap, string>>,
) {
    return async function invoke<TChannel extends Extract<keyof TMap, string>>(channel: TChannel, ...args: TMap[TChannel]['args']) {
        return invokeWithChannelContext<TMap[TChannel]['result']>(ipcRenderer, channel, args, options);
    };
}

export function createTypedIpcEventSubscriber<TEventMap extends {[TChannel in keyof TEventMap]: unknown}>(
    ipcRenderer: Partial<Pick<IpcRenderer, 'on' | 'removeListener' | 'send'>>,
) {
    type TEventCallback = (event: IpcRendererEvent, payload: unknown) => void;
    interface IChannelSubscription {
        callbacks: Set<TEventCallback>;
        handler: TEventCallback;
    }

    const subscriptions = new Map<string, IChannelSubscription>();
    const decodedEventFailureStates = new Map<string, IDecodedEventFailureState>();

    function subscribe(channel: string, callback: TEventCallback): TMenuEventUnsubscribe {
        if (typeof ipcRenderer.on !== 'function' || typeof ipcRenderer.removeListener !== 'function') {
            return () => undefined;
        }

        let subscription = subscriptions.get(channel);
        if (!subscription) {
            const callbacks = new Set<TEventCallback>();
            const handler: TEventCallback = (event, payload) => {
                for (const subscriber of [...callbacks]) {
                    subscriber(event, payload);
                }
            };
            subscription = {
                callbacks,
                handler,
            };
            subscriptions.set(channel, subscription);
            ipcRenderer.on(channel, handler);
        }

        subscription.callbacks.add(callback);
        let active = true;
        return () => {
            if (!active) {
                return;
            }
            active = false;
            const current = subscriptions.get(channel);
            if (!current) {
                return;
            }
            current.callbacks.delete(callback);
            if (current.callbacks.size === 0) {
                ipcRenderer.removeListener?.(channel, current.handler);
                subscriptions.delete(channel);
            }
        };
    }

    const shared: ISharedIpcEventSubscriber = {
        onPayloadUnchecked: (channel, callback) => subscribe(channel, (_event, payload) => callback(payload)),
    };

    return {
        shared,

        onNoArg<TChannel extends TNoArgEventChannel<TEventMap>>(channel: TChannel, callback: () => void): TMenuEventUnsubscribe {
            return subscribe(channel, () => callback());
        },

        onPayloadUnchecked<TChannel extends TPayloadEventChannel<TEventMap>>(
            channel: TChannel,
            callback: (payload: TEventMap[TChannel]) => void,
        ): TMenuEventUnsubscribe {
            return subscribe(channel, (_event, payload) => callback(payload as TEventMap[TChannel]));
        },

        onDecodedPayload<TChannel extends TPayloadEventChannel<TEventMap>>(
            channel: TChannel,
            decode: TIpcPayloadDecoder<TEventMap[TChannel]>,
            callback: (payload: TEventMap[TChannel]) => void,
        ): TMenuEventUnsubscribe {
            return subscribe(channel, (_event, payload) => {
                let decoded: TEventMap[TChannel] | null = null;
                let decoderError: unknown;
                try {
                    decoded = decode(payload);
                } catch (error) {
                    decoderError = error;
                }
                if (decoded !== null) {
                    callback(decoded);
                    return;
                }
                logDecodedEventValidationFailure(ipcRenderer, channel, payload, decoderError, decodedEventFailureStates);
            });
        },
    };
}

/**
 * Minimal shared IPC event subscriber interface backed by an arbitrary-channel
 * listener registry, avoiding `as unknown as` casts without relying on method
 * bivariance.
 */
export interface ISharedIpcEventSubscriber {
    readonly onPayloadUnchecked: (channel: string, callback: (payload: unknown) => void) => TMenuEventUnsubscribe;
}

export function createPlatformFeaturePreloadClient<TFeature extends TAnyDefinedPlatformFeature>(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'>,
    feature: TFeature,
    directBindings?: TFeatureDirectBindings<TFeature>,
    sharedEventSubscriber?: ISharedIpcEventSubscriber,
): TFeatureCapability<TFeature> {
    let invokeTimeoutMsByChannel: Record<string, number> | undefined;
    for (const spec of Object.values(feature.methods)) {
        if (spec.kind === 'sync' || 'local' in spec || spec.ipc.timeoutMs === undefined) {
            continue;
        }
        invokeTimeoutMsByChannel ??= {};
        invokeTimeoutMsByChannel[spec.channel] = spec.ipc.timeoutMs;
    }
    const baseInvokeOptions = invokeTimeoutMsByChannel ? {invokeTimeoutMsByChannel} : undefined;
    const isScanCleanupFeature = feature.path[0] === 'scanCleanup';
    const client: Record<string, unknown> = {};
    const untypedDirectBindings = directBindings as Record<string, (...args: unknown[]) => unknown> | undefined;

    for (const [name, spec] of Object.entries(feature.methods)) {
        if (spec.kind === 'sync' || 'local' in spec) {
            const binding = untypedDirectBindings?.[name];
            if (typeof binding !== 'function') {
                if (spec.optionalWhenImplemented) {
                    continue;
                }
                throw new Error(`Missing platform feature direct binding: ${name}`);
            }
            client[name] = binding;
            continue;
        }
        const mapArgs = spec.client?.mapArgs;
        client[name] = (...publicArgs: unknown[]) => {
            let subscribeToAbort: TPlatformIpcAbortSubscription | undefined;
            let localArgs = publicArgs;
            for (let index = 0; index < publicArgs.length; index += 1) {
                const value = publicArgs[index];
                if (!isRecord(value) || typeof value.signal !== 'function') {
                    continue;
                }
                if (localArgs === publicArgs) {
                    localArgs = publicArgs.slice();
                }
                const {signal, ...options} = value;
                subscribeToAbort = signal as TPlatformIpcAbortSubscription;
                localArgs[index] = options;
            }
            let wireArgs = mapArgs ? mapArgs(...(localArgs as never[])) : localArgs;
            // Scan-cleanup arguments can be reactive, so encode them as plain IPC values.
            if (isScanCleanupFeature) {
                try {
                    wireArgs = feature.ipcCodecs[spec.channel]?.encodeArgs?.(wireArgs) ?? wireArgs;
                } catch (error) {
                    const details = error instanceof Error ? `: ${getErrorMessage(error)}` : '';
                    throw new PlatformIpcInvokeError(spec.channel, new Error(`Invalid IPC request for ${spec.channel}${details}`));
                }
            }
            const invokeOptions = subscribeToAbort
                ? invokeTimeoutMsByChannel
                    ? {
                          invokeTimeoutMsByChannel,
                          subscribeToAbort,
                      }
                    : {subscribeToAbort}
                : baseInvokeOptions;
            return invokeWithChannelContext(ipcRenderer, spec.channel, wireArgs, invokeOptions);
        };
    }

    const eventEntries = Object.entries(feature.events);
    if (eventEntries.length > 0) {
        const eventSubscriber = sharedEventSubscriber ?? createTypedIpcEventSubscriber<Record<string, unknown>>(ipcRenderer);
        let requestedSubscriptions: Set<string> | undefined;
        let pendingSubscriptions: Set<string> | undefined;
        for (const [name, spec] of eventEntries) {
            const subscription = spec.subscription;
            client[name] = (callback: (payload: unknown) => void) => {
                const unsubscribe = eventSubscriber.onPayloadUnchecked(spec.channel, callback);
                if (subscription) {
                    requestedSubscriptions ??= new Set<string>();
                    pendingSubscriptions ??= new Set<string>();
                    if (!requestedSubscriptions.has(spec.channel) && !pendingSubscriptions.has(spec.channel)) {
                        const requested = requestedSubscriptions;
                        const pending = pendingSubscriptions;
                        pending.add(spec.channel);
                        void invokeWithChannelContext(ipcRenderer, subscription.channel, [], baseInvokeOptions)
                            .then(() => {
                                requested.add(spec.channel);
                            })
                            .catch((error) => {
                                console.warn(`IPC event subscription failed for ${spec.channel}: ${getErrorMessage(error)}`);
                            })
                            .finally(() => {
                                pending.delete(spec.channel);
                            });
                    }
                }
                return unsubscribe;
            };
        }
    }
    return client as TFeatureCapability<TFeature>;
}
