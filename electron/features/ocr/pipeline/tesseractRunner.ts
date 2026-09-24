import {
    open,
    stat,
    unlink,
} from 'fs/promises';
import type { IOcrWord } from '@contracts/shared';
import type { IOcrSearchablePdfOptions } from '@contracts/electronApiOcr';
import {
    AGENT_OCR_PAGE_SEGMENTATION_MODES,
    isSupportedPageSegmentationMode,
} from '@contracts/agentOcr';
import { isGreekOcrLanguage } from '@contracts/ocrLanguages';
import type { IOcrFileResult } from '@electron/features/ocr/pipeline/types';
import {buildTesseractEnv} from '@electron/features/ocr/main/buildTesseractEnv';
import {resolveTesseractLanguageConfig} from '@electron/features/ocr/main/resolveTesseractLanguageConfig';
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
const FILE_BASED_OCR_MAX_TSV_BYTES = 64 * 1024 * 1024;
const OCR_TSV_MAX_ROWS = 500_000;
const OCR_TSV_MAX_WORDS = 250_000;
const OCR_TSV_MAX_TEXT_CHARACTERS = 16 * 1024 * 1024;

async function readUtf8FileBounded(path: string, maxBytes: number) {
    const handle = await open(path, 'r');
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maxBytes) {
            throw new Error(`Tesseract TSV output exceeds the ${maxBytes}-byte limit`);
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

function shouldPreserveDictionaries(options: IOcrSearchablePdfOptions | undefined) {
    return options?.qualityProfile === 'accurate';
}

export function shouldNormalizeGreekMicroSign(languages: readonly string[]) {
    return languages.some(isGreekOcrLanguage);
}

function buildTesseractProfileArgs(options: IOcrSearchablePdfOptions | undefined) {
    const args: string[] = [];
    if (typeof options?.pageSegmentationMode === 'number') {
        if (!isSupportedPageSegmentationMode(options.pageSegmentationMode)) {
            throw new Error(
                `Tesseract page segmentation mode must be one of: ${AGENT_OCR_PAGE_SEGMENTATION_MODES.join(', ')}`,
            );
        }
        args.push('--psm', String(options.pageSegmentationMode));
    }
    if (options?.qualityProfile === 'poor-scan') {
        args.push('-c', 'thresholding_method=2');
    }
    return args;
}

// Tesseract exits 0 when it rejects a -c parameter, so a profile whose option
// the bundled engine does not know would otherwise run silently without it.
export function findUnsupportedTesseractOptions(stderrText: string) {
    return [...stderrText.matchAll(/^Could not set option: (.+)$/gmu)].map(match => match[1]!.trim());
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
): Promise<IOcrFileResult> {
    const outputBase = imagePath.replace(/\.png$/, '') + '-ocr';
    const languageConfig = resolveTesseractLanguageConfig(languages, {preserveDictionaries: shouldPreserveDictionaries(options)});
    const tsvPath = `${outputBase}.tsv`;
    const pdfPath = `${outputBase}.pdf`;
    const args = [
        imagePath,
        outputBase,
        '-l',
        languageConfig.orderedLanguages.join('+'),
        '--tessdata-dir',
        tessdataPath,
        '--dpi',
        String(extractionDpi),
        ...languageConfig.extraConfigArgs,
        ...buildTesseractProfileArgs(options),
        '-c',
        'tessedit_create_tsv=1',
        '-c',
        'tessedit_create_pdf=1',
        '-c',
        'textonly_pdf=1',
    ];
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
    try {
        stderrText = (await runNativeToolCommand(tesseractBinary, args, {
            env: buildTesseractEnv(tessdataPath, threads),
            timeoutMs: FILE_BASED_OCR_TIMEOUT_MS,
            maxStderrBytes: FILE_BASED_OCR_MAX_STDERR_BYTES,
            commandLabel: 'tesseract',
            ...(signal === undefined ? {} : {signal}),
        })).stderr;
    } catch (error) {
        const result = await failure(getErrorMessage(error));
        if (isAbortError(error) || signal?.aborted) {
            throw error;
        }
        return result;
    }

    try {
        const parsedTsv = parseTsvOcrData((await readUtf8FileBounded(tsvPath, FILE_BASED_OCR_MAX_TSV_BYTES)).trim());
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

interface ITsvLineBox {
    top: number;
    height: number;
}

interface IParsedTsvWordRow {
    parts: string[];
    text: string;
    left: number;
    top: number;
    width: number;
    height: number;
}

const TESSERACT_TSV_HEADER = [
    'level',
    'page_num',
    'block_num',
    'par_num',
    'line_num',
    'word_num',
    'left',
    'top',
    'width',
    'height',
    'conf',
    'text',
] as const;

function parsePositiveTsvInt(value: string | undefined) {
    const parsed = parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeTsvInt(value: string | undefined) {
    const parsed = parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseTsvOcrData(tsvContent: string, limits: {
    maxRows?: number;
    maxWords?: number;
    maxTextCharacters?: number;
    maxInputCharacters?: number;
} = {}): {
    words: IOcrWord[];
    text: string;
} {
    const acceptedWordRows: IParsedTsvWordRow[] = [];
    const lineBoxes = new Map<string, ITsvLineBox>();
    const textState: ITsvTextState = {
        currentLineKey: null,
        currentWords: [],
        outputLines: [],
        outputCharacters: 0,
    };
    const maxRows = limits.maxRows ?? OCR_TSV_MAX_ROWS;
    const maxWords = limits.maxWords ?? OCR_TSV_MAX_WORDS;
    const maxTextCharacters = limits.maxTextCharacters ?? OCR_TSV_MAX_TEXT_CHARACTERS;
    if (tsvContent.length > (limits.maxInputCharacters ?? FILE_BASED_OCR_MAX_TSV_BYTES)) {
        throw new Error('Tesseract TSV output exceeds the parser input limit');
    }

    for (const row of iterateTsvRows(tsvContent, maxRows)) {
        const level = parseInt(row.parts[0]!, 10);
        if (level === 4) {
            const top = parseNonNegativeTsvInt(row.parts[7]);
            const height = parsePositiveTsvInt(row.parts[9]);
            if (top !== null && height !== null) {
                lineBoxes.set(getTsvLineKey(row.parts), {
                    top,
                    height,
                });
            }
            continue;
        }
        if (level !== 5) continue;

        const left = parseNonNegativeTsvInt(row.parts[6]);
        const top = parseNonNegativeTsvInt(row.parts[7]);
        const width = parsePositiveTsvInt(row.parts[8]);
        const height = parsePositiveTsvInt(row.parts[9]);
        const confidence = parseNonNegativeTsvInt(row.parts[10]);
        if (left === null || top === null || width === null || height === null || confidence === null) continue;
        appendTsvTextRow(textState, row, maxTextCharacters);
        if (confidence < 20) continue;
        if (acceptedWordRows.length >= maxWords) {
            throw new Error(`Tesseract TSV output exceeds the ${maxWords}-word limit`);
        }
        acceptedWordRows.push({
            parts: row.parts,
            text: row.text,
            left,
            top,
            width,
            height,
        });
    }

    flushTsvTextLine(textState.outputLines, textState.currentWords);

    return {
        words: acceptedWordRows.map((row) => {
            const lineBox = lineBoxes.get(getTsvLineKey(row.parts));
            return {
                text: row.text,
                x: row.left,
                y: lineBox?.top ?? row.top,
                width: row.width,
                height: lineBox?.height ?? row.height,
            };
        }),
        text: textState.outputLines.join('\n').trim(),
    };
}

export function parseTsvOutput(tsvContent: string): IOcrWord[] {
    return parseTsvOcrData(tsvContent).words;
}

function getTsvLineKey(parts: string[]) {
    const blockNum = parts[2]?.length ? parts[2] : '0';
    const parNum = parts[3]?.length ? parts[3] : '0';
    const lineNum = parts[4]?.length ? parts[4] : '0';
    return `${blockNum}-${parNum}-${lineNum}`;
}

function flushTsvTextLine(outputLines: string[], currentWords: string[]) {
    if (currentWords.length > 0) {
        outputLines.push(currentWords.join(' '));
    }
}

interface ITsvTextState {
    currentLineKey: string | null;
    currentWords: string[];
    outputLines: string[];
    outputCharacters: number;
}

function appendTsvTextRow(
    state: ITsvTextState,
    row: {
        parts: string[];
        text: string;
    },
    maxTextCharacters: number,
) {
    if (!row.text) {
        return;
    }

    const lineKey = getTsvLineKey(row.parts);
    const startsNewLine = state.currentLineKey !== null && lineKey !== state.currentLineKey;
    const lineSeparatorCharacters = startsNewLine && state.currentWords.length > 0 ? 1 : 0;
    const separatorCharacters = !startsNewLine && state.currentWords.length > 0 ? 1 : 0;
    if (state.outputCharacters + lineSeparatorCharacters + separatorCharacters + row.text.length > maxTextCharacters) {
        throw new Error(`Tesseract TSV output exceeds the ${maxTextCharacters}-character text limit`);
    }
    if (startsNewLine) {
        flushTsvTextLine(state.outputLines, state.currentWords);
        state.currentWords = [];
        state.outputCharacters += lineSeparatorCharacters;
    }

    state.currentLineKey = lineKey;
    state.currentWords.push(row.text);
    state.outputCharacters += separatorCharacters + row.text.length;
}

function* iterateTsvRows(tsvContent: string, maxRows: number): Generator<{
    parts: string[];
    text: string;
}> {
    const trimmed = tsvContent.trim();
    const firstLineEnd = trimmed.indexOf('\n');
    const headerLine = (firstLineEnd < 0 ? trimmed : trimmed.slice(0, firstLineEnd)).replace(/\r$/u, '');
    const header = headerLine.split('\t');
    const hasValidHeader = TESSERACT_TSV_HEADER.every((column, index) => header[index] === column);
    if (!hasValidHeader) {
        throw new Error('Invalid Tesseract TSV output');
    }
    if (firstLineEnd < 0) {
        return;
    }

    let rowCount = 0;
    let cursor = firstLineEnd + 1;
    while (cursor <= trimmed.length) {
        const nextLineEnd = trimmed.indexOf('\n', cursor);
        const lineEnd = nextLineEnd < 0 ? trimmed.length : nextLineEnd;
        const line = trimmed.slice(cursor, lineEnd).replace(/\r$/u, '');
        cursor = nextLineEnd < 0 ? trimmed.length + 1 : nextLineEnd + 1;
        if (!line.trim()) continue;
        rowCount += 1;
        if (rowCount > maxRows) {
            throw new Error(`Tesseract TSV output exceeds the ${maxRows}-row limit`);
        }

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        yield {
            parts,
            text: (parts[11] ?? '').trim(),
        };
    }
}
