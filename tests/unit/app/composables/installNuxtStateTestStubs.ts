import {ref} from 'vue';
import {vi} from 'vitest';

export type TRefStore = Map<string, ReturnType<typeof ref>>;

export function installNuxtStateTestStubs(cookieStore: TRefStore, stateStore: TRefStore) {
    vi.stubGlobal('useCookie', <T>(key: string, options?: {default?: () => T}) => {
        const existing = cookieStore.get(key);
        if (existing) {
            return existing;
        }

        const cookie = ref(options?.default ? options.default() : null);
        cookieStore.set(key, cookie);
        return cookie;
    });

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
