import { isLatinScriptOcrLanguage } from '@contracts/ocrLanguages';
import type {
    IHocrChar,
    IHocrLine,
} from '@electron/features/ocr/pipeline/hocrReading';
import { hocrWordText } from '@electron/features/ocr/pipeline/hocrReading';
import type { IOcrWordEdit } from '@electron/features/ocr/pipeline/types';

/*
 * Early print, read by three models. The selected language's model reads the
 * words but has never seen the long s (ſ), the æ and œ ligatures or the ct
 * ligature: it reads ſ as f or l, æ as z or x, and ct as é, & or a lone c.
 * `ita_old` reads ſ and grave accents, `fra` reads æ and œ; every ſ, æ and œ
 * they read on the 1677 breviary a user reported was right. In a word outside
 * the language's dictionary, a letter both read otherwise changes. Words still
 * outside it are then decoded from the selected model's own letter
 * alternatives and the known confusions, and a missing word space is restored
 * where the print shows a gap and every part is a dictionary word.
 *
 * On that breviary, against a hand transcription of two pages: words read
 * right went from 72% and 70% (`lat` alone) to 92% on both; words with ſ from
 * none to 92%, with æ or œ from none to 89% and 100%.
 */

// On early print the modern model's reading has f where the print has ſ, so
// f outnumbers s inside words: 61% to 99% on the 1677 breviary, against 8% to
// 27% on modern German and English.
const SIGNATURE_MIN_LETTERS = 30;
const SIGNATURE_MIN_F_SHARE = 0.45;
// On a long-s page `ita_old` reads ſ under most of those f. On a modern page
// the signature misjudged it reads at most a few.
const CONFIRMED_MIN_LONG_S_SHARE = 0.2;
// `ita_old` puts ſ second at 59-85 where it chose f for a printed ſ, and at
// most 23 under a printed f.
const LONG_S_CHOICE_MIN = 40;
// A missing word space: the letters stand apart by this share of the letter height.
const SPLIT_GAP_SHARE = 0.15;
const MAX_ALIGNED_LINE_LENGTH = 1000;
const MAX_DECODE_CHANGES = 3;
const MAX_DECODE_COST = 2.5;
const DECODE_STEP_BUDGET = 20_000;
const MAX_DECODED_LETTERS = 30;

const LETTER = /\p{L}/u;
const LIGATURE_LETTERS = new Set([
    'æ',
    'œ',
    'Æ',
    'Œ',
]);
const GRAVE = /^[àèìòù]$/u;
// Letters a modern model reads where the print has ſ.
const LONG_S_READINGS = new Set([
    'f',
    'l',
    't',
    's',
    'í',
    'i',
    'r',
]);
// What a modern model reads for the ct ligature, or for its c.
const CT_READINGS = new Set([
    'é',
    '€',
    '&',
    'Q',
    'G',
    '@',
    'ć',
    '£',
    '¢',
    'd',
    'è',
    'ê',
    'C',
    'q',
]);
const SHORT_WORD = /^[aàeèoô]$/u;

export function canReadEarlyPrint(languages: readonly string[]) {
    return languages.length > 0 && languages.every(isLatinScriptOcrLanguage);
}

/** The spelling a dictionary is looked up by: no accents or case, ſ as s, æ as ae, u for v and i for j. */
export function dictionaryKey(word: string) {
    return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
        .replaceAll('ſ', 's')
        .replaceAll('æ', 'ae')
        .replaceAll('œ', 'oe')
        .replaceAll('j', 'i')
        .replaceAll('v', 'u');
}

// Latin has no f before a consonant other than l, r or f, nor at a word's
// end: dictionary words that do are OCR of ſ, which web text is full of.
const LATIN_IMPOSSIBLE_F = /f(?![aeiouylrf])/u;

export function createEarlyPrintDictionary(words: Iterable<string>, latin: boolean): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const word of words) {
        const key = dictionaryKey(word);
        if (key && !(latin && LATIN_IMPOSSIBLE_F.test(key))) keys.add(key);
    }
    return keys;
}

function countInWordLetters(words: readonly string[], letters: readonly string[]) {
    const counts = new Map(letters.map(letter => [
        letter,
        0,
    ]));
    for (const text of words) {
        for (let index = 0; index < text.length - 1; index++) {
            if (!LETTER.test(text[index + 1]!)) continue;
            const count = counts.get(text[index]!);
            if (count !== undefined) counts.set(text[index]!, count + 1);
        }
    }
    return counts;
}

/** Whether a modern model's reading of a page looks like long-s print read as f. */
export function hasLongSSignature(words: readonly string[]) {
    const counts = countInWordLetters(words, [
        'f',
        's',
    ]);
    const f = counts.get('f')!;
    const s = counts.get('s')!;
    return f + s >= SIGNATURE_MIN_LETTERS && f / (f + s) >= SIGNATURE_MIN_F_SHARE;
}

interface ISlot {
    text: string;
    confidence: number;
    choices: ReadonlyMap<string, number>;
    left: number;
    right: number;
    letterHeight: number;
    /** Set by a model that reads this letter right; decoding leaves it alone. */
    settled: boolean;
}

const isLetter = (text: string) => LETTER.test(text);

function substitutionCost(left: string, right: string) {
    if (left === right) return 0;
    if (left === ' ' || right === ' ') return 2.5;
    return isLetter(left) === isLetter(right) ? 1 : 1.6;
}

/**
 * For each character of `line`, the characters of `other` an edit-distance
 * alignment puts there; `other`'s insertions join the character before them.
 * Letters pair with letters before punctuation, and spaces only with spaces.
 */
function alignTo(line: readonly string[], other: readonly IHocrChar[]): IHocrChar[][] | null {
    const rows = line.length + 1;
    const width = other.length + 1;
    if (rows > MAX_ALIGNED_LINE_LENGTH || width > MAX_ALIGNED_LINE_LENGTH) return null;
    const distance = new Float64Array(rows * width);
    for (let column = 0; column < width; column++) distance[column] = column;
    for (let row = 1; row < rows; row++) {
        distance[row * width] = row;
        for (let column = 1; column < width; column++) {
            distance[row * width + column] = Math.min(
                distance[(row - 1) * width + column - 1]! + substitutionCost(line[row - 1]!, other[column - 1]!.text),
                distance[(row - 1) * width + column]! + 1,
                distance[row * width + column - 1]! + 1,
            );
        }
    }
    if (distance[rows * width - 1]! > 0.5 * Math.max(line.length, other.length)) return null;
    const aligned: number[][] = Array.from({length: line.length}, () => []);
    let row = line.length;
    let column = other.length;
    while (row > 0 || column > 0) {
        const here = distance[row * width + column]!;
        if (row > 0 && column > 0
            && here === distance[(row - 1) * width + column - 1]! + substitutionCost(line[row - 1]!, other[column - 1]!.text)) {
            aligned[row - 1]!.push(column - 1);
            row--;
            column--;
        } else if (row > 0 && here === distance[(row - 1) * width + column]! + 1) {
            row--;
        } else {
            aligned[Math.max(row - 1, 0)]!.push(column - 1);
            column--;
        }
    }
    return aligned.map(indices => indices.sort((a, b) => a - b).map(index => other[index]!));
}

function boxOverlap(a: IHocrLine['box'], b: IHocrLine['box']) {
    const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (width <= 0 || height <= 0) return 0;
    const smaller = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
    return smaller > 0 ? width * height / smaller : 0;
}

/** The other model's reading of the same printed line, aligned to `line`'s characters. */
function readingOf(line: IHocrLine, characters: readonly string[], otherLines: readonly IHocrLine[]) {
    let best: IHocrLine | null = null;
    let bestOverlap = 0.5;
    for (const other of otherLines) {
        const overlap = boxOverlap(line.box, other.box);
        if (overlap > bestOverlap) {
            best = other;
            bestOverlap = overlap;
        }
    }
    if (!best) return null;
    const otherChars: IHocrChar[] = [];
    best.words.forEach((word, index) => {
        if (index > 0) otherChars.push(spaceChar());
        otherChars.push(...word.chars);
    });
    return alignTo(characters, otherChars);
}

function spaceChar(): IHocrChar {
    return {
        text: ' ',
        confidence: 100,
        left: 0,
        right: 0,
        choices: new Map(),
    };
}

function seesLongS(chars: readonly IHocrChar[] | undefined) {
    if (chars?.length !== 1) return false;
    const [char] = chars;
    return char!.text === 'ſ' || ((char!.text === 'f' || char!.text === 'l') && (char!.choices.get('ſ') ?? 0) >= LONG_S_CHOICE_MIN);
}

const asVote = (text: string) => text.replaceAll('ſ', 'f');

interface IWordSlots {
    ordinal: number;
    from: string;
    slots: ISlot[];
    /** The word's pieces once spaces a vote put inside it split them. */
    parts: ISlot[][];
}

/** The page's words as slots, one per character the selected model read, after both models had their say. */
function mergeLine(
    line: IHocrLine,
    firstOrdinal: number,
    longS: readonly IHocrLine[],
    ligatures: readonly IHocrLine[],
    dictionary: ReadonlySet<string>,
): IWordSlots[] {
    const flat: Array<ISlot & {
        space: boolean;
        vote?: string;
        ligature: readonly IHocrChar[]
    }> = [];
    line.words.forEach((word, index) => {
        if (index > 0) flat.push({
            ...slotOf(spaceChar(), line),
            space: true,
            ligature: [],
        });
        for (const char of word.chars) flat.push({
            ...slotOf(char, line),
            space: false,
            ligature: [],
        });
    });
    const characters = flat.map(slot => slot.text);
    const longSReading = readingOf(line, characters, longS);
    const ligatureReading = readingOf(line, characters, ligatures);
    const voters = [
        longSReading,
        ligatureReading,
    ].filter(reading => reading !== null);

    // A letter changes where both other models read the same other thing.
    if (voters.length === 2) {
        flat.forEach((slot, index) => {
            if (slot.space) return;
            const [
                first,
                second,
            ] = voters.map(reading => asVote(reading[index]!.map(char => char.text).join('')));
            if (first !== undefined && first === second && first !== asVote(slot.text)) {
                slot.vote = first;
            }
        });
        // A vote never changes the letters of a word the dictionary knows: the
        // other two models share some misreadings (codem for eodem).
        let from = 0;
        for (let index = 0; index <= flat.length; index++) {
            if (index < flat.length && !flat[index]!.space) continue;
            const word = flat.slice(from, index);
            const lettersOf = (text: string) => text.replace(/[^\p{L}\s]/gu, '');
            const before = lettersOf(word.map(slot => slot.text).join(''));
            const after = lettersOf(word.map(slot => slot.vote ?? slot.text).join(''));
            if (before !== after && dictionary.has(dictionaryKey(before))) {
                for (const slot of word) delete slot.vote;
            }
            from = index + 1;
        }
    }

    const wordLengths = flat.map(() => 0);
    for (let from = 0, index = 0; index <= flat.length; index++) {
        if (index < flat.length && !flat[index]!.space) continue;
        const length = flat.slice(from, index).filter(slot => isLetter(slot.text)).length;
        wordLengths.fill(length, from, index);
        from = index + 1;
    }
    flat.forEach((slot, index) => {
        if (slot.space) return;
        if (slot.vote !== undefined) slot.text = slot.vote;
        if (LONG_S_READINGS.has(slot.text) && seesLongS(longSReading?.[index])) {
            slot.text = 'ſ';
            slot.settled = true;
        }
        slot.ligature = ligatureReading?.[index] ?? [];
        const ligature = slot.ligature.find(char => LIGATURE_LETTERS.has(char.text));
        if (ligature) {
            slot.text = ligature.text + (slot.text.endsWith(' ') ? ' ' : '');
            slot.settled = true;
        }
        // A grave where the selected model saw some accent (veró, tantüm) or
        // in a word of four letters or more: `ita_old` puts graves on short
        // bare Latin words (Sì for Si).
        const accent = longSReading?.[index];
        const marked = slot.text.normalize('NFD') !== slot.text;
        if (accent?.length === 1 && GRAVE.test(accent[0]!.text) && (marked || wordLengths[index]! >= 4)
            && dictionaryKey(accent[0]!.text) === dictionaryKey(slot.text)) {
            slot.text = accent[0]!.text;
        }
        // A semicolon the modern model read as a digit.
        if (/^[35]$/u.test(slot.text) && (flat[index - 1]?.space ?? true) && (flat[index + 1]?.space ?? true)
            && voters.some(reading => reading[index]!.length === 1 && reading[index]![0]!.text === ';')) {
            slot.text = ';';
        }
    });
    // One æ where the modern model read two letters (RUBRICZE): drop the one the ligature model did not see.
    flat.forEach((slot, index) => {
        if (!LIGATURE_LETTERS.has(slot.text.trim())) return;
        for (const neighbour of [
            flat[index - 1],
            flat[index + 1],
        ]) {
            if (neighbour && !neighbour.space && !neighbour.settled && neighbour.ligature.length === 0
                && /^[aezxAEZX]$/u.test(neighbour.text)) {
                neighbour.text = '';
            }
        }
    });

    const words: IWordSlots[] = [];
    let current: IWordSlots | null = null;
    for (const slot of flat) {
        if (slot.space) {
            current = null;
            continue;
        }
        if (!current) {
            const ordinal = firstOrdinal + words.length;
            current = {
                ordinal,
                from: hocrWordText(line.words[words.length]!),
                slots: [],
                parts: [],
            };
            words.push(current);
        }
        current.slots.push(slot);
    }
    return words;
}

function slotOf(char: IHocrChar, line: IHocrLine): ISlot {
    return {
        text: char.text,
        confidence: char.confidence,
        choices: char.choices,
        left: char.left,
        right: char.right,
        letterHeight: line.letterHeight,
        settled: false,
    };
}

interface IOption {
    text: string;
    cost: number;
}

function slotOptions(slot: ISlot, ctFollows: boolean): IOption[] {
    const [
        head = '',
        ...rest
    ] = [...slot.text];
    const tail = rest.join('');
    const options: IOption[] = [{
        text: slot.text,
        cost: 0,
    }];
    if (slot.settled) return options;
    const add = (text: string, cost: number) => {
        const existing = options.find(option => option.text === text + tail);
        if (existing) existing.cost = Math.min(existing.cost, cost);
        else options.push({
            text: text + tail,
            cost,
        });
    };
    for (const [
        choice,
        confidence,
    ] of slot.choices) {
        if (choice === head || !isLetter(choice) || confidence < 10) continue;
        add(choice, Math.max(0.05, (slot.confidence - confidence) / 50));
    }
    if (head === 'f') add('ſ', 0.6);
    if (head === 'l' || head === 't') add('ſ', 1);
    if (CT_READINGS.has(head)) {
        // With no t after it, the glyph stands for the whole ct.
        add('c', 0.5);
        add('ct', ctFollows ? 0.6 : 0.4);
    }
    if (head === 't') add('ct', 0.8);
    if ('zx’\''.includes(head) && head !== '') add('æ', 0.5);
    if (head === 'e') add('c', 1);
    if (head === 'c') add('e', 1);
    if (head === 'å' || head === 'á') add('â', 0.2);
    if (head === 'ü') add('ù', 0.2);
    if (head === 'é') add('è', 0.3);
    return options;
}

/** The cheapest dictionary word the slots can read as, as one text per slot. */
function decode(slots: readonly ISlot[], dictionary: ReadonlySet<string>): {
    cost: number;
    texts: string[]
} | null {
    if (slots.length === 0 || slots.length > MAX_DECODED_LETTERS) return null;
    const options = slots.map((slot, index) => slotOptions(slot, (slots[index + 1]?.text ?? '').startsWith('t')));
    const chosen = slots.map(() => '');
    let best: {
        cost: number;
        texts: string[]
    } | null = null;
    let steps = 0;
    const walk = (index: number, cost: number, changes: number) => {
        if (++steps > DECODE_STEP_BUDGET || cost > MAX_DECODE_COST || (best && cost >= best.cost)) return;
        if (index === slots.length) {
            if (dictionary.has(dictionaryKey(chosen.join('')))) best = {
                cost,
                texts: [...chosen],
            };
            return;
        }
        for (const option of options[index]!) {
            const change = option.cost > 0 ? 1 : 0;
            if (changes + change > MAX_DECODE_CHANGES) continue;
            chosen[index] = option.text;
            walk(index + 1, cost + option.cost, changes + change);
        }
    };
    walk(0, 0, 0);
    return best;
}

const textOf = (slots: readonly ISlot[]) => slots.map(slot => slot.text).join('');

function isWord(slots: readonly ISlot[], dictionary: ReadonlySet<string>) {
    return (slots.length >= 2 || SHORT_WORD.test(textOf(slots))) && dictionary.has(dictionaryKey(textOf(slots)));
}

const isUpper = (text: string) => text !== text.toLowerCase();
const isLower = (text: string) => text !== text.toUpperCase();

function apply(slots: readonly ISlot[], texts: readonly string[]) {
    slots.forEach((slot, index) => {
        slot.text = texts[index]!;
    });
}

/**
 * A missing word space: split where a capital follows a small letter (words
 * have no inner capitals), or where the print shows a gap and every part, at
 * most three, is a dictionary word as read. Spaced capitals (OFFICIUM) stay
 * one word; a word the dictionary lacks is not cut into decoded pieces.
 */
function restoreWordSpaces(slots: readonly ISlot[], dictionary: ReadonlySet<string>) {
    const capitals: number[] = [];
    for (let index = 1; index < slots.length; index++) {
        if (isUpper(slots[index]!.text) && isLower(slots[index - 1]!.text)) capitals.push(index);
    }
    if (capitals.length > 0) {
        let from = 0;
        for (const to of [
            ...capitals,
            slots.length,
        ]) {
            const part = slots.slice(from, to);
            if (!isWord(part, dictionary)) restoreWordSpaces(part, dictionary);
            if (from > 0) slots[from]!.text = ` ${slots[from]!.text}`;
            from = to;
        }
        return;
    }
    if (slots.filter(slot => isUpper(slot.text)).length >= 2) return;
    const gapBefore = (index: number) => slots[index]!.left - slots[index - 1]!.right >= SPLIT_GAP_SHARE * slots[index]!.letterHeight;
    const cuts: number[] = [];
    for (let cut = 1; cut < slots.length; cut++) {
        if (!gapBefore(cut) || !isWord(slots.slice(0, cut), dictionary)) continue;
        if (isWord(slots.slice(cut), dictionary)) {
            cuts.splice(0, cuts.length, cut);
            break;
        }
        if (cuts.length > 0) continue;
        for (let second = cut + 1; second < slots.length; second++) {
            if (gapBefore(second) && isWord(slots.slice(cut, second), dictionary) && isWord(slots.slice(second), dictionary)) {
                cuts.push(cut, second);
                break;
            }
        }
    }
    for (const cut of cuts) slots[cut]!.text = ` ${slots[cut]!.text}`;
}

/** The letters of a word between its leading and trailing punctuation; a ct glyph ending it counts (O& for Oct). */
function letterRange(slots: readonly ISlot[]) {
    let start = 0;
    let end = slots.length;
    while (start < end && !isLetter(slots[start]!.text || '-')) start++;
    while (end > start && !isLetter(slots[end - 1]!.text || '-')
        && !(CT_READINGS.has(slots[end - 1]!.text) && end - 1 > start)) end--;
    return [
        start,
        end,
    ] as const;
}

export interface IEarlyPrintReadings {
    /** The selected languages' reading; its words are the page's words. */
    base: readonly IHocrLine[];
    /** `ita_old`'s reading: the long s and grave accents. */
    longS: readonly IHocrLine[];
    /** `fra`'s reading: æ and œ. */
    ligatures: readonly IHocrLine[];
}

/**
 * Word edits that turn the selected model's reading of an early printed page
 * into the page's text, or none when the other models found no long s there.
 */
export function planEarlyPrintWordEdits(
    readings: IEarlyPrintReadings,
    dictionary: ReadonlySet<string>,
    options: {latin: boolean},
): IOcrWordEdit[] {
    const baseWords = readings.base.flatMap(line => line.words.map(hocrWordText));
    const longSWords = readings.longS.flatMap(line => line.words.map(hocrWordText));
    const longSCount = longSWords.join('').split('ſ').length - 1;
    if (longSCount < CONFIRMED_MIN_LONG_S_SHARE * countInWordLetters(baseWords, ['f']).get('f')!) return [];

    const lines: IWordSlots[][] = [];
    let ordinal = 0;
    for (const line of readings.base) {
        lines.push(mergeLine(line, ordinal, readings.longS, readings.ligatures, dictionary));
        ordinal += line.words.length;
    }

    // Each word, split where a vote put a space, with a line-end hyphen joined to the next line's first word.
    for (const word of lines.flat()) word.parts = splitAtSpaces(word.slots);
    const parts = lines.map(words => words.flatMap(word => word.parts));
    const units: ISlot[][][] = [];
    parts.forEach((lineParts, lineIndex) => {
        lineParts.forEach((part, index) => {
            const next = parts[lineIndex + 1]?.[0];
            if (index === 0 && units.at(-1)?.[1] === part) return;
            if (index === lineParts.length - 1 && part.at(-1)?.text === '-' && next) {
                units.push([
                    part,
                    next,
                ]);
            } else {
                units.push([part]);
            }
        });
    });
    for (const unit of units) {
        const letters = unit.flatMap((part) => {
            const [
                start,
                end,
            ] = letterRange(part);
            return part.slice(start, end);
        }).filter(slot => slot.text !== '');
        if (letters.length === 0 || dictionary.has(dictionaryKey(textOf(letters)))) continue;
        const read = decode(letters, dictionary);
        if (read) apply(letters, read.texts);
        else if (unit.length === 1) restoreWordSpaces(letters, dictionary);
    }

    const edits: IOcrWordEdit[] = [];
    for (const word of lines.flat()) {
        if (options.latin) {
            for (const part of word.parts) {
                part.forEach((slot, index) => {
                    // Latin has no f before a consonant but l, r or f: the print has ſ.
                    const next = dictionaryKey(part[index + 1]?.text ?? '');
                    if (slot.text === 'f' && /^[b-df-hj-km-np-qs-tv-xz]/u.test(next) && !/^[lrf]/u.test(next)) slot.text = 'ſ';
                    // Latin print marks ù and â, which modern models read as ü and å.
                    slot.text = slot.text.replace('ü', 'ù').replace('å', 'â');
                });
            }
        }
        const to = word.parts.map(textOf).join(' ').replace(/\s+/gu, ' ').trim();
        if (to !== '' && to !== word.from) {
            edits.push({
                word: word.ordinal,
                from: word.from,
                to,
            });
        }
    }
    return edits;
}

/** A word's slots in pieces at the spaces a vote put inside them. */
function splitAtSpaces(slots: ISlot[]): ISlot[][] {
    const pieces: ISlot[][] = [[]];
    for (const slot of slots) {
        const texts = slot.text.split(' ');
        texts.forEach((text, index) => {
            if (index > 0) pieces.push([]);
            if (index === 0) {
                slot.text = text;
                if (text !== '' || texts.length === 1) pieces.at(-1)!.push(slot);
            } else if (text !== '') {
                pieces.at(-1)!.push({
                    ...slot,
                    text,
                    choices: new Map(),
                    settled: true,
                });
            }
        });
    }
    return pieces.filter(piece => piece.length > 0);
}
