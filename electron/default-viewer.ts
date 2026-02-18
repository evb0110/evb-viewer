import {
    app,
    dialog,
    shell,
} from 'electron';
import type { BrowserWindow } from 'electron';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ISettingsData } from '@app/types/shared';
import {
    loadSettings,
    saveSettings,
} from '@electron/settings';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('default-viewer');
const KNOWN_USER_DATA_DIR_NAMES = [
    'EVB Viewer',
    'EVB Viewer Dev',
    'EVB-Viewer',
] as const;

async function isPromptSuppressedInKnownSettingsFiles() {
    const appDataPath = app.getPath('appData');
    for (const dirName of KNOWN_USER_DATA_DIR_NAMES) {
        const settingsPath = join(appDataPath, dirName, 'settings.json');
        try {
            const raw = await readFile(settingsPath, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<ISettingsData>;
            if (parsed.suppressDefaultViewerPrompt === true) {
                return true;
            }
        } catch {
            // Best-effort migration lookup: ignore missing/invalid files.
        }
    }
    return false;
}

async function persistPromptSuppression(settings: ISettingsData) {
    if (settings.suppressDefaultViewerPrompt) {
        return;
    }

    settings.suppressDefaultViewerPrompt = true;
    try {
        await saveSettings(settings);
    } catch (err) {
        logger.error(`Failed to suppress prompt: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export async function promptSetDefaultViewer(window: BrowserWindow) {
    const settings = await loadSettings();
    const isSuppressedElsewhere = await isPromptSuppressedInKnownSettingsFiles();
    if (settings.suppressDefaultViewerPrompt || isSuppressedElsewhere) {
        if (isSuppressedElsewhere && !settings.suppressDefaultViewerPrompt) {
            await persistPromptSuppression(settings);
        }
        return;
    }

    const setDefault = te('dialogs.defaultViewer.setDefault');
    const dontAskAgain = te('dialogs.defaultViewer.dontAskAgain');
    const notNow = te('dialogs.defaultViewer.notNow');

    const BUTTON_SET_DEFAULT = 0;
    const BUTTON_DONT_ASK_AGAIN = 1;
    const BUTTON_NOT_NOW = 2;

    const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        title: te('dialogs.defaultViewer.title'),
        message: te('dialogs.defaultViewer.message'),
        buttons: [
            setDefault,
            dontAskAgain,
            notNow,
        ],
        defaultId: BUTTON_SET_DEFAULT,
        cancelId: BUTTON_NOT_NOW,
    });

    if (response === BUTTON_SET_DEFAULT) {
        await showDefaultAppsInstructions(window);
    }

    // Make the prompt one-time to avoid repeated startup interruption.
    if (response === BUTTON_DONT_ASK_AGAIN || response === BUTTON_NOT_NOW || response === BUTTON_SET_DEFAULT) {
        await persistPromptSuppression(settings);
    }
}

async function showDefaultAppsInstructions(window: BrowserWindow) {
    if (process.platform === 'darwin') {
        await dialog.showMessageBox(window, {
            type: 'info',
            title: te('dialogs.defaultViewer.instructionsTitle'),
            message: te('dialogs.defaultViewer.instructionsTitle'),
            detail: te('dialogs.defaultViewer.instructionsMac'),
            buttons: ['OK'],
        });
    } else if (process.platform === 'win32') {
        void shell.openExternal('ms-settings:defaultapps');
    } else {
        await dialog.showMessageBox(window, {
            type: 'info',
            title: te('dialogs.defaultViewer.instructionsTitle'),
            message: te('dialogs.defaultViewer.instructionsTitle'),
            detail: te('dialogs.defaultViewer.instructionsLinux'),
            buttons: ['OK'],
        });
    }
}
