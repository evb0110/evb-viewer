import { vi } from 'vitest';
import type { IPlatformMethodDescriptor } from '@contracts/platformApiDescriptor';
import { cast } from '@tests/helpers/cast';

export interface IPlatformApiFixtureEventMethod<TPayload = unknown> {
    /** Deliver a live event to the subscribers that are currently attached. */
    emit: (payload: TPayload) => void;
    /** Deliver an explicit replay in the feature's chosen order. */
    replay: (payload: TPayload) => void;
    /** Inject a late or out-of-order event without helper-side filtering. */
    emitLate: (payload: TPayload) => void;
    dispose: () => void;
}

export interface IPlatformApiFixtureOperation<TResult, TArgs extends unknown[] = [], TKey = number, TError = unknown> {
    method: (...args: TArgs) => Promise<TResult>;
    resolve: (value: TResult, operationKey?: TKey) => void;
    reject: (reason: TError, operationKey?: TKey) => void;
    cancel: (operationKey?: TKey) => void;
}

export interface IPlatformApiFixtureOperationOptions<TArgs extends unknown[], TKey> {operationKey?: (...args: TArgs) => TKey;}

interface IPlatformApiFixturePendingOperation<TResult> {
    resolve: (value: TResult) => void;
    reject: (reason: unknown) => void;
}

/**
 * Creates an explicitly controlled async boundary for a real consumer test.
 * The default descriptor methods remain immediate and inert.
 */
export function createPlatformApiFixtureOperation<TResult, TArgs extends unknown[] = [], TKey = number, TError = unknown>(
    options: IPlatformApiFixtureOperationOptions<TArgs, TKey> = {},
): IPlatformApiFixtureOperation<TResult, TArgs, TKey, TError> {
    const pendingOperations = new Map<TKey | symbol, IPlatformApiFixturePendingOperation<TResult>>();
    const singleOperationKey = Symbol('fixture-operation');
    const resolveOperationKey = (...args: TArgs): TKey | symbol => options.operationKey === undefined
        ? singleOperationKey
        : options.operationKey(...args);
    const settle = (
        operationKey: TKey | symbol | undefined,
        settleOperation: (operation: IPlatformApiFixturePendingOperation<TResult>) => void,
    ) => {
        if (operationKey === undefined) {
            return;
        }
        const operation = pendingOperations.get(operationKey);
        if (operation === undefined) {
            return;
        }
        pendingOperations.delete(operationKey);
        settleOperation(operation);
    };
    const method = vi.fn((..._args: TArgs) => {
        const operationKey = resolveOperationKey(..._args);
        if (pendingOperations.has(operationKey)) {
            return Promise.reject(new Error('Fixture operation already has an in-flight invocation'));
        }
        return new Promise<TResult>((resolve, reject) => {
            pendingOperations.set(operationKey, {
                resolve,
                reject,
            });
        });
    });
    return {
        method,
        resolve: (value, operationKey) => {
            settle(
                options.operationKey === undefined ? singleOperationKey : operationKey,
                operation => operation.resolve(value),
            );
        },
        reject: (reason, operationKey) => {
            settle(
                options.operationKey === undefined ? singleOperationKey : operationKey,
                operation => operation.reject(reason),
            );
        },
        cancel: operationKey => {
            settle(
                options.operationKey === undefined ? singleOperationKey : operationKey,
                operation => operation.reject(new Error('Fixture operation canceled')),
            );
        },
    };
}

type TPlatformApiFixtureEventFunction = (
    callback: (payload: unknown) => void,
) => () => void;

function createAsyncDefault(path: string) {
    if (path === 'updates.getState') {
        return vi.fn(async () => ({
            phase: 'unsupported',
            origin: 'auto',
            version: null,
            percent: null,
            message: null,
        }));
    }
    if (path === 'updates.check' || path === 'updates.download' || path === 'updates.install') {
        return vi.fn(async () => ({started: false}));
    }
    if (path.endsWith('.get')) {
        return vi.fn(async () => ({}));
    }
    if (path.endsWith('.getMemoryInfo')) {
        return vi.fn(() => null);
    }
    if (path.endsWith('.fileExists')) {
        return vi.fn(async () => false);
    }
    if (path.endsWith('.readFile') || path.endsWith('.readFileRange')) {
        return vi.fn(async () => new Uint8Array());
    }
    if (path.endsWith('.readFileChunks')) {
        return vi.fn(async () => ({
            bytesRead: 0,
            chunks: 0,
            size: 0,
        }));
    }
    if (path.endsWith('.readTextFile')) {
        return vi.fn(async () => '');
    }
    if (path.endsWith('.registerFilesForOpen')) {
        return vi.fn(async () => []);
    }
    if (path.endsWith('.getDocumentRevision')) {
        return vi.fn(async () => ({
            authority: 'electron-working-copy',
            contentRevision: 1,
            documentRef: '/tmp/fixture.pdf',
            mintedAt: 1,
            token: 'drt1:1:1:fixture',
            version: 1,
        }));
    }
    if (path.includes('validatePdf') || path.includes('repairPdf') || path.includes('savePdfData')) {
        return vi.fn(async () => ({valid: true}));
    }
    if (path.endsWith('.saveFileStructured')) {
        return vi.fn(async () => ({
            externalWriteCommitted: true,
            ok: true,
            validation: null,
            workingCopyRefreshed: true,
        }));
    }
    if (path.includes('openDocument') || path.includes('openPdf')) {
        return vi.fn(async () => null);
    }
    if (path.includes('getPathForFile')) {
        return vi.fn(() => '/tmp/fixture.pdf');
    }
    if (path.includes('getPathsForFiles')) {
        return vi.fn(() => []);
    }
    return vi.fn(async () => {
        throw new Error(`Unsupported platform API fixture call: ${path}`);
    });
}

export function createDefaultPlatformApiFixtureMethod(
    descriptor: IPlatformMethodDescriptor, example?: () => unknown,
) {
    if (descriptor.kind === 'event') {
        const subscribers = new Set<(payload: unknown) => void>();
        const method = cast<TPlatformApiFixtureEventFunction & IPlatformApiFixtureEventMethod>(vi.fn((callback: (payload: unknown) => void) => {
            subscribers.add(callback);
            let subscribed = true;
            return () => {
                if (!subscribed) {
                    return;
                }
                subscribed = false;
                subscribers.delete(callback);
            };
        }));
        const controls: IPlatformApiFixtureEventMethod = {
            emit: payload => {
                for (const subscriber of subscribers) {
                    subscriber(payload);
                }
            },
            replay: payload => {
                for (const subscriber of subscribers) {
                    subscriber(payload);
                }
            },
            emitLate: payload => {
                for (const subscriber of subscribers) {
                    subscriber(payload);
                }
            },
            dispose: () => subscribers.clear(),
        };
        Object.assign(method, controls);
        return method;
    }
    if (example !== undefined) {
        return descriptor.kind === 'async'
            ? vi.fn(async () => example())
            : vi.fn(() => example());
    }
    const path = descriptor.path.join('.');
    if (descriptor.kind === 'sync') {
        if (
            path.endsWith('.getMemoryInfo')
            || path.endsWith('.getResourceProfile')
        ) {
            return vi.fn(() => null);
        }
        if (path.endsWith('.getPathForFile')) {
            return vi.fn(() => '/tmp/fixture.pdf');
        }
        if (path.endsWith('.getPathsForFiles')) {
            return vi.fn(() => []);
        }
    }
    if (descriptor.kind === 'void') {
        return vi.fn(() => undefined);
    }
    return createAsyncDefault(path);
}
