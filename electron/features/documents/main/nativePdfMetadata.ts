import { stat } from 'fs/promises';
import type {
    IPdfNativePageGeometry,
    IPdfNativePageSizesExactOptions,
    IPdfOpeningGeometry,
} from '@contracts/electronApiDocuments';
import { requireDocumentRef } from '@contracts/documentRef';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {
    PDF_PAGE_LABEL_STYLE_VALUES,
    type IPdfPageLabelRange,
} from '@contracts/pdfPageLabels';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';
import { resolveOriginalBackedReadTransport } from '@electron/features/documents/main/documentFileReadHandlers';
import { resolveExistingReadablePdfPath } from '@electron/features/documents/main/documentFilePathResolution';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { getRecentFiles } from '@electron/recentFiles';
import { readRecentReadingViewOf } from '@electron/recentReadingViews';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import {
    runNativeToolCommand,
    type IRunNativeToolCommandOptions,
} from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import { NativeProcessError } from '@electron/native-tools/processResult';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import { isErrnoException } from '@contracts/runtimeGuards';
import { isWorkingCopyDocumentPath } from '@electron/file-access/workingCopyDirectory';
import { getWorkingCopyBackingEntry } from '@electron/file-access/workingCopyStore';
import { requireEpochMs } from '@contracts/timestamps';
import {
    readNativePdfCatalogPart,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public/nativePageOpsPath';
import {
    assertWorkingCopyRevisionCurrent,
    getWorkingCopyRevision,
} from '@electron/file-access/documentRevisionStore';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { readPdfNativePageGeometry } from '@electron/pdf/pdfPageSizes';
import * as v from 'valibot';

const PDFINFO_TIMEOUT_MS = 20_000;
const PDFINFO_BASE_STDOUT_BYTES = 256 * 1024;
const logger = createLogger('native-pdf-metadata');

function withPopplerEnv(
    env: NodeJS.ProcessEnv | undefined,
    options: IRunNativeToolCommandOptions,
): IRunNativeToolCommandOptions {
    return env ? {
        ...options,
        env,
    } : options;
}

function normalizePdfOpeningIdentity(value: {
    size: number;
    modifiedAt: unknown
}) {
    return {
        size: value.size,
        modifiedAt: requireEpochMs(value.modifiedAt),
    } satisfies Pick<IPdfOpeningGeometry, 'size' | 'modifiedAt'>;
}

async function resolvePdfPath(context: IDocumentsSenderIdContext, filePath: unknown) {
    return resolveExistingReadablePdfPath(filePath, context.senderId);
}

async function resolvePdfOpeningGeometryPath(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
) {
    // A Recent file's shape is its original's: the open about to start reads
    // the original, while a working copy of an earlier open may be closing.
    // Recent-file metadata preflight runs before the open command mints its
    // normal path capability, so a path still in the main-process Recent
    // ledger is granted to this renderer owner. The normal readable-path
    // resolver accepts only managed paths and would answer with that copy.
    if (typeof filePath === 'string' && (await getRecentFiles()).some(file => file.originalPath === filePath)) {
        const trustedRecentPath = allowOpenPath(filePath, context.sender ?? context.senderId);
        if (trustedRecentPath !== null) {
            return trustedRecentPath;
        }
    }
    return resolvePdfPath(context, filePath);
}

// Poppler's answer for an encrypted PDF read without its password. Opening
// geometry is read before the password prompt, so this is an expected outcome.
function isPasswordRequiredPdfInfoFailure(error: unknown) {
    return error instanceof NativeProcessError
        && error.kind === 'exit-code'
        && error.exitCode === 1
        && error.message.includes('Command Line Error: Incorrect password');
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

/**
 * Runs one native read for a sender as a main operation: cancelling the
 * operation, or the sender navigating or closing, aborts it and its tool's
 * command group.
 */
async function runNativePdfRead<T>(
    context: IDocumentsSenderIdContext,
    resolvedPath: string,
    labels: {
        group: string;
        canceled: string;
        navigation: string;
    },
    read: (signal: AbortSignal, cancelGroup: string) => Promise<T>,
): Promise<T> {
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancel = (reason: string) => {
        if (!abortController.signal.aborted) {
            abortController.abort(new Error(reason));
        }
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel,
    });
    cancelGroup = `${labels.group}:${mainOperation.id}`;
    const handleMainAbort = () => cancel(labels.canceled);
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(context.sender, cancel, labels.navigation);
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});
    try {
        return await read(abortController.signal, cancelGroup);
    } finally {
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        unregisterSenderCleanup();
        mainOperation.complete();
    }
}

export function registerNativePdfSenderCleanup(
    sender: Electron.WebContents | undefined,
    abort: (reason: string) => void,
    navigationReason = 'Renderer navigation canceled native PDF metadata read',
) {
    if (!sender) {
        return () => undefined;
    }
    if (sender.isDestroyed()) {
        abort('Renderer lifecycle ended');
        return () => undefined;
    }

    return onSenderLifetimeEnd(sender, (end) => {
        abort(end === 'main-frame-navigation' ? navigationReason : 'Renderer lifecycle ended');
    }, {navigation: true});
}

export async function handlePdfNativePageSizes(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    options: IPdfNativePageSizesExactOptions,
): Promise<IPdfNativePageGeometry> {
    const expectedRevisionToken = parseDocumentRevisionToken(
        options.expectedDocumentRevisionToken,
    );
    if (expectedRevisionToken === null) {
        throw new Error('Document revision token is required for exact PDF geometry');
    }
    const resolvedPath = await resolvePdfPath(context, filePath);
    const originalBackedRead = resolveOriginalBackedReadTransport(resolvedPath, context.senderId);
    const revision = await getWorkingCopyRevision(resolvedPath, context.senderId);
    if (revision.token !== expectedRevisionToken) {
        throw createStaleRevisionError({
            documentRef: requireDocumentRef(resolvedPath),
            expectedRevision: expectedRevisionToken,
            actualRevision: revision.token,
        });
    }
    await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);

    const pages = await runNativePdfRead(context, resolvedPath, {
        group: 'pdf-native-page-geometry',
        canceled: 'Native PDF exact page geometry canceled',
        navigation: 'Renderer navigation canceled native PDF exact page geometry',
    }, async (signal, cancelGroup) => {
        const read = (physicalPath: string) => readExactPageGeometry(physicalPath, signal, cancelGroup);
        const pages = originalBackedRead ? await originalBackedRead.read(read) : await read(resolvedPath);
        throwIfAborted(signal);
        await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);
        return pages;
    });
    return {
        kind: 'exact',
        documentRef: requireDocumentRef(filePath),
        documentRevisionToken: expectedRevisionToken,
        pageCount: pages.length,
        pages,
    };
}

/** Every page's box, page rotation and UserUnit, from the same native reader. */
async function readExactPageGeometry(physicalPath: string, signal: AbortSignal, cancelGroup: string) {
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native page operations are required for exact PDF geometry');
    }
    const pages = await readPdfNativePageGeometry(physicalPath, {
        pdfPageOpsBinary: binaryPath,
        qpdfBinary: getPdfNativeToolPaths().qpdf,
        tempDir: getAppTempDir(),
        signal,
        cancelGroup,
        log: (level, message) => {
            if (level === 'debug') {
                logger.debug(message);
            } else {
                logger.warn(message);
            }
        },
    });
    throwIfAborted(signal);
    if (pages.length < 1) {
        throw new Error('Native exact geometry returned no pages');
    }
    return pages.map((page) => {
        if (![
            0,
            90,
            180,
            270,
        ].includes(page.rotation) || page.userUnit === undefined) {
            throw new Error(`Native exact geometry returned invalid page ${String(page.pageNumber)}`);
        }
        return {
            pageNumber: requirePageNumber(page.pageNumber, pages.length),
            xPoints: page.xPoints,
            yPoints: page.yPoints,
            widthPoints: page.widthPoints,
            heightPoints: page.heightPoints,
            rotation: page.rotation as 0 | 90 | 180 | 270,
            userUnit: page.userUnit,
        };
    });
}

const nativePdfPageLabelRangeSchema = v.pipe(v.object({
    pageIndex: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    start: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
    style: v.optional(v.picklist(PDF_PAGE_LABEL_STYLE_VALUES)),
    prefix: v.optional(v.string()),
}), v.transform(({
    pageIndex,
    start,
    style,
    prefix,
}) => ({
    // Native zero-based indices and omitted defaults become renderer label ranges here.
    startPage: pageIndex + 1,
    style: style ?? null,
    prefix: prefix ?? '',
    startNumber: start ?? 1,
})));

export function parseNativePdfPageLabelRanges(
    pageLabels: readonly unknown[],
): Array<v.InferOutput<typeof nativePdfPageLabelRangeSchema>> {
    return pageLabels.map((rawRange, index) => {
        const parsed = v.safeParse(nativePdfPageLabelRangeSchema, rawRange, {abortEarly: true});
        if (!parsed.success) {
            throw new Error(`Native PDF catalog page label ${index} is invalid`);
        }
        return parsed.output;
    });
}

export async function handlePdfPageLabelRanges(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<IPdfPageLabelRange[]> {
    const resolvedPath = await resolvePdfPath(context, filePath);
    const originalBackedRead = resolveOriginalBackedReadTransport(resolvedPath, context.senderId);
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native page operations are required to read PDF page labels');
    }
    return runNativePdfRead(context, resolvedPath, {
        group: 'pdf-page-labels',
        canceled: 'Native PDF page-label read canceled',
        navigation: 'Renderer navigation canceled native PDF page-label read',
    }, async (signal, cancelGroup) => {
        const readCatalog = async (physicalPath: string) => parseNativePdfPageLabelRanges(
            await readNativePdfCatalogPart(binaryPath, physicalPath, 'pageLabels', {
                commandLabel: 'evb-pdf-page-ops(read-page-labels)',
                signal,
                cancelGroup,
            }),
        );
        return originalBackedRead
            ? originalBackedRead.read(readCatalog)
            : readCatalog(resolvedPath);
    });
}

async function readPdfOpeningGeometryIdentity(resolvedPath: string) {
    try {
        // The modification time as the working-copy registry reads it, so a
        // Recent reading view's witness compares exactly.
        const fileStat = await stat(resolvedPath, {bigint: true});
        const mtimeMs = Number(fileStat.mtimeNs) / 1_000_000;
        return {
            size: Number(fileStat.size),
            modifiedAt: requireEpochMs(Math.trunc(mtimeMs)),
            mtimeMs,
        };
    } catch (error) {
        if (isMissingPdfOpeningGeometrySource(error)) {
            return null;
        }
        throw error;
    }
}

function isMissingPdfOpeningGeometrySource(error: unknown) {
    return isErrnoException(error)
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isUnregisteredManagedWorkingCopy(filePath: unknown, senderId?: number) {
    if (typeof filePath !== 'string') {
        return false;
    }
    const normalizedPath = filePath.trim();
    return isWorkingCopyDocumentPath(normalizedPath)
        && getWorkingCopyBackingEntry(normalizedPath, senderId) === null;
}

export async function handlePdfOpeningGeometry(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<IPdfOpeningGeometry | null> {
    if (isUnregisteredManagedWorkingCopy(filePath, context.senderId)) {
        return null;
    }
    let resolvedPath: string;
    try {
        resolvedPath = await resolvePdfOpeningGeometryPath(context, filePath);
    } catch (error) {
        if (isUnregisteredManagedWorkingCopy(filePath, context.senderId)) {
            return null;
        }
        throw error;
    }
    const originalBackedRead = resolveOriginalBackedReadTransport(resolvedPath, context.senderId);
    // A working copy that still reads its original keeps its admission
    // identity when the original changes, so only the checked read can tell.
    if (originalBackedRead) {
        return readPdfOpeningGeometry(
            context,
            resolvedPath,
            originalBackedRead,
            normalizePdfOpeningIdentity(originalBackedRead.identity),
        );
    }
    const identityBefore = await readPdfOpeningGeometryIdentity(resolvedPath);
    if (identityBefore === null) {
        return null;
    }
    // Where the reader left these bytes, matched against main's own stat of
    // them, names the page the open shows first; a changed file has none.
    const readingView = typeof filePath === 'string'
        ? await readRecentReadingViewOf({
            originalPath: filePath,
            sourceSize: identityBefore.size,
            sourceModifiedAtMs: identityBefore.mtimeMs,
        })
        : null;
    // With no reading view, the admitted copy's exact table owns the first
    // layout. Managed-copy callers still need its count to admit a restore.
    if (readingView === null && !isWorkingCopyDocumentPath(resolvedPath)) return null;
    const readingPage = readingView?.anchor?.page ?? readingView?.currentPage ?? 1;
    const shape = await readPdfOpeningGeometry(context, resolvedPath, null, identityBefore, readingPage);
    const matched = readingView !== null && shape?.pageNumber === readingPage && shape.pageCount === readingView.pageCount;
    const identityAfter = await readPdfOpeningGeometryIdentity(resolvedPath);
    if (identityAfter?.size !== identityBefore.size || identityAfter.mtimeMs !== identityBefore.mtimeMs) {
        return null;
    }
    return shape && (matched || shape.pageNumber === 1) ? {
        ...shape,
        readingView: matched ? readingView : null,
    } : null;
}

async function readPdfOpeningGeometry(
    context: IDocumentsSenderIdContext,
    resolvedPath: string,
    originalBackedRead: ReturnType<typeof resolveOriginalBackedReadTransport>,
    identityBefore: Pick<IPdfOpeningGeometry, 'size' | 'modifiedAt'>,
    openingPage = 1,
): Promise<IPdfOpeningGeometry | null> {
    return runNativePdfRead(context, resolvedPath, {
        group: 'pdf-opening-geometry',
        canceled: 'PDF opening geometry discovery canceled',
        navigation: 'Renderer navigation canceled PDF opening geometry discovery',
    }, async (signal, cancelGroup) => {
        const read = async (physicalPath: string): Promise<IPdfOpeningGeometry | null> => {
            let pages: Awaited<ReturnType<typeof readExactPageGeometry>>;
            try {
                pages = await readExactPageGeometry(physicalPath, signal, cancelGroup);
            } catch (error) {
                throwIfAborted(signal);
                logger.warn(`PDF opening page geometry unavailable: ${getErrorMessage(error)}`);
                // Preserve password prompting and Poppler's malformed/recovery
                // handling. Its dimensions omit UserUnit, so only a complete
                // exact table may size the opening skeleton.
                const tools = getPdfNativeToolPaths();
                await runNativeToolCommand(tools.pdfinfo, [
                    '-f',
                    '1',
                    '-l',
                    '1',
                    physicalPath,
                ], withPopplerEnv(buildPopplerEnv(tools), {
                    timeoutMs: PDFINFO_TIMEOUT_MS,
                    maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES,
                    rejectOnStdoutTruncation: true,
                    commandLabel: 'pdfinfo-opening-geometry',
                    signal,
                    cancelGroup,
                })).catch((error: unknown) => {
                    if (!isPasswordRequiredPdfInfoFailure(error)) throw error;
                });
                throwIfAborted(signal);
                return null;
            }
            const pageNumber = requirePageNumber(openingPage, pages.length);
            const opening = pages[pageNumber - 1]!;
            const displayed = pages.map((page) => {
                const turned = page.rotation === 90 || page.rotation === 270;
                return {
                    width: (turned ? page.heightPoints : page.widthPoints) * page.userUnit,
                    height: (turned ? page.widthPoints : page.heightPoints) * page.userUnit,
                };
            });
            return {
                size: identityBefore.size,
                modifiedAt: identityBefore.modifiedAt,
                pageNumber,
                pageCount: pages.length,
                width: displayed[pageNumber - 1]!.width,
                height: displayed[pageNumber - 1]!.height,
                rotation: opening.rotation,
                widestPageWidth: displayed.reduce((width, page) => Math.max(width, page.width), 0),
                tallestPageHeight: displayed.reduce((height, page) => Math.max(height, page.height), 0),
                pages,
            };
        };
        const shape = originalBackedRead ? await originalBackedRead.read(read) : await read(resolvedPath);
        throwIfAborted(signal);
        return shape;
    });
}
