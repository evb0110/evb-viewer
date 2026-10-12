import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {getNativeExternalBuildInputs} from '@scripts/native-build-id.mjs';
import { writeGeneratedFileIfChanged } from '@scripts/writeGeneratedFileIfChanged';

export interface IGenerateFirstUnsupportedAnnotationCharacterOptions { projectRoot?: string; }

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontRelativePaths = getNativeExternalBuildInputs('pdf-page-ops').filter(file => file.startsWith('public/fonts/annotation/'));
const coverageRelativePath = 'packages/contracts/annotationFontCoverage.json';
const generatedRelativePath = 'packages/contracts/firstUnsupportedAnnotationCharacter.ts';
const fontFacesRelativePath = 'app/assets/css/annotation-fonts.scss';

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

function mappedCodepoints(font: Buffer) {
    const subtable = selectCmapSubtable(font, readTableOffset(font, 'cmap'));
    return [...subtable.format === 4
        ? format4Codepoints(font, subtable.offset)
        : format12Codepoints(font, subtable.offset)];
}

function toRanges(codepoints: number[]) {
    codepoints.sort((left, right) => left - right);
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

export function unicodeRanges(fonts: Buffer | readonly Buffer[]): Array<[number, number]> {
    return toRanges((Buffer.isBuffer(fonts) ? [fonts] : fonts).flatMap(mappedCodepoints));
}

// One face table drives the screen's @font-face fallback and native layout, so both
// choose the same font for every grapheme cluster. A script face claims the characters
// of the script its Noto family names and the combining marks it maps; shared
// punctuation, digits, spaces and tatweel stay with the last, general face, which claims
// whatever it maps. A decomposed Latin "u" + U+0308 therefore stays in the general face,
// because the script face does not claim the base letter.
export function faceRanges(files: readonly string[], programs: readonly Buffer[]) {
    const general = new Set(mappedCodepoints(programs.at(-1)!));
    return files.map((file, index) => {
        if (index === files.length - 1) return undefined;
        const script = /^NotoSans(\p{L}+)-/u.exec(file)?.[1];
        if (!script) throw new Error(`${file} does not name the script its face serves`);
        const own = new RegExp(`^[\\p{Script=${script}}\\p{Script=Inherited}]$`, 'u');
        const codepoints = mappedCodepoints(programs[index]!);
        const stranded = codepoints.find(code => !general.has(code) && !own.test(String.fromCodePoint(code))
            && !/^\p{Script=Common}$/u.test(String.fromCodePoint(code)));
        if (stranded !== undefined) {
            throw new Error(`${file} maps U+${stranded.toString(16)} outside its ${script} face`);
        }
        return toRanges(codepoints.filter(code => own.test(String.fromCodePoint(code))));
    });
}

export function renderAnnotationFontFaces(files: readonly string[], ranges: ReturnType<typeof faceRanges>) {
    const face = (family: string, file: string, range?: Array<[number, number]>) => [
        '@font-face {',
        `    font-family: "${family}";`,
        `    src: url("/fonts/annotation/${file}") format("truetype");`,
        '    font-style: normal;',
        '    font-weight: 400;',
        '    font-display: swap;',
        ...range
            ? [`    unicode-range: ${range.map(([
                start,
                end,
            ]) => `U+${hex(start)}${start === end ? '' : `-${hex(end)}`}`).join(', ')};`]
            : [],
        '}',
    ].join('\n');
    const hex = (code: number) => code.toString(16).toUpperCase().padStart(4, '0');
    // A later face of one family is tried first, so the first script face is declared last.
    const scripts = files.slice(0, -1).map((file, index) => face('EVB Annotation Scripts', file, ranges[index])).reverse();
    return [
        '/* Generated by scripts/generateFirstUnsupportedAnnotationCharacter.ts. */',
        ...scripts,
        face('EVB Annotation Sans', files.at(-1)!),
    ].join('\n\n').concat('\n');
}

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
            if (code < range[0]!) high = middle;
            else if (code > range[1]!) low = middle + 1;
            else break;
        }
        if (low === high) {
            return character;
        }
    }
    return undefined;
}
`;

export function renderFirstUnsupportedAnnotationCharacter() {
    return [
        '// Generated by scripts/generateFirstUnsupportedAnnotationCharacter.ts.',
        'import coverage from \'@contracts/annotationFontCoverage.json\';',
        '',
        'const ranges: ReadonlyArray<readonly number[]> = coverage.ranges;',
        '',
        TAIL,
    ].join('\n');
}

export async function generateFirstUnsupportedAnnotationCharacter(
    options: IGenerateFirstUnsupportedAnnotationCharacterOptions = {},
) {
    const root = options.projectRoot ?? projectRoot;
    const programs = await Promise.all(fontRelativePaths.map(file => readFile(path.join(root, file))));
    const files = fontRelativePaths.map(file => path.basename(file));
    const ranges = faceRanges(files, programs);
    const fonts = programs.map((program, index) => ({
        file: files[index],
        sha256: createHash('sha256').update(program).digest('hex'),
        unicodeRange: ranges[index],
    }));
    const changed = await Promise.all([
        writeGeneratedFileIfChanged(path.join(root, fontFacesRelativePath), renderAnnotationFontFaces(files, ranges)),
        writeGeneratedFileIfChanged(path.join(root, coverageRelativePath), `${JSON.stringify({
            fonts,
            ranges: unicodeRanges(programs),
        }, null, 2)}\n`),
        writeGeneratedFileIfChanged(path.join(root, generatedRelativePath), renderFirstUnsupportedAnnotationCharacter()),
    ]);
    return changed.some(Boolean);
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun && await generateFirstUnsupportedAnnotationCharacter()) {
    console.info('Generated the text box glyph support ranges.');
}
