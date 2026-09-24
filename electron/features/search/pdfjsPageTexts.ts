// The legacy build evaluates `new DOMMatrix()` for canvas code that text
// extraction never runs, so the stub must load before PDF.js.
import '@electron/features/search/domPolyfill';
import { existsSync } from 'fs';
import {
    join,
    sep,
} from 'path';
import {
    getDocument,
    VerbosityLevel,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
// PDF.js in Node runs its worker code in the calling thread. Handing it the
// bundled module keeps it from importing a separate pdf.worker.mjs file.
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import type {
    DocumentInitParameters,
    PDFDocumentLoadingTask,
} from 'pdfjs-dist/types/src/display/api';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { assembleSearchablePageText } from '@pdf-core/pdfSearchCore';
import type { IPageText } from '@electron/features/search/pageText';

(globalThis as typeof globalThis & {pdfjsWorker?: unknown}).pdfjsWorker = pdfjsWorker;

const PDFJS_NODE_MAX_INTERMEDIATE_CANVAS_BYTES = 128 * 1024 * 1024;
const PDFJS_RANGE_CHUNK_SIZE = 1024 * 1024;

function getPdfjsAssetRootCandidates() {
    const candidates: string[] = [];
    const resourcesPath = (process as NodeJS.Process & {resourcesPath?: unknown}).resourcesPath;
    if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
        candidates.push(
            join(resourcesPath, 'app.asar', 'nuxt-output', 'public', 'pdf'),
            join(resourcesPath, 'app', 'nuxt-output', 'public', 'pdf'),
        );
    }
    candidates.push(
        join(process.cwd(), 'nuxt-output', 'public', 'pdf'),
        join(process.cwd(), 'public', 'pdf'),
    );
    return candidates;
}

let pdfjsAssetRoot: string | null = null;

function resolvePdfjsAssetRoot() {
    pdfjsAssetRoot ??= getPdfjsAssetRootCandidates().find(candidate => existsSync(join(candidate, 'standard_fonts'))) ?? null;
    if (pdfjsAssetRoot === null) {
        throw new Error(`PDF.js asset root is missing. Checked: ${getPdfjsAssetRootCandidates().join(', ')}`);
    }
    return pdfjsAssetRoot;
}

// PDF.js in Node reads these assets with fs.readFile(`${directory}${name}`),
// and fs does not open a `file://` string, so the value stays a filesystem
// path. PDF.js still requires the trailing '/', which Windows fs also accepts.
function resolvePdfjsAssetDirectory(directoryName: string) {
    const assetDir = join(resolvePdfjsAssetRoot(), directoryName);
    if (!existsSync(assetDir)) {
        throw new Error(`PDF.js asset directory is missing: ${assetDir}`);
    }
    return assetDir.endsWith(sep) ? `${assetDir.slice(0, -1)}/` : `${assetDir}/`;
}

/** Standard fonts and CMaps let PDF.js read text in non-embedded fonts. */
export function createPdfjsNodeDocumentOptions() {
    return {
        verbosity: VerbosityLevel.ERRORS,
        standardFontDataUrl: resolvePdfjsAssetDirectory('standard_fonts'),
        cMapUrl: resolvePdfjsAssetDirectory('cmaps'),
        cMapPacked: true,
        wasmUrl: resolvePdfjsAssetDirectory('wasm'),
        iccUrl: resolvePdfjsAssetDirectory('iccs'),
        useSystemFonts: false,
        useWorkerFetch: false,
        canvasMaxAreaInBytes: PDFJS_NODE_MAX_INTERMEDIATE_CANVAS_BYTES,
    } satisfies Partial<DocumentInitParameters>;
}

interface IPdfjsTextItemForAssembly {
    text: string;
    separatorAfter: 'line' | 'none';
    transform: readonly number[];
    width: number;
    fontName: string;
    isGlyphRun: boolean;
}

function restorePdfjsCombiningMarkOrder(text: string, direction: string) {
    if (direction !== 'rtl') {
        return text;
    }
    return text.replace(/^(\p{M}+)([^\p{M}])/u, '$2$1');
}

function isSingleScalar(text: string) {
    return text.length > 0 && Array.from(text).length === 1 && !/\s/u.test(text);
}

function areAdjacentPdfjsGlyphs(
    previous: IPdfjsTextItemForAssembly,
    current: IPdfjsTextItemForAssembly,
) {
    if (
        previous.separatorAfter === 'line'
        || previous.fontName !== current.fontName
        || !previous.isGlyphRun
        || !current.isGlyphRun
        || !Number.isFinite(previous.width)
        || !Number.isFinite(current.width)
    ) {
        return false;
    }
    const [
        a,
        b,
        , previousVerticalScale,
        previousX,
        previousY,
    ] = previous.transform;
    const currentX = current.transform[4];
    const currentY = current.transform[5];
    if (
        a === undefined
        || b === undefined
        || previousX === undefined
        || previousY === undefined
        || currentX === undefined
        || currentY === undefined
        || previousVerticalScale === undefined
    ) {
        return false;
    }
    const scale = Math.hypot(a, b);
    if (!Number.isFinite(scale) || scale <= Number.EPSILON) {
        return false;
    }
    const expectedX = previousX + a / scale * previous.width;
    const expectedY = previousY + b / scale * previous.width;
    const tolerance = /\p{M}$/u.test(previous.text)
        ? Math.max(0.75, Math.abs(previousVerticalScale) * 0.75)
        : Math.max(0.75, previous.width * 0.2);
    return Math.hypot(currentX - expectedX, currentY - expectedY) <= tolerance;
}

function mergePositionedPdfjsGlyphItems(items: readonly IPdfjsTextItemForAssembly[]) {
    // The repaired RTL layer deliberately creates one PDF.js item per glyph.
    // Rejoin only items whose reported origins prove adjacency, so the search
    // assembler's word separators do not become spaces between glyphs.
    const merged: IPdfjsTextItemForAssembly[] = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item === undefined) {
            continue;
        }
        const previous = merged.at(-1);
        const next = items[index + 1];
        if (
            // PDF.js synthesizes this separator after a zero-width combining
            // mark when it closes a bidi item. The mark stays in the output;
            // only the consumer-generated separator is ignored.
            item.text === ' '
            && previous !== undefined
            && /\p{M}$/u.test(previous.text)
            && next !== undefined
            && isSingleScalar(next.text)
            && item.width <= Math.max(0.75, previous.width * 1.25)
        ) {
            continue;
        }
        if (previous !== undefined && areAdjacentPdfjsGlyphs(previous, item)) {
            previous.text += item.text;
            previous.separatorAfter = item.separatorAfter;
            previous.transform = item.transform;
            previous.width = item.width;
            continue;
        }
        merged.push({...item});
    }
    return merged;
}

export interface IPdfPageRange {
    firstPage?: number;
    lastPage?: number;
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

/**
 * Reads the PDF text layer page by page, in reading order, the way the
 * viewer's text layer sees it. PDF.js reads the file in ranges and each page
 * is released before the next, so memory stays bounded on very large files.
 */
export async function extractPdfjsPageTexts(
    pdfPath: string,
    range: IPdfPageRange,
    onPage: (page: IPageText) => void,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const loadingTask: PDFDocumentLoadingTask = getDocument({
        url: pdfPath,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: PDFJS_RANGE_CHUNK_SIZE,
        ...createPdfjsNodeDocumentOptions(),
    } satisfies DocumentInitParameters);
    try {
        const doc = await loadingTask.promise;
        const lastPage = Math.min(range.lastPage ?? doc.numPages, doc.numPages);
        for (let pageNumber = Math.max(1, range.firstPage ?? 1); pageNumber <= lastPage; pageNumber += 1) {
            throwIfAborted(signal);
            const page = await doc.getPage(pageNumber);
            try {
                const content = await page.getTextContent({
                    includeMarkedContent: true,
                    disableNormalization: true,
                });
                const items: IPdfjsTextItemForAssembly[] = [];
                for (const item of content.items) {
                    if ('str' in item) {
                        items.push({
                            separatorAfter: item.hasEOL ? 'line' : 'none',
                            transform: item.transform,
                            width: item.width,
                            fontName: item.fontName,
                            text: restorePdfjsCombiningMarkOrder(item.str, item.dir),
                            isGlyphRun: isSingleScalar(item.str)
                                || (item.dir === 'rtl' && /^\p{M}+[^\p{M}]$/u.test(item.str)),
                        });
                    }
                }
                onPage({
                    pageNumber,
                    text: assembleSearchablePageText(mergePositionedPdfjsGlyphItems(items)).text,
                });
            } finally {
                page.cleanup();
            }
        }
    } finally {
        await loadingTask.destroy();
    }
}

/** Every page's text, collected in one array; for tests and bounded reads. */
export async function extractTextWithPdfjs(pdfPath: string, range: IPdfPageRange = {}) {
    const pages: IPageText[] = [];
    await extractPdfjsPageTexts(pdfPath, range, page => pages.push(page));
    return pages;
}
