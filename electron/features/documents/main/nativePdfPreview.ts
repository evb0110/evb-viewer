import {
    mkdtemp,
    readFile,
    rm,
    stat,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';
import {
    PDF_NATIVE_PAGE_PREVIEW_RASTER_WIDTH_CEILING_PX,
    type IPdfNativePageGeometry,
    type IPdfNativePageSizesExactOptions,
    type IPdfNativePageSizesOptions,
    type IPdfNativePagePreview,
    type IPdfNativePagePreviewOptions,
    type IPdfNativePageSize,
    type IPdfNativePageSizeOverride,
    type IPdfNativePageSizes,
    type IPdfOpeningGeometry,
    type TPdfNativePageSizes,
    type TPdfNativePageSizesResult,
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
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
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
import { mainJobBroker } from '@electron/resources/jobBroker';
import type { IJobBrokerLease } from '@electron/resources/jobBroker';
import { createLogger } from '@electron/utils/createLogger';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import { acquireNativePdfPreviewAdmission } from '@electron/features/documents/main/acquireNativePdfPreviewAdmission';
import { QPDF_TIMEOUT_MS } from '@electron/features/page-ops/publicNative';
import {
    isErrnoException,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import { isWorkingCopyDirectoryName } from '@electron/file-access/workingCopyDirectory';
import { getWorkingCopyBackingEntry } from '@electron/file-access/workingCopyStore';
import { requireEpochMs } from '@contracts/timestamps';
import { resolveNativePageOpsPath } from '@electron/features/page-ops/public/nativePageOpsPath';
import {
    assertWorkingCopyRevisionCurrent,
    getWorkingCopyRevision,
} from '@electron/file-access/documentRevisionStore';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { readPdfNativePageGeometry } from '@electron/pdf/pdfPageSizes';

const PDFINFO_TIMEOUT_MS = 20_000;
const PDF_RENDER_TIMEOUT_MS = 30_000;
/**
 * The dense page-size compatibility shape is reserved for small documents.
 * Larger documents use the compact default-plus-overrides representation so
 * page-count metadata cannot force a whole-document array allocation.
 */
export const PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT = 5_000;
const PDFINFO_PAGE_SIZE_WINDOW_PAGES = 64;
const PDFINFO_PAGE_SIZE_WINDOW_LIMIT = PDFINFO_PAGE_SIZE_WINDOW_PAGES * 2;
const PDFINFO_BASE_STDOUT_BYTES = 256 * 1024;
const PDFINFO_PER_PAGE_STDOUT_BYTES = 512;
const PDF_RENDER_DEFAULT_TARGET_WIDTH_PX = 1_200;
const PDF_RENDER_MIN_TARGET_WIDTH_PX = 64;
const PDF_RENDER_MAX_TARGET_WIDTH_PX = PDF_NATIVE_PAGE_PREVIEW_RASTER_WIDTH_CEILING_PX;
const PDF_RENDER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PDF_RENDER_MAX_OUTPUT_PIXELS = 64 * 1024 * 1024;
const logger = createLogger('native-pdf-preview');

const PAGE_COUNT_RE = /^Pages:\s+(\d+)\s*$/imu;
const DEFAULT_PAGE_SIZE_RE = /^Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts\b/imu;
const PAGE_SIZE_RE = /^Page\s+(\d+)\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts\b/gimu;
const PAGE_ROTATION_RE = /^Page\s+(\d+)\s+rot:\s+(-?\d+)\s*$/gimu;
const OPTIMIZED_RE = /^Optimized:\s+(yes|no)\s*$/imu;

const activePreviewAborters = new Map<string, (reason: string) => void>();
const activePreviewPromises = new Map<string, Promise<IPdfNativePagePreview>>();
interface INativePdfPreviewRequestLifecycle {
    abortController: AbortController;
    cancel: (reason: string) => void;
    complete: () => void;
    setCancelGroup: (cancelGroup: string) => void;
}

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
        throw new Error('Unable to determine PDF page count for native preview');
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

function resolveDisplayedPageSize(
    width: number,
    height: number,
    rotation: 0 | 90 | 180 | 270,
): IPdfNativePageSize {
    return rotation === 90 || rotation === 270
        ? {
            width: height,
            height: width,
        }
        : {
            width,
            height,
        };
}

function isPageInPdfInfoWindow(pageNumber: number, pageCount: number) {
    return pageNumber <= PDFINFO_PAGE_SIZE_WINDOW_PAGES
        || pageNumber > pageCount - PDFINFO_PAGE_SIZE_WINDOW_PAGES;
}

export function parsePdfInfoPageSizes(
    pdfInfoOutput: string,
    pageCount: number,
    fallbackPageSize?: IPdfNativePageSize | null,
): TPdfNativePageSizes {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('Unable to determine PDF page count for native preview');
    }
    const parsedPageSizes = new Map<number, IPdfNativePageSize>();
    const pageRotations = new Map<number, 0 | 90 | 180 | 270>();

    PAGE_ROTATION_RE.lastIndex = 0;
    for (const match of pdfInfoOutput.matchAll(PAGE_ROTATION_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
            continue;
        }
        pageRotations.set(pageNumber, normalizeRightAngleRotation(match[2]));
    }

    PAGE_SIZE_RE.lastIndex = 0;
    for (const match of pdfInfoOutput.matchAll(PAGE_SIZE_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const width = parsePositiveFiniteNumber(match[2]);
        const height = parsePositiveFiniteNumber(match[3]);
        if (
            !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > pageCount
            || !width
            || !height
            || pageCount > PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT
                && !isPageInPdfInfoWindow(pageNumber, pageCount)
        ) {
            continue;
        }
        parsedPageSizes.set(pageNumber, resolveDisplayedPageSize(
            width,
            height,
            pageRotations.get(pageNumber) ?? 0,
        ));
    }

    const fallbackPageSizeFor = (pageNumber: number) => fallbackPageSize === null || fallbackPageSize === undefined
        ? null
        : resolveDisplayedPageSize(
            fallbackPageSize.width,
            fallbackPageSize.height,
            pageRotations.get(pageNumber) ?? 0,
        );
    const normalizedFallbackPageSize = fallbackPageSizeFor(1);
    const firstResolvedSize = normalizedFallbackPageSize
        ?? parsedPageSizes.values().next().value
        ?? null;
    if (!firstResolvedSize) {
        throw new Error('Unable to determine PDF page dimensions for native preview');
    }

    if (pageCount > PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT) {
        // The compact default describes the unrotated catalog size. A page's
        // display rotation is an override, including page 1; using page 1's
        // displayed dimensions as the default would make every unrotated page
        // look like an override when the first page is quarter-turned.
        const compactDefaultPageSize = fallbackPageSize ?? firstResolvedSize;
        const compactPageSizes = new Map(parsedPageSizes);
        if (fallbackPageSize !== null && fallbackPageSize !== undefined) {
            for (const pageNumber of pageRotations.keys()) {
                if (!compactPageSizes.has(pageNumber)) {
                    const fallback = fallbackPageSizeFor(pageNumber);
                    if (fallback) {
                        compactPageSizes.set(pageNumber, fallback);
                    }
                }
            }
        }
        const overrides: IPdfNativePageSizeOverride[] = [];
        for (const [
            pageNumber,
            size,
        ] of compactPageSizes) {
            if (
                size.width === compactDefaultPageSize.width
                && size.height === compactDefaultPageSize.height
            ) {
                continue;
            }
            overrides.push({
                pageNumber: requirePageNumber(pageNumber, pageCount),
                ...size,
            });
            if (overrides.length > PDFINFO_PAGE_SIZE_WINDOW_LIMIT) {
                throw new Error('Native PDF page-size metadata exceeds the complete override limit');
            }
        }
        return {
            pageCount,
            defaultPageSize: { ...compactDefaultPageSize },
            overrides,
        } satisfies IPdfNativePageSizes;
    }

    const sizes = Array.from({ length: pageCount }, (_, index) => {
        const fallback = fallbackPageSizeFor(index + 1);
        return fallback ? {...fallback} : null;
    });
    for (const [
        pageNumber,
        size,
    ] of parsedPageSizes) {
        sizes[pageNumber - 1] = size;
    }
    return sizes.map(size => size ?? { ...firstResolvedSize });
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

export function parsePdfOpeningGeometryMetadata(
    pdfInfoOutput: string,
    identity: Pick<IPdfOpeningGeometry, 'size' | 'modifiedAt'>,
): IPdfOpeningGeometry {
    const pageCount = normalizePageCount(pdfInfoOutput);
    PAGE_SIZE_RE.lastIndex = 0;
    let firstPageSizeMatch: RegExpMatchArray | undefined;
    for (const match of pdfInfoOutput.matchAll(PAGE_SIZE_RE)) {
        if (Number.parseInt(match[1] ?? '', 10) === 1) {
            firstPageSizeMatch = match;
            break;
        }
    }
    const fallbackPageSize = parseDefaultPageSize(pdfInfoOutput);
    const width = parsePositiveFiniteNumber(firstPageSizeMatch?.[2]) ?? fallbackPageSize?.width ?? null;
    const height = parsePositiveFiniteNumber(firstPageSizeMatch?.[3]) ?? fallbackPageSize?.height ?? null;
    if (width === null || height === null) {
        throw new Error('Unable to determine PDF opening page dimensions');
    }
    PAGE_ROTATION_RE.lastIndex = 0;
    let firstPageRotationMatch: RegExpMatchArray | undefined;
    for (const match of pdfInfoOutput.matchAll(PAGE_ROTATION_RE)) {
        if (Number.parseInt(match[1] ?? '', 10) === 1) {
            firstPageRotationMatch = match;
            break;
        }
    }
    const rotation = normalizeRightAngleRotation(firstPageRotationMatch?.[2]);
    const isQuarterTurn = rotation === 90 || rotation === 270;
    const optimized = OPTIMIZED_RE.exec(pdfInfoOutput)?.[1]?.toLowerCase();
    return {
        pageNumber: requirePageNumber(1, pageCount),
        pageCount,
        width: isQuarterTurn ? height : width,
        height: isQuarterTurn ? width : height,
        rotation,
        size: identity.size,
        modifiedAt: identity.modifiedAt,
        ...(optimized === undefined ? {} : {linearized: optimized === 'yes'}),
    };
}

function normalizePreviewTargetWidth(options: IPdfNativePagePreviewOptions | undefined) {
    const rawTargetWidth = options?.targetWidthPx ?? PDF_RENDER_DEFAULT_TARGET_WIDTH_PX;
    if (!Number.isFinite(rawTargetWidth)) {
        return PDF_RENDER_DEFAULT_TARGET_WIDTH_PX;
    }
    return Math.min(
        PDF_RENDER_MAX_TARGET_WIDTH_PX,
        Math.max(PDF_RENDER_MIN_TARGET_WIDTH_PX, Math.trunc(rawTargetWidth)),
    );
}

function normalizePreviewRequestId(options: IPdfNativePagePreviewOptions | undefined) {
    const requestId = options?.previewRequestId?.trim();
    return requestId && requestId.length > 0 ? requestId : null;
}

function getPreviewAborterKey(senderId: number, requestId: string) {
    return `${senderId}:${requestId}`;
}

function getPreviewRequestOwnerId(context: IDocumentsSenderIdContext) {
    return context.senderId ?? -1;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf,
]);

export function readJpegDimensions(bytes: Uint8Array) {
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new Error('Native PDF preview renderer produced an invalid JPEG');
    }

    let offset = 2;
    while (offset < bytes.byteLength) {
        while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
        while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.byteLength) break;

        const marker = bytes[offset];
        offset += 1;
        if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
        if (offset + 2 > bytes.byteLength) break;

        const segmentLength = (Number(bytes[offset]) << 8) | Number(bytes[offset + 1]);
        if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) break;
        if (JPEG_START_OF_FRAME_MARKERS.has(marker) && segmentLength >= 7) {
            const height = (Number(bytes[offset + 3]) << 8) | Number(bytes[offset + 4]);
            const width = (Number(bytes[offset + 5]) << 8) | Number(bytes[offset + 6]);
            if (width > 0 && height > 0) {
                return {
                    width,
                    height,
                };
            }
            break;
        }
        offset += segmentLength;
    }

    throw new Error('Native PDF preview renderer produced an invalid JPEG');
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

function abortPreviewController(controller: AbortController, reason: string) {
    if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
    }
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function cancelActivePreviewRequest(senderId: number, requestId: string, reason: string) {
    const abort = activePreviewAborters.get(getPreviewAborterKey(senderId, requestId));
    if (!abort) {
        return false;
    }
    abort(reason);
    return true;
}

export function registerNativePdfSenderCleanup(
    sender: Electron.WebContents | undefined,
    abort: (reason: string) => void,
    navigationReason = 'Renderer navigation canceled native PDF preview',
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

function createNativePdfPreviewRequestLifecycle(
    context: IDocumentsSenderIdContext,
    previewRequestId: string | null,
): INativePdfPreviewRequestLifecycle {
    const abortController = new AbortController();
    const ownerId = getPreviewRequestOwnerId(context);
    let cancelGroup = '';
    const cancel = (reason: string) => {
        abortPreviewController(abortController, reason);
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    const aborterKey = previewRequestId
        ? getPreviewAborterKey(ownerId, previewRequestId)
        : null;
    if (previewRequestId) {
        cancelActivePreviewRequest(ownerId, previewRequestId, 'Native PDF preview request superseded');
        activePreviewAborters.set(getPreviewAborterKey(ownerId, previewRequestId), cancel);
    }
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(context.sender, cancel);

    return {
        abortController,
        cancel,
        complete: () => {
            if (aborterKey && activePreviewAborters.get(aborterKey) === cancel) {
                activePreviewAborters.delete(aborterKey);
            }
            unregisterSenderCleanup();
        },
        setCancelGroup: (nextCancelGroup) => {
            cancelGroup = nextCancelGroup;
        },
    };
}

function requireDocumentRef(value: unknown): TDocumentRef {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
}

async function handlePdfNativePageGeometry(
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
        abortPreviewController(abortController, reason);
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

export function handlePdfNativePageSizes(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<TPdfNativePageSizes>;
export function handlePdfNativePageSizes(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    options: IPdfNativePageSizesExactOptions,
): Promise<IPdfNativePageGeometry>;
export function handlePdfNativePageSizes(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    options?: IPdfNativePageSizesOptions,
): Promise<TPdfNativePageSizesResult>;
export async function handlePdfNativePageSizes(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    options?: IPdfNativePageSizesOptions,
): Promise<TPdfNativePageSizesResult> {
    if (options?.mode === 'exact') {
        return handlePdfNativePageGeometry(
            context,
            filePath,
            options as IPdfNativePageSizesExactOptions,
        );
    }
    const resolvedPath = await resolvePdfPath(context, filePath);
    const originalBackedRead = resolveOriginalBackedReadTransport(resolvedPath, context.senderId);
    const tools = getPdfNativeToolPaths();
    const env = buildPopplerEnv(tools);
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancelPageSizes = (reason: string) => {
        abortPreviewController(abortController, reason);
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel: cancelPageSizes,
    });
    cancelGroup = `pdf-native-page-sizes:${mainOperation.id}`;
    const handleMainAbort = () => {
        cancelPageSizes('Native PDF page-size discovery canceled');
    };
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancelPageSizes,
        'Renderer navigation canceled native PDF page-size discovery',
    );
    mainOperation.signal.addEventListener('abort', handleMainAbort, { once: true });

    const readPageSizes = async (physicalPath: string) => {
        const overview = await runNativeToolCommand(
            tools.pdfinfo,
            [physicalPath],
            withPopplerEnv(env, {
                timeoutMs: PDFINFO_TIMEOUT_MS,
                maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES,
                commandLabel: 'pdfinfo',
                signal: abortController.signal,
                cancelGroup,
            }),
        );
        throwIfAborted(abortController.signal);
        const pageCount = normalizePageCount(overview.stdout);
        const fallbackPageSize = parseDefaultPageSize(overview.stdout);
        const readPageSizeWindow = async (startPage: number, endPage: number) => {
            const detailed = await runNativeToolCommand(
                tools.pdfinfo,
                [
                    '-box',
                    '-f',
                    String(startPage),
                    '-l',
                    String(endPage),
                    physicalPath,
                ],
                withPopplerEnv(env, {
                    timeoutMs: PDFINFO_TIMEOUT_MS,
                    maxStdoutBytes: Math.max(
                        PDFINFO_BASE_STDOUT_BYTES,
                        (endPage - startPage + 1) * PDFINFO_PER_PAGE_STDOUT_BYTES,
                    ),
                    rejectOnStdoutTruncation: true,
                    commandLabel: 'pdfinfo',
                    signal: abortController.signal,
                    cancelGroup,
                }),
            );
            throwIfAborted(abortController.signal);
            return detailed.stdout;
        };

        if (pageCount <= PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT) {
            const detailed = await readPageSizeWindow(1, pageCount);
            return parsePdfInfoPageSizes(
                detailed,
                pageCount,
                parseDefaultPageSize(detailed) ?? fallbackPageSize,
            );
        }

        const firstWindowEnd = Math.min(pageCount, PDFINFO_PAGE_SIZE_WINDOW_PAGES);
        const lastWindowStart = Math.max(
            1,
            pageCount - PDFINFO_PAGE_SIZE_WINDOW_PAGES + 1,
        );
        const firstWindow = await readPageSizeWindow(1, firstWindowEnd);
        const lastWindow = await readPageSizeWindow(lastWindowStart, pageCount);
        return parsePdfInfoPageSizes(
            [
                overview.stdout,
                firstWindow,
                lastWindow,
            ].join('\n'),
            pageCount,
            parseDefaultPageSize(firstWindow) ?? fallbackPageSize,
        );
    };

    try {
        return originalBackedRead
            ? await originalBackedRead.read(readPageSizes)
            : await readPageSizes(resolvedPath);
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
    const catalogDir = await mkdtemp(join(tmpdir(), 'pdf-page-labels-'));
    const catalogPath = join(catalogDir, 'catalog.json');
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancelRead = (reason: string) => {
        abortPreviewController(abortController, reason);
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
        const readCatalog = async (physicalPath: string) => {
            await runNativeToolCommand(binaryPath, [
                'read-catalog',
                '--input',
                physicalPath,
                '--output',
                catalogPath,
            ], {
                timeoutMs: QPDF_TIMEOUT_MS,
                commandLabel: 'evb-pdf-page-ops(read-page-labels)',
                signal: abortController.signal,
                cancelGroup,
            });
            return parseNativePdfPageLabelRanges(JSON.parse(await readFile(catalogPath, 'utf8')));
        };
        return originalBackedRead
            ? await originalBackedRead.read(readCatalog)
            : await readCatalog(resolvedPath);
    } finally {
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        unregisterSenderCleanup();
        mainOperation.complete();
        await rm(catalogDir, {
            recursive: true,
            force: true,
        });
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
    return isWorkingCopyDirectoryName(basename(dirname(normalizedPath)))
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
        abortPreviewController(abortController, reason);
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
                '-box',
                '-f',
                '1',
                '-l',
                '1',
                physicalPath,
            ],
            withPopplerEnv(env, {
                timeoutMs: PDFINFO_TIMEOUT_MS,
                maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES,
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

export function handleCancelPdfNativePagePreview(
    context: IDocumentsSenderIdContext,
    requestId: string,
): Promise<{ canceled: boolean }> {
    const canceled = cancelActivePreviewRequest(
        getPreviewRequestOwnerId(context),
        requestId,
        'Native PDF preview canceled',
    );
    return Promise.resolve({canceled});
}

async function runPdfNativePagePreview(
    context: IDocumentsSenderIdContext,
    resolvedPath: string,
    pageNumber: unknown,
    requestLifecycle: INativePdfPreviewRequestLifecycle,
    options?: IPdfNativePagePreviewOptions,
): Promise<IPdfNativePagePreview> {
    const page = Number(pageNumber);
    if (!Number.isSafeInteger(page) || page < 1) {
        throw new Error(`Invalid PDF page number: ${String(pageNumber)}`);
    }

    const requestedTargetWidthPx = normalizePreviewTargetWidth(options);
    const previewRequestId = normalizePreviewRequestId(options);
    const ownerId = getPreviewRequestOwnerId(context);
    const originalBackedRead = resolveOriginalBackedReadTransport(resolvedPath, context.senderId);
    const tools = getPdfNativeToolPaths();
    const env = buildPopplerEnv(tools);
    const abortController = requestLifecycle.abortController;
    const cancelPreview = requestLifecycle.cancel;
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel: (reason) => {
            cancelPreview(reason);
        },
    });
    const cancelGroup = `pdf-native-preview:${mainOperation.id}`;
    requestLifecycle.setCancelGroup(cancelGroup);
    const handleMainAbort = () => {
        cancelPreview('Native PDF preview canceled');
    };
    mainOperation.signal.addEventListener('abort', handleMainAbort, { once: true });
    let tempDir: string | null = null;
    let resourceLease: IJobBrokerLease | null = null;
    const requestStartedAt = performance.now();
    let requestOutcome = 'failed';
    let admissionWaitMs: number | null = null;

    try {
        resourceLease = await acquireNativePdfPreviewAdmission({
            acquire: request => mainJobBroker.acquire(request),
            ownerSignal: abortController.signal,
            request: {
                ownerId: String(ownerId),
                kind: 'native-pdf-preview',
                priority: 'visible',
                admissionClass: 'interactive',
                perOwnerLimit: 2,
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: Math.max(16 * 1024 * 1024, PDF_RENDER_MAX_OUTPUT_BYTES * 2),
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            },
        });
        admissionWaitMs = Math.round((performance.now() - requestStartedAt) * 10) / 10;
        tempDir = await mkdtemp(join(tmpdir(), 'evb-pdf-native-preview-'));
        const outputPrefix = join(tempDir, 'page');
        const outputPath = `${outputPrefix}.jpg`;
        const renderPage = async (physicalPath: string) => {
            await runNativeToolCommand(
                tools.pdftoppm,
                [
                    '-jpeg',
                    '-jpegopt',
                    'quality=98,optimize=n,progressive=n',
                    '-singlefile',
                    '-scale-to-x',
                    String(requestedTargetWidthPx),
                    '-scale-to-y',
                    '-1',
                    '-f',
                    String(page),
                    '-l',
                    String(page),
                    physicalPath,
                    outputPrefix,
                ],
                withPopplerEnv(env, {
                    timeoutMs: PDF_RENDER_TIMEOUT_MS,
                    maxStdoutBytes: 64 * 1024,
                    maxStderrBytes: 512 * 1024,
                    commandLabel: 'pdftoppm',
                    signal: abortController.signal,
                    cancelGroup,
                }),
            );
        };
        if (originalBackedRead) {
            await originalBackedRead.read(renderPage);
        } else {
            await renderPage(resolvedPath);
        }
        const outputStat = await stat(outputPath);
        if (outputStat.size > PDF_RENDER_MAX_OUTPUT_BYTES) {
            throw new RangeError('Native PDF preview exceeds the 64 MiB output limit');
        }
        const bytes = new Uint8Array(await readFile(outputPath));
        const {
            width,
            height,
        } = readJpegDimensions(bytes);
        if (width * height > PDF_RENDER_MAX_OUTPUT_PIXELS) {
            throw new RangeError('Native PDF preview exceeds the 64-megapixel surface limit');
        }
        requestOutcome = 'completed';
        return {
            bytes,
            width,
            height,
            rasterWidthCeilingPx: PDF_RENDER_MAX_TARGET_WIDTH_PX,
        };
    } finally {
        if (tempDir !== null) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        mainOperation.complete();
        resourceLease?.release();
        logger.debug('Native PDF preview request finished', {
            ownerId,
            page,
            previewRequestId,
            targetWidthPx: requestedTargetWidthPx,
            admissionWaitMs,
            outcome: abortController.signal.aborted ? 'canceled' : requestOutcome,
            totalMs: Math.round((performance.now() - requestStartedAt) * 10) / 10,
        });
    }
}

export async function handlePdfNativePagePreview(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    pageNumber: unknown,
    options?: IPdfNativePagePreviewOptions,
): Promise<IPdfNativePagePreview> {
    const page = Number(pageNumber);
    const targetWidthPx = normalizePreviewTargetWidth(options);
    const previewRequestId = normalizePreviewRequestId(options);
    const requestId = previewRequestId ?? 'unscoped';
    const dedupeKey = typeof filePath === 'string'
        ? `${getPreviewRequestOwnerId(context)}\0${requestId}\0${filePath}\0${page}\0${targetWidthPx}`
        : null;
    const existing = dedupeKey === null
        ? undefined
        : activePreviewPromises.get(dedupeKey);
    if (existing) {
        return existing;
    }
    const requestLifecycle = createNativePdfPreviewRequestLifecycle(context, previewRequestId);
    const previewPromise = (async () => {
        try {
            const resolvedPath = await resolvePdfPath(context, filePath);
            throwIfAborted(requestLifecycle.abortController.signal);
            return await runPdfNativePagePreview(
                context,
                resolvedPath,
                pageNumber,
                requestLifecycle,
                options,
            );
        } finally {
            requestLifecycle.complete();
        }
    })();
    if (dedupeKey !== null) {
        activePreviewPromises.set(dedupeKey, previewPromise);
    }
    return previewPromise.finally(() => {
        if (
            dedupeKey !== null
            && activePreviewPromises.get(dedupeKey) === previewPromise
        ) {
            activePreviewPromises.delete(dedupeKey);
        }
    });
}
