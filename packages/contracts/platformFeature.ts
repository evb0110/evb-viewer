import type {
    IPlatformApiDescriptor,
    IPlatformMethodDescriptor,
    TPlatformBackend,
} from '@contracts/platformDescriptorTypes';
import * as v from 'valibot';

export type TPlatformFeatureSchema<TOutput = unknown> = v.GenericSchema<unknown, TOutput>;
type TSchemaValue = ReturnType<JSON['parse']>;

type TPlatformBrowserSpec = {method: string} | {
    unsupported: 'omitted';
    reason: 'unsupported-backend' | 'requires-native-backend' | 'not-implemented';
};

const fail = (message: string): never => {
    throw new Error(message);
};

function assertFeatureTupleArity<T>(schema: TPlatformFeatureSchema<T>, value: unknown) {
    if (schema.type !== 'strict_tuple' || !('items' in schema)) {
        return;
    }
    const items: unknown = schema.items;
    if (!Array.isArray(items)) {
        return;
    }
    const tupleItems: readonly unknown[] = items;
    let minimum = tupleItems.length;
    while (minimum > 0) {
        const lastItem = tupleItems[minimum - 1];
        if (typeof lastItem !== 'object' || lastItem === null || !('type' in lastItem) || lastItem.type !== 'optional') {
            break;
        }
        minimum--;
    }
    const maximum = tupleItems.length;
    const received = Array.isArray(value) ? value.length : 0;
    if (!Array.isArray(value) || received < minimum || received > maximum) {
        const expected = minimum === maximum ? String(maximum) : `${minimum}-${maximum}`;
        throw new Error(`expected ${expected} arguments, received ${received}`);
    }
}

function parseFeatureSchema<T>(schema: TPlatformFeatureSchema<T>, value: unknown): T {
    assertFeatureTupleArity(schema, value);
    return v.parse(schema, value, {abortEarly: true});
}

type TForwardedPlatformMethod<
    TName extends string,
    TChannel extends string,
    TArgs extends TPlatformFeatureSchema<unknown[]>,
    TResult extends TPlatformFeatureSchema,
    TMain extends string,
    TOptional extends boolean | undefined,
> = {
    readonly kind: 'async';
    readonly channel: TChannel;
    readonly ipc: {
        readonly args: TArgs;
        readonly result: TResult;
    };
    readonly main: {
        readonly method: TMain;
        readonly context: 'sender';
    };
    readonly browser: {readonly method: TName};
    readonly lazy: 'forwarded';
} & (TOptional extends true ? {readonly optionalWhenImplemented: true} : Record<never, never>);

interface IForwardedPlatformMethodDefinition {
    name: string;
    channel: string;
    args: TPlatformFeatureSchema<unknown[]>;
    result: TPlatformFeatureSchema;
    main: string;
    optionalWhenImplemented?: boolean;
}

interface IWideForwardedPlatformMethod {
    kind: 'async';
    channel: string;
    ipc: {
        args: TPlatformFeatureSchema<unknown[]>;
        result: TPlatformFeatureSchema;
    };
    main: {
        method: string;
        context: 'sender';
    };
    browser: {method: string};
    lazy: 'forwarded';
    optionalWhenImplemented?: boolean;
}

export function defineForwardedPlatformMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends TPlatformFeatureSchema<unknown[]>,
    const TResult extends TPlatformFeatureSchema,
    const TMain extends string,
    const TOptional extends boolean | undefined = undefined,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    main: TMain;
    optionalWhenImplemented?: TOptional;
}): TForwardedPlatformMethod<TName, TChannel, TArgs, TResult, TMain, TOptional>;
export function defineForwardedPlatformMethod(definition: IForwardedPlatformMethodDefinition): IWideForwardedPlatformMethod;
export function defineForwardedPlatformMethod(definition: IForwardedPlatformMethodDefinition): IWideForwardedPlatformMethod {
    return {
        kind: 'async',
        channel: definition.channel,
        ipc: {
            args: definition.args,
            result: definition.result,
        },
        main: {
            method: definition.main,
            context: 'sender',
        },
        browser: {method: definition.name},
        ...(definition.optionalWhenImplemented === true ? {optionalWhenImplemented: true} : {}),
        lazy: 'forwarded',
    };
}

export function defineForwardedPlatformEvent<
    const TName extends string,
    const TChannel extends string,
    const TPayload extends TPlatformFeatureSchema,
>(definition: {
    name: TName;
    channel: TChannel;
    payload: TPayload;
}) {
    return {
        kind: 'event',
        channel: definition.channel,
        payload: definition.payload,
        browser: {method: definition.name},
        lazy: 'forwarded',
    } as const;
}

export interface IPlatformIpcMethodSpec<
    TArgs extends TPlatformFeatureSchema<unknown[]> = TPlatformFeatureSchema<unknown[]>,
    TResult extends TPlatformFeatureSchema = TPlatformFeatureSchema,
> {
    kind: 'async' | 'void';
    channel: string;
    ipc: {
        args: TArgs;
        result: TResult;
        timeoutMs?: number;
    };
    client?: {mapArgs: (...args: never[]) => v.InferOutput<TArgs>};
    main: {
        method: string;
        context: 'none' | 'sender';
    };
    browser: TPlatformBrowserSpec;
    required?: Partial<Record<TPlatformBackend, boolean>>;
    optionalWhenImplemented?: boolean;
    lazy: 'forwarded' | 'direct';
}

export interface IPlatformSyncMethodSpec<
    TArgs extends TPlatformFeatureSchema<unknown[]> = TPlatformFeatureSchema<unknown[]>,
    TResult extends TPlatformFeatureSchema = TPlatformFeatureSchema,
> {
    kind: 'sync';
    args: TArgs;
    result: TResult;
    browser: TPlatformBrowserSpec;
    required?: Partial<Record<TPlatformBackend, boolean>>;
    optionalWhenImplemented?: boolean;
    lazy: 'direct';
}

export interface IPlatformLocalMethodSpec<
    TArgs extends TPlatformFeatureSchema<unknown[]> = TPlatformFeatureSchema<unknown[]>,
    TResult extends TPlatformFeatureSchema = TPlatformFeatureSchema,
> {
    kind: 'async' | 'void';
    local: {
        args: TArgs;
        result: TResult;
    };
    browser: TPlatformBrowserSpec;
    required?: Partial<Record<TPlatformBackend, boolean>>;
    optionalWhenImplemented?: boolean;
    lazy: 'forwarded' | 'direct';
}

export type TPlatformMethodSpec =
    | IPlatformIpcMethodSpec
    | IPlatformLocalMethodSpec
    | IPlatformSyncMethodSpec;

export interface IPlatformEventSpec<
    TPayload extends TPlatformFeatureSchema<TSchemaValue> = TPlatformFeatureSchema<TSchemaValue>,
> {
    kind: 'event';
    channel: string;
    payload: TPayload;
    subscription?: {
        channel: string;
        request: 'once-per-preload-event-channel';
        main: {
            method: string;
            context: 'sender';
        };
        replay?: {
            owner: 'ipc-progress-pump';
            mode: 'latest-per-key';
            key: (payload: v.InferOutput<TPayload>) => string;
            terminal: (payload: v.InferOutput<TPayload>) => boolean;
            intervalMs: number;
            terminalRetentionMs: number;
        };
    };
    browser: TPlatformBrowserSpec;
    required?: Partial<Record<TPlatformBackend, boolean>>;
    optionalWhenImplemented?: boolean;
    lazy: 'forwarded' | 'direct';
}

type TMethods = Record<string, TPlatformMethodSpec>;
type TEvents = Record<string, IPlatformEventSpec>;

interface IFeatureInput<TMethodMap extends TMethods, TEventMap extends TEvents> {
    path: readonly [string, ...string[]];
    capabilityPath?: readonly [string, ...string[]];
    required: Record<TPlatformBackend, boolean>;
    manifestPath?: readonly string[];
    methods: TMethodMap;
    events?: TEventMap;
}

type TPublicMethod<TSpec extends TPlatformMethodSpec> =
    TSpec extends IPlatformSyncMethodSpec<infer TArgs, infer TResult>
        ? (...args: v.InferOutput<TArgs>) => v.InferOutput<TResult>
        : TSpec extends IPlatformLocalMethodSpec<infer TArgs, infer TResult>
            ? (...args: v.InferOutput<TArgs>) => TSpec['kind'] extends 'async'
                ? Promise<v.InferOutput<TResult>>
                : v.InferOutput<TResult>
            : TSpec extends IPlatformIpcMethodSpec
                ? (
                    ...args: TSpec['client'] extends {mapArgs: (...args: infer TArgs) => unknown}
                        ? TArgs
                        : Extract<v.InferOutput<TSpec['ipc']['args']>, unknown[]>
                ) => TSpec['kind'] extends 'async'
                    ? Promise<v.InferOutput<TSpec['ipc']['result']>>
                    : v.InferOutput<TSpec['ipc']['result']>
                : never;

type TRequiredCapabilityMethods<TMethodMap extends TMethods> = {
    [TKey in keyof TMethodMap as TMethodMap[TKey] extends {optionalWhenImplemented: true}
        ? never
        : TKey]: TPublicMethod<TMethodMap[TKey]>
};
type TOptionalCapabilityMethods<TMethodMap extends TMethods> = {
    [TKey in keyof TMethodMap as TMethodMap[TKey] extends {optionalWhenImplemented: true}
        ? TKey
        : never]?: TPublicMethod<TMethodMap[TKey]>
};
type TRequiredCapabilityEvents<TEventMap extends TEvents> = {
    [TKey in keyof TEventMap as TEventMap[TKey] extends {optionalWhenImplemented: true}
        ? never
        : TKey]:
    (callback: (payload: v.InferOutput<TEventMap[TKey]['payload']>) => void) => (() => void)
};
type TOptionalCapabilityEvents<TEventMap extends TEvents> = {
    [TKey in keyof TEventMap as TEventMap[TKey] extends {optionalWhenImplemented: true}
        ? TKey
        : never]?:
    (callback: (payload: v.InferOutput<TEventMap[TKey]['payload']>) => void) => (() => void)
};
type TCapability<TMethodMap extends TMethods, TEventMap extends TEvents> =
    TRequiredCapabilityMethods<TMethodMap>
    & TOptionalCapabilityMethods<TMethodMap>
    & TRequiredCapabilityEvents<TEventMap>
    & TOptionalCapabilityEvents<TEventMap>;

export type TFeatureCapability<T> = T extends IDefinedPlatformFeature<infer M, infer E>
    ? TCapability<M, E>
    : never;

type TMethodInvokeMap<M extends TMethods> = {
    [K in keyof M as M[K] extends IPlatformIpcMethodSpec
        ? M[K]['channel']
        : never]: M[K] extends IPlatformIpcMethodSpec ? {
        args: Extract<v.InferOutput<M[K]['ipc']['args']>, unknown[]>;
        result: v.InferOutput<M[K]['ipc']['result']>;
    } : never
};

type TSubscriptionInvokeMap<E extends TEvents> = {
    [K in keyof E as E[K]['subscription'] extends {channel: infer C extends string} ? C : never]: {
        args: [];
        result: undefined;
    }
};
type TFeatureCodecMap<M extends TMethods, E extends TEvents> = {
    [TChannel in keyof (TMethodInvokeMap<M> & TSubscriptionInvokeMap<E>)]:
    (TMethodInvokeMap<M> & TSubscriptionInvokeMap<E>)[TChannel] extends {
        args: infer TArgs extends unknown[];
        result: infer TResult;
    } ? {
            encodeArgs: (value: unknown[]) => TArgs;
            decodeArgs: (value: readonly unknown[]) => TArgs;
            decodeResult: (value: unknown) => TResult;
        }
        : never;
};

export type TFeatureInvokeMap<T> = T extends IDefinedPlatformFeature<infer M, infer E>
    ? TMethodInvokeMap<M> & TSubscriptionInvokeMap<E>
    : never;

export type TFeatureEventMap<T> = T extends {events: infer E extends TEvents}
    ? {[K in keyof E as E[K]['channel']]: v.InferOutput<E[K]['payload']>}
    : never;

export interface IPlatformMainSenderContext<TSender> {
    sender: TSender;
    senderId: number;
}

type TSender<TEvent> = TEvent extends {sender: infer S} ? IPlatformMainSenderContext<S>
    : never;

type TMainMethod<TSpec extends IPlatformIpcMethodSpec, TEvent> = (
    ...args: TSpec['main']['context'] extends 'sender'
        ? [TSender<TEvent>, ...Extract<v.InferOutput<TSpec['ipc']['args']>, unknown[]>]
        : Extract<v.InferOutput<TSpec['ipc']['args']>, unknown[]>
) => v.InferOutput<TSpec['ipc']['result']> | Promise<v.InferOutput<TSpec['ipc']['result']>>;

export type TFeatureMainBindings<T, TEvent> = T extends {
    methods: infer M extends TMethods;
    events: infer E extends TEvents;
}
    ? {[K in keyof M as M[K] extends IPlatformIpcMethodSpec
        ? M[K] extends {main: {method: infer Name extends string}} ? Name : never
        : never]: M[K] extends IPlatformIpcMethodSpec ? TMainMethod<M[K], TEvent> : never} & {
            [K in keyof E as E[K]['subscription'] extends
            {main: {method: infer Name extends string}} ? Name : never]:
            (context: TSender<TEvent>) => void
        }
    : never;

export type TFeatureBrowserBindings<T> = TFeatureCapability<T>;
type TRequiredDirectBindings<M extends TMethods> = {
    [K in keyof M as M[K] extends IPlatformSyncMethodSpec | IPlatformLocalMethodSpec
        ? M[K] extends {optionalWhenImplemented: true} ? never : K
        : never]: TPublicMethod<M[K]>
};
type TOptionalDirectBindings<M extends TMethods> = {
    [K in keyof M as M[K] extends IPlatformSyncMethodSpec | IPlatformLocalMethodSpec
        ? M[K] extends {optionalWhenImplemented: true} ? K : never
        : never]?: TPublicMethod<M[K]>
};
export type TFeatureDirectBindings<T> = T extends {methods: infer M extends TMethods}
    ? TRequiredDirectBindings<M> & TOptionalDirectBindings<M>
    : never;
export type TFeatureSyncBindings<T> = TFeatureDirectBindings<T>;

type TFeatureInvokeChannels<M extends TMethods, E extends TEvents> =
    {readonly [K in keyof M as M[K] extends IPlatformIpcMethodSpec ? K : never]:
        M[K] extends IPlatformIpcMethodSpec ? M[K]['channel'] : never} & {
            readonly [K in keyof E as E[K]['subscription'] extends
            {main: {method: infer Name extends string}} ? Name : never]: string
        };

type TFeatureEventChannels<E extends TEvents> = {readonly [K in keyof E]: E[K]['channel']};

interface IPlatformFeatureCodec {
    encodeArgs: (value: unknown[]) => unknown[];
    decodeArgs: (value: readonly unknown[]) => unknown[];
    decodeResult: (value: unknown) => unknown;
}

export interface IDefinedPlatformFeature<M extends TMethods, E extends TEvents>
    extends IFeatureInput<M, E> {
    events: E;
    platformDescriptors: IPlatformApiDescriptor;
    invokeChannels: TFeatureInvokeChannels<M, E>;
    invokeChannelSet: ReadonlySet<string>;
    eventChannels: TFeatureEventChannels<E>;
    ipcCodecs: TFeatureCodecMap<M, E> & Readonly<Record<string, IPlatformFeatureCodec>>;
}

export type TAnyDefinedPlatformFeature = IDefinedPlatformFeature<TMethods, TEvents>;

export function definePlatformFeature<const M extends TMethods, const E extends TEvents>(
    definition: IFeatureInput<M, E>,
): IDefinedPlatformFeature<M, E>;
export function definePlatformFeature(
    definition: IFeatureInput<TMethods, TEvents>,
): IDefinedPlatformFeature<TMethods, TEvents> {
    const events = definition.events ?? {};
    const seen = new Set<string>();
    const invokeChannels: Record<string, string> = {};
    const eventChannels: Record<string, string> = {};
    const ipcCodecs: Record<string, IPlatformFeatureCodec> = {};
    const methods: IPlatformMethodDescriptor[] = [];
    const addChannel = (channel: string) => {
        if (seen.has(channel)) {
            fail(`Duplicate platform feature channel: ${channel}`);
        }
        seen.add(channel);
    };
    const addDescriptor = (
        name: string,
        spec: {
            kind: IPlatformMethodDescriptor['kind'];
            lazy: 'forwarded' | 'direct';
        },
        required: Record<TPlatformBackend, boolean>,
        optionalWhenImplemented = false,
    ) => {
        const descriptor: IPlatformMethodDescriptor = {
            path: [
                ...definition.path,
                name,
            ],
            kind: spec.kind,
            required,
            ...(optionalWhenImplemented ? {optionalWhenImplemented: true} : {}),
            browserLazy: spec.lazy,
        };
        methods.push(descriptor);
    };
    for (const [
        name,
        spec,
    ] of Object.entries(definition.methods)) {
        if (spec.kind === 'sync' || 'local' in spec) {
            addDescriptor(name, spec, {
                ...definition.required,
                ...spec.required,
            }, spec.optionalWhenImplemented);
            continue;
        }
        addChannel(spec.channel);
        invokeChannels[name] = spec.channel;
        ipcCodecs[spec.channel] = {
            encodeArgs: value => parseFeatureSchema(spec.ipc.args, value),
            decodeArgs: value => parseFeatureSchema(spec.ipc.args, value),
            decodeResult: value => parseFeatureSchema(spec.ipc.result, value),
        };
        addDescriptor(name, spec, {
            ...definition.required,
            ...spec.required,
        }, spec.optionalWhenImplemented);
    }
    for (const [
        name,
        spec,
    ] of Object.entries(events)) {
        addChannel(spec.channel);
        eventChannels[name] = spec.channel;
        addDescriptor(name, spec, {
            ...definition.required,
            ...spec.required,
        }, spec.optionalWhenImplemented);
        if (spec.subscription) {
            addChannel(spec.subscription.channel);
            invokeChannels[spec.subscription.main.method] = spec.subscription.channel;
            const noArgs = v.strictTuple([]);
            const undefinedResult = v.undefined();
            ipcCodecs[spec.subscription.channel] = {
                encodeArgs: value => parseFeatureSchema(noArgs, value),
                decodeArgs: value => parseFeatureSchema(noArgs, value),
                decodeResult: value => parseFeatureSchema(undefinedResult, value),
            };
        }
    }
    return {
        ...definition,
        events,
        platformDescriptors: {
            capabilities: [{
                path: definition.capabilityPath ?? definition.path,
                required: definition.required,
                ...(definition.manifestPath ? {manifestPath: definition.manifestPath} : {}),
            }],
            methods,
        },
        invokeChannels,
        invokeChannelSet: new Set(Object.values(invokeChannels)),
        eventChannels,
        ipcCodecs: Object.assign({}, ipcCodecs),
    };
}
