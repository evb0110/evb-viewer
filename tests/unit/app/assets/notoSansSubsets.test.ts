import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compile} from 'sass-embedded';
import {describe, expect, it} from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const MAIN_CSS_PATH = path.join(REPO_ROOT, 'app/assets/css/main.css');
const TOOLBAR_SHARED_SCSS_PATH = path.join(REPO_ROOT, 'app/assets/css/_toolbar-menu-shared.scss');
const TOOLBAR_GLOBAL_SCSS_PATH = path.join(REPO_ROOT, 'app/assets/css/toolbar-menu.scss');
const LOCALES_DIR = path.join(REPO_ROOT, 'packages/i18n-app/messages');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

// Symbols used in shortcut/comparison copy that fall back to the OS UI font (absent from upstream Noto Sans).
const SYSTEM_FALLBACK_SYMBOLS = new Set([0x2192, 0x2265, 0x2318]);

interface IFontFaceSubset {
    style: string;
    url: string;
    ranges: Array<[number, number]>;
}

interface IShapedGlyph {
    g: string;
    cl: number;
    ax: number;
    dx: number;
    dy: number;
}

function parseUnicodeRange(value: string): Array<[number, number]> {
    return value
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
        .map((token) => {
            const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/iu.exec(token);
            if (!match?.[1]) {
                throw new Error(`Invalid unicode-range token: ${token}`);
            }
            const start = Number.parseInt(match[1], 16);
            const end = match[2] ? Number.parseInt(match[2], 16) : start;
            return [start, end] as [number, number];
        });
}

function parseNotoFontFaces(css: string): IFontFaceSubset[] {
    const faces: IFontFaceSubset[] = [];
    for (const match of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gu)) {
        const body = match[1] ?? '';
        if (!body.includes("'EVB Noto Sans'")) {
            continue;
        }
        const style = /font-style:\s*([^;]+);/u.exec(body)?.[1]?.trim() ?? '';
        const url = /src:\s*url\(['"](\/fonts\/noto-sans\/[^'"]+\.woff2)['"]\)/u.exec(body)?.[1] ?? '';
        const rangeText = /unicode-range:\s*([\s\S]*?);/u.exec(body)?.[1] ?? '';
        faces.push({
            style,
            url,
            ranges: parseUnicodeRange(rangeText),
        });
    }
    return faces;
}

function inRanges(codepoint: number, ranges: ReadonlyArray<[number, number]>) {
    return ranges.some(([start, end]) => codepoint >= start && codepoint <= end);
}

function findMatchingFace(faces: readonly IFontFaceSubset[], style: string, codepoint: number) {
    // CSS font matching checks @font-face rules in reverse declaration order (last matching face wins).
    for (let index = faces.length - 1; index >= 0; index -= 1) {
        const face = faces[index]!;
        if (face.style === style && inRanges(codepoint, face.ranges)) {
            return face;
        }
    }
    return null;
}

function hasHarfBuzzAndWoff2Tools() {
    // woff2_decompress exits non-zero without a file argument, so probe binary presence via spawnSync.error.
    const hb = spawnSync('hb-shape', ['--version'], {stdio: 'ignore'});
    const woff2 = spawnSync('woff2_decompress', [], {stdio: 'ignore'});
    return !hb.error && !woff2.error;
}

describe('Noto Sans unicode-range subsets and toolbar-menu stylesheet dedup', () => {
    it('ships valid local WOFF2 subsets covering every Noto Sans glyph across all 9 locales', () => {
        const mainCss = readFileSync(MAIN_CSS_PATH, 'utf8');
        const faces = parseNotoFontFaces(mainCss);
        expect(faces.length).toBeGreaterThanOrEqual(4);

        for (const face of faces) {
            const filePath = path.join(PUBLIC_DIR, face.url.slice(1));
            const bytes = readFileSync(filePath);
            expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
            expect(face.ranges.length).toBeGreaterThan(0);
        }

        const normalLatin = faces.find((face) => face.style === 'normal' && face.url.endsWith('/noto-sans-latin-variable.woff2'));
        const normalCyrillic = faces.find((face) => face.style === 'normal' && face.url.endsWith('/noto-sans-cyrillic-variable.woff2'));
        expect(normalLatin).toBeDefined();
        expect(normalCyrillic).toBeDefined();

        const latinSize = readFileSync(path.join(PUBLIC_DIR, normalLatin!.url.slice(1))).byteLength;
        expect(latinSize).toBeLessThan(80 * 1024);

        const localeFiles = readdirSync(LOCALES_DIR)
            .filter((file) => file.endsWith('.ts'))
            .sort();
        expect(localeFiles).toHaveLength(9);

        const primaryRanges = [...normalLatin!.ranges, ...normalCyrillic!.ranges];
        const uncovered: string[] = [];
        for (const file of localeFiles) {
            const content = readFileSync(path.join(LOCALES_DIR, file), 'utf8');
            for (const ch of content) {
                const cp = ch.codePointAt(0)!;
                if (cp <= 0x20 || SYSTEM_FALLBACK_SYMBOLS.has(cp)) {
                    continue;
                }
                if (!inRanges(cp, primaryRanges)) {
                    uncovered.push(`${file}: ${ch} (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`);
                }
            }
        }
        expect(uncovered).toEqual([]);
    });

    it('keeps combining diacritical marks with compatible base glyphs so decomposed clusters shape without missing glyphs', () => {
        const mainCss = readFileSync(MAIN_CSS_PATH, 'utf8');
        const faces = parseNotoFontFaces(mainCss);

        // Base 'x' (U+0078) and combining acute accent (U+0301) must resolve to the same Latin face.
        for (const style of ['normal', 'italic'] as const) {
            const baseFace = findMatchingFace(faces, style, 0x0078);
            const markFace = findMatchingFace(faces, style, 0x0301);
            expect(baseFace).not.toBeNull();
            expect(markFace?.url).toBe(baseFace?.url);

            // Cyrillic subset also includes Cyrillic combining accents (e.g. U+0430 + U+0301).
            const cyrillicFace = faces.find((face) => face.style === style && face.url.includes('cyrillic-variable'));
            expect(cyrillicFace).toBeDefined();
            expect(inRanges(0x0430, cyrillicFace!.ranges)).toBe(true);
            expect(inRanges(0x0301, cyrillicFace!.ranges)).toBe(true);
        }

        if (!hasHarfBuzzAndWoff2Tools()) {
            return;
        }

        const tempDir = mkdtempSync(path.join(tmpdir(), 'noto-shape-check-'));
        try {
            const samples: Array<{file: string; text: string}> = [
                {file: 'fonts/noto-sans/noto-sans-latin-variable.woff2', text: 'x\u0301'},
                {file: 'fonts/noto-sans/noto-sans-italic-latin-variable.woff2', text: 'x\u0301'},
                {file: 'fonts/noto-sans/noto-sans-cyrillic-variable.woff2', text: 'а\u0301'},
                {file: 'fonts/noto-sans/noto-sans-italic-cyrillic-variable.woff2', text: 'а\u0301'},
            ];

            for (const sample of samples) {
                const woff2Copy = path.join(tempDir, path.basename(sample.file));
                const ttfPath = woff2Copy.replace(/\.woff2$/u, '.ttf');
                writeFileSync(woff2Copy, readFileSync(path.join(PUBLIC_DIR, sample.file)));
                execFileSync('woff2_decompress', [woff2Copy], {stdio: 'ignore'});
                const shaped = JSON.parse(
                    execFileSync('hb-shape', [ttfPath, '--output-format=json', `--text=${sample.text}`], {encoding: 'utf8'}),
                ) as IShapedGlyph[];

                expect(shaped).toHaveLength(2);
                expect(shaped.every((glyph) => glyph.g !== '.notdef')).toBe(true);
                expect(shaped[0]?.cl).toBe(0);
                expect(shaped[1]?.cl).toBe(0);
                expect(shaped[0]!.ax).toBeGreaterThan(0);
                expect(shaped[1]!.ax).toBe(0);
            }
        } finally {
            rmSync(tempDir, {recursive: true, force: true});
        }
    });

    it('emits shared toolbar-menu styles once in toolbar-menu.scss and nothing from _toolbar-menu-shared.scss', () => {
        const sharedCompiled = compile(TOOLBAR_SHARED_SCSS_PATH).css.trim();
        const globalCompiled = compile(TOOLBAR_GLOBAL_SCSS_PATH).css;

        expect(sharedCompiled).toBe('');
        expect(globalCompiled).toContain('.toolbar-menu-panel');
        expect(globalCompiled).toContain('.toolbar-menu-item');
        expect(globalCompiled).toContain('var(--app-toolbar-menu-popover-bg)');
    });
});
