import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createDjvuLibreEngine,
    type IDjvuLibreEngine,
    type TDjvuLibreModuleFactory,
} from '@djvu-core/djvuLibreEngine';
import { encodePpmP6 } from '@djvu-core/djvuPnm';

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
        expect(manifest.classes.map(entry => entry.id)).toEqual(expectedClasses);
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
                const [
                    imported,
                    wasmBytes,
                ] = await Promise.all([
                    import(pathToFileURL(resolve(process.cwd(), 'public/wasm/evb-djvulibre.mjs')).href) as Promise<{ default: TDjvuLibreModuleFactory }>,
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
        [
            'bitonal-faint-pencil.djvu',
            'bitonal-faint-pencil-page-1-72dpi.ppm',
            1,
        ],
        [
            'bitonal-faint-pencil.djvu',
            'bitonal-faint-pencil-page-2-72dpi.ppm',
            2,
        ],
        [
            'color-text-stamps-maps.djvu',
            'color-text-stamps-maps-72dpi.ppm',
            1,
        ],
        [
            'photo-art.djvu',
            'photo-art-72dpi.ppm',
            1,
        ],
        [
            'layered.djvu',
            'layered-72dpi.ppm',
            1,
        ],
        [
            'mixed-dpi.djvu',
            'mixed-dpi-page-1-72dpi.ppm',
            1,
        ],
        [
            'mixed-dpi.djvu',
            'mixed-dpi-page-2-72dpi.ppm',
            2,
        ],
    ] as const;

    for (const [
        source,
        golden,
        page,
    ] of goldenCases) {
        it(`matches ${golden} byte-for-byte at physical 72-DPI scale`, async () => {
            const bytes = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources', source)));
            const doc = await engine.openDocument({ initBytes: bytes });
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
        }, DJVU_TEST_TIMEOUT_MS);
    }

    it('proves the huge-page admission boundary and browser fixture page counts', async () => {
        const openAndRead = async (fixtureName: string) => {
            const bytes = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources', fixtureName)));
            const doc = await engine.openDocument({ initBytes: bytes });
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
    }, DJVU_TEST_TIMEOUT_MS);

    it('rejects the deterministic truncated DjVu fixture', async () => {
        const bytes = new Uint8Array(await readFile(resolve(corpusDirectory, 'sources/corrupt-truncated.djvu')));
        await expect((async () => {
            const doc = await engine.openDocument({ initBytes: bytes });
            try {
                await doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                });
            } finally {
                doc.close();
            }
        })()).rejects.toThrow();
    }, DJVU_TEST_TIMEOUT_MS);
});
