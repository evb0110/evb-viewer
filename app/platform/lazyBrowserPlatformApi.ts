import type { IPlatformApi } from '@contracts/platformApi';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    TBrowserPlatformAsyncMethodPath,
    TBrowserPlatformEventMethodPath,
    TBrowserPlatformMethodPath,
    TBrowserPlatformVoidMethodPath,
    TMethodAtBrowserPlatformPath,
} from '@app/platform/browserPlatformPathDescriptors';
import { createLazyBrowserPlatformApiGenerated } from '@app/platform/generated/createLazyBrowserPlatformApiGenerated';
import {
    PlatformContractError,
    validateBrowserPlatformApi,
} from '@app/platform/validatePlatformApi';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IBrowserPlatformModule { browserPlatformApi: IPlatformApi; }
type TPropertyPath = ReadonlyArray<string | symbol>;
type TUnsubscribe = () => void;
type TCallableBrowserMember = (...args: unknown[]) => unknown;
type TArgs<TPath extends TBrowserPlatformMethodPath> =
    TMethodAtBrowserPlatformPath<TPath> extends (...args: infer TMethodArgs) => unknown ? TMethodArgs : never;
type TAsyncResult<TPath extends TBrowserPlatformMethodPath> =
    TMethodAtBrowserPlatformPath<TPath> extends (...args: never[]) => Promise<infer TResult> ? TResult : never;

let browserPlatformApiPromise: Promise<IPlatformApi> | null = null;

function createBrowserPlatformContractError(result: ReturnType<typeof validateBrowserPlatformApi>) {
    return new PlatformContractError(
        result.failures.map(failure => failure.message).join(' '),
        result.failures,
    );
}

function loadBrowserPlatformApi() {
    browserPlatformApiPromise ??= import('@app/platform/browserPlatformApi')
        .then((module: IBrowserPlatformModule) => {
            const result = validateBrowserPlatformApi(module.browserPlatformApi);
            if (!result.ok) {
                throw createBrowserPlatformContractError(result);
            }
            return module.browserPlatformApi;
        })
        .catch((error: unknown) => {
            browserPlatformApiPromise = null;
            throw error;
        });
    return browserPlatformApiPromise;
}

async function resolveBrowserProperty(path: TPropertyPath) {
    let value: unknown = await loadBrowserPlatformApi();
    for (const key of path) {
        if (!isRecord(value)) {
            throw new TypeError(`Browser platform owner for ${String(key)} is not an object`);
        }
        value = (value as Record<PropertyKey, unknown>)[key];
    }
    return value;
}

function splitOwnerPath(path: TPropertyPath) {
    const methodKey = path.at(-1);
    if (methodKey === undefined) {
        throw new TypeError('Browser platform method path is empty');
    }
    return {
        methodKey,
        ownerPath: path.slice(0, -1),
    };
}

function formatPropertyPath(path: TPropertyPath) {
    return path.map(key => String(key)).join('.');
}

function getCallableBrowserMember(owner: unknown, methodKey: string | symbol) {
    if (!isRecord(owner)) {
        throw new TypeError(`Browser platform owner for ${String(methodKey)} is not an object`);
    }
    const method = (owner as Record<PropertyKey, unknown>)[methodKey];
    if (typeof method !== 'function') {
        throw new TypeError(`Browser platform member ${String(methodKey)} is not callable`);
    }
    return method as TCallableBrowserMember;
}

async function resolveBrowserMethod(path: TPropertyPath) {
    const {
        methodKey,
        ownerPath,
    } = splitOwnerPath(path);
    const api = await loadBrowserPlatformApi();
    const owner = ownerPath.length === 0
        ? api
        : await resolveBrowserProperty(ownerPath);
    const callable = getCallableBrowserMember(owner, methodKey);
    return {
        callable,
        owner,
    };
}

async function callBrowserMethod<TResult>(path: TPropertyPath, args: unknown[]) {
    const {
        callable,
        owner,
    } = await resolveBrowserMethod(path);
    const result: unknown = callable.apply(owner, args);
    return await result as TResult;
}

function subscribeToBrowserEvent(path: TPropertyPath, args: unknown[]): TUnsubscribe {
    let active = true;
    let unsubscribe: TUnsubscribe | null = null;
    const guardedArgs = args.map((arg) => {
        if (typeof arg !== 'function') {
            return arg;
        }

        return (...callbackArgs: unknown[]) => {
            if (!active) {
                return undefined;
            }

            return (arg as (...args: unknown[]) => unknown)(...callbackArgs);
        };
    });

    void resolveBrowserMethod(path).then(({
        callable,
        owner,
    }) => {
        if (!active) {
            return;
        }
        const cleanup: unknown = callable.apply(owner, guardedArgs);
        if (active.valueOf() && typeof cleanup === 'function') {
            unsubscribe = cleanup as TUnsubscribe;
        } else if (!active.valueOf() && typeof cleanup === 'function') {
            (cleanup as TUnsubscribe)();
        }
    }).catch((error: unknown) => {
        if (active) {
            BrowserLogger.error(
                'platform',
                `Failed to subscribe to browser event ${formatPropertyPath(path)}`,
                error,
                {code: 'RENDERER_BROWSER_EVENT_SUBSCRIPTION_FAILED'},
            );
        }
    });

    return () => {
        active = false;
        unsubscribe?.();
        unsubscribe = null;
    };
}

function lazyAsync<TPath extends TBrowserPlatformAsyncMethodPath>(
    path: TPath,
): TMethodAtBrowserPlatformPath<TPath> {
    return ((...args: TArgs<TPath>) =>
        callBrowserMethod<TAsyncResult<TPath>>(path, args)) as TMethodAtBrowserPlatformPath<TPath>;
}

function lazyEvent<TPath extends TBrowserPlatformEventMethodPath>(
    path: TPath,
): TMethodAtBrowserPlatformPath<TPath> {
    return ((...args: TArgs<TPath>) =>
        subscribeToBrowserEvent(path, args)) as TMethodAtBrowserPlatformPath<TPath>;
}

function lazyVoid<TPath extends TBrowserPlatformVoidMethodPath>(
    path: TPath,
): TMethodAtBrowserPlatformPath<TPath> {
    return ((...args: TArgs<TPath>) => {
        void callBrowserMethod<unknown>(path, args);
    }) as TMethodAtBrowserPlatformPath<TPath>;
}

export const lazyBrowserPlatformApi = createLazyBrowserPlatformApiGenerated({
    lazyAsync,
    lazyEvent,
    lazyVoid,
});
