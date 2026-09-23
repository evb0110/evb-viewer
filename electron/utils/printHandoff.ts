import { BrowserWindow } from 'electron';
import type { WebContentsPrintOptions } from 'electron';
import {
    copyFile,
    mkdtemp,
    readdir,
    open,
    rm,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    basename,
    join,
    parse,
} from 'path';
import { pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { sortBy } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import { createLogger } from '@electron/utils/createLogger';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { includesAsciiToken } from '@electron/utils/includesAsciiToken';
import { openMacOsPdfPrintDialog } from '@electron/utils/openMacOsPdfPrintDialog';
import { getPrintRuntimePlatform } from '@electron/utils/getPrintRuntimePlatform';

const logger = createLogger('documents-print');
// Low-end Windows machines can report the PDF plugin as loaded before it has painted.
const PRINT_LOAD_SETTLE_DELAY_MS = 2_000;
const PRINT_SURFACE_PROBE_INTERVAL_MS = parseIntegerEnv('EVB_PRINT_SURFACE_PROBE_INTERVAL_MS', 250, 50, 2_000);
const PRINT_SURFACE_READY_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_SURFACE_READY_TIMEOUT_MS', 15_000, 1_000, 120_000);
const PRINT_PDF_READY_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_PDF_READY_TIMEOUT_MS', 15_000, 1_000, 120_000);
const PRINT_SURFACE_PROBE_SIZE_PX = 480;
const PRINT_JOB_RESOURCE_RETENTION_MS = 30_000;
const PRINT_DIALOG_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_DIALOG_TIMEOUT_MS', 5 * 60 * 1000, 5_000);
const PRINT_DIALOG_TEST_MODE_ENV = 'EVB_PRINT_DIALOG_TEST_MODE';
const PRINT_DIALOG_TEST_MODE_PRINT_TO_PDF = 'print-to-pdf';
const PRINT_DIALOG_TEST_OUTPUT_PATH_ENV = 'EVB_PRINT_DIALOG_TEST_OUTPUT_PATH';
const PRINT_WINDOW_WIDTH_PX = 1280;
const PRINT_WINDOW_HEIGHT_PX = 1600;
export const PRINT_DJVU_TEMP_PREFIX = 'print-djvu-';
const MAX_PRINT_PDF_DATA_BYTES = parseIntegerEnv('EVB_PRINT_PDF_MAX_MB', 16, 1, 16) * 1024 * 1024;
const PRINT_RASTER_DPI = parseIntegerEnv('EVB_PRINT_RASTER_DPI', 180, 72, 300);
const PRINT_RASTER_CHUNK_PAGES = parseIntegerEnv('EVB_PRINT_RASTER_CHUNK_PAGES', 50, 1, 100);
const PRINT_RASTER_MAX_PAGES = parseIntegerEnv('EVB_PRINT_RASTER_MAX_PAGES', 100, 1, 1000);
const PRINT_RASTER_MAX_TOTAL_PIXELS = parseIntegerEnv(
    'EVB_PRINT_RASTER_MAX_TOTAL_PIXELS',
    64_000_000,
    1_000_000,
    1_000_000_000,
);
const PRINT_RASTER_RENDER_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_RASTER_TIMEOUT_MS', 3 * 60 * 1000, 5_000);
const PRINT_RASTER_IMAGE_LOAD_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_RASTER_IMAGE_LOAD_TIMEOUT_MS', 30_000, 1_000);
const PRINT_RASTER_METADATA_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_RASTER_METADATA_TIMEOUT_MS', 30_000, 5_000);
const PRINT_RASTER_METADATA_MAX_STDOUT_BYTES = 64 * 1024;
const PDF_HEADER_SCAN_BYTES = 1024;
const PDF_EOF_SCAN_BYTES = 1024 * 1024;
const scheduledPrintTempCleanup = new Map<string, ReturnType<typeof setTimeout>>();

export interface IPrintPdfResult {
    success: boolean;
    canceled?: boolean;
    error?: string;
}

export interface IPrintWindowContext {window?: BrowserWindow | null;}

interface IPrintHandoffOptions {
    onNativeDialogOpened?: () => void;
    signal?: AbortSignal;
    surface?: 'pdf-plugin' | 'rasterized-html';
}

interface IPrintWebContentsPrivateEvents {
    once: (event: string, listener: (...args: unknown[]) => void) => unknown;
    removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

interface IPdfPluginReadyWait {
    promise: Promise<void>;
    armTimeout: () => void;
}

interface IPdfPageSize {
    width: number;
    height: number;
}

interface IPdfPrintLayout {
    pageCount: number;
    pageSizes: IPdfPageSize[];
}

interface IPrintImagePage {
    pageNumber: number;
    path: string;
}

export function validatePdfBytesForHandoff(data: Uint8Array, label: string) {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error(`Invalid ${label} payload`);
    }
    if (data.byteLength > MAX_PRINT_PDF_DATA_BYTES) {
        throw new Error(`${label} payload is too large`);
    }

    const headerEnd = Math.min(data.byteLength, PDF_HEADER_SCAN_BYTES);
    const eofStart = Math.max(0, data.byteLength - PDF_EOF_SCAN_BYTES);
    if (
        !includesAsciiToken(data, '%PDF-', 0, headerEnd)
        || !includesAsciiToken(data, '%%EOF', eofStart, data.byteLength)
    ) {
        throw new Error(`${label} payload is not a valid PDF`);
    }
}

export async function assertPdfPathWithinSizeLimit(filePath: string) {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || !Number.isSafeInteger(fileStat.size) || fileStat.size <= 0) {
        throw new Error('Invalid PDF path');
    }

    const file = await open(filePath, 'r');
    try {
        const headerAndTail = fileStat.size <= PDF_EOF_SCAN_BYTES
            ? await readPdfPathRange(file, 0, fileStat.size)
            : null;
        const header = headerAndTail ?? await readPdfPathRange(file, 0, PDF_HEADER_SCAN_BYTES);
        const tail = headerAndTail ?? await readPdfPathRange(
            file,
            Math.max(0, fileStat.size - PDF_EOF_SCAN_BYTES),
            Math.min(fileStat.size, PDF_EOF_SCAN_BYTES),
        );
        const headerEnd = Math.min(header.byteLength, PDF_HEADER_SCAN_BYTES);
        const eofStart = Math.max(0, tail.byteLength - PDF_EOF_SCAN_BYTES);
        if (
            !includesAsciiToken(header, '%PDF-', 0, headerEnd)
            || !includesAsciiToken(tail, '%%EOF', eofStart, tail.byteLength)
        ) {
            throw new Error('Invalid PDF path');
        }
    } finally {
        await file.close();
    }
}

async function readPdfPathRange(
    file: Awaited<ReturnType<typeof open>>,
    position: number,
    length: number,
) {
    const buffer = Buffer.allocUnsafe(Math.max(0, length));
    let bytesReadTotal = 0;
    while (bytesReadTotal < buffer.byteLength) {
        const result = await file.read(
            buffer,
            bytesReadTotal,
            buffer.byteLength - bytesReadTotal,
            position + bytesReadTotal,
        );
        if (result.bytesRead === 0) {
            break;
        }
        bytesReadTotal += result.bytesRead;
    }
    return buffer.subarray(0, bytesReadTotal);
}

export function schedulePrintTempCleanup(path: string, delayMs = PRINT_JOB_RESOURCE_RETENTION_MS) {
    const existingTimer = scheduledPrintTempCleanup.get(path);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        scheduledPrintTempCleanup.delete(path);
        void unlink(path).catch(() => undefined);
    }, delayMs);
    timer.unref();
    scheduledPrintTempCleanup.set(path, timer);
}

export async function cleanupPrintTempPath(path: string) {
    const existingTimer = scheduledPrintTempCleanup.get(path);
    if (existingTimer) {
        clearTimeout(existingTimer);
        scheduledPrintTempCleanup.delete(path);
    }

    await unlink(path).catch(() => undefined);
}

function sanitizePrintDocumentTitle(title: string) {
    const sanitized = Array.from(title)
        .map((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            if (codePoint < 32 || character === '/' || character === '\\' || character === ':') {
                return '-';
            }
            return character;
        })
        .join('')
        .trim();
    return sanitized || 'document';
}

function resolvePrintDocumentTitle(filePath: string, fileName?: string) {
    const candidate = typeof fileName === 'string' && fileName.trim()
        ? fileName.trim()
        : filePath;
    const candidateBaseName = basename(candidate) || 'document';
    const parsed = parse(candidateBaseName);
    return sanitizePrintDocumentTitle(parsed.name || candidateBaseName || 'document');
}

function createPrintWindow(ownerWindow: BrowserWindow | undefined, documentTitle: string) {
    return new BrowserWindow({
        show: false,
        title: documentTitle,
        autoHideMenuBar: true,
        ...(ownerWindow ? { parent: ownerWindow } : {}),
        width: PRINT_WINDOW_WIDTH_PX,
        height: PRINT_WINDOW_HEIGHT_PX,
        skipTaskbar: true,
        minimizable: false,
        fullscreenable: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#ffffff',
        webPreferences: {
            // 'plugins: true' enables Chromium's built-in PDF viewer for native print preview.
            // The window has no preload and no Node API exposure, so this sandbox flip is a
            // pure defense-in-depth tightening; if the Chromium PDF plugin fails to render
            // under the sandbox in this Electron version, revert to sandbox:false.
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            plugins: true,
            backgroundThrottling: false,
        },
    });
}

function escapeHtml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parsePdfInfoPageCount(stdout: string) {
    const match = stdout.match(/^Pages:\s*(\d+)\s*$/imu);
    const pageCount = Number.parseInt(match?.[1] ?? '', 10);
    return Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : null;
}

function parsePdfInfoPageSizes(stdout: string, pageCount: number) {
    const pageSizes = new Array<IPdfPageSize | null>(pageCount).fill(null);
    const rotations = new Map<number, number>();
    const pageSizePattern = /^Page(?:\s+(\d+))?\s+size:\s*([\d.]+)\s+x\s+([\d.]+)\s+pts(?:\s|$)/gimu;
    for (const match of stdout.matchAll(pageSizePattern)) {
        const pageNumber = Number.parseInt(match[1] ?? '1', 10);
        const width = Number.parseFloat(match[2] ?? '');
        const height = Number.parseFloat(match[3] ?? '');
        if (
            !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > pageCount
            || !Number.isFinite(width)
            || !Number.isFinite(height)
            || width <= 0
            || height <= 0
        ) {
            continue;
        }
        pageSizes[pageNumber - 1] = {
            width,
            height,
        };
    }

    const cropBoxPattern = /^Page\s+(\d+)\s+CropBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s|$)/gimu;
    for (const match of stdout.matchAll(cropBoxPattern)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const left = Number.parseFloat(match[2] ?? '');
        const bottom = Number.parseFloat(match[3] ?? '');
        const right = Number.parseFloat(match[4] ?? '');
        const top = Number.parseFloat(match[5] ?? '');
        if (
            !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > pageCount
            || ![
                left,
                bottom,
                right,
                top,
            ].every(Number.isFinite)
            || right <= left
            || top <= bottom
        ) {
            continue;
        }
        pageSizes[pageNumber - 1] = {
            width: right - left,
            height: top - bottom,
        };
    }

    const rotationPattern = /^Page\s+(\d+)\s+rot:\s*(-?\d+)/gimu;
    for (const match of stdout.matchAll(rotationPattern)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const rotation = Number.parseInt(match[2] ?? '', 10);
        if (Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount && Number.isFinite(rotation)) {
            rotations.set(pageNumber - 1, ((rotation % 360) + 360) % 360);
        }
    }

    if (pageSizes.some(pageSize => pageSize === null)) {
        return null;
    }

    return pageSizes.map((pageSize, index) => {
        const rotation = rotations.get(index) ?? 0;
        if (rotation === 90 || rotation === 270) {
            return {
                width: pageSize!.height,
                height: pageSize!.width,
            };
        }
        return pageSize!;
    });
}

async function readPdfPrintLayout(path: string, signal?: AbortSignal): Promise<IPdfPrintLayout> {
    const paths = getPdfNativeToolPaths();
    const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
        timeoutMs: PRINT_RASTER_METADATA_TIMEOUT_MS,
        maxStdoutBytes: PRINT_RASTER_METADATA_MAX_STDOUT_BYTES,
        rejectOnStdoutTruncation: true,
        commandLabel: 'pdfinfo(print-raster)',
        ...(signal ? {signal} : {}),
    };
    const popplerEnv = buildPopplerEnv(paths);
    if (popplerEnv !== undefined) {
        commandOptions.env = popplerEnv;
    }

    const result = await runNativeToolCommand(paths.pdfinfo, [
        '-box',
        '-f',
        '1',
        '-l',
        String(PRINT_RASTER_MAX_PAGES),
        path,
    ], commandOptions);
    const pageCount = parsePdfInfoPageCount(result.stdout);
    const pageSizes = pageCount === null || pageCount > PRINT_RASTER_MAX_PAGES
        ? []
        : parsePdfInfoPageSizes(result.stdout, pageCount);
    if (pageCount === null || (pageCount <= PRINT_RASTER_MAX_PAGES && pageSizes === null)) {
        throw new Error('pdfinfo did not return printable PDF metadata');
    }

    return {
        pageCount,
        pageSizes: pageSizes ?? [],
    };
}

function parseRenderedImagePageNumber(fileName: string) {
    const match = fileName.match(/-(\d+)\.(?:jpe?g)$/iu);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

function isRenderedPrintImage(fileName: string, prefixBaseName: string) {
    return fileName.startsWith(`${prefixBaseName}-`) && /\.(?:jpe?g)$/iu.test(fileName);
}

async function renderPdfPrintImages(
    pdfPath: string,
    layout: IPdfPrintLayout,
    workDir: string,
    signal?: AbortSignal,
) {
    const paths = getPdfNativeToolPaths();
    const popplerEnv = buildPopplerEnv(paths);
    const renderedPages: IPrintImagePage[] = [];

    for (const firstPage of range(1, layout.pageCount + 1, PRINT_RASTER_CHUNK_PAGES)) {
        throwIfPrintHandoffAborted(signal);
        const lastPage = Math.min(layout.pageCount, firstPage + PRINT_RASTER_CHUNK_PAGES - 1);
        const prefixBaseName = `page-${String(firstPage).padStart(5, '0')}`;
        const prefix = join(workDir, prefixBaseName);
        const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
            timeoutMs: PRINT_RASTER_RENDER_TIMEOUT_MS,
            commandLabel: 'pdftoppm(print-raster)',
            ...(signal ? { signal } : {}),
        };
        if (popplerEnv !== undefined) {
            commandOptions.env = popplerEnv;
        }

        await runNativeToolCommand(paths.pdftoppm, [
            '-cropbox',
            '-jpeg',
            '-r',
            String(PRINT_RASTER_DPI),
            '-f',
            String(firstPage),
            '-l',
            String(lastPage),
            pdfPath,
            prefix,
        ], commandOptions);
        throwIfPrintHandoffAborted(signal);

        const fileNames = await readdir(workDir);
        renderedPages.push(...sortBy(
            fileNames
                .filter(fileName => isRenderedPrintImage(fileName, prefixBaseName))
                .map(fileName => ({
                    pageNumber: parseRenderedImagePageNumber(fileName),
                    path: join(workDir, fileName),
                })),
            ['pageNumber'],
        ));
    }

    if (renderedPages.length !== layout.pageCount) {
        throw new Error(`Expected ${layout.pageCount} printable page image(s), rendered ${renderedPages.length}`);
    }

    return renderedPages;
}

function buildRasterPrintHtml(
    title: string,
    layout: IPdfPrintLayout,
    imagePages: IPrintImagePage[],
) {
    const escapedTitle = escapeHtml(title);
    const pagesHtml = imagePages.map((page, index) => `
        <section class="print-page page-${index + 1}" data-page-number="${index + 1}">
            <img src="${escapeHtml(pathToFileURL(page.path).toString())}" alt="">
        </section>
    `).join('');
    const pageRules = layout.pageSizes.map((pageSize, index) => `
        @page page-${index + 1} {
            size: ${Math.max(1, pageSize.width).toFixed(2)}pt ${Math.max(1, pageSize.height).toFixed(2)}pt;
            margin: 0;
        }
    `).join('');

    return `<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <title>${escapedTitle}</title>
    <style>
        ${pageRules}
        html,
        body {
            margin: 0;
            padding: 0;
            background: #fff;
        }
        .print-page {
            box-sizing: border-box;
            margin: 0;
            overflow: hidden;
            break-after: page;
            page-break-after: always;
            background: #fff;
        }
        ${layout.pageSizes.map((pageSize, index) => `
        .page-${index + 1} {
            width: ${Math.max(1, pageSize.width).toFixed(2)}pt;
            height: ${Math.max(1, pageSize.height).toFixed(2)}pt;
            page: page-${index + 1};
        }
        `).join('')}
        .print-page:last-child {
            break-after: auto;
            page-break-after: auto;
        }
        .print-page img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
    </style>
</head>
<body>${pagesHtml}</body>
</html>`;
}

async function waitForRasterPrintSurfaceReady(printWindow: BrowserWindow) {
    await printWindow.webContents.executeJavaScript(`
        (() => {
            const timeoutMs = ${PRINT_RASTER_IMAGE_LOAD_TIMEOUT_MS};
            const waitForImage = (image) => {
                if (image.complete && image.naturalWidth > 0) {
                    return Promise.resolve(true);
                }
                if (typeof image.decode === 'function') {
                    return image.decode().then(() => {
                        if (image.naturalWidth <= 0) {
                            throw new Error('Printable page image decoded without dimensions');
                        }
                        return true;
                    });
                }
                return new Promise((resolve, reject) => {
                    image.addEventListener('load', () => resolve(true), {once: true});
                    image.addEventListener('error', () => reject(new Error('Printable page image failed to load')), {once: true});
                });
            };
            return Promise.race([
                Promise.all(Array.from(document.images).map(waitForImage)).then(() => true),
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Timed out loading printable page images')), timeoutMs);
                }),
            ]);
        })()
    `, true);
}

async function createRasterPrintHtmlPath(path: string, documentTitle: string, signal?: AbortSignal) {
    const workDir = await mkdtemp(join(tmpdir(), 'evb-print-raster-'));
    try {
        throwIfPrintHandoffAborted(signal);
        const layout = await readPdfPrintLayout(path, signal);
        if (layout.pageCount > PRINT_RASTER_MAX_PAGES) {
            await rm(workDir, {
                force: true,
                recursive: true,
            });
            return null;
        }
        let totalPixels = 0;
        for (const pageSize of layout.pageSizes) {
            const pagePixels = Math.ceil(pageSize.width * PRINT_RASTER_DPI / 72)
                * Math.ceil(pageSize.height * PRINT_RASTER_DPI / 72);
            if (!Number.isSafeInteger(pagePixels) || pagePixels <= 0 || totalPixels > PRINT_RASTER_MAX_TOTAL_PIXELS - pagePixels) {
                await rm(workDir, {
                    force: true,
                    recursive: true,
                });
                return null;
            }
            totalPixels += pagePixels;
        }
        throwIfPrintHandoffAborted(signal);
        const imagePages = await renderPdfPrintImages(path, layout, workDir, signal);
        throwIfPrintHandoffAborted(signal);
        const htmlPath = join(workDir, 'print.html');
        await writeFile(htmlPath, buildRasterPrintHtml(documentTitle, layout, imagePages), 'utf8');
        return {
            htmlPath,
            workDir,
        };
    } catch (error) {
        await rm(workDir, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
        throw error;
    }
}

function throwIfPrintHandoffAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        const error = new Error('Print handoff canceled');
        error.name = 'AbortError';
        throw error;
    }
}

function isPrintHandoffAbort(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

function lockPrintWindowTitle(printWindow: BrowserWindow, documentTitle: string) {
    printWindow.setTitle(documentTitle);
    const handlePageTitleUpdated = (event: Electron.Event) => {
        event.preventDefault();
        printWindow.setTitle(documentTitle);
    };
    printWindow.webContents.on('page-title-updated', handlePageTitleUpdated);

    return () => {
        printWindow.webContents.removeListener('page-title-updated', handlePageTitleUpdated);
    };
}

export function isCapturedPrintSurfaceBitmap(bitmap: Buffer, width: number, height: number) {
    const pixelCount = width * height;
    return Number.isSafeInteger(pixelCount) && pixelCount > 0 && bitmap.byteLength >= pixelCount * 4;
}

function waitForPrintHandoffDelay(delayMs: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(finish, delayMs);
        const handleAbort = () => finish(true);
        function finish(aborted = false) {
            clearTimeout(timer);
            signal?.removeEventListener('abort', handleAbort);
            if (aborted) {
                const error = new Error('Print handoff canceled');
                error.name = 'AbortError';
                reject(error);
                return;
            }
            resolve();
        }
        signal?.addEventListener('abort', handleAbort, {once: true});
        if (signal?.aborted) {
            handleAbort();
        }
    });
}

async function waitForPrintSurfacePainted(printWindow: BrowserWindow, signal?: AbortSignal) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < PRINT_SURFACE_READY_TIMEOUT_MS) {
        throwIfPrintHandoffAborted(signal);
        try {
            const image = await printWindow.webContents.capturePage({
                x: Math.max(0, Math.floor((PRINT_WINDOW_WIDTH_PX - PRINT_SURFACE_PROBE_SIZE_PX) / 2)),
                y: Math.max(0, Math.floor((PRINT_WINDOW_HEIGHT_PX - PRINT_SURFACE_PROBE_SIZE_PX) / 2)),
                width: PRINT_SURFACE_PROBE_SIZE_PX,
                height: PRINT_SURFACE_PROBE_SIZE_PX,
            }, {stayHidden: true});
            const size = image.getSize();
            if (isCapturedPrintSurfaceBitmap(image.toBitmap(), size.width, size.height)) {
                return true;
            }
        } catch (error) {
            logger.debug(`Print surface paint probe failed: ${getErrorMessage(error)}`);
        }
        await waitForPrintHandoffDelay(PRINT_SURFACE_PROBE_INTERVAL_MS, signal);
    }
    return false;
}

function revealPrintWindowForNativeDialog(printWindow: BrowserWindow, painted: boolean) {
    if (getPrintRuntimePlatform() !== 'darwin' || shouldRunPrintToPdfSmoke()) {
        return;
    }

    if (!painted) {
        logger.warn(`Print surface did not paint within ${PRINT_SURFACE_READY_TIMEOUT_MS}ms; opening the native dialog with the visible fallback`);
    }
    // Chromium needs a compositor-visible PDF plugin window on macOS, but the
    // native print sheet does not need its dark backing surface to be visible.
    printWindow.setOpacity(0);
    printWindow.showInactive();
}

function observePrintWindowReady(printWindow: BrowserWindow) {
    const handleReady = () => {
        logger.debug('Print handoff phase: ready-to-show');
    };
    printWindow.once('ready-to-show', handleReady);
    return () => {
        printWindow.removeListener('ready-to-show', handleReady);
    };
}

function waitForPdfPluginReadyToPrint(printWindow: BrowserWindow, signal?: AbortSignal): IPdfPluginReadyWait {
    // `ready-to-show` and `did-finish-load` can precede the PDF plugin's
    // removal of its print restriction. Electron exposes that transition as
    // this internal event for its own PDF printing test, and printing before
    // it fires can produce a structurally valid but empty PDF.
    const webContents = printWindow.webContents as IPrintWebContentsPrivateEvents;
    let armTimeout = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        let stopSenderLifetime: () => void = () => undefined;
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
            }
            webContents.removeListener('-pdf-ready-to-print', handleReady);
            stopSenderLifetime();
            printWindow.removeListener('closed', handleClosed);
            signal?.removeEventListener('abort', handleAbort);
        };
        const finish = (error?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (error) {
                reject(error);
                return;
            }
            resolve();
        };
        const handleReady = () => {
            logger.debug('Print handoff phase: pdf-ready-to-print');
            finish();
        };
        const handleClosed = () => {
            logger.debug('Print handoff phase: closed-before-pdf-ready');
            finish(new Error('Print window closed before the PDF viewer became ready'));
        };
        const handleAbort = () => {
            const error = new Error('Print handoff canceled');
            error.name = 'AbortError';
            finish(error);
        };

        armTimeout = () => {
            if (settled || timeout) {
                return;
            }
            logger.debug('Print handoff phase: pdf-readiness-timeout-armed');
            timeout = setTimeout(() => {
                logger.debug('Print handoff phase: pdf-readiness-timeout');
                finish(new Error(`PDF viewer did not become ready to print within ${PRINT_PDF_READY_TIMEOUT_MS}ms`));
            }, PRINT_PDF_READY_TIMEOUT_MS);
            timeout.unref();
        };

        webContents.once('-pdf-ready-to-print', handleReady);
        stopSenderLifetime = onSenderLifetimeEnd(printWindow.webContents, (end) => {
            if (end === 'destroyed') {
                logger.debug('Print handoff phase: destroyed-before-pdf-ready');
                finish(new Error('Print web contents destroyed before the PDF viewer became ready'));
            } else if (end === 'render-process-gone') {
                logger.debug('Print handoff phase: renderer-gone-before-pdf-ready');
                finish(new Error('Print renderer exited before the PDF viewer became ready'));
            }
        });
        printWindow.once('closed', handleClosed);
        signal?.addEventListener('abort', handleAbort, {once: true});
        if (signal?.aborted) {
            handleAbort();
        }
    });
    return {
        promise,
        armTimeout,
    };
}

function hideRevealedPrintWindow(printWindow: BrowserWindow) {
    if (getPrintRuntimePlatform() === 'darwin' && !printWindow.isDestroyed()) {
        printWindow.hide();
        printWindow.setOpacity(1);
    }
}

function closePrintWindow(printWindow: BrowserWindow) {
    if (!printWindow.isDestroyed()) {
        printWindow.close();
    }
}

function schedulePrintWindowClose(printWindow: BrowserWindow, delayMs = PRINT_JOB_RESOURCE_RETENTION_MS) {
    const timer = setTimeout(() => {
        closePrintWindow(printWindow);
    }, delayMs);
    timer.unref();
}

function shouldRunPrintToPdfSmoke() {
    return process.env[PRINT_DIALOG_TEST_MODE_ENV]?.trim() === PRINT_DIALOG_TEST_MODE_PRINT_TO_PDF;
}

async function runPrintToPdfSmoke(printWindow: BrowserWindow): Promise<IPrintPdfResult> {
    try {
        const data = await printWindow.webContents.printToPDF({printBackground: true});
        validatePdfBytesForHandoff(data, 'print smoke');
        const outputPath = process.env[PRINT_DIALOG_TEST_OUTPUT_PATH_ENV]?.trim();
        if (outputPath) {
            await writeFile(outputPath, data);
        }
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: getErrorMessage(error),
        };
    }
}

async function runPrintPathSmoke(path: string): Promise<IPrintPdfResult> {
    try {
        await assertPdfPathWithinSizeLimit(path);
        const outputPath = process.env[PRINT_DIALOG_TEST_OUTPUT_PATH_ENV]?.trim();
        if (outputPath) {
            await copyFile(path, outputPath);
        }
        return {success: true};
    } catch (error) {
        return {
            success: false,
            error: getErrorMessage(error),
        };
    }
}

function runNativePrintDialog(
    printWindow: BrowserWindow,
    printOptions: WebContentsPrintOptions = {},
    onNativeDialogOpened?: () => void,
): Promise<IPrintPdfResult> {
    if (shouldRunPrintToPdfSmoke()) {
        return runPrintToPdfSmoke(printWindow);
    }

    return new Promise((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
            finish({
                success: false,
                error: `Print dialog timed out after ${PRINT_DIALOG_TIMEOUT_MS}ms`,
            });
        }, PRINT_DIALOG_TIMEOUT_MS);
        timeout.unref();

        const handleClosed = () => {
            finish({
                success: false,
                error: 'Print window closed before the native dialog completed',
            });
        };
        const handleRendererGone = () => {
            finish({
                success: false,
                error: 'Print renderer exited before the native dialog completed',
            });
        };
        const cleanup = () => {
            clearTimeout(timeout);
            printWindow.removeListener('closed', handleClosed);
            printWindow.webContents.removeListener('render-process-gone', handleRendererGone);
            printWindow.webContents.removeListener('destroyed', handleClosed);
        };
        function finish(result: IPrintPdfResult) {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(result);
        }

        printWindow.once('closed', handleClosed);
        printWindow.webContents.once('render-process-gone', handleRendererGone);
        printWindow.webContents.once('destroyed', handleClosed);

        try {
            printWindow.webContents.print(
                {
                    silent: false,
                    printBackground: true,
                    margins: { marginType: 'printableArea' },
                    ...printOptions,
                },
                (success, failureReason) => {
                    if (success) {
                        finish({ success: true });
                        return;
                    }

                    const normalizedReason = failureReason.trim();
                    if (normalizedReason.toLowerCase().includes('cancel')) {
                        finish({
                            success: false,
                            canceled: true,
                            ...(normalizedReason ? { error: normalizedReason } : {}),
                        });
                        return;
                    }

                    finish({
                        success: false,
                        error: normalizedReason || 'Print failed',
                    });
                },
            );
            try {
                onNativeDialogOpened?.();
            } catch (error) {
                logger.warn(`Failed to report native print dialog handoff: ${getErrorMessage(error)}`);
            }
        } catch (error) {
            finish({
                success: false,
                error: getErrorMessage(error),
            });
        }
    });
}

export async function openNativePrintDialogForPath(
    ownerWindow: BrowserWindow | undefined,
    path: string,
    printOptions: WebContentsPrintOptions = {},
    fileName?: string,
    handoffOptions: IPrintHandoffOptions = {},
): Promise<IPrintPdfResult> {
    if (shouldRunPrintToPdfSmoke()) {
        return runPrintPathSmoke(path);
    }
    if (getPrintRuntimePlatform() === 'darwin' && handoffOptions.surface !== 'rasterized-html') {
        try {
            return await openMacOsPdfPrintDialog(path, handoffOptions);
        } catch (error) {
            if (isPrintHandoffAbort(error) || handoffOptions.signal?.aborted) {
                return {
                    success: false,
                    canceled: true,
                    error: 'Print handoff canceled',
                };
            }
            logger.warn(`Failed to open macOS PDF print dialog: ${getErrorMessage(error)}`);
            return {
                success: false,
                error: getErrorMessage(error),
            };
        }
    }
    const documentTitle = resolvePrintDocumentTitle(path, fileName);
    const shouldUseRasterSurface = handoffOptions.surface === 'rasterized-html';
    let rasterSurface: Awaited<ReturnType<typeof createRasterPrintHtmlPath>> | null = null;
    const printWindow = createPrintWindow(ownerWindow, documentTitle);
    const releasePrintWindowTitle = lockPrintWindowTitle(printWindow, documentTitle);
    const printWindowLifecycleAbortController = new AbortController();
    const printWindowSignal = handoffOptions.signal
        ? AbortSignal.any([
            handoffOptions.signal,
            printWindowLifecycleAbortController.signal,
        ])
        : printWindowLifecycleAbortController.signal;
    const releasePrintWindowReadyObserver = !shouldUseRasterSurface
        ? observePrintWindowReady(printWindow)
        : null;
    const pdfPluginReady = !shouldUseRasterSurface
        ? waitForPdfPluginReadyToPrint(printWindow, printWindowSignal)
        : null;
    if (pdfPluginReady) {
        void pdfPluginReady.promise.catch(() => undefined);
    }
    let shouldRetainPrintWindow = false;
    let closedForAbort = false as boolean;
    const closeForAbort = () => {
        closedForAbort = true;
        closePrintWindow(printWindow);
    };
    handoffOptions.signal?.addEventListener('abort', closeForAbort, { once: true });

    try {
        throwIfPrintHandoffAborted(handoffOptions.signal);
        rasterSurface = shouldUseRasterSurface
            ? await createRasterPrintHtmlPath(path, documentTitle, handoffOptions.signal)
            : null;
        throwIfPrintHandoffAborted(handoffOptions.signal);
        logger.debug('Print handoff phase: load-start');
        await printWindow.loadURL(rasterSurface ? pathToFileURL(rasterSurface.htmlPath).toString() : pathToFileURL(path).toString());
        logger.debug('Print handoff phase: load-resolved');
        pdfPluginReady?.armTimeout();
        throwIfPrintHandoffAborted(handoffOptions.signal);
        if (rasterSurface) {
            await waitForRasterPrintSurfaceReady(printWindow);
        } else if (pdfPluginReady) {
            await pdfPluginReady.promise;
        }
        throwIfPrintHandoffAborted(handoffOptions.signal);
        const printSurfacePainted = rasterSurface || shouldRunPrintToPdfSmoke() || getPrintRuntimePlatform() !== 'darwin'
            ? false
            : await waitForPrintSurfacePainted(printWindow, handoffOptions.signal);
        await waitForPrintHandoffDelay(PRINT_LOAD_SETTLE_DELAY_MS, handoffOptions.signal);
        throwIfPrintHandoffAborted(handoffOptions.signal);
        if (!rasterSurface) {
            revealPrintWindowForNativeDialog(printWindow, printSurfacePainted);
        }
        logger.debug('Print handoff phase: native-print-dispatch');
        const result = await runNativePrintDialog(
            printWindow,
            printOptions,
            handoffOptions.onNativeDialogOpened,
        );
        if (handoffOptions.signal?.aborted) {
            return {
                success: false,
                canceled: true,
                error: 'Print handoff canceled',
            };
        }
        if (result.success) {
            shouldRetainPrintWindow = true;
            if (!rasterSurface) {
                hideRevealedPrintWindow(printWindow);
            }
            schedulePrintWindowClose(printWindow);
        }
        return result;
    } catch (error) {
        if (isPrintHandoffAbort(error) || handoffOptions.signal?.aborted) {
            return {
                success: false,
                canceled: true,
                error: 'Print handoff canceled',
            };
        }
        logger.warn(`Failed to open native print dialog: ${getErrorMessage(error)}`);
        return {
            success: false,
            error: error instanceof Error ? getErrorMessage(error) : 'Failed to open native print dialog',
        };
    } finally {
        printWindowLifecycleAbortController.abort();
        handoffOptions.signal?.removeEventListener('abort', closeForAbort);
        releasePrintWindowReadyObserver?.();
        releasePrintWindowTitle();
        if (!shouldRetainPrintWindow && !closedForAbort) {
            closePrintWindow(printWindow);
        }
        if (rasterSurface) {
            scheduleRasterSurfaceCleanup(rasterSurface.workDir);
        }
    }
}

export async function printManagedTempPdfPath(
    context: IPrintWindowContext,
    filePath: string,
    fileName?: string,
    handoffOptions: IPrintHandoffOptions = {},
): Promise<IPrintPdfResult> {
    const ownerWindow = context.window ?? undefined;
    let shouldRetainTempPdf = false;
    try {
        await assertPdfPathWithinSizeLimit(filePath);
        const result = await openNativePrintDialogForPath(ownerWindow, filePath, {}, fileName, handoffOptions);
        if (result.success) {
            shouldRetainTempPdf = true;
            schedulePrintTempCleanup(filePath);
        }
        return result;
    } finally {
        if (!shouldRetainTempPdf) {
            await cleanupPrintTempPath(filePath);
        }
    }
}

function scheduleRasterSurfaceCleanup(path: string, delayMs = PRINT_JOB_RESOURCE_RETENTION_MS) {
    const timer = setTimeout(() => {
        void rm(path, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
    }, delayMs);
    timer.unref();
}
