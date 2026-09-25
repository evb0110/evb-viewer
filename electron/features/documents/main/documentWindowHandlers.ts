import { shell } from 'electron';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { refreshMenu } from '@electron/menu';
import {
    requireRevealPath,
    type TOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import { isKnownWorkingCopyOriginalPath } from '@electron/file-access/workingCopyStore';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import type { TOpenPathOwner } from '@electron/features/documents/main/openPathOwner';
import type {
    IDocumentsOpenPathContext,
    IDocumentsWindowContext,
} from '@electron/features/documents/documentsContexts';

const logger = createLogger('documents-dialogs');
const MAX_WINDOW_TITLE_LENGTH = 512;

function normalizeWindowTitle(title: unknown) {
    if (typeof title !== 'string') {
        return '';
    }

    return title.trim().slice(0, MAX_WINDOW_TITLE_LENGTH);
}

export function handleSetWindowTitle(context: IDocumentsWindowContext, title: string) {
    if (context.window) {
        const normalizedTitle = normalizeWindowTitle(title);
        context.window.setTitle(normalizedTitle || te('app.title'));
        refreshMenu();
    }
}

async function resolveRevealablePath(filePath: string, owner?: TOpenPathOwner) {
    const resolvedReadPath = await resolveAllowedReadPath(filePath);
    if (resolvedReadPath) {
        return resolvedReadPath;
    }

    const allowedRevealPath = (() => {
        try {
            return requireRevealPath(resolve(filePath), owner);
        } catch {
            return null;
        }
    })();
    if (allowedRevealPath && existsSync(allowedRevealPath)) {
        return allowedRevealPath;
    }

    const normalizedPath = resolve(filePath);
    const ownerId = typeof owner === 'number' ? owner : owner?.id;
    if (!isKnownWorkingCopyOriginalPath(normalizedPath, ownerId) || !existsSync(normalizedPath)) {
        return null;
    }
    return normalizedPath as TOpenPath;
}

export async function handleShowItemInFolder(
    context: IDocumentsOpenPathContext,
    filePath: string,
) {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
        return false;
    }

    try {
        const revealablePath = await resolveRevealablePath(normalizedPath, context.owner);
        if (!revealablePath) {
            return false;
        }
        shell.showItemInFolder(revealablePath);
        return true;
    } catch (error) {
        logger.error(`Failed to show item in folder: ${getErrorMessage(error)}`, {
            code: 'MAIN_DOCUMENT_REVEAL_FAILED',
            cause: error,
        });
        return false;
    }
}
