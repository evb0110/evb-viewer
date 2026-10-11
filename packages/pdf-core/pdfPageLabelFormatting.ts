import type { IPdfPageLabelRange } from '@contracts/pdfPageLabels';

/** A repeated ASCII character stays compact until somebody requests its full label. */
interface ILabelPart {
    text: string;
    repeat: number;
}

function getLabelParts(range: IPdfPageLabelRange, offset: number): ILabelPart[] {
    const parts = [{
        text: range.prefix,
        repeat: 1,
    }];
    const number = Math.max(1, range.startNumber + offset);
    if (range.style === null) {
        return parts;
    }
    if (range.style === 'D') {
        parts.push({
            text: String(number),
            repeat: 1,
        });
    } else if (range.style === 'A' || range.style === 'a') {
        parts.push({
            text: String.fromCharCode((range.style === 'A' ? 0x41 : 0x61) + (number - 1) % 26),
            repeat: Math.floor((number - 1) / 26) + 1,
        });
    } else {
        const thousands = Math.floor(number / 1000);
        parts.push({
            text: range.style === 'R' ? 'M' : 'm',
            repeat: thousands,
        });
        let remainder = number - thousands * 1000;
        let suffix = '';
        const numerals: ReadonlyArray<readonly [number, string]> = [
            [
                900,
                'CM',
            ],
            [
                500,
                'D',
            ],
            [
                400,
                'CD',
            ],
            [
                100,
                'C',
            ],
            [
                90,
                'XC',
            ],
            [
                50,
                'L',
            ],
            [
                40,
                'XL',
            ],
            [
                10,
                'X',
            ],
            [
                9,
                'IX',
            ],
            [
                5,
                'V',
            ],
            [
                4,
                'IV',
            ],
            [
                1,
                'I',
            ],
        ];
        for (const [
            value,
            text,
        ] of numerals) {
            const count = Math.floor(remainder / value);
            suffix += text.repeat(count);
            remainder -= count * value;
        }
        parts.push({
            text: range.style === 'R' ? suffix : suffix.toLowerCase(),
            repeat: 1,
        });
    }
    return parts.filter(part => part.text.length > 0 && part.repeat > 0);
}

export function getLabelForOffset(range: IPdfPageLabelRange, offset: number): string {
    return getLabelParts(range, offset).map(part => part.text.repeat(part.repeat)).join('');
}

function partsMatch(left: ILabelPart[], right: ILabelPart[]): boolean {
    const length = (parts: ILabelPart[]) => parts.reduce((total, part) => total + part.text.length * part.repeat, 0);
    if (length(left) !== length(right)) {
        return false;
    }
    let rightIndex = 0;
    let rightOffset = 0;
    for (const part of left) {
        let offset = 0;
        const text = part.text;
        while (offset < part.text.length * part.repeat) {
            const other = right[rightIndex];
            if (!other) {
                return false;
            }
            const otherText = other.text;
            const count = Math.min(part.text.length * part.repeat - offset, other.text.length * other.repeat - rightOffset);
            if (text.length === 1 && otherText.length === 1) {
                if (text !== otherText) {
                    return false;
                }
            } else if (text !== otherText || offset !== rightOffset) {
                for (let index = 0; index < count; index += 1) {
                    if (text[(offset + index) % text.length] !== otherText[(rightOffset + index) % otherText.length]) {
                        return false;
                    }
                }
            }
            offset += count;
            rightOffset += count;
            if (rightOffset === other.text.length * other.repeat) {
                rightIndex += 1;
                rightOffset = 0;
            }
        }
    }
    return true;
}

export function pageLabelMatchesText(range: IPdfPageLabelRange, offset: number, text: string, caseInsensitive = false): boolean {
    // Fold the whole input before measuring: Unicode case folding can change its length.
    const parts = getLabelParts(range, offset);
    return partsMatch(
        caseInsensitive ? parts.map(part => ({
            ...part,
            text: part.text.toLowerCase(),
        })) : parts,
        [{
            text: caseInsensitive ? text.toLowerCase() : text,
            repeat: 1,
        }].filter(part => part.text.length > 0),
    );
}

export function pageLabelValuesMatch(left: IPdfPageLabelRange, leftOffset: number, right: IPdfPageLabelRange, rightOffset: number): boolean {
    return partsMatch(getLabelParts(left, leftOffset), getLabelParts(right, rightOffset));
}

const DISPLAY_GRAPHEMES = 64;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function shorten(text: string, limit: number): string {
    let count = 0;
    for (const { index } of graphemes.segment(text)) {
        if (count === limit) {
            return `${text.slice(0, index)}…`;
        }
        count += 1;
    }
    return text;
}

/** Presentation only. Preserve short numbering suffixes so long prefixes still name distinct pages. */
export function formatPageLabelForDisplay(range: IPdfPageLabelRange | string, offset = 0): string {
    if (typeof range === 'string') {
        return shorten(range, DISPLAY_GRAPHEMES);
    }
    const parts = getLabelParts(range, offset);
    if (range.style === null) {
        return shorten(range.prefix, DISPLAY_GRAPHEMES);
    }
    const numbering = parts.slice(range.prefix.length > 0 ? 1 : 0);
    const numberingLength = numbering.reduce((total, part) => total + part.text.length * part.repeat, 0);
    if (numberingLength <= DISPLAY_GRAPHEMES / 2) {
        const suffix = numbering.map(part => part.text.repeat(part.repeat)).join('');
        return shorten(range.prefix, DISPLAY_GRAPHEMES - numberingLength) + suffix;
    }
    // Only the head is needed, even when the formula means millions of letters.
    const head = shorten(range.prefix, DISPLAY_GRAPHEMES + 1)
        + numbering.map(part => part.text.repeat(Math.min(part.repeat, DISPLAY_GRAPHEMES + 1))).join('');
    return shorten(head, DISPLAY_GRAPHEMES);
}
