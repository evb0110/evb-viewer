import {
    app,
    dialog,
    shell,
} from 'electron';
import type { BrowserWindow } from 'electron';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRecord } from '@contracts/runtimeGuards';
import {
    loadSettings,
    updateSettings,
} from '@electron/settings';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('defaultViewer');
const execFileAsync = promisify(execFile);
const LINUX_DESKTOP_ID = 'evb-viewer.desktop';
const LINUX_MIME_TYPES = [
    'application/pdf',
    'image/vnd.djvu',
] as const;
const KNOWN_USER_DATA_DIR_NAMES = [
    'EVB Viewer',
    'EVB Viewer Dev',
    'EVB-Viewer',
] as const;

function hasSuppressedDefaultViewerPrompt(raw: string) {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && parsed.suppressDefaultViewerPrompt === true;
}

async function isPromptSuppressedInKnownSettingsFiles() {
    const appDataPath = app.getPath('appData');
    for (const dirName of KNOWN_USER_DATA_DIR_NAMES) {
        const settingsPath = join(appDataPath, dirName, 'settings.json');
        try {
            const raw = await readFile(settingsPath, 'utf-8');
            if (hasSuppressedDefaultViewerPrompt(raw)) {
                return true;
            }
        } catch {
            // Best-effort migration lookup: ignore missing/invalid files.
        }
    }
    return false;
}

async function persistPromptSuppression() {
    try {
        await updateSettings((settings) => {
            if (settings.suppressDefaultViewerPrompt) {
                return undefined;
            }
            return {suppressDefaultViewerPrompt: true};
        });
    } catch (err) {
        logger.error(`Failed to suppress prompt: ${getErrorMessage(err)}`, {
            code: 'MAIN_DEFAULT_VIEWER_PROMPT_FAILED',
            cause: err,
        });
    }
}

export async function promptSetDefaultViewer(window: BrowserWindow) {
    const settings = await loadSettings();
    const isSuppressedElsewhere = await isPromptSuppressedInKnownSettingsFiles();
    if (settings.suppressDefaultViewerPrompt || isSuppressedElsewhere) {
        if (isSuppressedElsewhere && !settings.suppressDefaultViewerPrompt) {
            await persistPromptSuppression();
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
        await persistPromptSuppression();
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
        try {
            await shell.openExternal('ms-settings:defaultapps');
        } catch (err) {
            logger.warn(`Failed to open Windows default apps settings: ${getErrorMessage(err)}`);
            await showWindowsDefaultAppsFallback(window);
        }
    } else {
        try {
            await execFileAsync('xdg-mime', [
                'default',
                LINUX_DESKTOP_ID,
                ...LINUX_MIME_TYPES,
            ], { timeout: 10_000 });
            for (const mimeType of LINUX_MIME_TYPES) {
                const { stdout } = await execFileAsync('xdg-mime', [
                    'query',
                    'default',
                    mimeType,
                ], { timeout: 10_000 });
                if (stdout.trim() !== LINUX_DESKTOP_ID) {
                    // Some xdg-utils versions misread quoted Exec paths containing
                    // spaces. Ask GLib before treating that query as a failure.
                    const { stdout: gioOutput } = await execFileAsync('gio', [
                        'mime',
                        mimeType,
                    ], {
                        timeout: 10_000,
                        env: {
                            ...process.env,
                            LC_ALL: 'C',
                            LANGUAGE: 'C',
                        },
                    });
                    if (gioOutput.split('\n')[0]?.trim() !== `Default application for “${mimeType}”: ${LINUX_DESKTOP_ID}`) {
                        throw new Error(`Default handler for ${mimeType} was not updated`);
                    }
                }
            }
            return;
        } catch (err) {
            logger.warn(`Failed to set Linux default viewer: ${getErrorMessage(err)}`);
        }
        await dialog.showMessageBox(window, {
            type: 'info',
            title: te('dialogs.defaultViewer.instructionsTitle'),
            message: te('dialogs.defaultViewer.instructionsTitle'),
            detail: te('dialogs.defaultViewer.instructionsLinux'),
            buttons: ['OK'],
        });
    }
}

async function showWindowsDefaultAppsFallback(window: BrowserWindow) {
    await dialog.showMessageBox(window, {
        type: 'info',
        title: te('dialogs.defaultViewer.instructionsTitle'),
        message: te('dialogs.defaultViewer.message'),
        buttons: ['OK'],
    });
}
