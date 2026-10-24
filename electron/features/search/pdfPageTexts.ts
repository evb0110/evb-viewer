import {stat} from 'node:fs/promises';
import { dirname } from 'path';
import { range } from 'es-toolkit/math';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { getPdfPageCount } from '@electron/pdf/pdfPageCount';
import { normalizeExtractedPageText } from '@pdf-core/pdfSearchAlgorithms';
import { fileURLToPath } from 'url';
import { groupContiguousPages } from '@electron/pdf/pdfTextPageBatching';
import {
    inspectPdfPageTextVisibility,
    type TOcrPdfTextVisibilityAnalysis,
} from '@electron/pdf/inspectPdfPageTextVisibility';
import { resolveNativePageOpsPath } from '@electron/features/page-ops/public/nativePageOpsPath';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { createLogger } from '@electron/utils/createLogger';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { streamItems } from '@electron/features/search/streamItems';
import type { IPageText } from '@electron/features/search/pageText';
import { readOcrLayerLayout } from '@ocr-core/readOcrLayerLayout';
import type { IPdfPageRange } from '@electron/features/search/pdfjsPageTexts';
import * as v from 'valibot';

const PDF_TEXT_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['pdf-text'].fileName;
const POPPLER_TEXT_PAGE_WINDOW_SIZE = 256;
// One native visibility load inspects the pages of this many windows. Loading
// a large scan takes most of a second and up to twice its size in memory, and
// the report of 2,048 densely recognized pages stays within its byte limit.
const VISIBILITY_WINDOWS_PER_LOAD = 8;
const log = createLogger('search-page-text');

const PDF_TEXT_WORKER_PAGE_MESSAGE_SCHEMA = v.object({
    type: v.literal('page'),
    page: v.object({
        pageNumber: v.number(),
        text: v.string(),
    }),
});

// pdftotext wraps independently positioned right-to-left spans in bidi
// embedding and isolate controls. They are layout hints, never searchable text,
// and they split OCR words so queries and indexing miss them.

// Poppler reads predefined CJK CMaps only from its compile-time data
// directory, which the macOS runtime bundle lacks. It reports that per font.
const MISSING_POPPLER_DATA = /Missing language pack/u;

type TStreamPdfPageTextsOptions = IPdfPageRange & {
    signal?: AbortSignal | undefined;
    /** Leaves out text a page's CropBox hides, as the viewer does. */
    visiblePageOnly?: boolean;
};

/** A page area for pdftotext, in points from the top left of the rotated MediaBox. */
interface IPopplerTextArea {
    x: number;
    y: number;
    width: number;
    height: number;
}

const PDFINFO_PAGE_BOX = /^Page\s+(\d+)\s+(MediaBox|CropBox):\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/gmu;
const PDFINFO_PAGE_ROTATION = /^Page\s+(\d+)\s+rot:\s+(-?\d+)\s*$/gmu;

function popplerTextArea(media: number[], crop: number[], rotation: number): IPopplerTextArea {
    const [
        mx0 = 0,
        my0 = 0,
        mx1 = 0,
        my1 = 0,
    ] = media;
    const [
        x0 = 0,
        y0 = 0,
        x1 = 0,
        y1 = 0,
    ] = crop;
    const [
        x,
        y,
        width,
        height,
    ] = rotation === 90 ? [
        y0 - my0,
        x0 - mx0,
        y1 - y0,
        x1 - x0,
    ]
        : rotation === 180 ? [
            mx1 - x1,
            y0 - my0,
            x1 - x0,
            y1 - y0,
        ]
            : rotation === 270 ? [
                my1 - y1,
                mx1 - x1,
                y1 - y0,
                x1 - x0,
            ]
                : [
                    x0 - mx0,
                    my1 - y1,
                    x1 - x0,
                    y1 - y0,
                ];
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
    };
}

/**
 * The visible area of every page in the window whose CropBox hides part of
 * its MediaBox. pdftotext reads a whole MediaBox and ignores the CropBox, so
 * its text would include words the viewer never shows. pdfinfo reports the
 * CropBox already clipped to the MediaBox, inherited ones included.
 */
async function readCroppedPageAreas(pdfPath: string, window: Required<IPdfPageRange>, signal?: AbortSignal) {
    const paths = getPdfNativeToolPaths();
    const env = buildPopplerEnv(paths);
    const result = await runNativeToolCommand(paths.pdfinfo, [
        '-box',
        '-f',
        String(window.firstPage),
        '-l',
        String(window.lastPage),
        pdfPath,
    ], {
        ...(env === undefined ? {} : {env}),
        ...(signal === undefined ? {} : {signal}),
        commandLabel: 'pdfinfo(page boxes)',
        maxStdoutBytes: 4 * 1024 * 1024,
    });
    const mediaBoxes = new Map<number, number[]>();
    const cropBoxes = new Map<number, number[]>();
    for (const [
        , page,
        box,
        ...values
    ] of result.stdout.matchAll(PDFINFO_PAGE_BOX)) {
        (box === 'CropBox' ? cropBoxes : mediaBoxes).set(Number(page), values.map(value => Number(value.replace(',', '.'))));
    }
    const areas = new Map<number, IPopplerTextArea>();
    for (const [
        , page,
        rotation,
    ] of result.stdout.matchAll(PDFINFO_PAGE_ROTATION)) {
        const media = mediaBoxes.get(Number(page));
        const crop = cropBoxes.get(Number(page));
        if (media && crop && crop.some((value, index) => Math.abs(value - (media[index] ?? value)) >= 0.5)) {
            areas.set(Number(page), popplerTextArea(media, crop, ((Number(rotation) % 360) + 360) % 360));
        }
    }
    return areas;
}

/**
 * Reads the requested pages with one pdftotext process. Returns null when
 * Poppler could not map a font for lack of its CJK data, so the text is
 * incomplete. pdftotext ends every page, empty or not, with a form feed.
 * `contentOrder` reads with `-raw`, in content stream order.
 */
async function readPopplerPageTexts(
    pdfPath: string,
    range: IPdfPageRange,
    signal?: AbortSignal,
    contentOrder = false,
    area?: IPopplerTextArea,
) {
    const paths = getPdfNativeToolPaths();
    const env = buildPopplerEnv(paths);
    const pages: IPageText[] = [];
    let pageNumber = (range.firstPage ?? 1) - 1;
    let pending = '';
    const result = await runNativeToolCommand(paths.pdftotext, [
        ...(contentOrder ? ['-raw'] : []),
        ...(area === undefined ? [] : [
            '-x',
            String(area.x),
            '-y',
            String(area.y),
            '-W',
            String(area.width),
            '-H',
            String(area.height),
        ]),
        ...(range.firstPage === undefined ? [] : [
            '-f',
            String(range.firstPage),
        ]),
        ...(range.lastPage === undefined ? [] : [
            '-l',
            String(range.lastPage),
        ]),
        pdfPath,
        '-',
    ], {
        ...(env === undefined ? {} : {env}),
        ...(signal === undefined ? {} : {signal}),
        commandLabel: 'pdftotext(page text)',
        maxStdoutBytes: 64 * 1024,
        rejectOnStdoutTruncation: false,
        onStdout(chunk) {
            pending += chunk;
            for (let end = pending.indexOf('\f'); end >= 0; end = pending.indexOf('\f')) {
                pageNumber += 1;
                pages.push({
                    pageNumber,
                    text: normalizeExtractedPageText(pending.slice(0, end)),
                });
                pending = pending.slice(end + 1);
            }
        },
    });
    return MISSING_POPPLER_DATA.test(result.stderr) ? null : pages;
}

/** Reads a range with one pdftotext per run of pages that share a visible area. */
async function readVisiblePopplerPageTexts(
    pdfPath: string,
    range: Required<IPdfPageRange>,
    areas: ReadonlyMap<number, IPopplerTextArea>,
    signal?: AbortSignal,
    contentOrder = false,
) {
    if (areas.size === 0) return readPopplerPageTexts(pdfPath, range, signal, contentOrder);
    const areaKey = (pageNumber: number) => JSON.stringify(areas.get(pageNumber) ?? null);
    const pages: IPageText[] = [];
    for (let firstPage = range.firstPage; firstPage <= range.lastPage;) {
        let lastPage = firstPage;
        while (lastPage < range.lastPage && areaKey(lastPage + 1) === areaKey(firstPage)) lastPage += 1;
        const run = await readPopplerPageTexts(pdfPath, {
            firstPage,
            lastPage,
        }, signal, contentOrder, areas.get(firstPage));
        if (run === null) return null;
        pages.push(...run);
        if (run.length < lastPage - firstPage + 1) break;
        firstPage = lastPage + 1;
    }
    return pages;
}

/**
 * Streams the requested pages with PDF.js in a worker thread. Its bundled
 * CMaps and standard fonts read non-embedded fonts the same on every platform,
 * but it converts every embedded font, so it is many times slower than
 * pdftotext on OCR layers that embed a font per page.
 */
function streamPdfjsPageTexts(pdfPath: string, range: IPdfPageRange, signal?: AbortSignal) {
    return streamItems<IPageText>((emit, workerSignal) => runResultWorkerTask({
        workerPath: resolveUnpackedWorkerPath(dirname(fileURLToPath(import.meta.url)), PDF_TEXT_WORKER_FILENAME),
        workerData: {
            pdfPath,
            firstPage: range.firstPage,
            lastPage: range.lastPage,
        },
        invalidPayloadMessage: 'PDF text worker returned an invalid payload',
        createWorkerExitError: code => new Error(`PDF text worker exited with code ${code}`),
        onProgressMessage(message) {
            const parsed = v.safeParse(PDF_TEXT_WORKER_PAGE_MESSAGE_SCHEMA, message);
            if (parsed.success) {
                emit(parsed.output.page);
            }
            return parsed.success;
        },
        signal: workerSignal,
    }), signal);
}

function resolvePageOpsBinary() {
    try {
        return resolveNativePageOpsPath() ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * The window's pages whose only text is EVB's own OCR layer, read from the
 * lines its writer decoded, in the order the recognizer wrote them: column by
 * column, one recognized line per line. On a skewed scan each OCR line has a
 * rotated baseline that Poppler's layout analysis breaks into short, often
 * reversed fragments, so these pages need no pdftotext at all. Decoded lines
 * carry no glyph positions to clip, so a cropped page is left to Poppler.
 */
function readDecodedOcrLayers(
    window: Required<IPdfPageRange>,
    inspection: TOcrPdfTextVisibilityAnalysis,
    areas: ReadonlyMap<number, IPopplerTextArea>,
) {
    const pages = new Map<number, IPageText>();
    for (const pageNumber of range(window.firstPage, window.lastPage + 1)) {
        const page = inspection.visibility.get(pageNumber);
        if (page?.evbOcrLayer && page.evbOcrLines !== null && !page.paintedText && !areas.has(pageNumber)) {
            pages.set(pageNumber, {
                pageNumber,
                text: normalizeExtractedPageText(page.evbOcrLines.map(line => line.text).join('\n')),
                layout: readOcrLayerLayout(page.evbOcrLines),
            });
        }
    }
    return pages;
}

/**
 * Rereads the pages whose only text is another tool's invisible OCR layer, or
 * EVB's on a cropped page, with `-raw` in recognition order. Painted text keeps
 * the layout order: some producers omit word spaces and leave them to the gaps
 * the analysis measures.
 */
async function readOcrLayersInRecognitionOrder(
    pdfPath: string,
    pages: IPageText[],
    inspection: TOcrPdfTextVisibilityAnalysis,
    areas: ReadonlyMap<number, IPopplerTextArea>,
    signal?: AbortSignal,
) {
    const foreignLayerPages = pages.filter((page) => {
        const visibility = inspection.visibility.get(page.pageNumber);
        return page.text.length > 0 && visibility !== undefined && !visibility.paintedText
            && (visibility.evbOcrLayer || visibility.hiddenText);
    }).map(page => page.pageNumber);
    const ocrLayerTexts = new Map<number, IPageText>();
    for (const range of groupContiguousPages(foreignLayerPages)) {
        for (const page of await readVisiblePopplerPageTexts(pdfPath, range, areas, signal, true) ?? []) {
            ocrLayerTexts.set(page.pageNumber, page);
        }
    }
    return pages.map(page => ocrLayerTexts.get(page.pageNumber) ?? page);
}

/**
 * Reads the window's pages that have no decoded OCR layer with pdftotext, one
 * run per contiguous range. Null when Poppler lacked CJK data for any of them.
 * Stops at the first run that ends early, as the document does.
 */
async function readRemainingPopplerPageTexts(
    pdfPath: string,
    window: Required<IPdfPageRange>,
    decoded: ReadonlyMap<number, IPageText>,
    areas: ReadonlyMap<number, IPopplerTextArea>,
    signal?: AbortSignal,
) {
    const pages: IPageText[] = [];
    for (const run of groupContiguousPages(range(window.firstPage, window.lastPage + 1).filter(page => !decoded.has(page)))) {
        const runPages = await readVisiblePopplerPageTexts(pdfPath, run, areas, signal);
        if (runPages === null) return null;
        pages.push(...runPages);
        if (runPages.length < run.lastPage - run.firstPage + 1) {
            return {
                pages,
                endPage: (runPages.at(-1)?.pageNumber ?? run.firstPage - 1),
            };
        }
    }
    return {
        pages,
        endPage: window.lastPage,
    };
}

/**
 * Streams the PDF text layer page by page, in reading order. pdftotext reads
 * it in windows whose pages wait until it finishes, since only then does it
 * say whether Poppler lacked CJK data for any of them; such a window is
 * streamed with PDF.js instead. Poppler stops adding small glyphs to a page
 * after 50,000, so a window holds a few megabytes of real text.
 */
export function streamPdfPageTexts(
    pdfPath: string,
    options: TStreamPdfPageTextsOptions = {},
    onProgress?: (pageNumber: number) => void,
): AsyncGenerator<IPageText> {
    const {
        signal,
        visiblePageOnly = false,
        ...range
    } = options;
    return streamPdfPageTextRanges(pdfPath, [range], signal, onProgress, visiblePageOnly);
}

async function* streamPdfPageTextRanges(
    pdfPath: string,
    ranges: Iterable<IPdfPageRange>,
    signal?: AbortSignal,
    onProgress?: (pageNumber: number) => void,
    visiblePageOnly = false,
): AsyncGenerator<IPageText> {
    signal?.throwIfAborted();
    const source = await stat(pdfPath, {bigint: true});
    const assertSource = async () => {
        const current = await stat(pdfPath, {bigint: true});
        if (current.dev !== source.dev || current.ino !== source.ino || current.size !== source.size
            || current.mtimeNs !== source.mtimeNs || current.ctimeNs !== source.ctimeNs) {
            throw new Error('PDF source changed during text extraction');
        }
    };
    const windows: Array<Required<IPdfPageRange>> = [];
    for (const pageRange of ranges) {
        const lastPage = pageRange.lastPage ?? await getPdfPageCount(pdfPath, signal === undefined ? {} : {signal});
        for (const firstPage of range(pageRange.firstPage ?? 1, lastPage + 1, POPPLER_TEXT_PAGE_WINDOW_SIZE)) {
            windows.push({
                firstPage,
                lastPage: Math.min(firstPage + POPPLER_TEXT_PAGE_WINDOW_SIZE - 1, lastPage),
            });
        }
    }
    let inspection: TOcrPdfTextVisibilityAnalysis = {
        status: 'available',
        visibility: new Map(),
    };
    let inspectedWindows = 0;
    for (const [
        index,
        window,
    ] of windows.entries()) {
        signal?.throwIfAborted();
        await assertSource();
        // Starting a window reports its first page, so progress moves while
        // the visibility pass reads a group of windows ahead of pdftotext.
        onProgress?.(window.firstPage);
        if (index >= inspectedWindows) {
            // One load inspects every page of this window and the next ones,
            // before pdftotext reads any of them, so pages whose text is EVB's
            // decoded OCR layer skip it. It runs to completion between
            // pdftotext runs: a visibility reader kept open across them held a
            // native command slot while its extraction waited for one, and
            // eight such readers deadlocked extraction.
            inspectedWindows = index + VISIBILITY_WINDOWS_PER_LOAD;
            inspection = await inspectPdfPageTextVisibility({
                pdfPath,
                pageNumbers: windows.slice(index, inspectedWindows).flatMap(later => range(later.firstPage, later.lastPage + 1)),
                pdfPageOpsBinary: resolvePageOpsBinary(),
                qpdfBinary: getPdfNativeToolPaths().qpdf,
                tempDir: getAppTempDir(),
                ...(signal === undefined ? {} : {signal}),
                withEvbOcrText: true,
            });
            if (inspection.status === 'degraded') {
                log.warn(`OCR layers keep the layout reading order: ${inspection.message}`);
                // Each load reads the whole PDF, and a document that cannot be
                // read fails every later load the same way: a 760 MB report
                // spent 44 s on each of its eleven. Its later windows keep the
                // layout reading order without asking again.
                if (inspection.reason !== 'native-tool-failed') inspectedWindows = windows.length;
            }
        }
        const areas = visiblePageOnly ? await readCroppedPageAreas(pdfPath, window, signal) : new Map<number, IPopplerTextArea>();
        const decoded = readDecodedOcrLayers(window, inspection, areas);
        const poppler = await readRemainingPopplerPageTexts(pdfPath, window, decoded, areas, signal);
        if (poppler === null) {
            await assertSource();
            yield* streamPdfjsPageTexts(pdfPath, window, signal);
            continue;
        }
        const orderedPages = await readOcrLayersInRecognitionOrder(pdfPath, poppler.pages, inspection, areas, signal);
        const pages = [
            ...orderedPages,
            ...decoded.values(),
        ]
            .filter(page => page.pageNumber <= poppler.endPage)
            .sort((left, right) => left.pageNumber - right.pageNumber);
        await assertSource();
        for (const page of pages) {
            signal?.throwIfAborted();
            yield page;
        }
        if (poppler.endPage < window.lastPage) {
            return;
        }
    }
}

/** Reads the text of the requested pages, one pass per contiguous range. */
export async function readPdfPageTexts(
    pdfPath: string,
    pageNumbers: readonly number[],
    signal?: AbortSignal,
): Promise<IPageText[]> {
    const texts: IPageText[] = [];
    if (pageNumbers.length === 0) return texts;
    for await (const page of streamPdfPageTextRanges(pdfPath, groupContiguousPages([...pageNumbers]), signal)) {
        texts.push(page);
    }
    return texts;
}
