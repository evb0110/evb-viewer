import { getErrorMessage } from '@electron/utils/error';
import { stringifyJson } from '@contracts/stringifyJson';
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import {
    basename,
    extname,
} from 'path';
import { te } from '@electron/te';
import {
    IPC_FILENAME_MAX_LENGTH,
    truncateForIpc,
} from '@electron/utils/ipcLimits';
import { getDocumentsDialogDefaultPath } from '@electron/utils/dialogDefaultPaths';
import type { IDocumentsDialogContext } from '@electron/features/documents/documentsService';

interface IOpenDocumentDialogOptions {
    title: string;
    extensions: string[];
}

interface IOpenDocumentDialogContext {
    parentWindow: BrowserWindow | null;
    senderId: number;
}

interface ISaveDialogOptions {
    title: string;
    defaultPath: string;
    filterName: string;
    extension: string;
}

const activeDialogSenderIds = new Set<number>();

export function errorWithDetails(fallbackMessage: string, details: unknown): Error {
    let detailText = '';
    if (details instanceof Error) {
        detailText = getErrorMessage(details);
    } else if (typeof details === 'string') {
        detailText = details.trim();
    } else if (details !== null && details !== undefined) {
        try {
            detailText = stringifyJson(details) ?? '<unserializable details>';
        } catch {
            detailText = '<unserializable details>';
        }
    }
    if (!detailText) {
        return new Error(fallbackMessage);
    }
    return new Error(`${fallbackMessage}: ${detailText}`);
}

async function withSingleActiveDialogForSender<T>(senderId: number, callback: () => Promise<T>) {
    if (activeDialogSenderIds.has(senderId)) {
        throw new Error('A document dialog is already open for this window.');
    }
    activeDialogSenderIds.add(senderId);
    try {
        return await callback();
    } finally {
        activeDialogSenderIds.delete(senderId);
    }
}

function normalizeSaveDefaultPath(defaultPath: string, extension: string) {
    const suffix = `.${extension}`;
    const rawName = basename(defaultPath || `document${suffix}`);
    const filteredName = Array.from(rawName)
        .filter((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint > 31 && codePoint !== 127;
        })
        .join('');
    const sanitizedName = filteredName.trim().length > 0
        ? filteredName
        : `document${suffix}`;
    const extensionProbeName = sanitizedName.replace(/\s+$/u, '');
    const hasRequestedExtension = extname(extensionProbeName).toLowerCase() === suffix;
    const normalizedName = hasRequestedExtension ? extensionProbeName : sanitizedName;
    const baseName = hasRequestedExtension
        ? normalizedName.slice(0, -suffix.length)
        : normalizedName;
    const maxBaseLength = Math.max(1, IPC_FILENAME_MAX_LENGTH - suffix.length);
    return `${truncateForIpc(baseName, maxBaseLength)}${suffix}`;
}

export async function showOpenDocumentDialogForContext(
    context: IOpenDocumentDialogContext,
    options: IOpenDocumentDialogOptions,
) {
    const dialogOptions = {
        title: options.title,
        defaultPath: getDocumentsDialogDefaultPath(),
        filters: [{
            name: te('dialogs.documentsFilter'),
            extensions: options.extensions,
        }],
        properties: [
            'openFile',
            'multiSelections',
        ],
    } satisfies Electron.OpenDialogOptions;

    // Automation sessions answer the Open dialog like the Save dialog below:
    // hidden runs cannot drive the native picker, and the path still goes
    // through the same open pipeline as a user's choice.
    const automationOpenPath = process.env.EVB_AUTOMATION_USER_DATA_DIR
        && process.env.EVB_E2E_OPEN_DIALOG_PATH?.trim();
    if (automationOpenPath) {
        return {
            canceled: false,
            filePaths: [automationOpenPath],
        } satisfies Electron.OpenDialogReturnValue;
    }

    return withSingleActiveDialogForSender(context.senderId, () => context.parentWindow
        ? dialog.showOpenDialog(context.parentWindow, dialogOptions)
        : dialog.showOpenDialog(dialogOptions));
}

export async function showSaveDialogWithExtension(
    context: IDocumentsDialogContext,
    options: ISaveDialogOptions,
) {
    const automationTargetPath = process.env.EVB_AUTOMATION_USER_DATA_DIR
        && process.env.EVB_E2E_SAVE_DIALOG_PATH?.trim();
    if (automationTargetPath) {
        return automationTargetPath;
    }

    const dialogOptions = {
        title: options.title,
        defaultPath: normalizeSaveDefaultPath(options.defaultPath, options.extension),
        filters: [{
            name: options.filterName,
            extensions: [options.extension],
        }],
    };
    const result = await withSingleActiveDialogForSender(context.senderId, () => context.parentWindow
        ? dialog.showSaveDialog(context.parentWindow, dialogOptions)
        : dialog.showSaveDialog(dialogOptions));

    if (result.canceled || !result.filePath) {
        return null;
    }

    const extension = `.${options.extension}`;
    const extensionProbePath = result.filePath.replace(/\s+$/u, '');
    return extname(extensionProbePath).toLowerCase() === extension
        ? result.filePath
        : `${result.filePath}${extension}`;
}
