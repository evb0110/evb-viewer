import {
    open,
    readFile,
    rename,
    stat,
    unlink,
} from 'fs/promises';
import { join } from 'path';
import type { IOcrSearchablePdfOptions } from '@contracts/electronApiOcr';
import type { IOcrFileResult } from '@electron/features/ocr/pipeline/types';
import type { IOcrWordEdit } from '@ocr-core/types';
import {
    canReadEarlyPrint,
    createEarlyPrintDictionary,
    hasLongSSignature,
    planEarlyPrintWordEdits,
} from '@ocr-core/earlyPrintReading';
import { readTraineddataWordList } from '@ocr-core/readTraineddataWordList';
import {
    hocrWordText,
    readHocrLines,
} from '@ocr-core/hocrReading';
import {
    buildTesseractArgs,
    findUnsupportedTesseractOptions,
    shouldNormalizeGreekMicroSign,
    type ITesseractOutputs,
} from '@ocr-core/tesseractRecipe';
import {
    parseTsvOcrData,
    readTesseractWords,
    TESSERACT_MAX_HOCR_BYTES,
    TESSERACT_MAX_TSV_BYTES,
} from '@ocr-core/tesseractTsv';
import {buildTesseractEnv} from '@electron/features/ocr/main/buildTesseractEnv';
import { getErrorMessage } from '@electron/utils/error';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { isAbortError } from '@electron/utils/abort';

const PNG_SIGNATURE = Buffer.from([
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A,
]);

const FILE_BASED_OCR_TIMEOUT_MS = 3 * 60 * 1000;
const FILE_BASED_OCR_MAX_STDERR_BYTES = 262_144;

async function readUtf8FileBounded(path: string, maxBytes: number) {
    const handle = await open(path, 'r');
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maxBytes) {
            throw new Error(`Tesseract output exceeds the ${maxBytes}-byte limit`);
        }
        const bytes = Buffer.allocUnsafe(before.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
        }
        if (offset !== before.size) {
            throw new Error('Tesseract TSV output changed while it was being read');
        }
        return bytes.subarray(0, offset).toString('utf8');
    } finally {
        await handle.close();
    }
}

function getPngDimensions(imageBuffer: Buffer): {
    width: number;
    height: number;
} | null {
    if (imageBuffer.length < 24) {
        return null;
    }
    if (!imageBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return null;
    }
    const width = imageBuffer.readUInt32BE(16);
    const height = imageBuffer.readUInt32BE(20);
    if (width <= 0 || height <= 0) {
        return null;
    }
    return {
        width,
        height,
    };
}

export async function getPngDimensionsFromFile(imagePath: string) {
    const file = await open(imagePath, 'r');
    try {
        const header = Buffer.alloc(24);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (bytesRead < header.length) {
            return null;
        }
        return getPngDimensions(header);
    } finally {
        await file.close();
    }
}

async function safeUnlink(path: string) {
    try {
        await unlink(path);
    } catch {
        // Ignore cleanup errors.
    }
}

interface ITesseractRun {
    imagePath: string;
    extractionDpi: number;
    tesseractBinary: string;
    tessdataPath: string;
    threads?: number;
    signal?: AbortSignal;
    options?: IOcrSearchablePdfOptions;
}

/** Runs Tesseract on the page raster and returns its stderr; outputs land beside `outputBase`. */
async function runTesseract(
    run: ITesseractRun,
    outputBase: string,
    languages: readonly string[],
    outputs: ITesseractOutputs,
) {
    const args = buildTesseractArgs({
        imagePath: run.imagePath,
        outputBase,
        languages,
        tessdataPath: run.tessdataPath,
        dpi: run.extractionDpi,
        options: run.options,
        outputs,
    });
    return (await runNativeToolCommand(run.tesseractBinary, args, {
        env: buildTesseractEnv(run.tessdataPath, run.threads),
        timeoutMs: FILE_BASED_OCR_TIMEOUT_MS,
        maxStderrBytes: FILE_BASED_OCR_MAX_STDERR_BYTES,
        commandLabel: 'tesseract',
        ...(run.signal === undefined ? {} : {signal: run.signal}),
    })).stderr;
}

const dictionaries = new Map<string, Promise<ReadonlySet<string>>>();
const MAX_CACHED_DICTIONARIES = 2;

/**
 * The early-print dictionary of the selected languages: the union of their
 * word lists, loaded once per set of languages. Latin keeps its language
 * dictionary: script/Latin's multilingual DAWG exceeds the bounded reader
 * and includes words from languages the user did not select.
 */
function loadEarlyPrintDictionary(tessdataPath: string, languages: readonly string[]) {
    const codes = [...new Set(languages)].sort();
    const key = `${tessdataPath}\0${codes.join('+')}`;
    let dictionary = dictionaries.get(key);
    if (!dictionary) {
        dictionary = (async () => {
            const lists = await Promise.all(codes.map(async code => readTraineddataWordList(await readFile(join(tessdataPath, `${code === 'lat' ? 'lat_dictionary' : code}.traineddata`)))));
            return createEarlyPrintDictionary(lists.flatMap(list => list ?? []), codes.includes('lat'));
        })();
        dictionary.catch(() => dictionaries.delete(key));
        dictionaries.set(key, dictionary);
        while (dictionaries.size > MAX_CACHED_DICTIONARIES) dictionaries.delete(dictionaries.keys().next().value!);
    }
    return dictionary;
}

async function readHocr(path: string) {
    return readHocrLines(await readUtf8FileBounded(path, TESSERACT_MAX_HOCR_BYTES));
}

/**
 * On a page its own model read with the long-s signature, reads the raster
 * again: the same model, now also writing hOCR, then the early-print models.
 * Plans the edits that make their joint reading the page's text, and replaces
 * the first reading with the rerun's only when every pass succeeded.
 */
async function readEarlyPrint(
    run: ITesseractRun,
    outputBase: string,
    languages: readonly string[],
    tsvContent: string,
    prepareEarlyPrintModels: () => Promise<void>,
): Promise<{
    tsvContent: string;
    wordEdits: IOcrWordEdit[];
    unavailable?: string;
}> {
    // A TSV that cannot be read fails the page when it is parsed for its words.
    const words = (() => {
        try {
            return readTesseractWords(tsvContent);
        } catch {
            return [];
        }
    })();
    if (!hasLongSSignature(words.map(word => word.text))) {
        return {
            tsvContent,
            wordEdits: [],
        };
    }
    const bases = {
        base: `${outputBase}-early`,
        longS: `${outputBase}-ita_old`,
        ligatures: `${outputBase}-fra`,
    };
    try {
        await prepareEarlyPrintModels();
        await runTesseract(run, bases.base, languages, {
            pdf: true,
            tsv: true,
            hocr: true,
        });
        await runTesseract(run, bases.longS, ['ita_old'], {hocr: true});
        await runTesseract(run, bases.ligatures, ['fra'], {hocr: true});
        const rereadTsv = (await readUtf8FileBounded(`${bases.base}.tsv`, TESSERACT_MAX_TSV_BYTES)).trim();
        const base = await readHocr(`${bases.base}.hocr`);
        // Edits name words by their place in the TSV, which lists the hOCR's words in order.
        const hocrWords = base.flatMap(line => line.words.map(word => hocrWordText(word).trim()));
        const tsvWords = readTesseractWords(rereadTsv).map(word => word.text);
        if (hocrWords.length !== tsvWords.length || hocrWords.some((word, index) => word !== tsvWords[index])) {
            throw new Error('Tesseract listed different words in its hOCR and TSV');
        }
        const wordEdits = planEarlyPrintWordEdits({
            base,
            longS: await readHocr(`${bases.longS}.hocr`),
            ligatures: await readHocr(`${bases.ligatures}.hocr`),
        }, await loadEarlyPrintDictionary(run.tessdataPath, languages), {latin: languages.includes('lat')});
        // The page keeps the rerun's TSV in memory; only its PDF replaces the first.
        await rename(`${bases.base}.pdf`, `${outputBase}.pdf`);
        return {
            tsvContent: rereadTsv,
            wordEdits,
        };
    } catch (error) {
        if (isAbortError(error) || run.signal?.aborted) {
            throw error;
        }
        return {
            tsvContent,
            wordEdits: [],
            unavailable: getErrorMessage(error),
        };
    } finally {
        await Promise.all([
            `${bases.base}.pdf`,
            `${bases.base}.tsv`,
            `${bases.base}.hocr`,
            `${bases.longS}.hocr`,
            `${bases.ligatures}.hocr`,
        ].map(safeUnlink));
    }
}

export async function runOcrFileBased(
    imagePath: string,
    languages: string[],
    imageWidth: number,
    imageHeight: number,
    extractionDpi: number,
    tesseractBinary: string,
    tessdataPath: string,
    threads?: number,
    signal?: AbortSignal,
    options?: IOcrSearchablePdfOptions,
    prepareEarlyPrintModels?: () => Promise<void>,
): Promise<IOcrFileResult> {
    const outputBase = imagePath.replace(/\.png$/, '') + '-ocr';
    const tsvPath = `${outputBase}.tsv`;
    const pdfPath = `${outputBase}.pdf`;
    const run: ITesseractRun = {
        imagePath,
        extractionDpi,
        tesseractBinary,
        tessdataPath,
        ...(threads === undefined ? {} : {threads}),
        ...(signal === undefined ? {} : {signal}),
        ...(options === undefined ? {} : {options}),
    };
    const failure = async (error: string): Promise<IOcrFileResult> => {
        await Promise.all([
            safeUnlink(tsvPath),
            safeUnlink(pdfPath),
        ]);
        return {
            success: false,
            pageData: null,
            pdfPath: null,
            error,
        };
    };

    let stderrText: string;
    let tsvContent: string;
    try {
        stderrText = await runTesseract(run, outputBase, languages, {
            pdf: true,
            tsv: true,
        });
        tsvContent = (await readUtf8FileBounded(tsvPath, TESSERACT_MAX_TSV_BYTES)).trim();
    } catch (error) {
        const result = await failure(getErrorMessage(error));
        if (isAbortError(error) || signal?.aborted) {
            throw error;
        }
        return result;
    }

    const earlyPrint = prepareEarlyPrintModels === undefined || !canReadEarlyPrint(languages)
        ? {
            tsvContent,
            wordEdits: [],
        }
        : await readEarlyPrint(run, outputBase, languages, tsvContent, prepareEarlyPrintModels);
    try {
        const parsedTsv = parseTsvOcrData(earlyPrint.tsvContent, {}, earlyPrint.wordEdits);
        const {words} = parsedTsv;
        let pageText = parsedTsv.text;
        if (shouldNormalizeGreekMicroSign(languages)) {
            for (const word of words) {
                word.text = word.text.replace(/\u00B5/g, '\u03BC');
            }
            pageText = pageText.replace(/\u00B5/g, '\u03BC');
        }
        if (!(await stat(pdfPath).catch(() => null))?.isFile()) {
            return await failure('Tesseract did not produce PDF output');
        }
        await safeUnlink(tsvPath);
        const unsupportedOptions = findUnsupportedTesseractOptions(stderrText);
        return {
            success: true,
            ...(unsupportedOptions.length > 0 ? {unsupportedOptions} : {}),
            ...(earlyPrint.wordEdits.length > 0 ? {wordEdits: earlyPrint.wordEdits} : {}),
            ...(earlyPrint.unavailable === undefined ? {} : {earlyPrintUnavailable: earlyPrint.unavailable}),
            pageData: {
                pageNumber: 0,
                words,
                text: pageText,
                imageWidth,
                imageHeight,
            },
            pdfPath,
        };
    } catch (parseError) {
        return failure(getErrorMessage(parseError));
    }
}
