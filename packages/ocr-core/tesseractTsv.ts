import type { IOcrWord } from '@contracts/shared';
import type {
    IOcrWordEdit,
    ITesseractWord,
} from '@ocr-core/types';

/** Tesseract output bounds every host applies before it parses a page. */
export const TESSERACT_MAX_TSV_BYTES = 64 * 1024 * 1024;
export const TESSERACT_MAX_HOCR_BYTES = 256 * 1024 * 1024;
const OCR_TSV_MAX_ROWS = 500_000;
const OCR_TSV_MAX_WORDS = 250_000;
const OCR_TSV_MAX_TEXT_CHARACTERS = 16 * 1024 * 1024;

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
} = {}, wordEdits: readonly IOcrWordEdit[] = []): {
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
    if (tsvContent.length > (limits.maxInputCharacters ?? TESSERACT_MAX_TSV_BYTES)) {
        throw new Error('Tesseract TSV output exceeds the parser input limit');
    }

    const editedText = new Map(wordEdits.map(edit => [
        edit.word,
        edit.to,
    ]));
    for (const tsvRow of iterateTsvRows(tsvContent, maxRows)) {
        const edited = tsvRow.wordOrdinal === undefined ? undefined : editedText.get(tsvRow.wordOrdinal);
        const row = edited === undefined ? tsvRow : {
            ...tsvRow,
            text: edited,
        };
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
    /** Set on non-empty word rows: the word's place in Tesseract's PDF text. */
    wordOrdinal?: number;
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
    let wordCount = 0;
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

        const text = (parts[11] ?? '').trim();
        yield {
            parts,
            text,
            ...(parseInt(parts[0]!, 10) === 5 && text ? {wordOrdinal: wordCount++} : {}),
        };
    }
}

export function readTesseractWords(tsvContent: string): ITesseractWord[] {
    const words: ITesseractWord[] = [];
    for (const row of iterateTsvRows(tsvContent, OCR_TSV_MAX_ROWS)) {
        if (row.wordOrdinal === undefined) continue;
        words.push({
            ordinal: row.wordOrdinal,
            lineKey: getTsvLineKey(row.parts),
            text: row.text,
        });
    }
    return words;
}
