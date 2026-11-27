import {beforeEach, describe, expect, it, onTestFinished, vi} from 'vitest';
import {effectScope, ref, type Ref} from 'vue';
import {installNuxtStateTestStubs} from '@tests/unit/app/composables/installNuxtStateTestStubs';
import {usePlatformHydratedState} from '@app/composables/usePlatformHydratedState';

const cookieStore = new Map<string, Ref<unknown>>();
const stateStore = new Map<string, Ref<unknown>>();

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        resolve,
        reject,
    };
}

describe('usePlatformHydratedState', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        cookieStore.clear();
        stateStore.clear();
        installNuxtStateTestStubs(cookieStore, stateStore);
    });

    it('hydrates a second consumer when the first consumer unmounts mid-load', async () => {
        const deferred = createDeferred<string>();
        const loadValue = vi.fn(() => deferred.promise);
        const onLoaded = vi.fn();
        let firstState!: ReturnType<typeof usePlatformHydratedState<string>>;
        let secondState!: ReturnType<typeof usePlatformHydratedState<string>>;
        const firstScope = effectScope();
        const secondScope = effectScope();

        firstScope.run(() => {
            firstState = usePlatformHydratedState({
                key: 'shared-hydration-test',
                initialValue: () => 'initial',
                initialResolved: false,
                loadValue,
            });
        });
        const firstLoad = firstState.load();
        await vi.waitFor(() => expect(loadValue).toHaveBeenCalledTimes(1));

        secondScope.run(() => {
            secondState = usePlatformHydratedState({
                key: 'shared-hydration-test',
                initialValue: () => 'initial',
                initialResolved: false,
                loadValue,
                onLoaded,
            });
        });
        const secondLoad = secondState.load();
        firstScope.stop();
        deferred.resolve('loaded');

        await expect(firstLoad).resolves.toBeNull();
        await expect(secondLoad).resolves.toBe('loaded');
        expect(secondState.state.value).toBe('loaded');
        expect(secondState.isResolved.value).toBe(true);
        expect(onLoaded).toHaveBeenCalledWith('loaded');
        expect(loadValue).toHaveBeenCalledTimes(1);

        secondScope.stop();
    });

    it('does not clobber a local write that landed while the load was in flight', async () => {
        const deferred = createDeferred<{theme: string}>();
        const onLoaded = vi.fn();
        let hydrated!: ReturnType<typeof usePlatformHydratedState<{theme: string}>>;
        const scope = effectScope();

        scope.run(() => {
            hydrated = usePlatformHydratedState({
                key: 'mutation-fence-test',
                initialValue: () => ({theme: 'system'}),
                initialResolved: false,
                loadValue: () => deferred.promise,
                onLoaded,
            });
        });
        const loadPromise = hydrated.load();
        hydrated.state.value = {theme: 'dark'};
        deferred.resolve({theme: 'light'});

        await expect(loadPromise).resolves.toEqual({theme: 'light'});
        expect(hydrated.state.value).toEqual({theme: 'dark'});
        expect(hydrated.isResolved.value).toBe(true);
        expect(onLoaded).not.toHaveBeenCalled();

        scope.stop();
    });

    it('publishes the loaded value when no local write raced the load', async () => {
        const deferred = createDeferred<{theme: string}>();
        const onLoaded = vi.fn();
        let hydrated!: ReturnType<typeof usePlatformHydratedState<{theme: string}>>;
        const scope = effectScope();

        scope.run(() => {
            hydrated = usePlatformHydratedState({
                key: 'mutation-fence-clean-test',
                initialValue: () => ({theme: 'system'}),
                initialResolved: false,
                loadValue: () => deferred.promise,
                onLoaded,
            });
        });
        const loadPromise = hydrated.load();
        deferred.resolve({theme: 'light'});

        await expect(loadPromise).resolves.toEqual({theme: 'light'});
        expect(hydrated.state.value).toEqual({theme: 'light'});
        expect(onLoaded).toHaveBeenCalledWith({theme: 'light'});

        scope.stop();
    });

    it('stops automatic retries at the configured bound and permits an explicit retry', async () => {
        vi.useFakeTimers();
        const loadValue = vi.fn().mockRejectedValue(new Error('persistent failure'));
        let hydrated!: ReturnType<typeof usePlatformHydratedState<string>>;
        const scope = effectScope();
        onTestFinished(() => {
            scope.stop();
            vi.useRealTimers();
        });

        scope.run(() => {
            hydrated = usePlatformHydratedState({
                key: 'bounded-hydration-retry-test',
                initialValue: () => 'initial',
                initialResolved: false,
                loadValue,
                shouldRetry: () => true,
                retryDelayMs: 10,
                maxAutomaticRetries: 2,
            });
        });

        await hydrated.load();
        expect(loadValue).toHaveBeenCalledTimes(1);
        expect(hydrated.isResolved.value).toBe(false);

        await vi.advanceTimersByTimeAsync(10);
        expect(loadValue).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(10);
        expect(loadValue).toHaveBeenCalledTimes(3);
        expect(hydrated.isResolved.value).toBe(true);

        loadValue.mockResolvedValue('recovered');
        await expect(hydrated.retryNow()).resolves.toBe('recovered');
        expect(hydrated.state.value).toBe('recovered');
        expect(hydrated.isResolved.value).toBe(true);
    });

    it('isolates in-flight hydration promises and retry counters across separate Nuxt apps', async () => {
        const appA = {id: 'nuxt-app-a'};
        const appB = {id: 'nuxt-app-b'};
        const stateStoresByApp = new Map<object, Map<string, Ref<unknown>>>([
            [appA, new Map()],
            [appB, new Map()],
        ]);
        let activeApp: object = appA;

        vi.stubGlobal('tryUseNuxtApp', () => activeApp);
        vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
            const store = stateStoresByApp.get(activeApp)!;
            if (!store.has(key)) {
                store.set(key, ref(init()));
            }
            return store.get(key);
        });

        const scopeA = effectScope();
        const scopeB = effectScope();
        onTestFinished(() => {
            scopeA.stop();
            scopeB.stop();
            vi.unstubAllGlobals();
        });

        const deferredA = createDeferred<string>();
        const deferredB = createDeferred<string>();
        const loadValueA = vi.fn(() => deferredA.promise);
        const loadValueB = vi.fn(() => deferredB.promise);

        let stateA!: ReturnType<typeof usePlatformHydratedState<string>>;
        let stateB!: ReturnType<typeof usePlatformHydratedState<string>>;

        activeApp = appA;
        scopeA.run(() => {
            stateA = usePlatformHydratedState({
                key: 'isolated-shared-key',
                initialValue: () => 'initial-a',
                initialResolved: false,
                loadValue: loadValueA,
            });
        });
        const loadA = stateA.load();
        expect(loadValueA).toHaveBeenCalledTimes(1);

        activeApp = appB;
        scopeB.run(() => {
            stateB = usePlatformHydratedState({
                key: 'isolated-shared-key',
                initialValue: () => 'initial-b',
                initialResolved: false,
                loadValue: loadValueB,
            });
        });
        const loadB = stateB.load();
        expect(loadValueB).toHaveBeenCalledTimes(1);

        deferredB.resolve('loaded-b');
        await expect(loadB).resolves.toBe('loaded-b');
        expect(stateB.state.value).toBe('loaded-b');
        expect(stateA.isResolved.value).toBe(false);
        expect(stateA.state.value).toBe('initial-a');

        deferredA.resolve('loaded-a');
        await expect(loadA).resolves.toBe('loaded-a');
        expect(stateA.state.value).toBe('loaded-a');
        expect(stateB.state.value).toBe('loaded-b');
    });
});
