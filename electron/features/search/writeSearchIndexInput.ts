import { open } from 'node:fs/promises';
import {
    encodeSearchIndexInputLine,
    SEARCH_INDEX_TEXT_BUDGET,
} from '@contracts/searchIndexWire';
import type { IPageText } from '@electron/features/search/pageText';

/**
 * The index input of a page stream, within the index text budget. The first
 * page over it is reported instead of sent and ends the input, which stops
 * extraction there; the index then reports itself truncated at that page.
 */
async function* toIndexInputLines(pages: AsyncIterable<IPageText>) {
    let totalBytes = 0;
    for await (const page of pages) {
        const textBytes = Buffer.byteLength(page.text);
        totalBytes += textBytes;
        if (
            textBytes > SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes
            || totalBytes > SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes
        ) {
            yield {line: encodeSearchIndexInputLine({
                pageNumber: page.pageNumber,
                overBudget: true,
            })};
            return;
        }
        yield {
            page,
            line: encodeSearchIndexInputLine({
                pageNumber: page.pageNumber,
                text: page.text,
            }),
        };
    }
}

/**
 * Writes the index input of a page stream to `inputPath`. The indexer starts
 * once the file is complete and the page stream has ended, so no extraction
 * capacity is held while it runs: an indexer reading extraction as it ran held
 * native-command capacity that its own pdfinfo and pdftotext waited for, so
 * eight concurrent builds stalled until admission timed out.
 *
 * `onPage` follows each page once its line is in the file, with the length of
 * the file's complete lines, so a reader of that prefix sees every page
 * reported before it and none reported after.
 */
export async function writeSearchIndexInput(
    inputPath: string,
    pages: AsyncIterable<IPageText>,
    onPage: (page: IPageText, writtenBytes: number) => void,
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    const file = await open(inputPath, 'w');
    let writtenBytes = 0;
    try {
        for await (const {
            page, line,
        } of toIndexInputLines(pages)) {
            signal.throwIfAborted();
            const bytes = Buffer.from(line);
            for (let offset = 0; offset < bytes.length;) {
                const {bytesWritten} = await file.write(bytes, offset);
                signal.throwIfAborted();
                offset += bytesWritten;
            }
            writtenBytes += bytes.length;
            if (page) onPage(page, writtenBytes);
        }
    } finally {
        await file.close();
    }
}
