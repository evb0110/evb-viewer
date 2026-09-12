import type {
    IpcMainEvent,
    IpcMainInvokeEvent,
} from 'electron';
import type {
    IIpcCodec,
    IIpcInvokeSpec,
    IIpcMainRegistrar,
    TIpcCodecMap,
} from '@contracts/ipcMain';
import type {
    TAnyDefinedPlatformFeature,
    TFeatureMainBindings,
} from '@contracts/platformFeature';
import {
    isTrustedIpcInvokeSender,
    isTrustedWebContentsSender,
} from '@electron/platform-ipc/trustedIpcSender';
import { getErrorMessage } from '@electron/utils/error';
import {
    decodeIpcInvokeRequestId,
    IPC_INVOKE_REQUEST_ID_FIELD,
} from '@electron/platform-ipc/coreContract';
import {beginIpcInvokeCancellation} from '@electron/platform-ipc/ipcInvokeCancellation';
import {runWithMainOperationCancellationSignal} from '@electron/operation-lifecycle/mainOperationLifecycle';

const registeredInvokeChannels = new Set<string>();
const registeredEventChannels = new Set<string>();

class IpcArgumentValidationError extends Error {
    readonly code = 'IPC_INVALID_ARGUMENTS';
    readonly channel: string;
    override readonly cause?: unknown;

    constructor(channel: string, message: string, cause?: unknown) {
        super(`Invalid IPC arguments for ${channel}: ${message}`);
        this.name = 'IpcArgumentValidationError';
        this.channel = channel;
        this.cause = cause;
    }
}

export interface IIpcInvokeArgumentValidationPolicy {noArgumentChannels?: ReadonlySet<string>;}

export interface IValidatedIpcMainRegistrarOptions<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec} = never,
> {
    allowedChannels?: ReadonlySet<string>;
    argumentValidation?: IIpcInvokeArgumentValidationPolicy;
    codecs?: TIpcCodecMap<TMap>;
}

export interface IValidatedIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec} = never,
    TEvent = unknown,
> {handle: [TMap] extends [never]
    ? <TArgs extends unknown[], TResult>(
        channel: string,
        handler: (
            event: TEvent,
            ...args: TArgs
        ) => TResult | Promise<TResult>,
    ) => void
    : <TChannel extends Extract<keyof TMap, string>>(
        channel: TChannel,
        handler: (
            event: TEvent,
            ...args: TMap[TChannel]['args']
        ) => TMap[TChannel]['result'] | Promise<TMap[TChannel]['result']>,
    ) => void;}

export function createChannelSet<T extends Record<string, string>>(channels: T) {
    return new Set<string>(Object.values(channels));
}

function assertAllowedChannelRegistration(
    kind: 'invoke' | 'event',
    channel: string,
    allowedChannels?: ReadonlySet<string>,
) {
    if (allowedChannels && !allowedChannels.has(channel)) {
        throw new Error(`Unknown ${kind} IPC channel registered: ${channel}`);
    }
}

function assertUniqueChannelRegistration(
    kind: 'invoke' | 'event',
    registeredChannels: Set<string>,
    channel: string,
) {
    if (registeredChannels.has(channel)) {
        throw new Error(`Duplicate ${kind} IPC channel registration: ${channel}`);
    }
    registeredChannels.add(channel);
}

function assertKnownChannelRegistration(
    kind: 'invoke' | 'event',
    registeredChannels: Set<string>,
    channel: string,
    allowedChannels?: ReadonlySet<string>,
) {
    assertAllowedChannelRegistration(kind, channel, allowedChannels);
    assertUniqueChannelRegistration(kind, registeredChannels, channel);
}

function getPolicyChannels(policy: IIpcInvokeArgumentValidationPolicy | undefined) {
    return [...(policy?.noArgumentChannels ?? [])];
}

function extractIpcInvokeRequestId(args: unknown[]) {
    const metadata = args.at(-1);
    if (typeof metadata !== 'object' || metadata === null || !Object.hasOwn(metadata, IPC_INVOKE_REQUEST_ID_FIELD)) {
        return null;
    }
    const requestId = decodeIpcInvokeRequestId(metadata);
    if (requestId === null) {
        throw new Error('Invalid IPC invoke request metadata');
    }
    args.pop();
    return requestId;
}

function assertArgumentValidationPolicyChannelsAreKnown(options: {
    allowedChannels?: ReadonlySet<string>;
    argumentValidation?: IIpcInvokeArgumentValidationPolicy;
}) {
    if (!options.allowedChannels) {
        return;
    }

    for (const channel of getPolicyChannels(options.argumentValidation)) {
        if (!options.allowedChannels.has(channel)) {
            throw new Error(`IPC argument validation policy contains unknown invoke channel: ${channel}`);
        }
    }
}

export function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options?: IValidatedIpcMainRegistrarOptions,
): IValidatedIpcMainRegistrar<never, IpcMainInvokeEvent>;
export function createValidatedIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
>(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options?: IValidatedIpcMainRegistrarOptions<TMap>,
): IValidatedIpcMainRegistrar<TMap, IpcMainInvokeEvent>;
export function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options: IValidatedIpcMainRegistrarOptions | IValidatedIpcMainRegistrarOptions<Record<string, IIpcInvokeSpec>> = {},
): IValidatedIpcMainRegistrar<never, IpcMainInvokeEvent> {
    assertArgumentValidationPolicyChannelsAreKnown(options);
    return {handle: <TArgs extends unknown[], TResult>(
        channel: string,
        handler: (
            event: IpcMainInvokeEvent,
            ...args: TArgs
        ) => TResult | Promise<TResult>,
    ) => {
        assertAllowedChannelRegistration('invoke', channel, options.allowedChannels);
        const codec = options.codecs?.[channel] as IIpcCodec<IIpcInvokeSpec<TArgs, TResult>> | undefined;
        const decode = codec?.decodeArgs;
        const hasDecoder = typeof decode === 'function';
        const isExactNoArgumentChannel = !hasDecoder
            && options.argumentValidation?.noArgumentChannels?.has(channel) === true;
        if (!hasDecoder && !isExactNoArgumentChannel) {
            throw new Error(`IPC invoke channel registered without an argument decoder or explicit no-arg allowlist: ${channel}`);
        }
        assertUniqueChannelRegistration('invoke', registeredInvokeChannels, channel);
        registrar.handle(channel, async (event, ...args: unknown[]) => {
            if (!isTrustedIpcInvokeSender(event, channel)) {
                throw new Error('IPC sender is not trusted');
            }
            const requestId = extractIpcInvokeRequestId(args);
            const cancellation = requestId === null
                ? null
                : beginIpcInvokeCancellation(event.sender, requestId);
            try {
                let decodedArgs: TArgs;
                try {
                    if (isExactNoArgumentChannel) {
                        if (args.length > 0) {
                            throw new Error('expected no arguments');
                        }
                        const noArgs: unknown[] = [];
                        decodedArgs = noArgs as TArgs;
                    } else if (decode) {
                        decodedArgs = decode(args);
                        const unexpectedArgs = args.slice(decodedArgs.length);
                        if (unexpectedArgs.some(argument => argument !== undefined)) {
                            throw new Error(`unexpected trailing arguments after position ${decodedArgs.length}`);
                        }
                    } else {
                        throw new Error('argument decoder is unavailable');
                    }
                } catch (error) {
                    throw new IpcArgumentValidationError(channel, getErrorMessage(error), error);
                }
                const invokeHandler = () => handler(event, ...decodedArgs);
                // The signal reaches the handler through async context rather than
                // its signature: every channel would otherwise have to thread a
                // parameter it mostly ignores, and the operations that can act on a
                // cancellation already register themselves with the lifecycle.
                return cancellation === null
                    ? await invokeHandler()
                    : await runWithMainOperationCancellationSignal(cancellation.signal, invokeHandler);
            } finally {
                cancellation?.complete();
            }
        });
    }};
}

export function registerPlatformFeatureHandlers<
    TFeature extends TAnyDefinedPlatformFeature,
>(
    registrar: IValidatedIpcMainRegistrar<never, IpcMainInvokeEvent>,
    feature: TFeature,
    bindings: TFeatureMainBindings<TFeature, IpcMainInvokeEvent>,
) {
    const untypedBindings: object = bindings;
    const senderContext = (event: IpcMainInvokeEvent) => ({
        sender: event.sender,
        senderId: event.sender.id,
    });
    for (const spec of Object.values(feature.methods)) {
        if (spec.kind === 'sync' || 'local' in spec) {
            continue;
        }
        registrar.handle(spec.channel, (event, ...args: unknown[]) => {
            const binding: unknown = Reflect.get(untypedBindings, spec.main.method);
            if (typeof binding !== 'function') {
                throw new Error(`Missing platform feature main binding: ${spec.main.method}`);
            }
            const invokeBinding = binding as (...bindingArgs: unknown[]) => unknown;
            return spec.main.context === 'sender'
                ? invokeBinding(
                    senderContext(event),
                    ...args,
                )
                : invokeBinding(...args);
        });
    }
    for (const spec of Object.values(feature.events)) {
        if (!spec.subscription) {
            continue;
        }
        registrar.handle(spec.subscription.channel, (event) => {
            const binding: unknown = Reflect.get(untypedBindings, spec.subscription!.main.method);
            if (typeof binding !== 'function') {
                throw new Error(`Missing platform feature main binding: ${spec.subscription!.main.method}`);
            }
            const invokeBinding = binding as (...bindingArgs: unknown[]) => unknown;
            invokeBinding(senderContext(event));
            return undefined;
        });
    }
}

export interface IValidatedIpcMainEventRegistrar {on: (
    channel: string,
    handler: (event: IpcMainEvent, ...args: unknown[]) => void,
) => void;}

interface IValidatedIpcMainEventSource {on: (
    channel: string,
    handler: (event: IpcMainEvent, ...args: unknown[]) => void,
) => void;}

export function createValidatedIpcMainEventRegistrar(
    registrar: IValidatedIpcMainEventSource,
    options: {allowedChannels?: ReadonlySet<string>;} = {},
): IValidatedIpcMainEventRegistrar {
    return {on: (channel, handler) => {
        assertKnownChannelRegistration('event', registeredEventChannels, channel, options.allowedChannels);
        registrar.on(channel, (event, ...args: unknown[]) => {
            if (!isTrustedWebContentsSender(event.sender, event.senderFrame, channel)) {
                return;
            }
            handler(event, ...args);
        });
    }};
}
