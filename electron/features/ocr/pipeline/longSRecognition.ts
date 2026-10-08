import { isLatinScriptOcrLanguage } from '@contracts/ocrLanguages';
import type {
    IOcrWordEdit,
    ITesseractWord,
} from '@electron/features/ocr/pipeline/types';

// Modern Latin-script models read the long s (ſ) of early print as f, so on
// such a page f outnumbers s inside words (feftum, Chrifti, eft): 61% to 99%
// of them on a 1677 breviary, against 8% to 27% on modern German and English.
const SIGNATURE_MIN_LETTERS = 30;
const SIGNATURE_MIN_F_SHARE = 0.45;
// On a long-s page the historical models find ſ under most in-word f. On a
// modern page the signature misjudged they find at most a few.
const CONFIRMED_MIN_F_SHARE = 0.2;
const MAX_ALIGNED_LINE_LENGTH = 1000;
const MAX_LINE_DISTANCE_SHARE = 0.5;
const LETTER = /\p{L}/u;

export function canRecognizeLongS(languages: readonly string[]) {
    return languages.length > 0 && languages.every(isLatinScriptOcrLanguage);
}

function countInWordLetters(words: readonly ITesseractWord[]) {
    let f = 0;
    let s = 0;
    for (const {text} of words) {
        for (let index = 0; index < text.length - 1; index++) {
            if (!LETTER.test(text[index + 1]!)) continue;
            if (text[index] === 'f') f++;
            else if (text[index] === 's') s++;
        }
    }
    return {
        f,
        s,
    };
}

/** Whether a modern model's reading of a page looks like long-s print read as f. */
export function hasLongSSignature(words: readonly ITesseractWord[]) {
    const {
        f,
        s,
    } = countInWordLetters(words);
    return f + s >= SIGNATURE_MIN_LETTERS && f / (f + s) >= SIGNATURE_MIN_F_SHARE;
}

function groupWordsByLine(words: readonly ITesseractWord[]) {
    const lines = new Map<string, ITesseractWord[]>();
    for (const word of words) {
        const line = lines.get(word.lineKey);
        if (line) line.push(word);
        else lines.set(word.lineKey, [word]);
    }
    return lines;
}

/**
 * Positions in `line` where an edit-distance alignment puts an f against a ſ
 * of `reference`, or null when the two readings are too far apart to align.
 */
function findLongSPositions(line: string, reference: string) {
    const rows = line.length + 1;
    const width = reference.length + 1;
    const distance = new Uint16Array(rows * width);
    for (let column = 0; column < width; column++) distance[column] = column;
    for (let row = 1; row < rows; row++) {
        distance[row * width] = row;
        for (let column = 1; column < width; column++) {
            const substitution = distance[(row - 1) * width + column - 1]! + (line[row - 1] === reference[column - 1] ? 0 : 1);
            distance[row * width + column] = Math.min(
                substitution,
                distance[(row - 1) * width + column]! + 1,
                distance[row * width + column - 1]! + 1,
            );
        }
    }
    if (distance[rows * width - 1]! > MAX_LINE_DISTANCE_SHARE * Math.max(line.length, reference.length)) {
        return null;
    }
    const positions: number[] = [];
    let row = line.length;
    let column = reference.length;
    while (row > 0 && column > 0) {
        const here = distance[row * width + column]!;
        const aligned = line[row - 1] === reference[column - 1] ? 0 : 1;
        if (here === distance[(row - 1) * width + column - 1]! + aligned) {
            if (line[row - 1] === 'f' && reference[column - 1] === 'ſ') positions.push(row - 1);
            row--;
            column--;
        } else if (here === distance[(row - 1) * width + column]! + 1) {
            row--;
        } else {
            column--;
        }
    }
    return positions;
}

/**
 * Takes the long s from a historical model's reading of the same raster and
 * nothing else: every other letter stays as the selected model read it, and
 * each edit swaps f for ſ in place, so word lengths and boxes do not change.
 */
export function planLongSWordEdits(
    words: readonly ITesseractWord[],
    historicalWords: readonly ITesseractWord[],
): IOcrWordEdit[] {
    const historicalLines = groupWordsByLine(historicalWords);
    const edits: IOcrWordEdit[] = [];
    let replacedLetters = 0;
    for (const [
        lineKey,
        lineWords,
    ] of groupWordsByLine(words)) {
        const reference = historicalLines.get(lineKey)?.map(word => word.text).join(' ');
        const line = lineWords.map(word => word.text).join(' ');
        if (reference === undefined || line.length > MAX_ALIGNED_LINE_LENGTH || reference.length > MAX_ALIGNED_LINE_LENGTH) {
            continue;
        }
        const positions = new Set(findLongSPositions(line, reference) ?? []);
        let start = 0;
        for (const word of lineWords) {
            const letters = word.text.split('');
            let changed = false;
            for (let offset = 0; offset < word.text.length; offset++) {
                if (positions.has(start + offset)) {
                    letters[offset] = 'ſ';
                    changed = true;
                    replacedLetters++;
                }
            }
            if (changed) {
                edits.push({
                    word: word.ordinal,
                    from: word.text,
                    to: letters.join(''),
                });
            }
            start += word.text.length + 1;
        }
    }
    return replacedLetters >= CONFIRMED_MIN_F_SHARE * countInWordLetters(words).f ? edits : [];
}
