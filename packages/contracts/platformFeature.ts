import { getErrorMessage } from '@contracts/getErrorMessage';
import type {TBrand} from '@contracts/brand';
import type {
    IPlatformApiDescriptor,
    IPlatformMethodDescriptor, TPlatformBackend, 
} from '@contracts/platformDescriptorTypes';
import * as v from 'valibot';

export interface IRuntimeSchema<T> {
    decode: (value: unknown) => T;
    encode: {bivarianceHack(value: T): unknown}['bivarianceHack'];
    example: () => T;
    decodeAt?: (value: unknown, path: string) => T;
}

export type TInferSchema<T> = T extends {decode: (...args: never[]) => unknown}
    ? ReturnType<T['decode']>
    : T extends v.BaseSchema<unknown, infer TOutput, v.BaseIssue<unknown>>
        ? TOutput
        : never;
export type TPlatformFeatureSchema<TOutput = unknown> =
    | IRuntimeSchema<TOutput>
    | v.GenericSchema<unknown, TOutput>;
type TSchemaPrimitive = string | number | boolean | null;
type TSchemaValue = ReturnType<JSON['parse']>;
type TSchemaObject = Readonly<Record<string, IRuntimeSchema<TSchemaValue>>>;
type TOptionalSchemaKeys<TShape extends TSchemaObject> = {
    [TKey in keyof TShape]: undefined extends ReturnType<TShape[TKey]['decode']> ? TKey : never
}[keyof TShape];
type TRequiredSchemaKeys<TShape extends TSchemaObject> = Exclude<keyof TShape, TOptionalSchemaKeys<TShape>>;
type TDecodedSchemaObject<TShape extends TSchemaObject> = {
    [TKey in TRequiredSchemaKeys<TShape>]: ReturnType<TShape[TKey]['decode']>
} & {
    [TKey in TOptionalSchemaKeys<TShape>]?: Exclude<ReturnType<TShape[TKey]['decode']>, undefined>
};

type TPlatformBrowserSpec = {method: string} | {
    unsupported: 'omitted';
    reason: 'unsupported-backend' | 'requires-native-backend' | 'not-implemented';
};

const fail = (message: string, path = ''): never => {
    throw new Error(path.length === 0 ? message : `${path}: ${message}`);
};

const propertyPath = (path: string, key: string) => {
    if (path.length === 0) {
        return key;
    }
    return /^[A-Za-z_$][\w$]*$/u.test(key)
        ? `${path}.${key}`
        : `${path}[${JSON.stringify(key)}]`;
};

const indexPath = (path: string, index: number) => `${path}[${String(index)}]`;

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const throwWithPath = (error: unknown, path: string): never => {
    if (path.length === 0) {
        throw error;
    }
    const message = getErrorMessage(error);
    if (
        message === path
        || message.startsWith(`${path}:`)
        || message.startsWith(`${path}.`)
        || message.startsWith(`${path}[`)
    ) {
        throw error;
    }
    throw new Error(`${path}: ${message}`);
};

const decodeWithPath = <T>(itemSchema: IRuntimeSchema<T>, value: unknown, path: string): T => {
    try {
        if (itemSchema.decodeAt !== undefined) {
            return itemSchema.decodeAt(value, path);
        }
        return itemSchema.decode(value);
    } catch (error) {
        return throwWithPath(error, path);
    }
};

const schema = <T>(
    decodeAt: (value: unknown, path: string) => T,
    example: () => T,
    encode: (value: T) => unknown = value => decodeAt(value, ''),
): IRuntimeSchema<T> => {
    const decode = (value: unknown) => {
        try {
            return decodeAt(value, '');
        } catch (error) {
            return throwWithPath(error, '');
        }
    };
    const decodeWithContext = (value: unknown, path: string) => {
        try {
            return decodeAt(value, path);
        } catch (error) {
            return throwWithPath(error, path);
        }
    };
    return {
        decode,
        encode,
        example,
        decodeAt: decodeWithContext,
    };
};

function branded<TBase, TName extends string>(
    itemSchema: IRuntimeSchema<TBase>,
    guard: (value: TBase) => value is TBrand<TBase, TName>,
    message: string,
): IRuntimeSchema<TBrand<TBase, TName>> {
    const decode = (value: unknown, path: string) => {
        const decoded = decodeWithPath(itemSchema, value, path);
        return guard(decoded) ? decoded : fail(message, path);
    };
    const example = () => {
        const candidate = itemSchema.example();
        return guard(candidate) ? candidate : fail(message, '');
    };
    return schema<TBrand<TBase, TName>>(
        decode,
        example,
        value => itemSchema.encode(value),
    );
}

type TTupleSchema = ReadonlyArray<IRuntimeSchema<unknown>>;
type TTupleValue<TSchemas extends TTupleSchema> = {-readonly [TKey in keyof TSchemas]: TInferSchema<TSchemas[TKey]>};

function tuple<const TSchemas extends TTupleSchema>(schemas: TSchemas): IRuntimeSchema<TTupleValue<TSchemas>>;
function tuple(schemas: TTupleSchema): IRuntimeSchema<unknown[]> {
    const rebuild = (value: unknown, encode: boolean, path: string): unknown[] => {
        if (!isUnknownArray(value)) {
            return fail(`expected ${schemas.length} arguments, received 0`, path);
        }
        if (value.length !== schemas.length) {
            fail(`expected ${schemas.length} arguments, received ${value.length}`, path);
        }
        return schemas.map((itemSchema, index) => encode
            ? itemSchema.encode(value[index])
            : decodeWithPath(itemSchema, value[index], indexPath(path, index)));
    };
    return schema<unknown[]>(
        (value, path) => rebuild(value, false, path),
        () => schemas.map(itemSchema => itemSchema.example()),
        value => rebuild(value, true, ''),
    );
}

function oneOf<const TValues extends readonly TSchemaPrimitive[]>(
    values: TValues,
    message = 'expected one of the declared values',
): IRuntimeSchema<TValues[number]> {
    const decode = (value: unknown, path: string) => {
        const isDeclaredValue = (candidate: unknown): candidate is TValues[number] =>
            values.some(declaredValue => declaredValue === candidate);
        return isDeclaredValue(value) ? value : fail(message, path);
    };
    const [exampleValue] = values;
    if (exampleValue === undefined) {
        throw new Error('oneOf requires at least one declared value');
    }
    return schema<TValues[number]>(decode, () => exampleValue);
}

function literal<TValue extends TSchemaPrimitive>(value: TValue): IRuntimeSchema<TValue> {
    return oneOf([value]);
}

function record<T>(itemSchema: IRuntimeSchema<T>): IRuntimeSchema<Record<string, T>> {
    const decode = (value: unknown, path: string): Record<string, T> => {
        if (!isObjectRecord(value)) {
            return fail('expected an object', path);
        }
        const result: Record<string, T> = {};
        for (const [
            key,
            item,
        ] of Object.entries(value)) {
            // Plain assignment would route a decoded "__proto__" key through the
            // Object.prototype setter, silently dropping it and reparenting result.
            Object.defineProperty(result, key, {
                configurable: true,
                enumerable: true,
                value: decodeWithPath(itemSchema, item, propertyPath(path, key)),
                writable: true,
            });
        }
        return result;
    };
    return schema<Record<string, T>>(
        decode,
        () => ({}),
        value => Object.fromEntries(Object.entries(value).map(([
            key,
            item,
        ]) => [
            key,
            itemSchema.encode(item),
        ])),
    );
}

function object<const TShape extends TSchemaObject>(
    shape: TShape,
    options?: {
        exact?: boolean;
        message?: string;
    },
): IRuntimeSchema<TDecodedSchemaObject<TShape>>;
function object(
    shape: TSchemaObject,
    options: {
        exact?: boolean;
        message?: string
    } = {},
): IRuntimeSchema<Record<string, unknown>> {
    const rebuild = (value: unknown, encode: boolean, path: string): Record<string, unknown> => {
        if (!isObjectRecord(value)) {
            return fail(options.message ?? 'expected an object', path);
        }
        if (
            options.exact === true
            && Object.keys(value).some(key => !Object.hasOwn(shape, key))
        ) {
            return fail(options.message ?? 'unexpected object field', path);
        }
        const result: Record<string, unknown> = {};
        for (const [
            key,
            itemSchema,
        ] of Object.entries(shape)) {
            const item: unknown = encode
                ? itemSchema.encode(value[key])
                : decodeWithPath(itemSchema, value[key], propertyPath(path, key));
            if (item !== undefined) {
                result[key] = item;
            }
        }
        return result;
    };
    return schema<Record<string, unknown>>(
        (value, path) => rebuild(value, false, path),
        () => rebuild(Object.fromEntries(
            Object.entries(shape).map(([
                key,
                itemSchema,
            ]) => [
                key,
                itemSchema.example(),
            ]),
        ), false, ''),
        value => rebuild(value, true, ''),
    );
}

function union<const TSchemas extends ReadonlyArray<IRuntimeSchema<TSchemaValue>>>(
    schemas: TSchemas,
    message?: string,
): IRuntimeSchema<TInferSchema<TSchemas[number]>>;
function union(
    schemas: ReadonlyArray<IRuntimeSchema<unknown>>,
    message = 'value did not match any declared schema',
): IRuntimeSchema<unknown> {
    const decode = (value: unknown, path: string): unknown => {
        for (const itemSchema of schemas) {
            try {
                const decoded: unknown = decodeWithPath(itemSchema, value, path);
                return decoded;
            } catch {
                continue;
            }
        }
        return fail(message, path);
    };
    const [exampleSchema] = schemas;
    if (exampleSchema === undefined) {
        throw new Error('union requires at least one schema');
    }
    return schema<unknown>(decode, () => exampleSchema.example());
}

function trustedDirect<T>(example: () => T): IRuntimeSchema<T>;
function trustedDirect(example: () => unknown): IRuntimeSchema<unknown> {
    return schema(value => value, example);
}

export const runtimeSchema = {
    boolean(example = false) {
        const decode = (value: unknown, path: string) => typeof value === 'boolean'
            ? value
            : fail('expected a boolean IPC result', path);
        return schema<boolean>(decode, () => example);
    },
    string(example = '') {
        const decode = (value: unknown, path: string) => typeof value === 'string'
            ? value
            : fail('expected a string', path);
        return schema<string>(decode, () => example);
    },
    number(options: {
        integer?: boolean;
        min?: number;
        max?: number;
        message?: string
    } = {}) {
        const decode = (value: unknown, path: string) => {
            if (typeof value !== 'number') {
                return fail(options.message ?? 'expected a finite number', path);
            }
            if (
                !Number.isFinite(value)
                || (options.integer === true && !Number.isSafeInteger(value))
                || (options.min !== undefined && value < options.min)
                || (options.max !== undefined && value > options.max)
            ) {
                return fail(options.message ?? 'expected a finite number', path);
            }
            return value;
        };
        return schema<number>(decode, () => options.min ?? 0);
    },
    oneOf<const TValues extends readonly TSchemaPrimitive[]>(
        values: TValues,
        message = 'expected one of the declared values',
    ) {
        return oneOf(values, message);
    },
    literal<TValue extends TSchemaPrimitive>(value: TValue) {
        return literal(value);
    },
    undefined() {
        const decode = (value: unknown, path: string) => value === undefined
            ? undefined
            : fail('expected an undefined IPC result', path);
        return schema(decode, () => undefined);
    },
    tuple,
    optional<T>(itemSchema: IRuntimeSchema<T>): IRuntimeSchema<T | undefined> {
        return schema<T | undefined>(
            (value, path) => value === undefined ? undefined : decodeWithPath(itemSchema, value, path),
            () => undefined,
            value => value === undefined ? undefined : itemSchema.encode(value),
        );
    },
    nullable<T>(itemSchema: IRuntimeSchema<T>): IRuntimeSchema<T | null> {
        return schema<T | null>(
            (value, path) => value === null ? null : decodeWithPath(itemSchema, value, path),
            () => null,
            value => value === null ? null : itemSchema.encode(value),
        );
    },
    array<T>(
        itemSchema: IRuntimeSchema<T>,
        example: readonly T[] = [],
    ): IRuntimeSchema<T[]> {
        const decode = (value: unknown, path: string) => {
            if (!isUnknownArray(value)) {
                return fail('expected an array', path);
            }
            return value.map((item, index) => decodeWithPath(
                itemSchema,
                item,
                indexPath(path, index),
            ));
        };
        return schema<T[]>(
            decode,
            () => example.map(item => itemSchema.decode(item)),
            value => value.map(item => itemSchema.encode(item)),
        );
    },
    fromParser<T>(parse: (value: unknown) => T, example: () => T) {
        return schema(parse, example);
    },
    branded<TBase, TName extends string>(
        itemSchema: IRuntimeSchema<TBase>,
        guard: (value: TBase) => value is TBrand<TBase, TName>,
        message: string,
    ) {
        return branded(itemSchema, guard, message);
    },
    object<const TShape extends TSchemaObject>(
        shape: TShape,
        options: {
            exact?: boolean;
            message?: string
        } = {},
    ): IRuntimeSchema<TDecodedSchemaObject<TShape>> {
        return object(shape, options);
    },
    record<T>(itemSchema: IRuntimeSchema<T>) {
        return record(itemSchema);
    },
    refine<T>(
        itemSchema: IRuntimeSchema<T>,
        predicate: (value: T) => boolean,
        message: string,
    ): IRuntimeSchema<T> {
        const decode = (value: unknown, path: string) => {
            const decoded = decodeWithPath(itemSchema, value, path);
            return predicate(decoded) ? decoded : fail(message, path);
        };
        return schema<T>(
            decode,
            itemSchema.example,
            value => itemSchema.encode(value),
        );
    },
    union,
    fromNullableDecoder<T>(decodeNullable: (value: unknown) => T | null, label: string, example: () => T) {
        const decode = (value: unknown, path: string) => decodeNullable(value) ?? fail(`invalid ${label}`, path);
        return schema(decode, example);
    },
    declared<T>() {
        return (declaredSchema: IRuntimeSchema<T>) => declaredSchema;
    },
    trustedDirect,
};

function isRuntimeSchema<T>(schema: TPlatformFeatureSchema<T>): schema is IRuntimeSchema<T> {
    return 'decode' in schema && typeof schema.decode === 'function';
}

function assertFeatureTupleArity<T>(schema: TPlatformFeatureSchema<T>, value: unknown) {
    if (isRuntimeSchema(schema) || schema.type !== 'strict_tuple' || !('items' in schema)) {
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
    if (isRuntimeSchema(schema)) {
        return schema.decode(value);
    }
    assertFeatureTupleArity(schema, value);
    return v.parse(schema, value, {abortEarly: true});
}

function encodeFeatureSchema<T>(schema: TPlatformFeatureSchema<T>, value: unknown): T {
    if (isRuntimeSchema(schema)) {
        return schema.encode(value as T) as T;
    }
    assertFeatureTupleArity(schema, value);
    return v.parse(schema, value, {abortEarly: true});
}

function getFeatureSchemaExample(schema: TPlatformFeatureSchema): (() => unknown) | undefined {
    return isRuntimeSchema(schema) ? schema.example : undefined;
}

export function argsSchema<TArgs extends unknown[]>(
    decode: (args: readonly unknown[]) => TArgs,
    example: () => TArgs,
): IRuntimeSchema<TArgs> {
    return runtimeSchema.declared<TArgs>()(runtimeSchema.fromParser((value) => {
        if (!Array.isArray(value)) {
            throw new Error('expected IPC arguments');
        }
        return decode(value);
    }, example));
}

export function resultSchema<TResult>(
    decode: (value: unknown) => TResult,
    example: () => TResult,
): IRuntimeSchema<TResult> {
    return runtimeSchema.declared<TResult>()(runtimeSchema.fromParser(decode, example));
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
    client?: {mapArgs: (...args: never[]) => TInferSchema<TArgs>};
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
            key: (payload: TInferSchema<TPayload>) => string;
            terminal: (payload: TInferSchema<TPayload>) => boolean;
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
        ? (...args: TInferSchema<TArgs>) => TInferSchema<TResult>
        : TSpec extends IPlatformLocalMethodSpec<infer TArgs, infer TResult>
            ? (...args: TInferSchema<TArgs>) => TSpec['kind'] extends 'async'
                ? Promise<TInferSchema<TResult>>
                : TInferSchema<TResult>
            : TSpec extends IPlatformIpcMethodSpec
                ? (
                    ...args: TSpec['client'] extends {mapArgs: (...args: infer TArgs) => unknown}
                        ? TArgs
                        : Extract<TInferSchema<TSpec['ipc']['args']>, unknown[]>
                ) => TSpec['kind'] extends 'async'
                    ? Promise<TInferSchema<TSpec['ipc']['result']>>
                    : TInferSchema<TSpec['ipc']['result']>
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
    (callback: (payload: TInferSchema<TEventMap[TKey]['payload']>) => void) => (() => void)
};
type TOptionalCapabilityEvents<TEventMap extends TEvents> = {
    [TKey in keyof TEventMap as TEventMap[TKey] extends {optionalWhenImplemented: true}
        ? TKey
        : never]?:
    (callback: (payload: TInferSchema<TEventMap[TKey]['payload']>) => void) => (() => void)
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
        args: Extract<TInferSchema<M[K]['ipc']['args']>, unknown[]>;
        result: TInferSchema<M[K]['ipc']['result']>;
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
    ? {[K in keyof E as E[K]['channel']]: TInferSchema<E[K]['payload']>}
    : never;

export interface IPlatformMainSenderContext<TSender> {
    sender: TSender;
    senderId: number;
}

type TSender<TEvent> = TEvent extends {sender: infer S} ? IPlatformMainSenderContext<S>
    : never;

type TMainMethod<TSpec extends IPlatformIpcMethodSpec, TEvent> = (
    ...args: TSpec['main']['context'] extends 'sender'
        ? [TSender<TEvent>, ...Extract<TInferSchema<TSpec['ipc']['args']>, unknown[]>]
        : Extract<TInferSchema<TSpec['ipc']['args']>, unknown[]>
) => TInferSchema<TSpec['ipc']['result']> | Promise<TInferSchema<TSpec['ipc']['result']>>;

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
    fixtureMethods: ReadonlyArray<{
        descriptor: IPlatformMethodDescriptor;
        example: () => unknown;
    }>;
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
    const fixtureMethods: Array<{
        descriptor: IPlatformMethodDescriptor;
        example: () => unknown;
    }> = [];
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
        example?: () => unknown,
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
        if (example) {
            fixtureMethods.push({
                descriptor,
                example,
            });
        }
    };
    for (const [
        name,
        spec,
    ] of Object.entries(definition.methods)) {
        if (spec.kind === 'sync' || 'local' in spec) {
            addDescriptor(name, spec, {
                ...definition.required,
                ...spec.required,
            }, spec.kind === 'sync'
                ? getFeatureSchemaExample(spec.result)
                : getFeatureSchemaExample(spec.local.result), spec.optionalWhenImplemented);
            continue;
        }
        addChannel(spec.channel);
        invokeChannels[name] = spec.channel;
        ipcCodecs[spec.channel] = {
            encodeArgs: value => {
                const encoded = encodeFeatureSchema(spec.ipc.args, value);
                if (!isUnknownArray(encoded)) {
                    return fail(`Platform feature argument encoder returned a non-array: ${spec.channel}`);
                }
                return encoded;
            },
            decodeArgs: value => parseFeatureSchema(spec.ipc.args, value),
            decodeResult: value => parseFeatureSchema(spec.ipc.result, value),
        };
        addDescriptor(name, spec, {
            ...definition.required,
            ...spec.required,
        }, getFeatureSchemaExample(spec.ipc.result), spec.optionalWhenImplemented);
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
        }, undefined, spec.optionalWhenImplemented);
        if (spec.subscription) {
            addChannel(spec.subscription.channel);
            invokeChannels[spec.subscription.main.method] = spec.subscription.channel;
            const noArgs = runtimeSchema.tuple([]);
            ipcCodecs[spec.subscription.channel] = {
                encodeArgs: value => {
                    return noArgs.decode(value);
                },
                decodeArgs: noArgs.decode,
                decodeResult: runtimeSchema.undefined().decode,
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
        fixtureMethods,
    };
}
