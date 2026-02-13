import {
    ref,
    toRaw,
} from 'vue';
import type { ISettingsData } from '@app/types/shared';
import { BrowserLogger } from '@app/utils/browser-logger';

// Vite HMR types (not exposed by Nuxt's type system)
declare global {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting built-in ImportMeta
    interface ImportMeta {hot?: {
        data?: Record<string, unknown>;
        dispose: (callback: (data: Record<string, unknown>) => void) => void;
    };}
}

const DEFAULT_SETTINGS: ISettingsData = {
    version: 1,
    authorName: '',
    theme: 'light',
    locale: 'en',
};

// Shared state across all composable instances
const settings = ref<ISettingsData>({ ...DEFAULT_SETTINGS });
const isLoaded = ref(false);

// Deduplication: track in-flight load promise
let loadPromise: Promise<void> | null = null;

export const useSettings = () => {

    async function load() {
        if (!window.electronAPI) {
            return;
        }

        // Deduplicate: if already loading, return existing promise
        if (loadPromise) {
            return loadPromise;
        }

        loadPromise = (async () => {
            try {
                settings.value = await window.electronAPI.settings.get();
                isLoaded.value = true;
            } catch (e) {
                BrowserLogger.error('settings', 'Failed to load settings', e);
            } finally {
                loadPromise = null;
            }
        })();

        return loadPromise;
    }

    async function save() {
        if (!window.electronAPI) {
            return;
        }

        try {
            const raw = toRaw(settings.value);
            const payload: ISettingsData = {
                version: typeof raw.version === 'number' ? raw.version : DEFAULT_SETTINGS.version,
                authorName: typeof raw.authorName === 'string' ? raw.authorName : DEFAULT_SETTINGS.authorName,
                theme: raw.theme === 'dark' ? 'dark' : 'light',
                locale: raw.locale === 'ru' ? 'ru' : 'en',
            };
            await window.electronAPI.settings.save(payload);
        } catch (e) {
            BrowserLogger.error('settings', 'Failed to save settings', e);
        }
    }

    function updateSetting<K extends keyof ISettingsData>(key: K, value: ISettingsData[K]) {
        settings.value = {
            ...settings.value,
            [key]: value, 
        };
        void save();
    }

    return {
        settings,
        isLoaded,
        load,
        save,
        updateSetting,
    };
};

// HMR support: preserve and restore state across hot updates
if (import.meta.hot) {
    import.meta.hot.dispose((data) => {
        data.settings = settings.value;
        data.isLoaded = isLoaded.value;
    });

    const hmrData = import.meta.hot.data;
    if (hmrData?.settings) {
        settings.value = hmrData.settings as ISettingsData;
        isLoaded.value = (hmrData.isLoaded as boolean) ?? false;
    }
}
