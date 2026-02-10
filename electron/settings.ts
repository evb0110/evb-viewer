import {
    readFile,
    writeFile,
} from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import type { ISettingsData } from '@app/types/shared';

export type { ISettingsData } from '@app/types/shared';

const DEFAULT_SETTINGS: ISettingsData = {
    version: 1,
    authorName: '',
    theme: 'light',
    locale: 'en',
};

let settingsCache: ISettingsData = { ...DEFAULT_SETTINGS };

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
        const data = JSON.parse(content) as ISettingsData;
        settingsCache = data;
        return data;
    } catch (err) {
        console.error('Failed to load settings:', err);
        return { ...DEFAULT_SETTINGS };
    }
}

export async function saveSettings(settings: ISettingsData): Promise<void> {
    const storagePath = getStoragePath();
    try {
        settingsCache = settings;
        await writeFile(storagePath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (err) {
        console.error('Failed to save settings:', err);
        throw err;
    }
}

export function getSettingsSync(): ISettingsData {
    return settingsCache;
}

export async function initSettingsCache(): Promise<void> {
    settingsCache = await loadSettings();
}
