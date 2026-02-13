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
import type { ISettingsData } from '@app/types/shared';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('settings');

const DEFAULT_SETTINGS: ISettingsData = {
    version: 1,
    authorName: '',
    theme: 'light',
    locale: 'en',
};

function getStoragePath() {
    return join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<ISettingsData> {
    const storagePath = getStoragePath();
    if (!existsSync(storagePath)) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        const content = await readFile(storagePath, 'utf-8');
        return JSON.parse(content) as ISettingsData;
    } catch (err) {
        logger.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`);
        return { ...DEFAULT_SETTINGS };
    }
}

export async function saveSettings(settings: ISettingsData): Promise<void> {
    const storagePath = getStoragePath();
    try {
        await writeFile(storagePath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (err) {
        logger.error(`Failed to save settings: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
}

function loadSettingsSync(): ISettingsData {
    const storagePath = getStoragePath();
    if (!existsSync(storagePath)) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        const content = readFileSync(storagePath, 'utf-8');
        return JSON.parse(content) as ISettingsData;
    } catch (err) {
        logger.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`);
        return { ...DEFAULT_SETTINGS };
    }
}

export function getCurrentLocaleSync() {
    const locale = loadSettingsSync().locale;
    const supported = [
        'en',
        'ru',
        'fr',
        'de',
        'es',
        'it',
        'pt',
        'nl',
    ] as const;
    return supported.includes(locale as typeof supported[number])
        ? locale as typeof supported[number]
        : 'en';
}
