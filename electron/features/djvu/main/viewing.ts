import {
    app,
    type WebContents,
} from 'electron';
import {
    stat,
    unlink,
} from 'fs/promises';
import {resolve} from 'path';
import { getDjvuPageCount } from '@electron/features/djvu/main/metadata';
import { getDjvuPageSourceInfoForViewing } from '@electron/features/djvu/main/pagePreview';
import { isAllowedDjvuTempPdfPath } from '@electron/features/djvu/main/isAllowedDjvuTempPdfPath';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import { isErrnoException } from '@contracts/runtimeGuards';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import type { IPlatformMainSenderContext } from '@contracts/platformFeature';
import type { IDjvuOpenResult } from '@contracts/electronApiDjvu';

const logger = createLogger('djvu-viewing');
interface IDjvuOperationContext extends IPlatformMainSenderContext<WebContents> {}
const allowedDjvuViewingPathsBySender = new Map<number, Map<string, number>>();
const senderCleanupRegistered = new Set<number>();

function normalizeTempPdfPath(tempPdfPath: string) {
    if (!tempPdfPath || tempPdfPath.trim() === '') {
        return null;
    }

    try {
        return resolve(tempPdfPath.trim());
    } catch {
        return null;
    }
}

function normalizeDjvuViewingPath(djvuPath: string) {
    if (!djvuPath || djvuPath.trim() === '') {
        return null;
    }

    try {
        return resolve(djvuPath.trim());
    } catch {
        return null;
    }
}

function canManageDjvuTempPdfPath(tempPdfPath: string) {
    return isAllowedDjvuTempPdfPath(tempPdfPath, app.getPath('temp'));
}

async function safeDeleteDjvuTempPdf(tempPdfPath: string) {
    const normalizedPath = normalizeTempPdfPath(tempPdfPath);
    if (!normalizedPath || !canManageDjvuTempPdfPath(normalizedPath)) {
        return;
    }

    try {
        await unlink(normalizedPath);
    } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') {
            logger.warn(`Failed to remove DjVu temp PDF "${normalizedPath}": ${String(error)}`);
        }
    }
}

export function performDjvuViewingShutdownCleanup() {
    allowedDjvuViewingPathsBySender.clear();
    senderCleanupRegistered.clear();
}

export async function cleanupDjvuTempPdfPath(tempPdfPath: string) {
    await safeDeleteDjvuTempPdf(tempPdfPath);
}

function registerSenderCleanup(context: IDjvuOperationContext) {
    const {
        sender,
        senderId,
    } = context;
    if (senderCleanupRegistered.has(senderId)) {
        return;
    }

    const cleanup = () => {
        allowedDjvuViewingPathsBySender.delete(senderId);
        senderCleanupRegistered.delete(senderId);
    };

    senderCleanupRegistered.add(senderId);
    const stop = onSenderLifetimeEnd(sender, () => {
        stop();
        cleanup();
    }, {navigation: true});
}

export function adoptDjvuViewingPath(context: IDjvuOperationContext, djvuPath: string) {
    const normalizedPath = normalizeDjvuViewingPath(djvuPath);
    if (!normalizedPath) {
        return;
    }

    registerSenderCleanup(context);
    const { senderId } = context;
    const allowedPaths = allowedDjvuViewingPathsBySender.get(senderId) ?? new Map<string, number>();
    allowedPaths.set(normalizedPath, (allowedPaths.get(normalizedPath) ?? 0) + 1);
    allowedDjvuViewingPathsBySender.set(senderId, allowedPaths);
}

export function releaseDjvuViewingPath(context: IDjvuOperationContext, djvuPath: string) {
    const normalizedPath = normalizeDjvuViewingPath(djvuPath);
    if (!normalizedPath) {
        return;
    }

    const { senderId } = context;
    const allowedPaths = allowedDjvuViewingPathsBySender.get(senderId);
    if (!allowedPaths) {
        return;
    }

    const nextCount = (allowedPaths.get(normalizedPath) ?? 0) - 1;
    if (nextCount > 0) {
        allowedPaths.set(normalizedPath, nextCount);
        return;
    }

    allowedPaths.delete(normalizedPath);
    if (allowedPaths.size === 0) {
        allowedDjvuViewingPathsBySender.delete(senderId);
    }
}

export function isAllowedDjvuViewingPath(djvuPath: string, senderId?: number) {
    const normalizedPath = normalizeDjvuViewingPath(djvuPath);
    if (!normalizedPath) {
        return false;
    }

    if (typeof senderId === 'number') {
        return (allowedDjvuViewingPathsBySender.get(senderId)?.get(normalizedPath) ?? 0) > 0;
    }

    for (const allowedPaths of allowedDjvuViewingPathsBySender.values()) {
        if ((allowedPaths.get(normalizedPath) ?? 0) > 0) {
            return true;
        }
    }

    return false;
}

export async function handleDjvuOpenForViewing(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    signal?: AbortSignal,
    adoptViewingPath = true,
): Promise<IDjvuOpenResult> {
    try {
        const pageSourceInfo = await getDjvuPageSourceInfoForViewing(
            djvuPath,
            1,
            signal ? {signal} : {},
        ).catch(() => null);
        const fallbackMetadata = pageSourceInfo ? null : await Promise.all([
            getDjvuPageCount(djvuPath, signal ? {signal} : {}),
            stat(djvuPath),
        ] as const);
        const pageCount = pageSourceInfo?.pageCount ?? fallbackMetadata![0];
        if (pageCount <= 0) {
            return {
                success: false,
                error: 'DjVu document has no pages',
            };
        }

        if (adoptViewingPath) {
            adoptDjvuViewingPath(context, djvuPath);
        }

        logger.info(`Native DjVu viewing ready: ${djvuPath} (${pageCount} pages)`);
        return {
            success: true,
            pageCount,
            ...(pageSourceInfo ? {pageSourceInfo} : {}),
        };
    } catch (error) {
        const message = getErrorMessage(error);
        logger.error(`DjVu open failed: ${message}`, {
            code: 'MAIN_DJVU_VIEWING_FAILED',
            context: {},
            cause: error,
        });
        return {
            success: false,
            error: message,
        };
    }
}
