import { getErrorMessage } from '@electron/utils/error';
import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';
import type {
    IIpcInvokeSpec,
    TIpcCodecMap,
} from '@contracts/ipcMain';
import type {
    TAnyDefinedPlatformFeature,
    TFeatureCapability,
    TFeatureDirectBindings,
} from '@contracts/platformFeature';
import {createRequestId} from '@contracts/shared';
import {
    CORE_IPC_SEND_CHANNELS,
    IPC_INVOKE_REQUEST_ID_FIELD,
} from '@electron/platform-ipc/coreContract';

type TNoArgEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Extract<{
    [TChannel in keyof TEventMap]: TEventMap[TChannel] extends undefined ? TChannel : never;
}[keyof TEventMap], string>;

type TPayloadEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Exclude<
    Extract<keyof TEventMap, string>,
    TNoArgEventChannel<TEventMap>
>;

type TIpcPayloadDecoder<TPayload> = (value: unknown) => TPayload | null;
type TIpcInvokeTimeoutMap<TChannel extends string = string> = Readonly<Partial<Record<TChannel, number>>>;

interface IIpcInvokerOptions<TChannel extends string = string> { invokeTimeoutMsByChannel?: TIpcInvokeTimeoutMap<TChannel>; }

function logDecodedEventValidationFailure(
    ipcRenderer: Partial<Pick<IpcRenderer, 'send'>>,
    channel: string,
    payload: unknown,
) {
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
            data: { channel },
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
        const message = cause instanceof Error && getErrorMessage(cause)
            ? getErrorMessage(cause)
            : `IPC invoke failed for ${channel}`;
        super(message);
        this.name = 'PlatformIpcInvokeError';
        this.channel = channel;
        this.cause = cause;
    }
}

async function invokeWithChannelContext<TResult>(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'send'>,
    channel: string,
    args: unknown[],
    options?: IIpcInvokerOptions,
) {
    let timeoutHandle = null as ReturnType<typeof setTimeout> | null;
    const timeoutMs = options?.invokeTimeoutMsByChannel?.[channel];
    // Only a timed invoke can be abandoned, so only a timed invoke needs an id
    // for the main process to cancel it by.
    const timed = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? {
            requestId: createRequestId('ipc-invoke'),
            timeoutMs,
        }
        : null;
    try {
        const invokeArgs = timed === null
            ? args
            : [
                ...args,
                {[IPC_INVOKE_REQUEST_ID_FIELD]: timed.requestId},
            ];
        const invokePromise = ipcRenderer.invoke(channel, ...invokeArgs) as Promise<TResult>;
        if (timed === null) {
            return await invokePromise;
        }

        return await Promise.race([
            invokePromise,
            new Promise<never>((_resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                    // Giving up on the reply is not the same as stopping the work.
                    // Without this the handler keeps running and keeps its leases,
                    // and a user retry runs a second copy of it against the same
                    // document.
                    try {
                        ipcRenderer.send(CORE_IPC_SEND_CHANNELS.ipcInvokeCanceled, {[IPC_INVOKE_REQUEST_ID_FIELD]: timed.requestId});
                    } catch {
                        // Preserve the timeout identity if the renderer transport is already closing.
                    }
                    reject(new IpcInvokeTimeoutError(channel, timed.timeoutMs));
                }, timed.timeoutMs);
                timeoutHandle.unref?.();
            }),
        ]);
    } catch (error) {
        // A timeout keeps its own identity. Wrapping it made every
        // `instanceof IpcInvokeTimeoutError` upstream unreachable.
        if (error instanceof IpcInvokeTimeoutError) {
            throw error;
        }
        throw new PlatformIpcInvokeError(channel, error);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

export function createCodecIpcInvoker<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}>(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'send'>,
    codecs: TIpcCodecMap<TMap>,
    options?: IIpcInvokerOptions<Extract<keyof TMap, string>>,
) {
    return async function invoke<TChannel extends Extract<keyof TMap, string>>(
        channel: TChannel,
        ...args: TMap[TChannel]['args']
    ) {
        let encodedArgs: TMap[TChannel]['args'];
        try {
            encodedArgs = codecs[channel].encodeArgs?.(args) ?? args;
        } catch (error) {
            const details = error instanceof Error ? `: ${getErrorMessage(error)}` : '';
            throw new PlatformIpcInvokeError(
                channel,
                new Error(`Invalid IPC request for ${channel}${details}`),
            );
        }
        const result: unknown = await invokeWithChannelContext<unknown>(ipcRenderer, channel, encodedArgs, options);
        try {
            return codecs[channel].decodeResult(result);
        } catch (error) {
            const details = error instanceof Error ? `: ${getErrorMessage(error)}` : '';
            throw new PlatformIpcInvokeError(
                channel,
                new Error(`Invalid IPC response for ${channel}${details}`),
            );
        }
    };
}

export function createTypedIpcEventSubscriber<
    TEventMap extends {[TChannel in keyof TEventMap]: unknown},
>(ipcRenderer: Partial<Pick<IpcRenderer, 'on' | 'removeListener' | 'send'>>) {
    type TEventCallback = (event: IpcRendererEvent, payload: unknown) => void;
    interface IChannelSubscription {
        callbacks: Set<TEventCallback>;
        handler: TEventCallback;
    }

    const subscriptions = new Map<string, IChannelSubscription>();

    function subscribe(channel: string, callback: TEventCallback): TMenuEventUnsubscribe {
        if (
            typeof ipcRenderer.on !== 'function'
            || typeof ipcRenderer.removeListener !== 'function'
        ) {
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

    return {
        onNoArg<TChannel extends TNoArgEventChannel<TEventMap>>(
            channel: TChannel,
            callback: () => void,
        ): TMenuEventUnsubscribe {
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
                const decoded = decode(payload);
                if (decoded !== null) {
                    callback(decoded);
                    return;
                }
                logDecodedEventValidationFailure(ipcRenderer, channel, payload);
            });
        },
    };
}

export function createPlatformFeaturePreloadClient<
    TFeature extends TAnyDefinedPlatformFeature,
>(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'>,
    feature: TFeature,
    directBindings?: TFeatureDirectBindings<TFeature>,
): TFeatureCapability<TFeature> {
    const invokeTimeoutMsByChannel = Object.fromEntries(
        Object.values(feature.methods)
            .flatMap(spec => spec.kind === 'sync' || 'local' in spec || spec.ipc.timeoutMs === undefined
                ? []
                : [[
                    spec.channel,
                    spec.ipc.timeoutMs,
                ]]),
    );
    const invoke = createCodecIpcInvoker(
        ipcRenderer,
        feature.ipcCodecs,
        {invokeTimeoutMsByChannel},
    );
    const eventSubscriber = createTypedIpcEventSubscriber<Record<string, unknown>>(ipcRenderer);
    const requestedSubscriptions = new Set<string>();
    const pendingSubscriptions = new Set<string>();
    const client: Record<string, unknown> = {};
    const untypedDirectBindings = directBindings as Record<string, ((...args: unknown[]) => unknown)> | undefined;

    for (const [
        name,
        spec,
    ] of Object.entries(feature.methods)) {
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
        client[name] = (...publicArgs: unknown[]) => {
            const wireArgs = spec.client?.mapArgs
                ? spec.client.mapArgs(...publicArgs as never[])
                : publicArgs;
            return invoke(spec.channel, ...wireArgs);
        };
    }
    for (const [
        name,
        spec,
    ] of Object.entries(feature.events)) {
        client[name] = (callback: (payload: unknown) => void) => {
            const unsubscribe = eventSubscriber.onDecodedPayload(
                spec.channel,
                value => {
                    try {
                        return spec.payload.decode(value);
                    } catch {
                        return null;
                    }
                },
                callback,
            );
            const subscription = spec.subscription;
            if (
                subscription
                && !requestedSubscriptions.has(spec.channel)
                && !pendingSubscriptions.has(spec.channel)
            ) {
                pendingSubscriptions.add(spec.channel);
                void invoke(subscription.channel)
                    .then(() => {
                        requestedSubscriptions.add(spec.channel);
                    })
                    .catch(error => {
                        console.warn(`IPC event subscription failed for ${spec.channel}: ${getErrorMessage(error)}`);
                    })
                    .finally(() => {
                        pendingSubscriptions.delete(spec.channel);
                    });
            }
            return unsubscribe;
        };
    }
    return client as TFeatureCapability<TFeature>;
}
