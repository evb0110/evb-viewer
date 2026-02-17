import {
    readFile,
    writeFile,
} from 'fs/promises';
import {
    existsSync,
    readFileSync,
} from 'fs';
import { join } from 'path';
import { app } from 'electron';
import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    type TLocale,
} from '@app/i18n/locale-codes';
import type { ISettingsData } from '@app/types/shared';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('settings');

type TSupportedLocale = TLocale;

const DEFAULT_SETTINGS: ISettingsData = {
    version: 1,
    authorName: '',
    theme: 'light',
    locale: DEFAULT_LOCALE,
};

let settingsCache: ISettingsData | null = null;

function isSupportedLocale(locale: string): locale is TSupportedLocale {
    return LOCALE_CODES.includes(locale as TSupportedLocale);
}

function sanitizeSettings(raw: Partial<ISettingsData> | null | undefined): ISettingsData {
    const locale = typeof raw?.locale === 'string' && isSupportedLocale(raw.locale)
        ? raw.locale
        : DEFAULT_LOCALE;

    return {
        version: typeof raw?.version === 'number' ? raw.version : DEFAULT_SETTINGS.version,
        authorName: typeof raw?.authorName === 'string' ? raw.authorName : DEFAULT_SETTINGS.authorName,
        theme: raw?.theme === 'dark' ? 'dark' : 'light',
        locale,
        suppressDefaultViewerPrompt: typeof raw?.suppressDefaultViewerPrompt === 'boolean'
            ? raw.suppressDefaultViewerPrompt
            : undefined,
    };
}

function getStoragePath() {
    return join(app.getPath('userData'), 'settings.json');
}

function cloneSettings(settings: ISettingsData): ISettingsData {
    return {...settings};
}

function cacheSettings(raw: Partial<ISettingsData> | null | undefined): ISettingsData {
    settingsCache = sanitizeSettings(raw);
    return cloneSettings(settingsCache);
}

export async function loadSettings(): Promise<ISettingsData> {
    if (settingsCache) {
        return cloneSettings(settingsCache);
    }

    const storagePath = getStoragePath();
    if (!existsSync(storagePath)) {
        return cacheSettings(DEFAULT_SETTINGS);
    }

    try {
        const content = await readFile(storagePath, 'utf-8');
        return cacheSettings(JSON.parse(content) as Partial<ISettingsData>);
    } catch (err) {
        logger.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`);
        return cacheSettings(DEFAULT_SETTINGS);
    }
}

export async function saveSettings(settings: ISettingsData): Promise<void> {
    const storagePath = getStoragePath();
    const safeSettings = sanitizeSettings(settings);
    try {
        await writeFile(storagePath, JSON.stringify(safeSettings, null, 2), 'utf-8');
        settingsCache = safeSettings;
    } catch (err) {
        logger.error(`Failed to save settings: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
}

function loadSettingsSync(): ISettingsData {
    if (settingsCache) {
        return cloneSettings(settingsCache);
    }

    const storagePath = getStoragePath();
    if (!existsSync(storagePath)) {
        return cacheSettings(DEFAULT_SETTINGS);
    }

    try {
        const content = readFileSync(storagePath, 'utf-8');
        return cacheSettings(JSON.parse(content) as Partial<ISettingsData>);
    } catch (err) {
        logger.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`);
        return cacheSettings(DEFAULT_SETTINGS);
    }
}

export function getCurrentLocaleSync() {
    return loadSettingsSync().locale;
}
