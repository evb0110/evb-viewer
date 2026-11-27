import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';
import {createDjvuLibreEngine, type IDjvuLibreEngine, type TDjvuLibreModuleFactory} from '@djvu-core/djvuLibreEngine';
import {encodePpmP6} from '@djvu-core/djvuPnm';
import {readDjvuSourceLayout} from '@djvu-core/djvuSourceLayout';

const expectedClasses = [
    'bitonal-faint-pencil',
    'color-text-stamps-maps',
    'photo-art',
    'layered',
    'mixed-dpi',
    'huge-pages',
    'corrupt-missing-tool-enospc',
    'browser-tiff',
    'browser-boundary',
] as const;
const DJVU_TEST_TIMEOUT_MS = 20_000;
const corpusDirectory = resolve(process.cwd(), 'tests/fixtures/djvu');

async function loadManifest() {
    return JSON.parse(await readFile(resolve(corpusDirectory, 'corpus-manifest.json'), 'utf8')) as IDjvuCorpusManifest;
}

interface IDjvuCorpusManifest {
    schemaVersion: number;
    comparisonScale: string;
    classes: Array<{
        fixture: string | null;
        id: string;
        license: string | null;
        sha256: string | null;
        status: 'acquisition-required' | 'ready';
    }>;
}

describe('DjVu fidelity corpus manifest', () => {
    it('tracks every required quality class without treating missing evidence as passing', async () => {
        const manifest = await loadManifest();

        expect(manifest.schemaVersion).toBe(1);
        expect(manifest.comparisonScale).toBe('matched-physical-page-size');
        expect(manifest.classes.map((entry) => entry.id)).toEqual(expectedClasses);
        for (const entry of manifest.classes) {
            if (entry.status === 'ready') {
                expect(entry.fixture).toMatch(/\.djvu$/iu);
                expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
                expect(entry.license).toBeTruthy();
                const fixture = await readFile(resolve(corpusDirectory, entry.fixture!));
                expect(createHash('sha256').update(fixture).digest('hex')).toBe(entry.sha256);
            } else {
                expect(entry.fixture).toBeNull();
                expect(entry.sha256).toBeNull();
                expect(entry.license).toBeNull();
            }
        }
    });
});

describe('generated DjVu fidelity goldens (DjVuLibre WASM)', () => {
    let engine: IDjvuLibreEngine;

    beforeAll(() => {
        engine = createDjvuLibreEngine({
            loadEngine: async () => {
                const [imported, wasmBytes] = await Promise.all([
                    import(pathToFileURL(resolve(process.cwd(), 'public/wasm/evb-djvulibre.mjs')).href) as Promise<{
                        default: TDjvuLibreModuleFactory;
                    }>,
                    readFile(resolve(process.cwd(), 'public/wasm/evb-djvulibre.wasm')),
                ]);
                return {
                    factory: imported.default,
                    module: await WebAssembly.compile(wasmBytes),
                };
            },
        });
    });

    const goldenCases = [
        ['bitonal-faint-pencil.djvu', 'bitonal-faint-pencil-page-1-72dpi.ppm', 1],
        ['bitonal-faint-pencil.djvu', 'bitonal-faint-pencil-page-2-72dpi.ppm', 2],
        ['color-text-stamps-maps.djvu', 'color-text-stamps-maps-72dpi.ppm', 1],
        ['photo-art.djvu', 'photo-art-72dpi.ppm', 1],
        ['layered.djvu', 'layered-72dpi.ppm', 1],
        ['mixed-dpi.djvu', 'mixed-dpi-page-1-72dpi.ppm', 1],
        ['mixed-dpi.djvu', 'mixed-dpi-page-2-72dpi.ppm', 2],
    ] as const;

    for (const [source, golden, page] of goldenCases) {
        it(
            `matches ${golden} byte-for-byte at physical 72-DPI scale`,
            async () => {
                const bytes = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources', source)));
                const doc = await engine.openDocument({initBytes: bytes});
                try {
                    const pageInfo = await doc.getPageInfo(page);
                    // Exact ddjvu -scale=72 formula: floor((dim * 72) / dpi), then aspect clamp.
                    let targetWidth = Math.max(1, Math.floor((pageInfo.width * 72) / pageInfo.dpi));
                    let targetHeight = Math.max(1, Math.floor((pageInfo.height * 72) / pageInfo.dpi));
                    if (targetWidth * pageInfo.height > targetHeight * pageInfo.width) {
                        targetWidth = Math.max(1, Math.floor((targetHeight * pageInfo.width) / pageInfo.height));
                    } else if (targetHeight * pageInfo.width > targetWidth * pageInfo.height) {
                        targetHeight = Math.max(1, Math.floor((targetWidth * pageInfo.height) / pageInfo.width));
                    }
                    const rendered = await doc.renderPage(page, {
                        mode: 'color',
                        pixelFormat: 'rgb',
                        targetWidth,
                        targetHeight,
                    });
                    const ppm = Buffer.from(encodePpmP6(rendered.width, rendered.height, rendered.bytes));
                    expect(ppm).toEqual(await readFile(resolve(corpusDirectory, 'goldens', golden)));
                } finally {
                    doc.close();
                }
            },
            DJVU_TEST_TIMEOUT_MS,
        );
    }

    it(
        'proves the huge-page admission boundary and browser fixture page counts',
        async () => {
            const openAndRead = async (fixtureName: string) => {
                const bytes = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources', fixtureName)));
                const doc = await engine.openDocument({initBytes: bytes});
                try {
                    const docInfo = await doc.getDocInfo();
                    const page1 = await doc.getPageInfo(1);
                    return {
                        docInfo,
                        page1,
                    };
                } finally {
                    doc.close();
                }
            };

            const huge = await openAndRead('huge-page.djvu');
            const boundary = await openAndRead('browser-boundary-501-pages.djvu');
            const tiff = await openAndRead('browser-tiff-5-pages.djvu');

            expect(huge.page1.width).toBe(10000);
            expect(huge.page1.height).toBe(8001);
            expect(boundary.docInfo.pageCount).toBe(501);
            expect(tiff.docInfo.pageCount).toBe(5);
        },
        DJVU_TEST_TIMEOUT_MS,
    );

    it(
        'rejects the deterministic truncated DjVu fixture',
        async () => {
            const bytes = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources/corrupt-truncated.djvu')));
            await expect(
                (async () => {
                    const doc = await engine.openDocument({initBytes: bytes});
                    try {
                        await doc.renderPage(1, {
                            mode: 'color',
                            pixelFormat: 'rgb',
                        });
                    } finally {
                        doc.close();
                    }
                })(),
            ).rejects.toThrow();
        },
        DJVU_TEST_TIMEOUT_MS,
    );

    it(
        'reports upright dimensions and quarter-turn degrees for rotated INFO flags',
        async () => {
            const baseBytes = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources/photo-art.djvu')));
            // Locate the INFO chunk payload inside FORM:DJVU (byte 9 holds raw orientation flags).
            const infoTagOffset = Buffer.from(baseBytes).indexOf('INFO', 12, 'ascii');
            expect(infoTagOffset).toBeGreaterThanOrEqual(16);
            const flagByteOffset = infoTagOffset + 8 + 9;

            for (const [rawFlag, expectedRotation, expectedWidth, expectedHeight] of [
                [6, 90, 480, 640],
                [2, 180, 640, 480],
                [5, 270, 480, 640],
            ] as const) {
                const mutated = new Uint8Array(baseBytes);
                mutated[flagByteOffset] = rawFlag;
                const doc = await engine.openDocument({initBytes: mutated});
                try {
                    const info = await doc.getPageInfo(1);
                    const structure = await doc.getPageStructure(1);
                    const rendered = await doc.renderPage(1, {
                        mode: 'color',
                        pixelFormat: 'rgb',
                    });
                    expect(info.rotation).toBe(expectedRotation);
                    expect(info.width).toBe(expectedWidth);
                    expect(info.height).toBe(expectedHeight);
                    expect(structure.rotation).toBe(expectedRotation);
                    expect(structure.info?.width).toBe(expectedWidth);
                    expect(structure.info?.height).toBe(expectedHeight);
                    expect(rendered.width).toBe(expectedWidth);
                    expect(rendered.height).toBe(expectedHeight);
                } finally {
                    doc.close();
                }
            }
        },
        DJVU_TEST_TIMEOUT_MS,
    );

    it(
        'renders an indirect page component named index.djvu without colliding with the document index',
        async () => {
            const pageBytes = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources/indirect/low-dpi.djvu')));
            // Pre-encoded 1-page indirect FORM:DJVM (DIRM v1) whose sole page component ID is "index.djvu".
            const indirectIndex = new Uint8Array(Buffer.from('QVQmVEZPUk0AAAAkREpWTURJUk0AAAAXAQAB///vv4of0WXVdBnixB02vqU3QRcA', 'base64'));
            const fetched: string[] = [];
            const doc = await engine.openDocument({
                initBytes: indirectIndex,
                readComponentAsync: async (name) => {
                    fetched.push(name);
                    expect(name).toBe('index.djvu');
                    return pageBytes;
                },
            });
            try {
                const info = await doc.getPageInfo(1);
                const rendered = await doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                    targetWidth: 64,
                    targetHeight: 48,
                });
                expect(info.width).toBe(640);
                expect(info.height).toBe(480);
                expect(rendered.width).toBe(64);
                expect(rendered.height).toBe(48);
                expect(fetched).toEqual(['index.djvu']);
            } finally {
                doc.close();
            }
        },
        DJVU_TEST_TIMEOUT_MS,
    );

    it(
        'renders an async component larger than the 32 MiB cache limit in a single fetch',
        async () => {
            const indirectIndex = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources/indirect/index.djvu')));
            const basePage = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources/indirect/low-dpi.djvu')));
            // Append a valid unknown IFF chunk ('EVBP') inside FORM:DJVU to grow the component past 32 MiB.
            const padPayloadBytes = 33 * 1024 * 1024;
            const origFormSize = new DataView(basePage.buffer, basePage.byteOffset, basePage.byteLength).getUint32(8);
            const padChunkTotal = 8 + padPayloadBytes;
            const paddedStart = basePage.byteLength + (basePage.byteLength & 1);
            const hugeComponent = new Uint8Array(paddedStart + padChunkTotal);
            hugeComponent.set(basePage, 0);
            const dv = new DataView(hugeComponent.buffer);
            dv.setUint32(8, origFormSize + (paddedStart - basePage.byteLength) + padChunkTotal);
            hugeComponent.set(Buffer.from('EVBP', 'ascii'), paddedStart);
            dv.setUint32(paddedStart + 4, padPayloadBytes);

            let fetchCount = 0;
            const doc = await engine.openDocument({
                initBytes: indirectIndex,
                readComponentAsync: async (name) => {
                    expect(name).toBe('low-dpi.djvu');
                    fetchCount += 1;
                    return hugeComponent;
                },
            });
            try {
                const rendered = await doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                    targetWidth: 64,
                    targetHeight: 48,
                });
                expect(rendered.width).toBe(64);
                expect(rendered.height).toBe(48);
                expect(fetchCount).toBe(1);
            } finally {
                doc.close();
            }
        },
        DJVU_TEST_TIMEOUT_MS,
    );

    it(
        'rewrites bundled DIRM v0 (7-byte offset+size records) into a valid indirect index',
        async () => {
            const v1Bundled = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources/searchable-mixed-dpi.djvu')));
            // Read the existing v1 DIRM payload and construct a synthetic bundled DIRM v0 payload
            // with 7-byte (4-byte offset + 3-byte size) records before the BZZ stream.
            const dirmLen = new DataView(v1Bundled.buffer, v1Bundled.byteOffset, v1Bundled.byteLength).getUint32(20);
            const dirmV1 = v1Bundled.subarray(24, 24 + dirmLen);
            const fileCount = (dirmV1[1]! << 8) | dirmV1[2]!;
            const v0Dirm = new Uint8Array(3 + fileCount * 7 + (dirmV1.byteLength - (3 + fileCount * 4)));
            v0Dirm[0] = 0x80; // bundled + version 0
            v0Dirm[1] = dirmV1[1]!;
            v0Dirm[2] = dirmV1[2]!;
            const v0View = new DataView(v0Dirm.buffer);
            const v1View = new DataView(dirmV1.buffer, dirmV1.byteOffset, dirmV1.byteLength);
            const deltaBytes = fileCount * 3;
            const paddedDelta = (deltaBytes + (dirmLen & 1)) & ~1;
            for (let i = 0; i < fileCount; i += 1) {
                const origOffset = v1View.getUint32(3 + i * 4);
                v0View.setUint32(3 + i * 7, origOffset + paddedDelta);
                // 3-byte big-endian size placeholder (100 bytes).
                v0Dirm[3 + i * 7 + 4] = 0;
                v0Dirm[3 + i * 7 + 5] = 0;
                v0Dirm[3 + i * 7 + 6] = 100;
            }
            v0Dirm.set(dirmV1.subarray(3 + fileCount * 4), 3 + fileCount * 7);

            const v1DirmPaddedLen = 8 + dirmLen + (dirmLen & 1);
            const v0DirmPaddedLen = 8 + v0Dirm.byteLength + (v0Dirm.byteLength & 1);
            const restAfterDirm = v1Bundled.subarray(16 + v1DirmPaddedLen);
            const v0Bundled = new Uint8Array(16 + v0DirmPaddedLen + restAfterDirm.byteLength);
            v0Bundled.set(v1Bundled.subarray(0, 16), 0);
            new DataView(v0Bundled.buffer).setUint32(8, 4 + v0DirmPaddedLen + restAfterDirm.byteLength);
            v0Bundled.set(Buffer.from('DIRM', 'ascii'), 16);
            new DataView(v0Bundled.buffer).setUint32(20, v0Dirm.byteLength);
            v0Bundled.set(v0Dirm, 24);
            v0Bundled.set(restAfterDirm, 16 + v0DirmPaddedLen);

            const layout = await readDjvuSourceLayout({
                fileSize: v0Bundled.byteLength,
                readRange: async (offset, length) => v0Bundled.subarray(offset, offset + length),
            });
            expect(layout.hasComponents).toBe(true);
            expect(layout.bundledOffsets).toHaveLength(fileCount);
            expect(layout.documentBytes[24]).toBe(0x00); // indirect + version 0
            // The rewritten indirect DIRM must strip all 7-byte bundled records (3 + tail bytes only).
            const rewrittenDirmLen = new DataView(layout.documentBytes.buffer).getUint32(20);
            expect(rewrittenDirmLen).toBe(3 + (dirmV1.byteLength - (3 + fileCount * 4)));
        },
        DJVU_TEST_TIMEOUT_MS,
    );
});
