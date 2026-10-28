import {PLATFORM_FEATURE_REGISTRY} from '@contracts/platformApiDescriptor';
import type {
    TAnyDefinedPlatformFeature, TPlatformIpcAbortSubscription,
} from '@contracts/platformFeature';
import {isRecord} from '@contracts/runtimeGuards';

type TElectronPlatformApi = NonNullable<Window['electronAPI']>;
const rendererApis = new WeakMap<TElectronPlatformApi, TElectronPlatformApi>();

function adaptIpcMethod(invoke: (...args: unknown[]) => unknown) {
    return async (...args: unknown[]) => {
        const options = args.find(value => isRecord(value) && value.signal instanceof AbortSignal);
        if (!isRecord(options) || !(options.signal instanceof AbortSignal)) return invoke(...args);
        const {signal} = options;
        if (signal.aborted) throw new DOMException('IPC invoke aborted', 'AbortError');
        const subscribe: TPlatformIpcAbortSubscription = onAbort => {
            signal.addEventListener('abort', onAbort, {once: true});
            if (signal.aborted) onAbort();
            return () => signal.removeEventListener('abort', onAbort);
        };
        try {
            return await invoke(...args.map(value => value === options ? {
                ...options,
                signal: subscribe,
            } : value));
        } catch (error) {
            // contextBridge does not preserve the preload error's custom name.
            if (signal.aborted) throw new DOMException('IPC invoke aborted', 'AbortError');
            throw error;
        }
    };
}

function adaptElectronPlatformApi(api: TElectronPlatformApi): TElectronPlatformApi {
    const adapted = {...api};
    for (const feature of PLATFORM_FEATURE_REGISTRY as readonly TAnyDefinedPlatformFeature[]) {
        let capability: Record<string, unknown> = adapted;
        for (const segment of feature.path) {
            const child = capability[segment];
            if (!isRecord(child)) break;
            const copy = {...child};
            capability[segment] = copy;
            capability = copy;
        }
        for (const [
            name,
            spec,
        ] of Object.entries(feature.methods)) {
            const method = capability[name];
            if (spec.kind === 'async' && !('local' in spec) && typeof method === 'function') {
                capability[name] = adaptIpcMethod(method as (...args: unknown[]) => unknown);
            }
        }
    }
    rendererApis.set(api, adapted);
    return adapted;
}

function getElectronWindow(): Window | null {
    if (typeof window === 'undefined') {
        return null;
    }

    return window;
}

export function getRawElectronPlatformApi(): TElectronPlatformApi | undefined {
    const api = getElectronWindow()?.electronAPI;
    return api === undefined ? undefined : rendererApis.get(api) ?? adaptElectronPlatformApi(api);
}

export function hasElectronPlatformBridge() {
    return getRawElectronPlatformApi() !== undefined;
}
