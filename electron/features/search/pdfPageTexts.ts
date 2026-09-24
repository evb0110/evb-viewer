import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { groupContiguousPages } from '@electron/pdf/pdfTextPageBatching';
import { assembleSearchablePageText } from '@pdf-core/pdfSearchCore';
import type { IPageText } from '@electron/features/search/pageText';
import { streamItems } from '@electron/features/search/streamItems';

// pdftotext wraps independently positioned right-to-left spans in bidi
// embedding and isolate controls. They are layout hints, never searchable text,
// and they split OCR words so queries and indexing miss them.
const BIDI_FORMATTING_CONTROLS = /[‎‏‪-‮⁦-⁩]/gu;

function normalizePageText(text: string) {
    return assembleSearchablePageText([{text: text.replace(BIDI_FORMATTING_CONTROLS, '').trim()}]).text;
}

interface IStreamPdfPageTextsOptions {
    firstPage?: number;
    lastPage?: number;
    signal?: AbortSignal | undefined;
}

/**
 * Streams the PDF text layer page by page, in reading order, from one
 * pdftotext process. pdftotext ends every page, empty or not, with a form feed.
 */
export function streamPdfPageTexts(
    pdfPath: string,
    options: IStreamPdfPageTextsOptions = {},
): AsyncGenerator<IPageText> {
    const paths = getPdfNativeToolPaths();
    const env = buildPopplerEnv(paths);
    let pageNumber = (options.firstPage ?? 1) - 1;
    let pending = '';
    return streamItems<IPageText>((emit, signal) => runNativeToolCommand(paths.pdftotext, [
        ...(options.firstPage === undefined ? [] : [
            '-f',
            String(options.firstPage),
        ]),
        ...(options.lastPage === undefined ? [] : [
            '-l',
            String(options.lastPage),
        ]),
        pdfPath,
        '-',
    ], {
        ...(env === undefined ? {} : {env}),
        signal,
        commandLabel: 'pdftotext(page text)',
        maxStdoutBytes: 64 * 1024,
        rejectOnStdoutTruncation: false,
        onStdout(chunk) {
            pending += chunk;
            for (let end = pending.indexOf('\f'); end >= 0; end = pending.indexOf('\f')) {
                pageNumber += 1;
                emit({
                    pageNumber,
                    text: normalizePageText(pending.slice(0, end)),
                });
                pending = pending.slice(end + 1);
            }
        },
    }), options.signal);
}

/** Reads the text of the requested pages, one pdftotext run per contiguous range. */
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
