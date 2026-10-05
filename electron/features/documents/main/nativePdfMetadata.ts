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
    readNativePdfCatalog,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public/nativePageOpsPath';
import {
    assertWorkingCopyRevisionCurrent,
    getWorkingCopyRevision,
} from '@electron/file-access/documentRevisionStore';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { readPdfNativePageGeometry } from '@electron/pdf/pdfPageSizes';
import * as v from 'valibot';

type IPdfNativePageSize = Pick<IPdfOpeningGeometry, 'width' | 'height'>;

const PDFINFO_TIMEOUT_MS = 20_000;
// The opening skeleton reads every page of an ordinary document to find its
// widest page; beyond this many pages the first pages stand in for the rest.
const PDFINFO_OPENING_GEOMETRY_PAGE_LIMIT = 5_000;
const PDFINFO_BASE_STDOUT_BYTES = 256 * 1024;
const PDFINFO_PER_PAGE_STDOUT_BYTES = 128;
const logger = createLogger('native-pdf-metadata');
// The page shapes already read, by the path read: a few numbers each. The
// oldest read leaves once the store is full.
const PAGE_SHAPE_STORE_LIMIT = 256;
const pageShapes = new Map<string, IPdfOpeningGeometry>();

const PAGE_COUNT_RE = /^Pages:\s+(\d+)\s*$/imu;
const DEFAULT_PAGE_SIZE_RE = /^Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts\b/imu;
const PAGE_SIZE_RE = /^Page\s+(\d+)\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts\b/gimu;
const PAGE_ROTATION_RE = /^Page\s+(\d+)\s+rot:\s+(-?\d+)\s*$/gimu;

function parsePositiveFiniteNumber(value: string | undefined) {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function withPopplerEnv(
    env: NodeJS.ProcessEnv | undefined,
    options: IRunNativeToolCommandOptions,
): IRunNativeToolCommandOptions {
    return env ? {
        ...options,
        env,
    } : options;
}

function normalizePageCount(pdfInfoOutput: string) {
    const count = Number.parseInt(PAGE_COUNT_RE.exec(pdfInfoOutput)?.[1] ?? '', 10);
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('Unable to determine PDF page count');
    }
    return count;
}

function parseDefaultPageSize(pdfInfoOutput: string): IPdfNativePageSize | null {
    const match = DEFAULT_PAGE_SIZE_RE.exec(pdfInfoOutput);
    const width = parsePositiveFiniteNumber(match?.[1]);
    const height = parsePositiveFiniteNumber(match?.[2]);
    return width && height ? {
        width,
        height,
    } : null;
}

function isQuarterTurn(rawRotation: string | undefined) {
    return rawRotation !== undefined && Math.abs(Number.parseInt(rawRotation, 10) % 180) === 90;
}

function displayedPageSize(width: number, height: number, quarterTurned: boolean): IPdfNativePageSize {
    return quarterTurned
        ? {
            width: height,
            height: width,
        }
        : {
            width,
            height,
        };
}

function normalizeRightAngleRotation(rawRotation: string | undefined): 0 | 90 | 180 | 270 {
    const parsed = Number.parseInt(rawRotation ?? '0', 10);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error('Unable to determine PDF opening page rotation');
    }
    const normalized = ((parsed % 360) + 360) % 360;
    if (normalized !== 0 && normalized !== 90 && normalized !== 180 && normalized !== 270) {
        throw new Error('PDF opening page has an unsupported rotation');
    }
    return normalized;
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

/**
 * Reads the opening page (the first unless named) and the widest and tallest
 * pages from `pdfinfo -f 1 -l N` output. They set PDF.js's document-wide Fit
 * Width in either view turn, so the opening skeleton matches its first layout.
 */
export function parsePdfOpeningGeometryMetadata(
    pdfInfoOutput: string,
    identity: Pick<IPdfOpeningGeometry, 'size' | 'modifiedAt'>,
    openingPage = 1,
): IPdfOpeningGeometry {
    const pageCount = normalizePageCount(pdfInfoOutput);
    const rawRotations = new Map<number, string | undefined>();
    PAGE_ROTATION_RE.lastIndex = 0;
    for (const match of pdfInfoOutput.matchAll(PAGE_ROTATION_RE)) {
        rawRotations.set(Number.parseInt(match[1] ?? '', 10), match[2]);
    }
    const fallbackPageSize = parseDefaultPageSize(pdfInfoOutput);
    let firstPage: IPdfNativePageSize | null = null;
    let widestPageWidth = 0;
    let tallestPageHeight = 0;
    PAGE_SIZE_RE.lastIndex = 0;
    for (const match of pdfInfoOutput.matchAll(PAGE_SIZE_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const width = parsePositiveFiniteNumber(match[2]);
        const height = parsePositiveFiniteNumber(match[3]);
        if (width === null || height === null) {
            continue;
        }
        const displayed = displayedPageSize(width, height, isQuarterTurn(rawRotations.get(pageNumber)));
        widestPageWidth = Math.max(widestPageWidth, displayed.width);
        tallestPageHeight = Math.max(tallestPageHeight, displayed.height);
        if (pageNumber === openingPage) {
            firstPage = displayed;
        }
    }
    const rotation = normalizeRightAngleRotation(rawRotations.get(openingPage));
    firstPage ??= fallbackPageSize
        ? displayedPageSize(fallbackPageSize.width, fallbackPageSize.height, rotation === 90 || rotation === 270)
        : null;
    if (firstPage === null) {
        throw new Error('Unable to determine PDF opening page dimensions');
    }
    return {
        pageNumber: requirePageNumber(openingPage, pageCount),
        pageCount,
        width: firstPage.width,
        height: firstPage.height,
        rotation,
        widestPageWidth: Math.max(widestPageWidth, firstPage.width),
        tallestPageHeight: Math.max(tallestPageHeight, firstPage.height),
        size: identity.size,
        modifiedAt: identity.modifiedAt,
    };
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

    const pages = await readExactPageGeometry(context, resolvedPath, originalBackedRead, {
        group: 'pdf-native-page-geometry',
        canceled: 'Native PDF exact page geometry canceled',
        navigation: 'Renderer navigation canceled native PDF exact page geometry',
    }, () => assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken));
    return {
        kind: 'exact',
        documentRef: requireDocumentRef(filePath),
        documentRevisionToken: expectedRevisionToken,
        pageCount: pages.length,
        pages,
    };
}

/**
 * Every page's exact shape, in order, by the native reader: its box, page
 * rotation and UserUnit. `confirm` runs once the read is done and before the
 * pages are trusted.
 */
async function readExactPageGeometry(
    context: IDocumentsSenderIdContext,
    resolvedPath: string,
    originalBackedRead: ReturnType<typeof resolveOriginalBackedReadTransport>,
    labels: Parameters<typeof runNativePdfRead>[2],
    confirm?: () => Promise<void>,
) {
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native page operations are required for exact PDF geometry');
    }
    const tools = getPdfNativeToolPaths();
    return runNativePdfRead(context, resolvedPath, labels, async (signal, cancelGroup) => {
        const readGeometry = (physicalPath: string) => readPdfNativePageGeometry(physicalPath, {
            pdfPageOpsBinary: binaryPath,
            qpdfBinary: tools.qpdf,
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
        const pages = originalBackedRead
            ? await originalBackedRead.read(readGeometry)
            : await readGeometry(resolvedPath);
        throwIfAborted(signal);
        await confirm?.();
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
    value: unknown,
): Array<v.InferOutput<typeof nativePdfPageLabelRangeSchema>> {
    const catalog = v.safeParse(v.object({pageLabels: v.array(v.unknown())}), value, {abortEarly: true});
    if (!catalog.success) {
        throw new Error('Native PDF catalog read returned invalid page labels');
    }
    return catalog.output.pageLabels.map((rawRange, index) => {
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
            await readNativePdfCatalog(binaryPath, physicalPath, {
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

/**
 * Answers a file's page shape from memory while the file keeps the size and
 * modification time it was read at, and reads it otherwise. Every
 * opening-geometry answer for a file read in place comes from here, so a file
 * the app has read before costs one stat instead of a pdfinfo run over every
 * page box.
 */
export async function answerPdfPageShape(
    path: string,
    revision: Pick<IPdfOpeningGeometry, 'size' | 'modifiedAt'>,
    read: () => Promise<IPdfOpeningGeometry | null>,
    pageNumber = 1,
): Promise<IPdfOpeningGeometry | null> {
    const known = pageShapes.get(path);
    if (known?.size === revision.size && known.modifiedAt === revision.modifiedAt && known.pageNumber === pageNumber) {
        pageShapes.delete(path);
        pageShapes.set(path, known);
        return known;
    }
    const shape = await read();
    pageShapes.delete(path);
    if (shape) {
        pageShapes.set(path, shape);
        const [oldest] = pageShapes.keys();
        if (pageShapes.size > PAGE_SHAPE_STORE_LIMIT && oldest !== undefined) {
            pageShapes.delete(oldest);
        }
    }
    return shape;
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
    const readingPage = readingView?.anchor?.page ?? readingView?.currentPage ?? 1;
    // A reader's place sits among its pages, so every read also takes each
    // page's exact shape: a file first read without a place has one once its
    // reader leaves, and that next open is answered from the store. A view
    // whose page count these bytes do not have is not this document's: the
    // open shows no page until the document tells its own.
    const shape = await answerPdfPageShape(resolvedPath, identityBefore, async () => {
        const read = await readPdfOpeningGeometry(context, resolvedPath, null, identityBefore, readingPage);
        return read && {
            ...read,
            pages: await readExactPageGeometry(context, resolvedPath, null, {
                group: 'pdf-opening-pages',
                canceled: 'PDF opening page geometry canceled',
                navigation: 'Renderer navigation canceled PDF opening page geometry',
            }).catch((error: unknown) => {
                logger.warn(`PDF opening page geometry unavailable: ${getErrorMessage(error)}`);
                return null;
            }),
        };
    }, readingPage);
    const matched = readingView !== null && shape?.pageNumber === readingPage && shape.pageCount === readingView.pageCount;
    const identityAfter = await readPdfOpeningGeometryIdentity(resolvedPath);
    if (identityAfter?.size !== identityBefore.size || identityAfter.mtimeMs !== identityBefore.mtimeMs) {
        pageShapes.delete(resolvedPath);
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
    const tools = getPdfNativeToolPaths();
    const env = buildPopplerEnv(tools);
    return runNativePdfRead(context, resolvedPath, {
        group: 'pdf-opening-geometry',
        canceled: 'PDF opening geometry discovery canceled',
        navigation: 'Renderer navigation canceled PDF opening geometry discovery',
    }, async (signal, cancelGroup) => {
        const readPages = (physicalPath: string, first: number, last: number) => runNativeToolCommand(
            tools.pdfinfo,
            [
                '-f',
                String(first),
                '-l',
                String(last),
                physicalPath,
            ],
            withPopplerEnv(env, {
                timeoutMs: PDFINFO_TIMEOUT_MS,
                maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES
                    + (last - first + 1) * PDFINFO_PER_PAGE_STDOUT_BYTES,
                rejectOnStdoutTruncation: true,
                commandLabel: 'pdfinfo-opening-geometry',
                signal,
                cancelGroup,
            }),
        ).catch((error: unknown) => {
            if (isPasswordRequiredPdfInfoFailure(error)) {
                return null;
            }
            throw error;
        });
        // A page past the widest-page pass is read on its own, from the same file.
        const readGeometry = async (physicalPath: string) => {
            const pages = await readPages(physicalPath, 1, PDFINFO_OPENING_GEOMETRY_PAGE_LIMIT);
            const openingPageInfo = pages && openingPage > PDFINFO_OPENING_GEOMETRY_PAGE_LIMIT
                ? await readPages(physicalPath, openingPage, openingPage)
                : null;
            return pages && {stdout: `${pages.stdout}\n${openingPageInfo?.stdout ?? ''}`};
        };
        const result = originalBackedRead
            ? await originalBackedRead.read(readGeometry)
            : await readGeometry(resolvedPath);
        throwIfAborted(signal);
        // The caller checks the file after the read; a working copy reading its
        // original keeps the identity it was admitted with.
        return result && parsePdfOpeningGeometryMetadata(result.stdout, identityBefore, openingPage);
    });
}
