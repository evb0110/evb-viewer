import {
    app,
    type WebContents,
} from 'electron';
import {
    open,
    unlink,
} from 'fs/promises';
import {resolve} from 'path';
import { getDjvuPageCount } from '@electron/features/djvu/main/metadata';
import { getDjvuPageSourceInfoForViewing } from '@electron/features/djvu/main/pagePreview';
import {
    readDjvuSourceRevision,
    type IDjvuSourceRevision,
} from '@electron/features/djvu/main/djvuPageSourceInfoCache';
import { isAllowedDjvuTempPdfPath } from '@electron/features/djvu/main/isAllowedDjvuTempPdfPath';
import { NativeProcessError } from '@electron/native-tools/processResult';
import { isAbortError } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import { isErrnoException } from '@contracts/runtimeGuards';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import type { IPlatformMainSenderContext } from '@contracts/platformFeature';
import type {
    IDjvuOpenResult,
    IDjvuOpenSource,
} from '@contracts/electronApiDjvu';
import {isEqual} from 'es-toolkit/predicate';
import type { TDocumentOpenErrorCode } from '@contracts/documentOpenErrors';

const DJVU_IFF_HEADER_BYTES = 16;
const DJVU_FORM_TYPES = new Set([
    'DJVU',
    'DJVM',
    'DJVI',
    'THUM',
]);

const logger = createLogger('djvu-viewing');
interface IDjvuOperationContext extends IPlatformMainSenderContext<WebContents> {}
// The source size and modification time an open's probe read the pages from.
// DjVu is read live from its source, so this metadata, not a copy, is what
// ties a reading view to the bytes it showed. It cannot see a same-size,
// same-time replacement or a change to an indirect component file.
interface IDjvuViewingGrant {
    count: number;
    // Null when an open could not prove which bytes it read, or when two live
    // opens of the path read different bytes.
    source: IDjvuOpenSource | null;
}

const allowedDjvuViewingPathsBySender = new Map<number, Map<string, IDjvuViewingGrant>>();
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

function readSourceOf(revision: Partial<Pick<IDjvuSourceRevision, 'sourceModifiedAt' | 'sourceSize'>> | undefined): IDjvuOpenSource | null {
    const {
        sourceModifiedAt, sourceSize,
    } = revision ?? {};
    return sourceModifiedAt === undefined || sourceSize === undefined
        ? null
        : {
            sourceModifiedAt,
            sourceSize,
        };
}

// Live opens of one path that read different bytes leave no single source a
// view could belong to, until every one of them is released.
export function adoptDjvuViewingPath(context: IDjvuOperationContext, djvuPath: string, source: IDjvuOpenSource | null) {
    const normalizedPath = normalizeDjvuViewingPath(djvuPath);
    if (!normalizedPath) {
        return;
    }

    registerSenderCleanup(context);
    const { senderId } = context;
    const allowedPaths = allowedDjvuViewingPathsBySender.get(senderId) ?? new Map<string, IDjvuViewingGrant>();
    const live = allowedPaths.get(normalizedPath);
    allowedPaths.set(normalizedPath, {
        count: (live?.count ?? 0) + 1,
        source: !live || isEqual(live.source, source) ? source : null,
    });
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

    const grant = allowedPaths.get(normalizedPath);
    if (grant && grant.count > 1) {
        grant.count -= 1;
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
        return allowedDjvuViewingPathsBySender.get(senderId)?.has(normalizedPath) === true;
    }

    for (const allowedPaths of allowedDjvuViewingPathsBySender.values()) {
        if (allowedPaths.has(normalizedPath)) {
            return true;
        }
    }

    return false;
}

/**
 * The source this sender's open of a DjVu path admitted, while the source
 * still has that size and modification time. A source changed since the open
 * is refused rather than re-read, because the current bytes are not the ones
 * the sender's view was left on.
 */
export async function getAdmittedDjvuViewingSource(djvuPath: string, senderId: number) {
    const normalizedPath = normalizeDjvuViewingPath(djvuPath);
    const admitted = normalizedPath
        ? allowedDjvuViewingPathsBySender.get(senderId)?.get(normalizedPath)?.source
        : null;
    if (!normalizedPath || !admitted) {
        return null;
    }
    const current = await readDjvuSourceRevision(normalizedPath).catch(() => null);
    return current?.sourceSize === admitted.sourceSize && current.sourceModifiedAt === admitted.sourceModifiedAt
        ? {
            originalPath: normalizedPath,
            ...admitted,
        }
        : null;
}

/**
 * Whether the source's own bytes prove it is a truncated DjVu container: a
 * recognized `AT&TFORM` DjVu header whose FORM chunk is longer than the file.
 * DjVuLibre also opens other prefixes and chunk types, so any other header
 * proves nothing. A source the app cannot read proves nothing and throws.
 */
async function isMalformedDjvuContainer(djvuPath: string) {
    const handle = await open(djvuPath, 'r');
    try {
        const {size} = await handle.stat();
        const header = Buffer.alloc(DJVU_IFF_HEADER_BYTES);
        const {bytesRead} = await handle.read(header, 0, DJVU_IFF_HEADER_BYTES, 0);
        return bytesRead === DJVU_IFF_HEADER_BYTES
            && header.toString('latin1', 0, 8) === 'AT&TFORM'
            && DJVU_FORM_TYPES.has(header.toString('latin1', 12, 16))
            && 12 + header.readUInt32BE(8) > size;
    } finally {
        await handle.close();
    }
}

/**
 * Why an open probe failed, when the failure proves it. djvused exits 10 for
 * every exception, including an unreadable source and bad usage, so a native
 * refusal is an invalid DjVu only when the source bytes prove it malformed.
 */
async function classifyDjvuOpenFailure(error: unknown, djvuPath: string): Promise<TDocumentOpenErrorCode | null> {
    if (isErrnoException(error) && error.code === 'ENOENT') {
        return 'not-found';
    }
    if (!(error instanceof NativeProcessError && error.kind === 'exit-code')) {
        return null;
    }
    return await isMalformedDjvuContainer(djvuPath).catch(() => false) ? 'invalid-djvu' : null;
}

function isDjvuOpenCanceled(error: unknown, signal: AbortSignal | undefined) {
    return signal?.aborted === true || isAbortError(error);
}

export async function handleDjvuOpenForViewing(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    signal?: AbortSignal,
    adoptViewingPath = true,
): Promise<IDjvuOpenResult> {
    const probeOptions = signal ? {signal} : {};
    try {
        // The page-source probe can fail on a file the plain page count still
        // reads, so a genuine probe failure falls back; cancellation does not.
        const pageSourceInfo = await getDjvuPageSourceInfoForViewing(djvuPath, 1, probeOptions)
            .catch((error: unknown) => {
                if (isDjvuOpenCanceled(error, signal)) {
                    throw error;
                }
                return null;
            });
        let pageCount = pageSourceInfo?.pageCount;
        let source = readSourceOf(pageSourceInfo ?? undefined);
        if (pageCount === undefined) {
            // Stat first, so a missing file is reported as missing rather than
            // as whatever djvused says about a path it cannot open. The count
            // describes that source only if it is unchanged after the probe.
            const before = await readDjvuSourceRevision(djvuPath);
            pageCount = await getDjvuPageCount(djvuPath, probeOptions);
            const after = await readDjvuSourceRevision(djvuPath).catch(() => null);
            source = after?.revision === before.revision ? readSourceOf(before) : null;
        }
        if (pageCount <= 0) {
            return failDjvuOpen(new Error('DjVu document has no pages'), 'invalid-djvu');
        }

        if (adoptViewingPath) {
            adoptDjvuViewingPath(context, djvuPath, source);
        }

        logger.info(`Native DjVu viewing ready: ${djvuPath} (${pageCount} pages)`);
        return {
            success: true,
            pageCount,
            ...(pageSourceInfo ? {pageSourceInfo} : {}),
            ...(source ? {source} : {}),
        };
    } catch (error) {
        if (isDjvuOpenCanceled(error, signal)) {
            return {
                success: false,
                error: getErrorMessage(error),
                expected: {
                    kind: 'expected',
                    code: 'canceled',
                },
            };
        }
        return failDjvuOpen(error, await classifyDjvuOpenFailure(error, djvuPath));
    }
}

// The message stays diagnostic; the renderer localizes the code and shows the
// message only as technical details next to the logged failure receipt.
function failDjvuOpen(error: unknown, code: TDocumentOpenErrorCode | null): IDjvuOpenResult {
    const message = getErrorMessage(error);
    const failure = logger.error(`DjVu open failed: ${message}`, {
        code: 'MAIN_DJVU_VIEWING_FAILED',
        cause: error,
    });
    return {
        success: false,
        error: message,
        ...(code === null ? {} : {errorEnvelope: {
            code,
            message,
        }}),
        ...(failure === undefined ? {} : {failure}),
    };
}
