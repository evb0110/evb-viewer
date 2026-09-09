import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {
    requireEpochMs,
    requireIsoTimestamp,
} from '@contracts/timestamps';
import {
    encodeOcrShardIndex,
    type IOcrGenerationV4,
    type IOcrIndexV3Manifest,
    type IOcrPageMappingV4,
    type IOcrShardV4,
    type TOcrPageArtifact,
} from '@contracts/ocrIndex';
import {
    OcrCatalogCorruptError,
    OcrCatalogFencedError,
    OcrCatalogPathError,
    openCatalog,
    readCatalogFile,
    resolveCatalogPath,
    type IOcrCatalogHandle,
} from '@electron/features/ocr/main/ocrCatalogV4';

const revision = requireDocumentRevisionToken('drt1:ocr-catalog-v4-test');
const catalogId = '123e4567-e89b-42d3-a456-426614174000';
const generation = 1;
const generationDirectory = 'gen-00000001';
const roots: string[] = [];

const page: TOcrPageArtifact = {
    rotation: 0,
    render: {
        dpi: 300,
        imagePx: {
            w: 1200,
            h: 1600,
        },
    },
    text: 'page one',
    words: [],
};

function mapping(pageNumber: number, pageGeneration = generation): IOcrPageMappingV4 {
    return {
        path: `${generationDirectory}/pages/${String(Math.floor((pageNumber - 1) / 256)).padStart(6, '0')}/p${String(pageNumber).padStart(8, '0')}.json`,
        generation: pageGeneration,
    };
}

async function collectWindow(handle: IOcrCatalogHandle, start: number, count: number) {
    const pages = [];
    for await (const page of handle.readWindow(start, count)) {
        pages.push(page);
    }
    return pages;
}

async function createRoot(pageCount = 2, mappedPages = [1]) {
    const root = await mkdtemp(join(tmpdir(), 'evb-ocr-catalog-v4-'));
    roots.push(root);
    const shardCount = Math.ceil(pageCount / 256);
    const generationManifest: IOcrGenerationV4 = {
        version: 4,
        catalogId,
        generation,
        parent: null,
        source: {pdfPath: join(root, 'document.pdf')},
        documentRevision: {token: revision},
        pageCount,
        shardSize: 256,
        shardCount,
        mappedPageCount: mappedPages.length,
        createdAt: requireIsoTimestamp('2026-08-27T00:00:00.000Z'),
        dirtyShards: [...new Set(mappedPages.map(pageNumber => Math.floor((pageNumber - 1) / 256)))],
        liveRefs: {
            [String(generation)]: mappedPages.length,
            '0': 0,
        },
        releasedGenerations: [],
        releasedLegacyPaths: [],
    };
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
        version: 4,
        catalogId,
        source: generationManifest.source,
        documentRevision: generationManifest.documentRevision,
        pageCount,
        shardSize: 256,
        generation,
        publishedAt: '2026-08-27T00:00:00.000Z',
    }));
    const generationRoot = join(root, generationDirectory);
    await mkdir(join(generationRoot, 'pages'), {recursive: true});
    await mkdir(join(generationRoot, 'shards'), {recursive: true});
    await writeFile(join(generationRoot, 'generation.json'), JSON.stringify(generationManifest));
    const records = Array.from({length: shardCount}, (_value, shard) => ({
        generation: mappedPages.some(pageNumber => Math.floor((pageNumber - 1) / 256) === shard)
            ? generation
            : 0,
        mappedCount: mappedPages.filter(pageNumber => Math.floor((pageNumber - 1) / 256) === shard).length,
        reserved: 0 as const,
    }));
    await writeFile(join(generationRoot, 'shards.idx'), encodeOcrShardIndex(records));
    for (const pageNumber of mappedPages) {
        const pageMapping = mapping(pageNumber);
        await mkdir(join(root, pageMapping.path, '..'), {recursive: true});
        await writeFile(join(root, pageMapping.path), JSON.stringify(page));
    }
    const shards = new Map<number, IOcrPageMappingV4[]>();
    for (const pageNumber of mappedPages) {
        const shard = Math.floor((pageNumber - 1) / 256);
        const entries = shards.get(shard) ?? [];
        entries.push(mapping(pageNumber));
        shards.set(shard, entries);
    }
    for (const [
        shard,
        entries,
    ] of shards) {
        const pageNumbers = mappedPages.filter(pageNumber => Math.floor((pageNumber - 1) / 256) === shard);
        const shardValue: IOcrShardV4 = {
            version: 4,
            generation,
            shard,
            pages: Object.fromEntries(pageNumbers.map((pageNumber, index) => [
                String(pageNumber),
                entries[index]!,
            ])) as Record<string, IOcrPageMappingV4>,
        };
        await writeFile(join(generationRoot, 'shards', `shard-${String(shard).padStart(6, '0')}.json`), JSON.stringify(shardValue));
    }
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('OCR catalog v4 path confinement', () => {
    it('accepts normalized relative paths and rejects reinterpretation', () => {
        expect(resolveCatalogPath('/tmp/catalog', 'nested/page.json')).toBe('/tmp/catalog/nested/page.json');
        for (const path of [
            '',
            '../page.json',
            './page.json',
            'nested/../page.json',
            'nested\\page.json',
            '/tmp/page.json',
            'C:/page.json',
            'C:page.json',
        ]) {
            expect(() => resolveCatalogPath('/tmp/catalog', path)).toThrow(OcrCatalogPathError);
        }
        expect(() => resolveCatalogPath('/tmp/catalog', 'gen-1/pages/000000/p00000001.json')).toThrow(OcrCatalogPathError);
        expect(() => resolveCatalogPath('/tmp/catalog', 'gen-00000001/pages/000000/p00000001.json', {kind: 'legacy'})).toThrow(OcrCatalogPathError);
    });

    it('rejects symlinked page artifacts', async () => {
        const root = await createRoot();
        const pagePath = mapping(1).path;
        const targetPath = join(root, 'outside-page.json');
        await writeFile(targetPath, JSON.stringify(page));
        await rm(join(root, pagePath));
        await symlink(targetPath, join(root, pagePath));
        const handle = await openCatalog(root);
        await expect(handle?.readPage(1)).rejects.toThrow(OcrCatalogPathError);
        await handle?.close?.();
    });

    it('treats a missing or malformed v4 artifact as catalog corruption', async () => {
        const root = await createRoot();
        const pagePath = mapping(1).path;
        await rm(join(root, pagePath));
        const handle = await openCatalog(root);
        await expect(handle?.readPage(1)).rejects.toThrow(OcrCatalogCorruptError);

        await writeFile(join(root, pagePath), '{');
        await expect(handle?.readPage(1)).rejects.toThrow(OcrCatalogCorruptError);
        await handle?.close?.();
    });

    it('rejects a symlinked ancestor directory', async () => {
        const root = await createRoot();
        const pagesPath = join(root, generationDirectory, 'pages');
        const outsidePagesPath = join(root, 'outside-pages');
        await mkdir(join(outsidePagesPath, '000000'), {recursive: true});
        await writeFile(join(outsidePagesPath, '000000', 'p00000001.json'), JSON.stringify(page));
        await rm(pagesPath, {
            recursive: true,
            force: true,
        });
        await symlink(outsidePagesPath, pagesPath);
        const handle = await openCatalog(root);
        await expect(handle?.readPage(1)).rejects.toThrow(OcrCatalogPathError);
        await handle?.close?.();
    });

    it('validates the catalog root before direct artifact reads', async () => {
        const root = await createRoot();
        await expect(readCatalogFile(root, mapping(1).path, {kind: 'canonical-v4'})).resolves.toEqual(
            Buffer.from(JSON.stringify(page)),
        );
        await expect(readCatalogFile(root, '../outside-page.json')).rejects.toThrow(OcrCatalogPathError);
    });
});

describe('OCR catalog v4 reader', () => {
    it('reads scalar metadata, one page, a two-shard window, and streams mapped pages', async () => {
        const root = await createRoot(257, [
            1,
            257,
        ]);
        const handle = await openCatalog(root);
        expect(handle?.header).toMatchObject({
            version: 4,
            catalogId,
            pageCount: 257,
            mappedPageCount: 2,
            complete: false,
        });
        await expect(handle?.readPage(1)).resolves.toEqual(page);
        await expect(handle?.readPage(2)).resolves.toBeNull();
        await expect(collectWindow(handle!, 255, 3)).resolves.toEqual([
            {
                pageNumber: 255,
                artifact: null,
            },
            {
                pageNumber: 256,
                artifact: null,
            },
            {
                pageNumber: 257,
                artifact: page,
            },
        ]);
        await expect(handle?.windowAvailability(255, 3)).resolves.toEqual(new Uint8Array([
            0,
            0,
            1,
        ]));
        await expect(handle?.findFirstUnmapped()).resolves.toBe(2);
        const mapped: number[] = [];
        for await (const item of handle!.iterateMappedPages()) {
            mapped.push(item.pageNumber);
        }
        expect(mapped).toEqual([
            1,
            257,
        ]);
        await handle?.close?.();
    });

    it('rejects a revision fence, truncated index, malformed shard, and oversized snapshot', async () => {
        const root = await createRoot();
        await expect(openCatalog(root, {expectedDocumentRevision: requireDocumentRevisionToken('drt1:other')})).rejects.toThrow(OcrCatalogFencedError);

        const generationPath = join(root, generationDirectory, 'generation.json');
        const generationManifest = JSON.parse(await readFile(generationPath, 'utf8')) as IOcrGenerationV4;
        await writeFile(generationPath, JSON.stringify({
            ...generationManifest,
            mappedPageCount: generationManifest.mappedPageCount + 1,
        }));
        await expect(openCatalog(root)).rejects.toThrow(OcrCatalogCorruptError);
        await writeFile(generationPath, JSON.stringify(generationManifest));

        await writeFile(join(root, generationDirectory, 'shards.idx'), Buffer.alloc(16));
        await expect(openCatalog(root)).rejects.toThrow(OcrCatalogCorruptError);

        const largeRoot = await createRoot(5_000_000, []);
        const largeHandle = await openCatalog(largeRoot);
        expect(largeHandle).toBeTruthy();
        await largeHandle?.close?.();
    });

    it('fails closed when a root declares version 4 but is malformed', async () => {
        const root = await createRoot();
        await writeFile(join(root, 'manifest.json'), '{"version":"4","catalogId":');
        await expect(openCatalog(root)).rejects.toThrow(OcrCatalogCorruptError);
    });
});

describe('OCR catalog v3 compatibility adapter', () => {
    it('keeps arbitrary legacy mapping paths readable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-ocr-catalog-v3-'));
        roots.push(root);
        const legacyPagePath = 'nested/legacy.json';
        await mkdir(join(root, 'nested'), {recursive: true});
        await writeFile(join(root, legacyPagePath), JSON.stringify(page));
        const manifest: IOcrIndexV3Manifest = {
            version: 3,
            documentRevision: {token: revision},
            createdAt: requireEpochMs(Date.now()),
            source: {pdfPath: join(root, 'document.pdf')},
            pageCount: 1,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {1: {path: legacyPagePath}},
        };
        await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
        const handle = await openCatalog(root);
        expect(handle?.header.version).toBe(3);
        await expect(handle?.readPage(1)).resolves.toEqual(page);
        await handle?.close?.();
    });

    it('streams a sparse logical million-page manifest without materializing pages', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-ocr-catalog-v3-large-'));
        roots.push(root);
        const firstPath = 'legacy/first.json';
        const lastPath = 'legacy/last.json';
        await mkdir(join(root, 'legacy'), {recursive: true});
        await writeFile(join(root, firstPath), JSON.stringify(page));
        await writeFile(join(root, lastPath), JSON.stringify({
            ...page,
            text: 'last',
        }));
        const manifest: IOcrIndexV3Manifest = {
            version: 3,
            documentRevision: {token: revision},
            createdAt: requireEpochMs(Date.now()),
            source: {pdfPath: join(root, `${'d'.repeat(1_100)}.pdf`)},
            pageCount: 1_000_000,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {
                1: {path: firstPath},
                999_999: {path: lastPath},
            },
        };
        const manifestPath = join(root, 'manifest.json');
        await writeFile(manifestPath, JSON.stringify(manifest));
        expect((await stat(manifestPath)).size).toBeGreaterThan(1_024);
        const handle = await openCatalog(root);
        expect(handle?.header).toMatchObject({
            version: 3,
            pageCount: 1_000_000,
            mappedPageCount: 2,
        });
        await expect(handle?.readPage(999_999)).resolves.toMatchObject({text: 'last'});
        await expect(handle?.findFirstUnmapped()).resolves.toBe(2);
        await expect(handle?.readWindowMappings(999_900, 100)).resolves.toContainEqual({
            pageNumber: 999_999,
            mapping: {
                path: lastPath,
                generation: 0,
            },
        });
        await handle?.close?.();
    });

    it('applies confinement to legacy mappings returned by a window read', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-ocr-catalog-v3-path-'));
        roots.push(root);
        const manifest: IOcrIndexV3Manifest = {
            version: 3,
            documentRevision: {token: revision},
            createdAt: requireEpochMs(Date.now()),
            source: {pdfPath: join(root, 'document.pdf')},
            pageCount: 1,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {1: {path: '../outside-page.json'}},
        };
        await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
        const handle = await openCatalog(root);
        await expect(handle?.readWindowMappings(1, 1)).rejects.toThrow(OcrCatalogPathError);
        await handle?.close?.();
    });
});

describe('OCR catalog artifact validation (SRCH-004)', () => {
    it('reports a v4 page whose artifact is not JSON as unavailable', async () => {
        const root = await createRoot(2, [1]);
        await writeFile(join(root, mapping(1).path), 'not json');
        const handle = await openCatalog(root);

        await expect(handle?.windowAvailability(1, 2)).resolves.toEqual(new Uint8Array([
            0,
            0,
        ]));
        await expect(collectWindow(handle!, 1, 2)).resolves.toEqual([
            {
                pageNumber: 1,
                artifact: null,
            },
            {
                pageNumber: 2,
                artifact: null,
            },
        ]);
        await handle?.close?.();
    });

    it('reports a v4 page whose artifact fails the page schema as unavailable', async () => {
        const root = await createRoot(2, [1]);
        await writeFile(join(root, mapping(1).path), JSON.stringify({text: 5}));
        const handle = await openCatalog(root);

        await expect(handle?.windowAvailability(1, 2)).resolves.toEqual(new Uint8Array([
            0,
            0,
        ]));
        await handle?.close?.();
    });

    it('reports a v3 page whose artifact is corrupt as unavailable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-ocr-catalog-v3-corrupt-'));
        roots.push(root);
        const goodPath = 'legacy/good.json';
        const badPath = 'legacy/bad.json';
        await mkdir(join(root, 'legacy'), {recursive: true});
        await writeFile(join(root, goodPath), JSON.stringify(page));
        await writeFile(join(root, badPath), '{"text":');
        const manifest: IOcrIndexV3Manifest = {
            version: 3,
            documentRevision: {token: revision},
            createdAt: requireEpochMs(Date.now()),
            source: {pdfPath: join(root, 'document.pdf')},
            pageCount: 3,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {
                1: {path: goodPath},
                2: {path: badPath},
            },
        };
        await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
        const handle = await openCatalog(root);

        await expect(handle?.windowAvailability(1, 3)).resolves.toEqual(new Uint8Array([
            1,
            0,
            0,
        ]));
        await handle?.close?.();
    });
});
