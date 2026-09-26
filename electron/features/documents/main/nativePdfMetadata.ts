import { stat } from 'fs/promises';
import type {
    IPdfNativePageGeometry,
    IPdfNativePageSizesExactOptions,
    IPdfNativePageSize,
    IPdfOpeningGeometry,
} from '@contracts/electronApiDocuments';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
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
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import {
    runNativeToolCommand,
    type IRunNativeToolCommandOptions,
} from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import {
    isErrnoException,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
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

const PDFINFO_TIMEOUT_MS = 20_000;
// The opening skeleton reads every page of an ordinary document to find its
// widest page; beyond this many pages the first pages stand in for the rest.
const PDFINFO_OPENING_GEOMETRY_PAGE_LIMIT = 5_000;
const PDFINFO_BASE_STDOUT_BYTES = 256 * 1024;
const PDFINFO_PER_PAGE_STDOUT_BYTES = 128;
const logger = createLogger('native-pdf-metadata');

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
 * Reads the first page and the widest page from `pdfinfo -f 1 -l N` output.
 * The widest page sets PDF.js's document-wide Fit Width, so the opening
 * skeleton uses it to match the first PDF.js layout.
 */
export function parsePdfOpeningGeometryMetadata(
    pdfInfoOutput: string,
    identity: Pick<IPdfOpeningGeometry, 'size' | 'modifiedAt'>,
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
        if (pageNumber === 1) {
            firstPage = displayed;
        }
    }
    const rotation = normalizeRightAngleRotation(rawRotations.get(1));
    firstPage ??= fallbackPageSize
        ? displayedPageSize(fallbackPageSize.width, fallbackPageSize.height, rotation === 90 || rotation === 270)
        : null;
    if (firstPage === null) {
        throw new Error('Unable to determine PDF opening page dimensions');
    }
    return {
        pageNumber: requirePageNumber(1, pageCount),
        pageCount,
        width: firstPage.width,
        height: firstPage.height,
        rotation,
        widestPageWidth: Math.max(widestPageWidth, firstPage.width),
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
    try {
        return await resolvePdfPath(context, filePath);
    } catch (error) {
        if (
            typeof filePath !== 'string'
            || !(await getRecentFiles()).some(file => file.originalPath === filePath)
        ) {
            throw error;
        }

        // Recent-file metadata preflight runs before the open command mints its
        // normal path capability. Grant only a path which is still present in
        // the main-process Recent ledger, scoped to this renderer owner.
        const owner = context.sender ?? context.senderId;
        const trustedRecentPath = allowOpenPath(filePath, owner);
        if (trustedRecentPath === null) {
            throw error;
        }
        // Opening geometry is intentionally discovered from the immutable
        // original source before a working copy exists. The Recent ledger plus
        // the owner-scoped open capability is the authority boundary here;
        // the normal readable-path resolver only accepts managed temp paths
        // and therefore cannot resolve this pre-open source.
        return trustedRecentPath;
    }
}

function abortWithReason(controller: AbortController, reason: string) {
    if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
    }
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw abortErrorFromSignal(signal);
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

function requireDocumentRef(value: unknown): TDocumentRef {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
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

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native page operations are required for exact PDF geometry');
    }
    const tools = getPdfNativeToolPaths();
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancelPageGeometry = (reason: string) => {
        abortWithReason(abortController, reason);
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel: cancelPageGeometry,
    });
    cancelGroup = `pdf-native-page-geometry:${mainOperation.id}`;
    const handleMainAbort = () => {
        cancelPageGeometry('Native PDF exact page geometry canceled');
    };
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancelPageGeometry,
        'Renderer navigation canceled native PDF exact page geometry',
    );
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    try {
        const readGeometry = (physicalPath: string) => readPdfNativePageGeometry(physicalPath, {
            pdfPageOpsBinary: binaryPath,
            qpdfBinary: tools.qpdf,
            tempDir: getAppTempDir(),
            signal: abortController.signal,
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
        throwIfAborted(abortController.signal);
        await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);
        if (pages.length < 1) {
            throw new Error('Native exact geometry returned no pages');
        }
        const geometryPages = pages.map(page => {
            const rotation: 0 | 90 | 180 | 270 = page.rotation === 0
                ? 0
                : page.rotation === 90
                    ? 90
                    : page.rotation === 180
                        ? 180
                        : page.rotation === 270
                            ? 270
                            : (() => {
                                throw new Error(
                                    `Native exact geometry returned invalid page ${String(page.pageNumber)}`,
                                );
                            })();
            if (page.userUnit === undefined) {
                throw new Error(`Native exact geometry returned invalid page ${String(page.pageNumber)}`);
            }
            return {
                pageNumber: requirePageNumber(page.pageNumber, pages.length),
                xPoints: page.xPoints,
                yPoints: page.yPoints,
                widthPoints: page.widthPoints,
                heightPoints: page.heightPoints,
                rotation,
                userUnit: page.userUnit,
            };
        });
        return {
            kind: 'exact',
            documentRef: requireDocumentRef(filePath),
            documentRevisionToken: expectedRevisionToken,
            pageCount: geometryPages.length,
            pages: geometryPages,
        };
    } finally {
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        unregisterSenderCleanup();
        mainOperation.complete();
    }
}

export function parseNativePdfPageLabelRanges(value: unknown): IPdfPageLabelRange[] {
    if (!isRecord(value) || !Array.isArray(value.pageLabels)) {
        throw new Error('Native PDF catalog read returned invalid page labels');
    }
    return value.pageLabels.map((rawRange, index) => {
        if (!isRecord(rawRange)) {
            throw new Error(`Native PDF catalog page label ${index} is invalid`);
        }
        const pageIndex = rawRange.pageIndex;
        const start = rawRange.start;
        const style = rawRange.style;
        const prefix = rawRange.prefix;
        if (
            typeof pageIndex !== 'number'
            || !Number.isSafeInteger(pageIndex)
            || pageIndex < 0
            || typeof start !== 'undefined' && (
                typeof start !== 'number'
                || !Number.isSafeInteger(start)
                || start < 1
            )
            || typeof style !== 'undefined'
                && !isOneOf(PDF_PAGE_LABEL_STYLE_VALUES, style)
            || typeof prefix !== 'undefined' && typeof prefix !== 'string'
        ) {
            throw new Error(`Native PDF catalog page label ${index} is invalid`);
        }
        return {
            startPage: pageIndex + 1,
            style: style ?? null,
            prefix: prefix ?? '',
            startNumber: start ?? 1,
        };
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
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancelRead = (reason: string) => {
        abortWithReason(abortController, reason);
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel: cancelRead,
    });
    cancelGroup = `pdf-page-labels:${mainOperation.id}`;
    const handleMainAbort = () => cancelRead('Native PDF page-label read canceled');
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancelRead,
        'Renderer navigation canceled native PDF page-label read',
    );
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    try {
        const readCatalog = async (physicalPath: string) => parseNativePdfPageLabelRanges(
            await readNativePdfCatalog(binaryPath, physicalPath, {
                commandLabel: 'evb-pdf-page-ops(read-page-labels)',
                signal: abortController.signal,
                cancelGroup,
            }),
        );
        return originalBackedRead
            ? await originalBackedRead.read(readCatalog)
            : await readCatalog(resolvedPath);
    } finally {
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        unregisterSenderCleanup();
        mainOperation.complete();
    }
}

async function readPdfOpeningGeometryIdentity(resolvedPath: string) {
    try {
        const fileStat = await stat(resolvedPath);
        return {
            size: fileStat.size,
            modifiedAt: requireEpochMs(Math.trunc(fileStat.mtimeMs)),
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
    const identityBefore = originalBackedRead
        ? normalizePdfOpeningIdentity(originalBackedRead.identity)
        : await readPdfOpeningGeometryIdentity(resolvedPath);
    if (identityBefore === null) {
        return null;
    }
    const tools = getPdfNativeToolPaths();
    const env = buildPopplerEnv(tools);
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancelOpeningGeometry = (reason: string) => {
        abortWithReason(abortController, reason);
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel: cancelOpeningGeometry,
    });
    cancelGroup = `pdf-opening-geometry:${mainOperation.id}`;
    const handleMainAbort = () => {
        cancelOpeningGeometry('PDF opening geometry discovery canceled');
    };
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancelOpeningGeometry,
        'Renderer navigation canceled PDF opening geometry discovery',
    );
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    try {
        const readGeometry = (physicalPath: string) => runNativeToolCommand(
            tools.pdfinfo,
            [
                '-f',
                '1',
                '-l',
                String(PDFINFO_OPENING_GEOMETRY_PAGE_LIMIT),
                physicalPath,
            ],
            withPopplerEnv(env, {
                timeoutMs: PDFINFO_TIMEOUT_MS,
                maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES
                    + PDFINFO_OPENING_GEOMETRY_PAGE_LIMIT * PDFINFO_PER_PAGE_STDOUT_BYTES,
                rejectOnStdoutTruncation: true,
                commandLabel: 'pdfinfo-opening-geometry',
                signal: abortController.signal,
                cancelGroup,
            }),
        );
        const result = originalBackedRead
            ? await originalBackedRead.read(readGeometry)
            : await readGeometry(resolvedPath);
        throwIfAborted(abortController.signal);
        const identityAfter = originalBackedRead
            ? normalizePdfOpeningIdentity(originalBackedRead.identity)
            : await readPdfOpeningGeometryIdentity(resolvedPath);
        if (identityAfter === null) {
            return null;
        }
        if (
            identityAfter.size !== identityBefore.size
            || identityAfter.modifiedAt !== identityBefore.modifiedAt
        ) {
            throw new Error('PDF changed while opening geometry was being discovered');
        }
        return parsePdfOpeningGeometryMetadata(result.stdout, identityAfter);
    } finally {
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        unregisterSenderCleanup();
        mainOperation.complete();
    }
}
