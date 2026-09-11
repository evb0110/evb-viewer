import {
    createChannelSet,
    createValidatedIpcMainRegistrar,
    registerPlatformFeatureHandlers,
} from '@electron/platform-ipc/validatedIpcRegistrar';
import {
    type IFeatureRegistrationContext,
    type platformDescriptors,
    type IFeatureRegistrationDescriptor,
    FEATURE_REGISTRATION_DESCRIPTORS,
    registerDocumentFeatureAdapters,
} from '@electron/platform-ipc/featureRegistrationTable';

type TDeferredHandler = (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown;

interface ILazyChannelOwner {
    readonly registrationKey: string;
    currentGeneration: object | null;
    dispatch: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
}

const lazyChannelOwners = new WeakMap<object, Map<string, ILazyChannelOwner>>();

export interface IFeatureRegistrationResult {
    readonly descriptor: IFeatureRegistrationDescriptor;
    readonly dispose: () => Promise<void>;
}

export interface IFeatureRegistrationRuntime {
    readonly registrations: readonly IFeatureRegistrationResult[];
    disposeAll(): Promise<void>;
}

const noDispose = () => Promise.resolve();

export function createFeatureRegistrationRuntime(
    registrations: readonly IFeatureRegistrationResult[],
): IFeatureRegistrationRuntime {
    let disposed = false;
    let disposalPromise: Promise<void> | null = null;
    return {
        registrations,
        disposeAll() {
            disposalPromise ??= (async () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                let firstError: unknown;
                for (const registration of [...registrations].reverse()) {
                    try {
                        await registration.dispose();
                    } catch (error) {
                        firstError ??= error;
                    }
                }
                if (firstError !== undefined) {
                    if (firstError instanceof Error) {
                        throw firstError;
                    }
                    throw new Error('Feature registration disposal failed', {cause: firstError});
                }
            })();
            return disposalPromise;
        },
    };
}

function registerLazyValidatedFeature(
    ipcMain: Electron.IpcMain,
    registrationKey: string,
    channels: Record<string, string>,
    codecs: Record<string, {
        decodeArgs: (args: readonly unknown[]) => unknown[];
        decodeResult: (value: unknown) => unknown;
    }>,
    load: (registrar: {handle: (channel: string, handler: TDeferredHandler) => void;}) => Promise<void>,
) {
    const handlers = new Map<string, TDeferredHandler>();
    let loading: Promise<void> | null = null;
    let lastLoadError: unknown;
    const generation = {};
    const owners = lazyChannelOwners.get(ipcMain) ?? new Map<string, ILazyChannelOwner>();
    lazyChannelOwners.set(ipcMain, owners);
    const ownedOwners: ILazyChannelOwner[] = [];
    const rejectReleasedRequest: ILazyChannelOwner['dispatch'] = () => Promise.reject(
        new Error(`Lazy IPC feature ${registrationKey} is no longer active`),
    );
    const ensureLoaded = async () => {
        loading ??= load({handle: (channel, handler) => {
            if (handlers.has(channel)) throw new Error(`Duplicate lazy IPC handler: ${channel}`);
            handlers.set(channel, handler);
        }}).then(() => {
            lastLoadError = undefined;
        }, error => {
            lastLoadError = error;
            loading = null;
            handlers.clear();
            throw error;
        });
        await loading;
    };
    const registrar = createValidatedIpcMainRegistrar(ipcMain, {
        allowedChannels: createChannelSet(channels),
        codecs: codecs as never,
    });
    const dispatch = async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
        await ensureLoaded();
        if (!ownedOwners.every(owner => owner.currentGeneration === generation)) {
            throw new Error(`Lazy IPC feature ${registrationKey} is no longer active`);
        }
        const channel = args.shift();
        if (typeof channel !== 'string') {
            throw new Error('Lazy IPC dispatch lost its channel identity');
        }
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`Lazy IPC feature did not register channel: ${channel}`);
        return handler(event, ...args as never[]);
    };
    try {
        for (const channel of new Set(Object.values(channels))) {
            const existing = owners.get(channel);
            if (existing) {
                if (existing.registrationKey !== registrationKey || existing.currentGeneration !== null) {
                    throw new Error(`Duplicate lazy IPC handler: ${channel}`);
                }
                existing.currentGeneration = generation;
                existing.dispatch = dispatch;
                ownedOwners.push(existing);
                continue;
            }
            const owner: ILazyChannelOwner = {
                registrationKey,
                currentGeneration: generation,
                dispatch: dispatch,
            };
            registrar.handle(channel, (event, ...args: unknown[]) => {
                return owner.dispatch(event, channel, ...args);
            });
            owners.set(channel, owner);
            ownedOwners.push(owner);
        }
    } catch (error) {
        for (const owner of ownedOwners) {
            if (owner.currentGeneration === generation) {
                owner.currentGeneration = null;
                owner.dispatch = rejectReleasedRequest;
            }
        }
        throw error;
    }

    return {
        waitForLoad: async () => {
            if (loading !== null) {
                await loading;
                return;
            }
            if (lastLoadError !== undefined) {
                if (lastLoadError instanceof Error) {
                    throw lastLoadError;
                }
                throw new Error('Lazy feature load failed', {cause: lastLoadError});
            }
        },
        release: () => {
            for (const owner of ownedOwners) {
                if (owner.currentGeneration === generation) {
                    owner.currentGeneration = null;
                    owner.dispatch = rejectReleasedRequest;
                }
            }
        },
    };
}

export function registerLazyPlatformFeature(
    ipcMain: Electron.IpcMain,
    descriptor: typeof platformDescriptors[number],
    context: IFeatureIpcAdapterOptions,
) {
    let loadedBindings: Record<string, unknown> | null = null;
    const lazyRegistration = registerLazyValidatedFeature(
        ipcMain,
        descriptor.name,
        descriptor.feature.invokeChannels,
        descriptor.feature.ipcCodecs,
        async (registrar) => {
            loadedBindings = await descriptor.create(context);
            registerPlatformFeatureHandlers(
                registrar as never,
                descriptor.feature as never,
                loadedBindings as never,
            );
        },
    );
    let disposalPromise: Promise<void> | null = null;
    return () => {
        disposalPromise ??= (async () => {
            lazyRegistration.release();
            let loadError: unknown;
            try {
                await lazyRegistration.waitForLoad();
            } catch (error) {
                loadError = error;
            }
            let disposalError: unknown;
            const disposer = descriptor.disposeBindingKey === undefined
                ? undefined
                : loadedBindings?.[descriptor.disposeBindingKey];
            try {
                if (descriptor.disposeBindingKey !== undefined
                    && loadError === undefined
                    && loadedBindings !== null
                    && typeof disposer !== 'function') {
                    throw new Error(
                        `Feature ${descriptor.name} did not provide callable disposer ${descriptor.disposeBindingKey}`,
                    );
                }
                if (typeof disposer === 'function') {
                    await (disposer as () => Promise<void>)();
                }
            } catch (error) {
                disposalError = error;
            } finally {
                loadedBindings = null;
            }
            if (loadError !== undefined) {
                if (loadError instanceof Error) {
                    throw loadError;
                }
                throw new Error('Lazy feature load failed', {cause: loadError});
            }
            if (disposalError !== undefined) {
                if (disposalError instanceof Error) {
                    throw disposalError;
                }
                throw new Error('Feature binding disposal failed', {cause: disposalError});
            }
        })();
        return disposalPromise;
    };
}

let disposeRegisteredScanCleanupBindings: (() => Promise<void>) | null = null;

/**
 * Preserve the legacy shutdown hook for callers that only need to dispose the
 * scan-cleanup feature when it has already been loaded. The registration table
 * owns the lazy loader, so this hook never imports the feature by itself.
 */
export async function disposeScanCleanupMainBindingsIfLoaded(): Promise<void> {
    const dispose = disposeRegisteredScanCleanupBindings;
    if (dispose === null) {
        return;
    }
    await dispose();
}

export interface IFeatureIpcAdapterOptions extends IFeatureRegistrationContext {}

export function registerFeatureIpcAdapters(
    ipcMain: Electron.IpcMain,
    options: IFeatureIpcAdapterOptions,
): IFeatureRegistrationRuntime {
    const registrations: IFeatureRegistrationResult[] = [];
    let documentsRegistered = false;
    disposeRegisteredScanCleanupBindings = null;
    for (const descriptor of FEATURE_REGISTRATION_DESCRIPTORS) {
        if (descriptor.kind === 'documents') {
            if (!documentsRegistered) {
                registerDocumentFeatureAdapters(ipcMain);
                documentsRegistered = true;
            }
            registrations.push({
                descriptor,
                dispose: noDispose,
            });
            continue;
        }
        if (descriptor.kind === 'core') {
            const dispose = descriptor.register?.(ipcMain, options);
            registrations.push({
                descriptor,
                dispose: dispose ?? noDispose,
            });
            continue;
        }
        const dispose = registerLazyPlatformFeature(
            ipcMain,
            descriptor as typeof platformDescriptors[number],
            options,
        );
        if (descriptor.name === 'scan-cleanup') {
            disposeRegisteredScanCleanupBindings = dispose;
        }
        registrations.push({
            descriptor,
            dispose,
        });
    }
    return createFeatureRegistrationRuntime(registrations);
}
