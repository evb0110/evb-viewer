import {
    dialog,
    shell,
} from 'electron';
import type { BrowserWindow } from 'electron';
import {
    loadSettings,
    saveSettings,
} from '@electron/settings';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('default-viewer');

export async function promptSetDefaultViewer(window: BrowserWindow) {
    const settings = await loadSettings();
    if (settings.suppressDefaultViewerPrompt) {
        return;
    }

    const setDefault = te('dialogs.defaultViewer.setDefault');
    const notNow = te('dialogs.defaultViewer.notNow');
    const dontAskAgain = te('dialogs.defaultViewer.dontAskAgain');

    const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        title: te('dialogs.defaultViewer.title'),
        message: te('dialogs.defaultViewer.message'),
        buttons: [
            setDefault,
            notNow,
            dontAskAgain,
        ],
        defaultId: 0,
        cancelId: 1,
    });

    if (response === 0) {
        await showDefaultAppsInstructions(window);
    } else if (response === 2) {
        settings.suppressDefaultViewerPrompt = true;
        try {
            await saveSettings(settings);
        } catch (err) {
            logger.error(`Failed to suppress prompt: ${err instanceof Error ? err.message : String(err)}`);
        }
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
