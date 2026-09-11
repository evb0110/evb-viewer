import type {
    IPlatformApi,
    IPlatformRuntimeManifest,
    TPlatformBackend,
} from '@contracts/platformApi';
import { PLATFORM_API_DESCRIPTOR } from '@contracts/platformApi';
import {
    PLATFORM_FEATURE_REGISTRY,
    type IPlatformMethodDescriptor,
} from '@contracts/platformApiDescriptor';
import { isRecord } from '@contracts/runtimeGuards';
import { createDefaultPlatformApiFixtureMethod } from '@tests/helpers/createDefaultPlatformApiFixtureMethod';

type TDeepPartialValue<T> = NonNullable<T> extends (...args: never[]) => unknown
    ? T
    : NonNullable<T> extends object
        ? TDeepPartial<NonNullable<T>>
        : T;
type TRequiredKey<T, TKey extends keyof T> = Pick<T, TKey> extends Required<Pick<T, TKey>>
    ? true
    : false;

export type TDeepPartial<T> = {
    [TKey in keyof T]?: TRequiredKey<T, TKey> extends true
        ? TDeepPartialValue<T[TKey]>
        : TDeepPartialValue<T[TKey]> | undefined;
};

export type TPlatformApiFixtureOverrides = TDeepPartial<IPlatformApi>;

export interface ICreatePlatformApiFixtureOptions<TOverrides extends TPlatformApiFixtureOverrides = TPlatformApiFixtureOverrides> {
    backend: TPlatformBackend;
    manifest: IPlatformRuntimeManifest;
    overrides?: TOverrides;
}

function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown) {
    let owner = root;
    for (const segment of path.slice(0, -1)) {
        const current = owner[segment];
        if (isRecord(current)) {
            owner = current;
            continue;
        }
        const child: Record<string, unknown> = {};
        owner[segment] = child;
        owner = child;
    }
    owner[path.at(-1)!] = value;
}

function readPath(root: unknown, path: readonly string[]) {
    let value = root;
    for (const segment of path) {
        if (!isRecord(value)) {
            return undefined;
        }
        value = value[segment];
    }
    return value;
}

function cloneValue<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map(item => cloneValue(item)) as T;
    }
    if (isRecord(value) && typeof value !== 'function') {
        return Object.fromEntries(
            Object.entries(value).map(([
                key,
                child,
            ]) => [
                key,
                cloneValue(child),
            ]),
        ) as T;
    }
    return value;
}

function deepMerge(
    target: Record<string, unknown>,
    overrides: unknown,
) {
    if (!isRecord(overrides)) {
        return target;
    }
    for (const [
        key,
        value,
    ] of Object.entries(overrides)) {
        const current = target[key];
        if (isRecord(current) && isRecord(value) && typeof current !== 'function' && typeof value !== 'function') {
            deepMerge(current, value);
            continue;
        }
        target[key] = value;
    }
    return target;
}

function createBasePlatformApiFixture(manifest: IPlatformRuntimeManifest) {
    const api: Record<string, unknown> = {manifest: cloneValue(manifest)};
    const methods: readonly IPlatformMethodDescriptor[] = PLATFORM_API_DESCRIPTOR.methods;
    const migratedExamples = new Map(
        PLATFORM_FEATURE_REGISTRY.flatMap(feature =>
            feature.fixtureMethods.map(fixture => [
                fixture.descriptor.path.join('.'),
                fixture.example,
            ] as const)),
    );
    for (const descriptor of methods) {
        setPath(
            api,
            descriptor.path,
            createDefaultPlatformApiFixtureMethod(
                descriptor,
                migratedExamples.get(descriptor.path.join('.')),
            ),
        );
    }
    return api;
}

function assertPlatformApiFixture(
    api: Record<string, unknown>,
    backend: TPlatformBackend,
): asserts api is Record<string, unknown> & IPlatformApi {
    for (const descriptor of PLATFORM_API_DESCRIPTOR.methods) {
        if (!descriptor.required[backend] || descriptor.optionalWhenImplemented) {
            continue;
        }
        if (typeof readPath(api, descriptor.path) !== 'function') {
            throw new TypeError(`Missing platform API fixture method ${descriptor.path.join('.')}`);
        }
    }
}

export function createPlatformApiFixture<TOverrides extends TPlatformApiFixtureOverrides = TPlatformApiFixtureOverrides>({
    manifest,
    overrides = {} as TOverrides,
}: ICreatePlatformApiFixtureOptions<TOverrides>): IPlatformApi & TOverrides {
    const api = createBasePlatformApiFixture(manifest);
    deepMerge(api, overrides);
    assertPlatformApiFixture(api, manifest.backend);
    return api as IPlatformApi & TOverrides;
}
