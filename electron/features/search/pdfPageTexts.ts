import { dirname } from 'path';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { normalizeSearchablePageText } from '@pdf-core/pdfSearchCore';
import { fileURLToPath } from 'url';
import { groupContiguousPages } from '@electron/pdf/pdfTextPageBatching';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { streamItems } from '@electron/features/search/streamItems';
import type { IPageText } from '@electron/features/search/pageText';
import type { IPdfPageRange } from '@electron/features/search/pdfjsPageTexts';
import * as v from 'valibot';

const PDF_TEXT_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['pdf-text'].fileName;
const POPPLER_TEXT_PAGE_WINDOW_SIZE = 256;

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
const BIDI_FORMATTING_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

// Poppler reads predefined CJK CMaps only from its compile-time data
// directory, which the macOS runtime bundle lacks. It reports that per font.
const MISSING_POPPLER_DATA = /Missing language pack/u;

function normalizePopplerPageText(text: string) {
    return normalizeSearchablePageText(text.replace(BIDI_FORMATTING_CONTROLS, '').trim());
}

type TStreamPdfPageTextsOptions = IPdfPageRange & {signal?: AbortSignal | undefined};

export async function readPdfPageCount(pdfPath: string, signal?: AbortSignal) {
    const paths = getPdfNativeToolPaths();
    const env = buildPopplerEnv(paths);
    const result = await runNativeToolCommand(paths.pdfinfo, [pdfPath], {
        ...(env === undefined ? {} : {env}),
        ...(signal === undefined ? {} : {signal}),
        commandLabel: 'pdfinfo(page count)',
        maxStdoutBytes: 1024 * 1024,
    });
    const pageCount = Number(result.stdout.match(/^Pages:\s*(\d+)\s*$/mu)?.[1]);
    if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
        throw new Error('pdfinfo did not report a valid page count');
    }
    return pageCount;
}

/**
 * Reads the requested pages with one pdftotext process. Returns null when
 * Poppler could not map a font for lack of its CJK data, so the text is
 * incomplete. pdftotext ends every page, empty or not, with a form feed.
 */
async function readPopplerPageTexts(pdfPath: string, range: IPdfPageRange, signal?: AbortSignal) {
    const paths = getPdfNativeToolPaths();
    const env = buildPopplerEnv(paths);
    const pages: IPageText[] = [];
    let pageNumber = (range.firstPage ?? 1) - 1;
    let pending = '';
    const result = await runNativeToolCommand(paths.pdftotext, [
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
                    text: normalizePopplerPageText(pending.slice(0, end)),
                });
                pending = pending.slice(end + 1);
            }
        },
    });
    return MISSING_POPPLER_DATA.test(result.stderr) ? null : pages;
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
): AsyncGenerator<IPageText> {
    const {
        signal,
        ...range
    } = options;
    return (async function* () {
        signal?.throwIfAborted();
        const lastPage = range.lastPage ?? await readPdfPageCount(pdfPath, signal);
        for (
            let firstPage = range.firstPage ?? 1;
            firstPage <= lastPage;
            firstPage += POPPLER_TEXT_PAGE_WINDOW_SIZE
        ) {
            signal?.throwIfAborted();
            const batchRange = {
                firstPage,
                lastPage: Math.min(firstPage + POPPLER_TEXT_PAGE_WINDOW_SIZE - 1, lastPage),
            };
            const pages = await readPopplerPageTexts(pdfPath, batchRange, signal);
            if (pages === null) {
                yield* streamPdfjsPageTexts(pdfPath, batchRange, signal);
                continue;
            }
            yield* pages;
            if (pages.length < batchRange.lastPage - firstPage + 1) {
                return;
            }
        }
    })();
}

/** Reads the text of the requested pages, one pass per contiguous range. */
export async function readPdfPageTexts(
    pdfPath: string,
    pageNumbers: readonly number[],
    signal?: AbortSignal,
): Promise<IPageText[]> {
    const texts: IPageText[] = [];
    for (const range of groupContiguousPages([...pageNumbers])) {
        for await (const page of streamPdfPageTexts(pdfPath, {
            ...range,
            signal,
        })) {
            texts.push(page);
        }
    }
    return texts;
}
