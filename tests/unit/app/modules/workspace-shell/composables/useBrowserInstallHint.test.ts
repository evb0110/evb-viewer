import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
    watch,
} from 'vue';
import type {
    EffectScope,
    Ref,
} from 'vue';
import type {StorageLike} from '@vueuse/core';
import {
    BROWSER_INSTALL_HINT_COOKIE_KEY,
    BROWSER_INSTALL_HINT_STORAGE_KEY,
} from '@app/utils/browserRuntimePersistence';

const mocks = vi.hoisted(() => ({
    mountedCallbacks: [] as Array<() => void>,
    startAutoDismiss: vi.fn(),
    useStorage: vi.fn(),
    useTimeoutFn: vi.fn(),
}));

vi.mock('vue', async (importOriginal) => ({
    ...await importOriginal(),
    onMounted: (callback: () => void) => {
        mocks.mountedCallbacks.push(callback);
    },
}));

vi.mock('@vueuse/core', () => ({
    useStorage: mocks.useStorage,
    useTimeoutFn: mocks.useTimeoutFn,
}));

const browserStorage = new Map<string, string>();
const stateStore = new Map<string, Ref<unknown>>();
const cookieWrites: string[] = [];
const scopes: EffectScope[] = [];
let cookieHeader = '';

function installBrowserGlobals() {
    const localStorage = {
        getItem: (key: string) => browserStorage.get(key) ?? null,
        setItem: (key: string, value: string) => {
            browserStorage.set(key, value);
        },
    };
    vi.stubGlobal('window', {localStorage});
    vi.stubGlobal('location', {protocol: 'https:'});
    vi.stubGlobal('document', {
        get cookie() {
            return cookieHeader;
        },
        set cookie(value: string) {
            cookieWrites.push(value);
        },
    });
    vi.stubGlobal('useRuntimeConfig', () => ({public: {landingUrl: 'https://evb-viewer.com'}}));
    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
        const existing = stateStore.get(key);
        if (existing) {
            return existing;
        }
        const state = ref(init());
        stateStore.set(key, state);
        return state;
    });
}

async function createBrowserInstallHint() {
    const analytics = {track: vi.fn()};
    const scope = effectScope();
    scopes.push(scope);
    const { useBrowserInstallHint } = await import('@app/modules/workspace-shell/composables/useBrowserInstallHint');
    const hint = scope.run(() => useBrowserInstallHint({
        analytics,
        isBrowserRuntime: ref(true),
    }));
    if (!hint) {
        throw new Error('Failed to create browser install hint composable');
    }
    for (const callback of mocks.mountedCallbacks.splice(0)) {
        callback();
    }
    await nextTick();
    return {
        analytics,
        hint,
    };
}

describe('useBrowserInstallHint persistence', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        browserStorage.clear();
        stateStore.clear();
        cookieWrites.length = 0;
        mocks.mountedCallbacks.length = 0;
        cookieHeader = '';
        mocks.useStorage.mockImplementation((key: string, defaultValue: boolean, storage: StorageLike) => {
            const stored = storage.getItem(key);
            const state = ref(stored === null ? defaultValue : stored === 'true');
            watch(state, value => storage.setItem(key, String(value)), {flush: 'sync'});
            return state;
        });
        mocks.useTimeoutFn.mockReturnValue({start: mocks.startAutoDismiss});
        installBrowserGlobals();
    });

    afterEach(() => {
        for (const scope of scopes.splice(0)) {
            scope.stop();
        }
        vi.unstubAllGlobals();
    });

    it('migrates a legacy dismissal cookie to local storage and expires it securely', async () => {
        cookieHeader = `${BROWSER_INSTALL_HINT_COOKIE_KEY}=1; unrelated=value`;

        const { hint } = await createBrowserInstallHint();

        expect(browserStorage.get(BROWSER_INSTALL_HINT_STORAGE_KEY)).toBe('true');
        expect(hint.showBrowserInstallHint.value).toBe(false);
        const expectedExpiry = `${BROWSER_INSTALL_HINT_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
        expect(cookieWrites).toEqual([expectedExpiry]);
    });

    it('persists a new manual dismissal only in local storage', async () => {
        const {
            analytics,
            hint,
        } = await createBrowserInstallHint();
        expect(hint.showBrowserInstallHint.value).toBe(true);

        hint.dismissBrowserInstallHint('manual');

        expect(browserStorage.get(BROWSER_INSTALL_HINT_STORAGE_KEY)).toBe('true');
        expect(hint.showBrowserInstallHint.value).toBe(false);
        expect(cookieWrites).toEqual([]);
        expect(analytics.track).toHaveBeenCalledWith(
            'browser_install_hint_interacted',
            expect.objectContaining({action: 'dismissed'}),
        );
    });

    it('does not write cookies on later visits once local storage is canonical', async () => {
        browserStorage.set(BROWSER_INSTALL_HINT_STORAGE_KEY, 'true');

        const { hint } = await createBrowserInstallHint();
        hint.dismissBrowserInstallHint('auto');

        expect(hint.showBrowserInstallHint.value).toBe(false);
        expect(browserStorage.get(BROWSER_INSTALL_HINT_STORAGE_KEY)).toBe('true');
        expect(cookieWrites).toEqual([]);
    });
});
