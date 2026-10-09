import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGeneratedFileIfChanged } from '@scripts/writeGeneratedFileIfChanged';

export interface IGenerateFirstUnsupportedAnnotationCharacterOptions { projectRoot?: string; }

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontRelativePath = 'public/fonts/annotation/DejaVuSans.ttf';
const generatedRelativePath = 'packages/contracts/firstUnsupportedAnnotationCharacter.ts';

// Subtable choice mirrors skrifa's Charmap, which native/pdf-page-ops/src/text_box_font.rs
// reads through `charmap.map`: a Windows symbol subtable beats a Unicode full-repertoire
// subtable, which beats a BMP subtable. Among equal kinds the last cmap record wins.
const SUBTABLE_KIND_BMP = 1;
const SUBTABLE_KIND_FULL = 2;
const SUBTABLE_KIND_SYMBOL = 3;

interface ICmapRecord {
    format: number;
    kind: number;
    offset: number;
}

function readTableOffset(font: Buffer, tag: string) {
    const tableCount = font.readUInt16BE(4);
    for (let index = 0; index < tableCount; index++) {
        const record = 12 + index * 16;
        if (font.toString('latin1', record, record + 4) === tag) {
            return font.readUInt32BE(record + 8);
        }
    }
    throw new Error(`The bundled text box font has no ${tag} table`);
}

function classifyEncoding(platform: number, encoding: number) {
    if (platform === 3 && encoding === 0) return SUBTABLE_KIND_SYMBOL;
    // Variation-sequence records (platform 0, encoding 5) map through format 14 only.
    if (platform === 0 && encoding === 5) return undefined;
    if ((platform === 3 && encoding === 10) || (platform === 0 && encoding === 4)) return SUBTABLE_KIND_FULL;
    if (platform === 2 || platform === 0 || (platform === 3 && encoding === 1)) return SUBTABLE_KIND_BMP;
    return undefined;
}

// Returns the subtable skrifa maps through, or throws for the forms this generator does not read.
function selectCmapSubtable(font: Buffer, cmapOffset: number): ICmapRecord {
    const recordCount = font.readUInt16BE(cmapOffset + 2);
    let selected: ICmapRecord | undefined;
    for (let index = recordCount - 1; index >= 0; index--) {
        const record = cmapOffset + 4 + index * 8;
        const kind = classifyEncoding(font.readUInt16BE(record), font.readUInt16BE(record + 2));
        const offset = cmapOffset + font.readUInt32BE(record + 4);
        const format = font.readUInt16BE(offset);
        const readable = format === 4 || format === 12 || format === 13;
        if (kind === undefined || !readable) continue;
        if (selected === undefined || kind > selected.kind) {
            selected = {
                format,
                kind,
                offset,
            };
        }
    }
    if (selected === undefined) {
        throw new Error('The bundled text box font has no Unicode cmap subtable');
    }
    if (selected.kind === SUBTABLE_KIND_SYMBOL || selected.format === 13) {
        throw new Error(`The bundled text box font selects an unsupported cmap subtable (format ${selected.format})`);
    }
    return selected;
}

function* format4Codepoints(font: Buffer, offset: number) {
    const segmentCount = font.readUInt16BE(offset + 6) / 2;
    const endCodes = offset + 14;
    const startCodes = endCodes + 2 + segmentCount * 2;
    const idDeltas = startCodes + segmentCount * 2;
    const idRangeOffsets = idDeltas + segmentCount * 2;
    for (let segment = 0; segment < segmentCount; segment++) {
        const start = font.readUInt16BE(startCodes + segment * 2);
        const end = font.readUInt16BE(endCodes + segment * 2);
        const delta = font.readUInt16BE(idDeltas + segment * 2);
        const rangeOffset = font.readUInt16BE(idRangeOffsets + segment * 2);
        for (let code = start; code <= end; code++) {
            let glyph = (code + delta) & 0xffff;
            if (rangeOffset !== 0) {
                const glyphAddress = idRangeOffsets + segment * 2 + rangeOffset + (code - start) * 2;
                glyph = font.readUInt16BE(glyphAddress);
                if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
            }
            if (glyph !== 0) yield code;
        }
    }
}

function* format12Codepoints(font: Buffer, offset: number) {
    const groupCount = font.readUInt32BE(offset + 12);
    for (let group = 0; group < groupCount; group++) {
        const record = offset + 16 + group * 12;
        const start = font.readUInt32BE(record);
        const end = font.readUInt32BE(record + 4);
        const startGlyph = font.readUInt32BE(record + 8);
        for (let code = start; code <= end; code++) {
            if (startGlyph + code - start !== 0) yield code;
        }
    }
}

export function unicodeRanges(font: Buffer): Array<[number, number]> {
    const subtable = selectCmapSubtable(font, readTableOffset(font, 'cmap'));
    const codepoints = [...subtable.format === 4
        ? format4Codepoints(font, subtable.offset)
        : format12Codepoints(font, subtable.offset)].sort((left, right) => left - right);
    const ranges: Array<[number, number]> = [];
    for (const code of codepoints) {
        const last = ranges.at(-1);
        if (last && code <= last[1] + 1) {
            last[1] = Math.max(last[1], code);
        } else {
            ranges.push([
                code,
                code,
            ]);
        }
    }
    return ranges;
}

const hex = (code: number) => `0x${code.toString(16)}`;

// The lookup and its control/invisible exceptions mirror text_box_font.rs `invisible` and `validate_text`.
const TAIL = `export function firstUnsupportedAnnotationCharacter(text: string): string | undefined {
    for (const character of text) {
        const code = character.codePointAt(0)!;
        if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0xad
            || code === 0x61c || (code >= 0x200b && code <= 0x200f)
            || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f)
            || (code >= 0xfe00 && code <= 0xfe0f) || code === 0xfeff) continue;
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
            return character;
        }
        let low = 0;
        let high = ranges.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            const range = ranges[middle]!;
            if (code < range[0]) high = middle;
            else if (code > range[1]) low = middle + 1;
            else break;
        }
        if (low === high) {
            return character;
        }
    }
    return undefined;
}
`;

export function renderFirstUnsupportedAnnotationCharacter(font: Buffer) {
    const digest = createHash('sha256').update(font).digest('hex');
    const rangeLines = unicodeRanges(font).map(([
        start,
        end,
    ]) => [
        '    [',
        `        ${hex(start)},`,
        `        ${hex(end)},`,
        '    ],',
    ].join('\n'));
    return [
        '// Generated from public/fonts/annotation/DejaVuSans.ttf, DejaVu 2.37.',
        `// SHA-256 ${digest}.`,
        '// Keep native text_box_font.rs admission and this coverage in agreement.',
        'const ranges: ReadonlyArray<readonly [number, number]> = [',
        ...rangeLines,
        '];',
        '',
        TAIL,
    ].join('\n');
}

export async function generateFirstUnsupportedAnnotationCharacter(
    options: IGenerateFirstUnsupportedAnnotationCharacterOptions = {},
) {
    const root = options.projectRoot ?? projectRoot;
    const font = await readFile(path.join(root, fontRelativePath));
    return writeGeneratedFileIfChanged(
        path.join(root, generatedRelativePath),
        renderFirstUnsupportedAnnotationCharacter(font),
    );
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun && await generateFirstUnsupportedAnnotationCharacter()) {
    console.info('Generated the text box glyph support ranges.');
}
