#!/usr/bin/env node

/*
 * Build a small, deterministic RGB camera-page PDF for the export oracle.
 * The raster has a mild paper gradient, isolated dark sensor noise, and
 * printed block letters. It contains no material from a published document.
 */

import {
    mkdir,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';

const WIDTH = 320;
const HEIGHT = 240;
const DPI = 300;
const PAGE_WIDTH_POINTS = WIDTH * 72 / DPI;
const PAGE_HEIGHT_POINTS = HEIGHT * 72 / DPI;

function parseOutput(argv) {
    const index = argv.indexOf('--out');
    if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error('Usage: generate-scan-cleanup-rgb-fixture.mjs --out <pdf>');
    }
    return resolve(argv[index + 1]);
}

function makeRaster() {
    const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
    let state = 0x1f123bb5;
    const nextNoise = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state >>> 24;
    };
    for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
            const noise = nextNoise() % 9 - 4;
            const gradient = Math.round((x / WIDTH) * 9 + (y / HEIGHT) * 5);
            const base = 232 + gradient + noise;
            const offset = (y * WIDTH + x) * 3;
            pixels[offset] = Math.min(255, base + 2);
            pixels[offset + 1] = Math.min(255, base);
            pixels[offset + 2] = Math.min(255, base - 3);
        }
    }
    const glyphs = {
        A: [
            '01110',
            '10001',
            '10001',
            '11111',
            '10001',
            '10001',
            '10001',
        ],
        B: [
            '11110',
            '10001',
            '10001',
            '11110',
            '10001',
            '10001',
            '11110',
        ],
        C: [
            '01111',
            '10000',
            '10000',
            '10000',
            '10000',
            '10000',
            '01111',
        ],
        E: [
            '11111',
            '10000',
            '10000',
            '11110',
            '10000',
            '10000',
            '11111',
        ],
        G: [
            '01111',
            '10000',
            '10000',
            '10111',
            '10001',
            '10001',
            '01111',
        ],
        I: [
            '11111',
            '01110',
            '01110',
            '01110',
            '01110',
            '01110',
            '11111',
        ],
        M: [
            '10001',
            '11011',
            '10101',
            '10101',
            '10001',
            '10001',
            '10001',
        ],
        R: [
            '11110',
            '10001',
            '10001',
            '11110',
            '10100',
            '10010',
            '10001',
        ],
        S: [
            '01111',
            '10000',
            '10000',
            '01110',
            '00001',
            '00001',
            '11110',
        ],
        T: [
            '11111',
            '01100',
            '01100',
            '01100',
            '01100',
            '01100',
            '01100',
        ],
        X: [
            '10001',
            '10001',
            '01010',
            '00100',
            '01010',
            '10001',
            '10001',
        ],
    };
    const drawText = (
        text,
        left,
        top,
        scale,
        letterAdvanceScale = 6,
        spaceAdvanceScale = 3,
    ) => {
        let x = left;
        for (const letter of text) {
            if (letter === ' ') {
                x += scale * spaceAdvanceScale;
                continue;
            }
            const glyph = glyphs[letter];
            if (!glyph) {
                x += scale * 6;
                continue;
            }
            for (let row = 0; row < glyph.length; row += 1) {
                for (let column = 0; column < glyph[row].length; column += 1) {
                    if (glyph[row][column] !== '1') continue;
                    for (let yy = 0; yy < scale; yy += 1) {
                        for (let xx = 0; xx < scale; xx += 1) {
                            const targetX = x + column * scale + xx;
                            const targetY = top + row * scale + yy;
                            if (targetX < 0 || targetX >= WIDTH || targetY < 0 || targetY >= HEIGHT) continue;
                            const offset = (targetY * WIDTH + targetX) * 3;
                            pixels[offset] = 24;
                            pixels[offset + 1] = 25;
                            pixels[offset + 2] = 28;
                        }
                    }
                }
            }
            x += scale * letterAdvanceScale;
        }
    };
    drawText('RGB CAMERA', 28, 54, 4, 6, 15);
    drawText('BASE TEXT', 42, 126, 4, 6, 15);
    // Isolated dark sensor specks exercise the texture guard without making a
    // connected text-like component.
    for (const [
        x,
        y,
    ] of [
            [
                17,
                22,
            ],
            [
                81,
                32,
            ],
            [
                142,
                28,
            ],
            [
                205,
                41,
            ],
            [
                286,
                26,
            ],
            [
                301,
                180,
            ],
        ]) {
        const offset = (y * WIDTH + x) * 3;
        pixels[offset] = 108;
        pixels[offset + 1] = 112;
        pixels[offset + 2] = 115;
    }
    return pixels;
}

function makePdf(image) {
    const content = Buffer.from([
        'q',
        `${PAGE_WIDTH_POINTS} 0 0 ${PAGE_HEIGHT_POINTS} 0 0 cm`,
        '/Im0 Do',
        'Q',
    ].join('\n'), 'ascii');
    const imageDictionary = Buffer.from([
        `<< /Type /XObject /Subtype /Image /Width ${String(WIDTH)} /Height ${String(HEIGHT)}`,
        '/ColorSpace /DeviceRGB /BitsPerComponent 8',
        `/Length ${String(image.length)} >>`,
        'stream',
        '',
    ].join('\n'), 'ascii');
    const imageStream = Buffer.concat([
        imageDictionary,
        image,
        Buffer.from('\nendstream', 'ascii'),
    ]);
    const contentStream = Buffer.concat([
        Buffer.from(`<< /Length ${String(content.length)} >>\nstream\n`, 'ascii'),
        content,
        Buffer.from('\nendstream', 'ascii'),
    ]);
    const objects = [
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
        Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
        Buffer.from([
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH_POINTS} ${PAGE_HEIGHT_POINTS}]`,
            '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
        ].join(' '), 'ascii'),
        contentStream,
        imageStream,
        Buffer.from('<< /Producer (evb-viewer RGB oracle fixture) >>', 'ascii'),
    ];
    const chunks = [Buffer.from('%PDF-1.4\n', 'ascii')];
    const offsets = [];
    for (const [
        index,
        object,
    ] of objects.entries()) {
        offsets.push(chunks.reduce((total, chunk) => total + chunk.length, 0));
        chunks.push(
            Buffer.from(`${String(index + 1)} 0 obj\n`, 'ascii'),
            object,
            Buffer.from('\nendobj\n', 'ascii'),
        );
    }
    const xrefOffset = chunks.reduce((total, chunk) => total + chunk.length, 0);
    chunks.push(Buffer.from(`xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`, 'ascii'));
    for (const offset of offsets) {
        chunks.push(Buffer.from(`${String(offset).padStart(10, '0')} 00000 n \n`, 'ascii'));
    }
    chunks.push(Buffer.from([
        `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 6 0 R >>`,
        `startxref\n${String(xrefOffset)}\n%%EOF\n`,
    ].join('\n'), 'ascii'));
    return Buffer.concat(chunks);
}

export async function generateScanCleanupRgbFixture(outputPath) {
    const output = resolve(outputPath);
    await mkdir(dirname(output), {recursive: true});
    await writeFile(output, makePdf(makeRaster()));
    return output;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const output = await generateScanCleanupRgbFixture(parseOutput(process.argv.slice(2)));
    process.stdout.write(`Wrote RGB oracle fixture: ${output}\n`);
}
