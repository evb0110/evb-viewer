import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
async function* toIndexInputLines(pages: AsyncIterable<IPageText>, onPage: (pageNumber: number) => void) {
    let totalBytes = 0;
    for await (const page of pages) {
        const textBytes = Buffer.byteLength(page.text);
        totalBytes += textBytes;
        if (
            textBytes > SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes
            || totalBytes > SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes
        ) {
            yield encodeSearchIndexInputLine({
                pageNumber: page.pageNumber,
                overBudget: true,
            });
            return;
        }
        onPage(page.pageNumber);
        yield encodeSearchIndexInputLine({
            pageNumber: page.pageNumber,
            text: page.text,
        });
    }
}

/**
 * Writes the index input of a page stream to `inputPath`. The indexer starts
 * once the file is complete: an indexer reading extraction as it ran held
 * native-command capacity that its own pdfinfo and pdftotext waited for, so
 * eight concurrent builds stalled until admission timed out.
 */
export async function writeSearchIndexInput(
    inputPath: string,
    pages: AsyncIterable<IPageText>,
    onPage: (pageNumber: number) => void,
    signal: AbortSignal,
) {
    await pipeline(Readable.from(toIndexInputLines(pages, onPage)), createWriteStream(inputPath), {signal});
}
