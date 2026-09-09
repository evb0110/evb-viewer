import {
    appendFile,
    mkdir,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { runOcrCommand } from '@electron/features/ocr/worker/runOcrCommand';
import {
    forEachConcurrent,
    getOcrConcurrency,
} from '@electron/utils/concurrency';

const QPDF_TIMEOUT_MS = 10 * 60 * 1000;
const SPLIT_PAGE_FILE_RE = /^page-(\d+)\.pdf$/u;
const OCR_ASSEMBLY_BATCH_PAGES = 5_000;

type TOcrPageEntry = readonly [number, string];
type TOcrPageEntrySource = readonly TOcrPageEntry[] | AsyncIterable<TOcrPageEntry>;

interface IStreamingPdfAssemblerOptions {
    qpdfBinary: string;
    originalPdfPath: string;
    ocrPageEntries: TOcrPageEntrySource;
    pageCount: number;
    tempDir: string;
    sessionId: string;
    trackTempFile: (path: string) => string;
    signal?: AbortSignal;
    mutatePage: (originalPagePath: string, ocrPagePath: string, outputPath: string) => Promise<void>;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException('OCR assembly canceled', 'AbortError');
    }
}

async function runQpdf(binary: string, args: string[], signal?: AbortSignal) {
    await runOcrCommand(binary, args, {
        allowedExitCodes: [
            0,
            3,
        ],
        commandLabel: 'qpdf(streaming-ocr-assembly)',
        timeoutMs: QPDF_TIMEOUT_MS,
        ...(signal ? {signal} : {}),
    });
}

async function writeQpdfArgsFile(path: string, args: readonly string[]) {
    await writeFile(path, args.length === 0
        ? ''
        : `${args.map(arg => arg.replace(/\r?\n/gu, ' ')).join('\n')}\n`);
}

async function appendQpdfArgsFile(path: string, args: readonly string[]) {
    if (args.length === 0) {
        return;
    }
    await appendFile(path, `${args.map(arg => arg.replace(/\r?\n/gu, ' ')).join('\n')}\n`);
}

async function extractSourcePages(
    options: IStreamingPdfAssemblerOptions,
    pageNumbers: readonly number[],
) {
    const splitDir = options.trackTempFile(join(options.tempDir, `${options.sessionId}-source-pages`));
    await mkdir(splitDir, {recursive: true});
    const argsPath = options.trackTempFile(join(
        options.tempDir,
        `${options.sessionId}-qpdf-extract-args.txt`,
    ));
    await writeQpdfArgsFile(argsPath, [
        options.originalPdfPath,
        '--pages',
        options.originalPdfPath,
        pageNumbers.join(','),
        '--',
        '--split-pages=1',
        join(splitDir, 'page.pdf'),
    ]);
    await runQpdf(options.qpdfBinary, [`@${argsPath}`], options.signal);

    const produced = (await readdir(splitDir))
        .map(name => ({
            name,
            index: Number(SPLIT_PAGE_FILE_RE.exec(name)?.[1] ?? Number.NaN),
        }))
        .filter(entry => Number.isSafeInteger(entry.index))
        .sort((left, right) => left.index - right.index);
    if (produced.length !== pageNumbers.length) {
        throw new Error(
            `qpdf extracted ${produced.length} source page(s) for ${pageNumbers.length} OCR page(s)`,
        );
    }
    const pathByPage = new Map<number, string>();
    produced.forEach((entry, index) => {
        const pageNumber = pageNumbers[index];
        if (pageNumber !== undefined) {
            pathByPage.set(pageNumber, options.trackTempFile(join(splitDir, entry.name)));
        }
    });
    return {
        splitDir,
        pathByPage,
    };
}

function toAsyncPageEntries(source: TOcrPageEntrySource): AsyncIterable<TOcrPageEntry> {
    if (Symbol.asyncIterator in Object(source)) {
        return source as AsyncIterable<TOcrPageEntry>;
    }
    return (async function* () {
        await Promise.resolve();
        const entries = [...source as readonly TOcrPageEntry[]]
            .sort(([left], [right]) => left - right);
        for (const entry of entries) {
            yield entry;
        }
    })();
}

function appendPageSelectionArgs(
    originalPdfPath: string,
    replacements: ReadonlyMap<number, string>,
    pageCount: number,
    firstUnappendedPage: number,
) {
    const args: string[] = [];
    let page = firstUnappendedPage;
    for (const [
        pageNumber,
        replacementPath,
    ] of [...replacements.entries()].sort(([left], [right]) => left - right)) {
        if (pageNumber < page || pageNumber > pageCount) {
            continue;
        }
        const untouchedEnd = pageNumber - 1;
        if (page <= untouchedEnd) {
            args.push(originalPdfPath, page === untouchedEnd ? String(page) : `${page}-${untouchedEnd}`);
        }
        args.push(replacementPath, '1');
        page = pageNumber + 1;
    }
    const lastReplacementPage = [...replacements.keys()].reduce(
        (lastPage, pageNumber) => Math.max(lastPage, pageNumber),
        firstUnappendedPage - 1,
    );
    return {
        args,
        nextPage: Math.min(pageCount + 1, lastReplacementPage + 1),
    };
}

async function processEntryBatch(
    options: IStreamingPdfAssemblerOptions,
    entries: readonly TOcrPageEntry[],
    argsPath: string,
    firstUnappendedPage: number,
) {
    throwIfAborted(options.signal);
    const pageNumbers = Array.from(new Set(entries.map(([pageNumber]) => pageNumber)))
        .sort((left, right) => left - right);
    if (pageNumbers.length === 0) {
        return firstUnappendedPage;
    }

    const extracted = await extractSourcePages(options, pageNumbers);
    const replacements = new Map<number, string>();
    try {
        await forEachConcurrent([...entries], getOcrConcurrency(entries.length), async ([
            pageNumber,
            ocrPagePath,
        ]) => {
            throwIfAborted(options.signal);
            const extractedPath = extracted.pathByPage.get(pageNumber);
            if (extractedPath === undefined) {
                throw new Error(`Missing extracted source page ${pageNumber} for OCR assembly`);
            }
            const replacementPath = options.trackTempFile(join(
                options.tempDir,
                `${options.sessionId}-ocr-page-${pageNumber}.pdf`,
            ));
            await options.mutatePage(extractedPath, ocrPagePath, replacementPath);
            replacements.set(pageNumber, replacementPath);
        });
    } finally {
        await rm(extracted.splitDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }

    const selection = appendPageSelectionArgs(
        options.originalPdfPath,
        replacements,
        options.pageCount,
        firstUnappendedPage,
    );
    await appendQpdfArgsFile(argsPath, selection.args);
    return selection.nextPage;
}

export async function assembleSearchablePdfStreaming(options: IStreamingPdfAssemblerOptions) {
    throwIfAborted(options.signal);
    const argsPath = options.trackTempFile(join(options.tempDir, `${options.sessionId}-qpdf-args.txt`));
    await writeQpdfArgsFile(argsPath, [
        options.originalPdfPath,
        '--pages',
    ]);
    let entriesInBatch: TOcrPageEntry[] = [];
    let firstUnappendedPage = 1;
    let lastSeenPage = 0;
    let entryCount = 0;
    for await (const entry of toAsyncPageEntries(options.ocrPageEntries)) {
        const pageNumber = entry[0];
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > options.pageCount) {
            throw new Error(`Invalid OCR assembly page number ${String(pageNumber)}`);
        }
        if (pageNumber <= lastSeenPage) {
            throw new Error(`OCR assembly page entries are not strictly ordered at page ${String(pageNumber)}`);
        }
        lastSeenPage = pageNumber;
        entriesInBatch.push(entry);
        entryCount += 1;
        if (entriesInBatch.length >= OCR_ASSEMBLY_BATCH_PAGES) {
            firstUnappendedPage = await processEntryBatch(
                options,
                entriesInBatch,
                argsPath,
                firstUnappendedPage,
            );
            entriesInBatch = [];
        }
    }
    if (entriesInBatch.length > 0) {
        firstUnappendedPage = await processEntryBatch(
            options,
            entriesInBatch,
            argsPath,
            firstUnappendedPage,
        );
    }
    if (entryCount === 0) {
        throw new Error('No valid OCR pages were available to assemble');
    }
    if (firstUnappendedPage <= options.pageCount) {
        await appendQpdfArgsFile(argsPath, [
            options.originalPdfPath,
            firstUnappendedPage === options.pageCount
                ? String(firstUnappendedPage)
                : `${firstUnappendedPage}-${options.pageCount}`,
        ]);
    }
    await appendQpdfArgsFile(argsPath, [
        '--',
        options.trackTempFile(join(options.tempDir, `${options.sessionId}-merged.pdf`)),
    ]);
    const outputPath = join(options.tempDir, `${options.sessionId}-merged.pdf`);
    throwIfAborted(options.signal);
    await runQpdf(options.qpdfBinary, [`@${argsPath}`], options.signal);
    if ((await stat(outputPath)).size <= 0) {
        throw new Error('Streaming OCR assembly produced an empty PDF');
    }
    return outputPath;
}
