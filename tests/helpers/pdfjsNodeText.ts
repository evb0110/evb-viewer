/**
 * PDF.js text of a PDF read in Node, the way the renderer's text layer sees it.
 * Tests and the OCR quality corpus compare it with Poppler's text.
 */
import { existsSync } from 'fs';
import { createRequire } from 'module';
import {
    join,
    sep,
} from 'path';
import { pathToFileURL } from 'url';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';
import { assembleSearchablePageText } from '@pdf-core/pdfSearchCore';

async function loadPdfjs() {
    if (typeof globalThis.DOMMatrix === 'undefined') {
        // The legacy build evaluates `new DOMMatrix()` for canvas code that
        // text extraction never runs.
        Object.defineProperty(globalThis, 'DOMMatrix', {
            value: class {
                preMultiplySelf() { return this; }
                multiply() { return this; }
                invertSelf() { return this; }
                inverse() { return this; }
                translate() { return this; }
                scale() { return this; }
            },
            configurable: true,
            writable: true,
        });
    }
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
        createRequire(pathToFileURL(join(process.cwd(), 'package.json'))).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    ).href;
    return pdfjs;
}

interface IPdfjsRuntimeWithVerbosity { VerbosityLevel?: {ERRORS?: number;}; }

const PDFJS_NODE_MAX_INTERMEDIATE_CANVAS_BYTES = 128 * 1024 * 1024;

let pdfjsAssetRoot: string | null = null;

function getPdfjsAssetRootCandidates() {
    return [
        join(process.cwd(), 'nuxt-output', 'public', 'pdf'),
        join(process.cwd(), 'public', 'pdf'),
    ];
}

function resolvePdfjsAssetRoot() {
    if (pdfjsAssetRoot) {
        return pdfjsAssetRoot;
    }

    for (const candidate of getPdfjsAssetRootCandidates()) {
        if (existsSync(join(candidate, 'standard_fonts'))) {
            pdfjsAssetRoot = candidate;
            return pdfjsAssetRoot;
        }
    }

    throw new Error(`PDF.js asset root is missing. Checked: ${getPdfjsAssetRootCandidates().join(', ')}`);
}

// PDF.js in Node reads these assets with fs.readFile(`${directory}${name}`),
// and fs does not open a `file://` string, so the value stays a filesystem
// path. PDF.js still requires the trailing '/', which Windows fs also accepts.
function toPdfjsNodeAssetDirectory(path: string) {
    return path.endsWith('/') || path.endsWith(sep) ? `${path.slice(0, -1)}/` : `${path}/`;
}

function resolvePdfjsAssetDirUrl(directoryName: string) {
    const assetDir = join(resolvePdfjsAssetRoot(), directoryName);
    if (!existsSync(assetDir)) {
        throw new Error(`PDF.js asset directory is missing: ${assetDir}`);
    }
    return toPdfjsNodeAssetDirectory(assetDir);
}

export function createPdfjsNodeDocumentOptions(
    runtime?: IPdfjsRuntimeWithVerbosity,
) {
    return {
        ...(typeof runtime?.VerbosityLevel?.ERRORS === 'number'
            ? {verbosity: runtime.VerbosityLevel.ERRORS}
            : {}),
        standardFontDataUrl: resolvePdfjsAssetDirUrl('standard_fonts'),
        cMapUrl: resolvePdfjsAssetDirUrl('cmaps'),
        cMapPacked: true,
        wasmUrl: resolvePdfjsAssetDirUrl('wasm'),
        iccUrl: resolvePdfjsAssetDirUrl('iccs'),
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
    direction: string;
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
        || previous.transform.length < 6
        || current.transform.length < 6
        || !Number.isFinite(previous.width)
        || !Number.isFinite(current.width)
    ) {
        return false;
    }

    const a = previous.transform[0];
    const b = previous.transform[1];
    const previousX = previous.transform[4];
    const previousY = previous.transform[5];
    const currentX = current.transform[4];
    const currentY = current.transform[5];
    const previousVerticalScale = previous.transform[3];
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
    const directionX = a / scale;
    const directionY = b / scale;
    const expectedX = previousX + directionX * previous.width;
    const expectedY = previousY + directionY * previous.width;
    const markContinuation = /\p{M}$/u.test(previous.text);
    const tolerance = markContinuation
        ? Math.max(0.75, Math.abs(previousVerticalScale) * 0.75)
        : Math.max(0.75, previous.width * 0.2);
    return Math.hypot(
        currentX - expectedX,
        currentY - expectedY,
    ) <= tolerance;
}

function mergePositionedPdfjsGlyphItems(items: readonly IPdfjsTextItemForAssembly[]) {
    // The repaired RTL layer deliberately creates one PDF.js item per glyph.
    // Rejoin only items whose reported origins prove adjacency. This keeps
    // the existing search assembler's word separators from becoming spaces
    // between glyphs, without maintaining another copy of OCR text.
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
            previous.isGlyphRun = true;
            continue;
        }
        merged.push({...item});
    }
    return merged.map(({
        text,
        separatorAfter,
    }) => ({
        text,
        separatorAfter,
    }));
}

export interface IPdfjsPageText {
    pageNumber: number;
    text: string;
}

export async function extractTextWithPdfjs(pdfPath: string): Promise<IPdfjsPageText[]> {
    const {
        getDocument, VerbosityLevel,
    } = await loadPdfjs();
    const typedGetDocument: (options: DocumentInitParameters) => ReturnType<typeof getDocument> = getDocument;
    const loadingTask = typedGetDocument({
        url: pdfPath,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 1024 * 1024,
        ...createPdfjsNodeDocumentOptions({VerbosityLevel}),
    });
    const doc = await loadingTask.promise;
    try {
        const pages: IPdfjsPageText[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
            const page = await doc.getPage(pageNumber);
            try {
                const content = await page.getTextContent({
                    includeMarkedContent: true,
                    disableNormalization: true,
                });
                const textItems: IPdfjsTextItemForAssembly[] = [];
                for (const item of content.items) {
                    if ('str' in item) {
                        textItems.push({
                            separatorAfter: item.hasEOL ? 'line' : 'none',
                            transform: item.transform,
                            width: item.width,
                            fontName: item.fontName,
                            text: restorePdfjsCombiningMarkOrder(item.str, item.dir),
                            isGlyphRun: isSingleScalar(item.str)
                                || (item.dir === 'rtl' && /^\p{M}+[^\p{M}]$/u.test(item.str)),
                            direction: item.dir,
                        });
                    }
                }
                pages.push({
                    pageNumber,
                    text: assembleSearchablePageText(mergePositionedPdfjsGlyphItems(textItems)).text,
                });
            } finally {
                page.cleanup();
            }
        }
        return pages;
    } finally {
        await doc.cleanup();
        await loadingTask.destroy();
    }
}
