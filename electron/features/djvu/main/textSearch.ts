import { createHash } from 'node:crypto';
import {
    mkdir,
    stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { IPdfSearchResult } from '@contracts/search';
import type { IOcrWord } from '@contracts/shared';
import type { IDjvuPageTextRaw } from '@djvu-core/djvuLibreTypes';
import { assembleSearchablePageTextItems } from '@pdf-core';
import { runDjvuEngine } from '@electron/features/djvu/main/djvuEnginePool';
import {
    streamItems,
    type IPageText,
    type ISearchIndexedDocument,
} from '@electron/features/search/public';
import { mainJobBroker } from '@electron/resources/jobBroker';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { getAppTempDir } from '@electron/utils/appTempDir';

const DJVU_PAGE_TEXT_TIMEOUT_MS = 30_000;
const DJVU_MAX_PAGE_NUMBER = 2_147_483_647;
const DJVU_TEXT_MAX_PAGE_CHARS = 8 * 1024 * 1024;
const DJVU_SEARCH_MAX_WORDS_PER_MATCH = 256;
const DJVU_PAGE_TEXT_BROKER_RESOURCES = {
    cpuTokens: 1,
    estimatedResidentBytes: 64 * 1024 * 1024,
    nativeProcesses: 0,
    ioWeight: 1,
};

interface IDjvuTextZone {
    lineId: number | null;
    text: string;
    word?: IOcrWord | undefined;
}

interface IDjvuWordSpan {
    startOffset: number;
    endOffset: number;
    word: IOcrWord;
}

interface IDjvuParsedTextPage {
    pageNumber: number;
    width: number;
    height: number;
    text: string;
    zones: IDjvuTextZone[];
    zoneOffsets: Array<{
        startOffset: number;
        endOffset: number;
    }>;
    wordSpans: IDjvuWordSpan[];
}

function buildParsedTextPage(pageNumber: number, raw: IDjvuPageTextRaw): IDjvuParsedTextPage {
    const pageWidth = raw.pageWidth;
    const pageHeight = raw.pageHeight;
    const zones: IDjvuTextZone[] = [];

    for (const zone of raw.zones) {
        if (!zone.text) {
            continue;
        }
        const width = Math.max(0, zone.xmax - zone.xmin);
        const height = Math.max(0, zone.ymax - zone.ymin);
        const hasGeometry = width > 0 && height > 0 && pageHeight > 0;
        zones.push({
            lineId: zone.lineId >= 0 ? zone.lineId : null,
            text: zone.text,
            ...(hasGeometry
                ? {
                    word: {
                        text: zone.text,
                        x: Math.max(0, zone.xmin),
                        y: Math.max(0, pageHeight - zone.ymax),
                        width,
                        height,
                    },
                }
                : {}),
        });
    }

    const searchableItems = zones.map((zone, index) => {
        const nextZone = zones[index + 1];
        return {
            text: zone.text,
            separatorAfter: nextZone
                ? zone.lineId !== null && nextZone.lineId !== zone.lineId
                    ? 'line' as const
                    : 'space' as const
                : 'none' as const,
        };
    });

    if (searchableItems.length === 0 && raw.text.length > 0) {
        const cleaned = raw.text.trimEnd();
        if (cleaned.length > 0) {
            searchableItems.push({
                text: cleaned,
                separatorAfter: 'none',
            });
            zones.push({
                lineId: null,
                text: cleaned,
            });
        }
    }

    const assembled = assembleSearchablePageTextItems(searchableItems);
    if (assembled.text.length > DJVU_TEXT_MAX_PAGE_CHARS) {
        throw new Error(`DjVu page ${pageNumber} text exceeds the supported limit`);
    }

    const zoneOffsets = assembled.itemOffsets.map(offset => ({
        startOffset: offset.startOffset,
        endOffset: offset.endOffset,
    }));
    const wordSpans: IDjvuWordSpan[] = [];
    for (let index = 0; index < zoneOffsets.length; index += 1) {
        const offset = zoneOffsets[index];
        const word = zones[index]?.word;
        if (offset && word && offset.endOffset > offset.startOffset) {
            wordSpans.push({
                startOffset: offset.startOffset,
                endOffset: offset.endOffset,
                word,
            });
        }
    }

    return {
        pageNumber,
        width: pageWidth,
        height: pageHeight,
        text: assembled.text,
        zones,
        zoneOffsets,
        wordSpans,
    };
}

export async function readDjvuPageText(
    filePath: string,
    pageNumber: number,
    signal?: AbortSignal,
): Promise<string> {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > DJVU_MAX_PAGE_NUMBER) {
        return '';
    }
    return mainJobBroker.run({
        ownerId: `djvu-page-text:${filePath}`,
        kind: 'djvu-page-text',
        priority: 'foreground',
        admissionClass: 'interactive',
        resources: DJVU_PAGE_TEXT_BROKER_RESOURCES,
        ...(signal === undefined ? {} : { signal }),
    }, async () => {
        try {
            const raw = await runDjvuEngine({
                type: 'getPageText',
                djvuPath: filePath,
                pageNumber,
                includeZones: true,
            }, {
                ...(signal ? { signal } : {}),
                timeoutMs: DJVU_PAGE_TEXT_TIMEOUT_MS,
            });
            return buildParsedTextPage(pageNumber, raw).text;
        } catch (error) {
            if (!signal?.aborted && error instanceof Error && error.message.includes('out of bounds')) {
                return '';
            }
            throw error;
        }
    });
}

function wordsForPageRange(page: IDjvuParsedTextPage, startOffset: number, endOffset: number) {
    const { wordSpans } = page;
    if (wordSpans.length === 0) {
        return [];
    }
    let low = 0;
    let high = wordSpans.length;
    while (low < high) {
        const middle = low + ((high - low) >>> 1);
        if (wordSpans[middle]!.endOffset <= startOffset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    const words: IOcrWord[] = [];
    for (let index = low; index < wordSpans.length; index += 1) {
        const span = wordSpans[index]!;
        if (span.startOffset >= endOffset) {
            break;
        }
        words.push(span.word);
        if (words.length >= DJVU_SEARCH_MAX_WORDS_PER_MATCH) {
            break;
        }
    }
    return words;
}

/**
 * The DjVu text layer as a search document. DjVu files are read-only sources,
 * so the index lives in app temp, keyed by path, and its revision is the file's
 * size and modification time.
 */
export async function djvuSearchDocument(djvuPath: string): Promise<ISearchIndexedDocument> {
    const source = await stat(djvuPath);
    const directory = join(getAppTempDir(), 'djvu-search');
    await mkdir(directory, { recursive: true });
    return {
        indexPath: join(directory, `${createHash('sha256').update(djvuPath).digest('hex')}.evb-search-index`),
        documentRevision: `djvu:${source.size}:${Math.trunc(source.mtimeMs)}`,
        readPages: signal => streamItems<IPageText>(async (emit, commandSignal) => {
            const docInfo = await runDjvuEngine({
                type: 'getDocInfo',
                djvuPath,
            }, {
                signal: commandSignal,
                timeoutMs: DJVU_PAGE_TEXT_TIMEOUT_MS,
            });
            for (let pageNumber = 1; pageNumber <= docInfo.pageCount; pageNumber += 1) {
                if (commandSignal.aborted) {
                    throw abortErrorFromSignal(commandSignal);
                }
                const raw = await runDjvuEngine({
                    type: 'getPageText',
                    djvuPath,
                    pageNumber,
                    includeZones: true,
                }, {
                    signal: commandSignal,
                    timeoutMs: DJVU_PAGE_TEXT_TIMEOUT_MS,
                });
                const parsed = buildParsedTextPage(pageNumber, raw);
                emit({
                    pageNumber,
                    text: parsed.text,
                });
            }
        }, signal),
    };
}

/** Adds the word boxes of each match from the DjVu text zones of its page. */
export async function addDjvuMatchGeometry(
    djvuPath: string,
    results: readonly IPdfSearchResult[],
    signal?: AbortSignal,
): Promise<IPdfSearchResult[]> {
    const pageNumbers = [...new Set(results.map(result => result.pageNumber))];
    const pages = new Map<number, IDjvuParsedTextPage>();
    for (const pageNumber of pageNumbers) {
        if (signal?.aborted) {
            throw abortErrorFromSignal(signal);
        }
        const raw = await runDjvuEngine({
            type: 'getPageText',
            djvuPath,
            pageNumber,
            includeZones: true,
        }, {
            ...(signal ? { signal } : {}),
            timeoutMs: DJVU_PAGE_TEXT_TIMEOUT_MS,
        });
        pages.set(pageNumber, buildParsedTextPage(pageNumber, raw));
    }
    return results.map((result) => {
        const page = pages.get(result.pageNumber);
        const words = page ? wordsForPageRange(page, result.startOffset, result.endOffset) : [];
        return page && words.length > 0
            ? {
                ...result,
                words,
                pageWidth: page.width,
                pageHeight: page.height,
                rotation: 0 as const,
            }
            : result;
    });
}

export async function detectDjvuHasText(
    filePath: string,
    signal?: AbortSignal,
    _onTerminationProof?: (proof: Promise<boolean>) => void,
) {
    return runDjvuEngine({
        type: 'hasText',
        djvuPath: filePath,
    }, {
        ...(signal ? { signal } : {}),
        timeoutMs: 60_000,
    });
}
