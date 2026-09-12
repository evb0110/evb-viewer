import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    utimes,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import {
    createDeleteRangeIdentityDelta,
    createMoveIdentityDelta,
} from '@electron/file-access/pageIdentityDelta';
import type {IOcrIndexV3Manifest} from '@contracts/ocrIndex';
import {
    OcrCatalogAbortedError,
    OcrCatalogCorruptError,
    openCatalog,
} from '@electron/features/ocr/main/ocrCatalogV4';
import {getOcrCatalogRecoveryReceiptPath} from '@electron/features/ocr/main/ocrCatalogRecovery';
import {
    migrateOcrIndexV3ToV4,
    OcrCatalogCommittedDurabilityError,
    getOcrCatalogV4PreparedDescriptorPath,
    prepareOcrCatalogV4Generation,
    publishPreparedOcrCatalogV4,
    readOcrCatalogV4PreparedDescriptor,
    remapOcrCatalogV4PageRanges,
    rollbackPreparedOcrCatalogV4,
    OCR_CATALOG_V4_ORPHAN_GRACE_MS,
    sweepOcrCatalogV4Orphans,
    writeOcrIndexV4,
} from '@electron/features/ocr/worker/indexWriterV4';

const revision = requireDocumentRevisionToken('drt1:ocr-index-writer-v4-test');
const roots: string[] = [];

function page(pageNumber: number, text = `page ${pageNumber}`) {
    return {
        pageNumber,
        text,
        words: [],
        imageWidth: 1200,
        imageHeight: 1600,
    };
}

async function createCatalogRoot() {
    const root = await mkdtemp(join(tmpdir(), 'evb-ocr-index-writer-v4-'));
    roots.push(root);
    return root;
}

function batches(...pages: Array<Array<ReturnType<typeof page>>>) {
    return pages;
}

function revisionInfo(token: string, documentRef: string): IDocumentRevisionInfo {
    return {
        version: 1,
        token: requireDocumentRevisionToken(token),
        documentRef: requireDocumentRef(documentRef),
        authority: 'electron-working-copy',
        contentRevision: 1,
        mintedAt: requireEpochMs(Date.now()),
    };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('writeOcrIndexV4', () => {
    it('keeps a committed generation readable when post-rename durability confirmation fails', async () => {
        const root = await createCatalogRoot();
        await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 1,
            pageBatches: batches([page(1, 'old')]),
            assertRevisionCurrent: async () => {},
        });

        await expect(writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 1,
            pageBatches: batches([page(1, 'new')]),
            durabilityBoundary: {syncDirectory: async () => {throw new Error('injected directory sync failure');}},
            assertRevisionCurrent: async () => {},
        })).rejects.toBeInstanceOf(OcrCatalogCommittedDurabilityError);

        const handle = await openCatalog(root, {expectedDocumentRevision: revision});
        await expect(handle?.readPage(1)).resolves.toMatchObject({text: 'new'});
        await handle?.close?.();
        await expect(readdir(join(root, 'gen-00000002'))).resolves.toEqual([
            'generation.json',
            'pages',
            'shards',
            'shards.idx',
        ]);
    });

    it('clears a prior recovery receipt when a generation publishes', async () => {
        const root = await createCatalogRoot();
        await writeFile(getOcrCatalogRecoveryReceiptPath(root), JSON.stringify({
            version: 1,
            documentRevision: revision,
            detectedAt: '2026-09-12T00:00:00.000Z',
            reason: 'truncated shard index',
            quarantinedPath: `${root}.2026-09-12T00-00-00-000Z.corrupt`,
        }), 'utf8');

        await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 1,
            pageBatches: batches([page(1)]),
            assertRevisionCurrent: async () => {},
        });

        await expect(readFile(getOcrCatalogRecoveryReceiptPath(root), 'utf8'))
            .rejects.toMatchObject({code: 'ENOENT'});
    });

    it('publishes a bounded generation and carries untouched shard references', async () => {
        const root = await createCatalogRoot();
        const fence = vi.fn(async () => {});
        const first = await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 257,
            pageBatches: batches([
                page(1),
                page(257),
            ]),
            extractionDpi: 240,
            assertRevisionCurrent: fence,
        });
        expect(first).toMatchObject({
            generation: 1,
            parent: null,
            mappedPageCount: 2,
            dirtyShards: [
                0,
                1,
            ],
            published: true,
        });
        expect(fence).toHaveBeenCalledOnce();

        const second = await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 257,
            pageBatches: batches([page(2)]),
            assertRevisionCurrent: fence,
        });
        expect(second).toMatchObject({
            generation: 2,
            parent: 1,
            mappedPageCount: 3,
            dirtyShards: [0],
            published: true,
        });
        const handle = await openCatalog(root, {expectedDocumentRevision: revision});
        await expect(handle?.readPage(1)).resolves.toMatchObject({
            text: 'page 1',
            render: {dpi: 240},
        });
        await expect(handle?.readPage(2)).resolves.toMatchObject({text: 'page 2'});
        await expect(handle?.readPage(257)).resolves.toMatchObject({
            text: 'page 257',
            render: {dpi: 240},
        });
        await expect(handle?.findFirstUnmapped()).resolves.toBe(3);
        await handle?.close?.();

        const generationManifest = JSON.parse(await readFile(join(root, 'gen-00000002', 'generation.json'), 'utf8')) as {
            liveRefs: Record<string, number>;
            dirtyShards: number[];
        };
        expect(generationManifest.dirtyShards).toEqual([0]);
        expect(generationManifest.liveRefs).toMatchObject({
            '1': 1,
            '2': 1,
        });
        expect(await readdir(join(root, 'gen-00000002', 'shards'))).toEqual(['shard-000000.json']);
    });

    it('fences before root publication and removes an unpublished generation', async () => {
        const root = await createCatalogRoot();
        await expect(writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 1,
            pageBatches: batches([page(1)]),
            assertRevisionCurrent: async () => {
                throw new Error('revision changed');
            },
        })).rejects.toThrow('revision changed');
        await expect(readdir(root)).resolves.toEqual([]);
    });

    it('aborts a bounded write before publication and removes its staged generation', async () => {
        const root = await createCatalogRoot();
        const controller = new AbortController();
        async function* abortedBatches() {
            yield [page(1)];
            controller.abort();
            yield [page(2)];
        }

        await expect(writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 2,
            pageBatches: abortedBatches(),
            signal: controller.signal,
            assertRevisionCurrent: async () => {},
        })).rejects.toBeInstanceOf(OcrCatalogAbortedError);
        await expect(readdir(root)).resolves.toEqual([]);
    });

    it('fails closed when orphan sweep encounters a truncated referenced shard', async () => {
        const root = await createCatalogRoot();
        await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 1,
            pageBatches: batches([page(1)]),
            assertRevisionCurrent: async () => {},
        });
        await mkdir(join(root, 'gen-00000099'), {recursive: true});
        await writeFile(join(root, 'gen-00000001', 'shards', 'shard-000000.json'), '{');

        await expect(sweepOcrCatalogV4Orphans(root)).rejects.toBeInstanceOf(OcrCatalogCorruptError);
        await expect(readdir(root)).resolves.toContain('gen-00000099');
    });

    it('keeps the fixed index bounded for a sparse five-million-page catalog', async () => {
        const root = await createCatalogRoot();
        const result = await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 5_000_000,
            pageBatches: batches([page(5_000_000)]),
            assertRevisionCurrent: async () => {},
        });
        expect(result.mappedPageCount).toBe(1);
        const handle = await openCatalog(root);
        await expect(handle?.readPage(5_000_000)).resolves.toMatchObject({text: 'page 5000000'});
        await handle?.close?.();
    });

    it('remaps million-page sparse move and delete deltas by affected shards', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const root = await createCatalogRoot();
        const workingCopyPath = join(root, 'document.pdf');
        const catalogRoot = `${workingCopyPath}.ocr`;
        const pageCount = 1_000_000;
        const initialRevision = revisionInfo('drt1:ocr-index-writer-v4-remap-1', workingCopyPath);
        await writeOcrIndexV4({
            catalogRoot,
            sourcePdfPath: workingCopyPath,
            documentRevision: initialRevision,
            pageCount,
            pageBatches: batches([
                page(1, 'first'),
                page(pageCount, 'last'),
            ]),
            assertRevisionCurrent: async () => {},
        });

        const movedRevision = revisionInfo('drt1:ocr-index-writer-v4-remap-2', workingCopyPath);
        const move = createMoveIdentityDelta(pageCount, 1, 2);
        await expect(remapOcrCatalogV4PageRanges(
            workingCopyPath,
            {
                previousPageCount: move.previousPageCount,
                nextPageCount: move.nextPageCount!,
                ranges: move.ranges!,
            },
            movedRevision,
        )).resolves.toBe(true);
        const movedCatalog = await openCatalog(catalogRoot, {expectedDocumentRevision: movedRevision.token});
        await expect(movedCatalog?.readPage(1)).resolves.toBeNull();
        await expect(movedCatalog?.readPage(2)).resolves.toMatchObject({text: 'first'});
        await expect(movedCatalog?.readPage(pageCount)).resolves.toMatchObject({text: 'last'});
        await movedCatalog?.close?.();

        const deletedRevision = revisionInfo('drt1:ocr-index-writer-v4-remap-3', workingCopyPath);
        const deletion = createDeleteRangeIdentityDelta(pageCount, 1, 1);
        await expect(remapOcrCatalogV4PageRanges(
            workingCopyPath,
            {
                previousPageCount: deletion.previousPageCount,
                nextPageCount: deletion.nextPageCount!,
                ranges: deletion.ranges!,
            },
            deletedRevision,
        )).resolves.toBe(true);
        const deletedCatalog = await openCatalog(catalogRoot, {expectedDocumentRevision: deletedRevision.token});
        await expect(deletedCatalog?.readPage(1)).resolves.toMatchObject({text: 'first'});
        await expect(deletedCatalog?.readPage(pageCount - 1)).resolves.toMatchObject({text: 'last'});
        await expect(deletedCatalog?.readPage(pageCount)).rejects.toThrow(RangeError);
        await deletedCatalog?.close?.();
    }, 15_000);

    it('keeps a remapped generation readable when durability confirmation fails', async () => {
        const root = await createCatalogRoot();
        const workingCopyPath = join(root, 'remap-durability.pdf');
        const catalogRoot = `${workingCopyPath}.ocr`;
        await writeOcrIndexV4({
            catalogRoot,
            sourcePdfPath: workingCopyPath,
            documentRevision: revisionInfo('drt1:remap-durability-1', workingCopyPath),
            pageCount: 1,
            pageBatches: batches([page(1, 'page')]),
            assertRevisionCurrent: async () => {},
        });

        const nextRevision = revisionInfo('drt1:remap-durability-2', workingCopyPath);
        await expect(remapOcrCatalogV4PageRanges(
            workingCopyPath,
            {
                previousPageCount: 1,
                nextPageCount: 1,
                ranges: [{
                    kind: 'retain',
                    fromPageNumber: 1,
                    toPageNumber: 1,
                    count: 1,
                }],
            },
            nextRevision,
            undefined,
            {afterRootRename: async () => {throw new Error('injected directory sync failure');}},
        )).rejects.toBeInstanceOf(OcrCatalogCommittedDurabilityError);

        const handle = await openCatalog(catalogRoot, {expectedDocumentRevision: nextRevision.token});
        await expect(handle?.readPage(1)).resolves.toMatchObject({text: 'page'});
        await handle?.close?.();
    });

    it('recomputes mapped count when a delete drops a complete terminal shard', async () => {
        const root = await createCatalogRoot();
        const workingCopyPath = join(root, 'terminal-delete.pdf');
        const catalogRoot = `${workingCopyPath}.ocr`;
        const initialRevision = revisionInfo('drt1:ocr-index-writer-v4-terminal-1', workingCopyPath);
        await writeOcrIndexV4({
            catalogRoot,
            sourcePdfPath: workingCopyPath,
            documentRevision: initialRevision,
            pageCount: 512,
            pageBatches: batches([
                page(1, 'first'),
                page(512, 'terminal'),
            ]),
            assertRevisionCurrent: async () => {},
        });
        const nextRevision = revisionInfo('drt1:ocr-index-writer-v4-terminal-2', workingCopyPath);
        const deletion = {
            previousPageCount: 512,
            nextPageCount: 256,
            ranges: [
                {
                    kind: 'retain' as const,
                    fromPageNumber: 1,
                    toPageNumber: 1,
                    count: 256,
                },
                {
                    kind: 'delete' as const,
                    fromPageNumber: 257,
                    count: 256,
                },
            ],
        };
        await expect(remapOcrCatalogV4PageRanges(
            workingCopyPath,
            {
                previousPageCount: deletion.previousPageCount,
                nextPageCount: deletion.nextPageCount,
                ranges: deletion.ranges,
            },
            nextRevision,
        )).resolves.toBe(true);
        const handle = await openCatalog(catalogRoot, {expectedDocumentRevision: nextRevision.token});
        expect(handle?.header.mappedPageCount).toBe(1);
        await expect(handle?.readPage(1)).resolves.toMatchObject({text: 'first'});
        await expect(handle?.readPage(256)).resolves.toBeNull();
        await handle?.close?.();
    });

    it('handles a destination shard created by a page insertion', async () => {
        const root = await createCatalogRoot();
        const workingCopyPath = join(root, 'terminal-insert.pdf');
        const catalogRoot = `${workingCopyPath}.ocr`;
        const initialRevision = revisionInfo('drt1:ocr-index-writer-v4-insert-1', workingCopyPath);
        await writeOcrIndexV4({
            catalogRoot,
            sourcePdfPath: workingCopyPath,
            documentRevision: initialRevision,
            pageCount: 256,
            pageBatches: batches([page(1, 'first')]),
            assertRevisionCurrent: async () => {},
        });
        const nextRevision = revisionInfo('drt1:ocr-index-writer-v4-insert-2', workingCopyPath);
        await expect(remapOcrCatalogV4PageRanges(
            workingCopyPath,
            {
                previousPageCount: 256,
                nextPageCount: 257,
                ranges: [
                    {
                        kind: 'retain',
                        fromPageNumber: 1,
                        toPageNumber: 1,
                        count: 256,
                    },
                    {
                        kind: 'insert',
                        toPageNumber: 257,
                        count: 1,
                        identitySeed: 'insert-seed',
                    },
                ],
            },
            nextRevision,
        )).resolves.toBe(true);
        const handle = await openCatalog(catalogRoot, {expectedDocumentRevision: nextRevision.token});
        expect(handle?.header.pageCount).toBe(257);
        await expect(handle?.readPage(1)).resolves.toMatchObject({text: 'first'});
        await expect(handle?.readPage(257)).resolves.toBeNull();
        await handle?.close?.();
    });

    it('removes generation directories not referenced by the published index', async () => {
        const root = await createCatalogRoot();
        await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 1,
            pageBatches: batches([page(1)]),
            assertRevisionCurrent: async () => {},
        });
        await mkdir(join(root, 'gen-00000099'), {recursive: true});
        const staleTime = new Date(Date.now() - OCR_CATALOG_V4_ORPHAN_GRACE_MS - 1_000);
        await utimes(join(root, 'gen-00000099'), staleTime, staleTime);
        await expect(sweepOcrCatalogV4Orphans(root)).resolves.toBe(1);
        await expect(readdir(root)).resolves.not.toContain('gen-00000099');
    });

    it('keeps an aged orphan while a reader lease is open, then removes it after close', async () => {
        const root = await createCatalogRoot();
        await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 1,
            pageBatches: batches([page(1)]),
            assertRevisionCurrent: async () => {},
        });
        const orphanPath = join(root, 'gen-00000099');
        await mkdir(orphanPath, {recursive: true});
        const staleTime = new Date(Date.now() - OCR_CATALOG_V4_ORPHAN_GRACE_MS - 1_000);
        await utimes(orphanPath, staleTime, staleTime);

        const handle = await openCatalog(root);
        await expect(sweepOcrCatalogV4Orphans(root)).resolves.toBe(0);
        await expect(readdir(root)).resolves.toContain('gen-00000099');

        await handle?.close?.();
        await expect(sweepOcrCatalogV4Orphans(root)).resolves.toBe(1);
        await expect(readdir(root)).resolves.not.toContain('gen-00000099');
    });

    it('keeps an older artifact generation referenced by a dirty shard', async () => {
        const root = await createCatalogRoot();
        await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 2,
            pageBatches: batches([page(1, 'old')]),
            assertRevisionCurrent: async () => {},
        });
        await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath: join(root, 'document.pdf'),
            documentRevision: revision,
            pageCount: 2,
            pageBatches: batches([page(2, 'new')]),
            assertRevisionCurrent: async () => {},
        });

        await expect(sweepOcrCatalogV4Orphans(root)).resolves.toBe(0);
        const handle = await openCatalog(root);
        await expect(handle?.readPage(1)).resolves.toMatchObject({text: 'old'});
        await expect(handle?.readPage(2)).resolves.toMatchObject({text: 'new'});
        await handle?.close?.();
    });

    it('prepares beside a staged result and publishes a tiny rebind without copying the catalog', async () => {
        const root = await createCatalogRoot();
        const sourcePdfPath = join(root, 'document.pdf');
        const initialRevision = revisionInfo('drt1:ocr-index-writer-v4-stage-1', sourcePdfPath);
        await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath,
            documentRevision: initialRevision,
            pageCount: 1,
            pageBatches: batches([page(1, 'initial')]),
            assertRevisionCurrent: async () => {},
        });
        const stagedResultPdfPath = join(root, 'result.pdf');
        const descriptorPath = getOcrCatalogV4PreparedDescriptorPath(stagedResultPdfPath);
        const staged = await prepareOcrCatalogV4Generation({
            catalogRoot: root,
            sourcePdfPath,
            documentRevision: initialRevision,
            pageCount: 1,
            pageBatches: batches([page(1, 'staged')]),
            resultPath: stagedResultPdfPath,
            resultIdentity: 'result-identity-1',
            assertRevisionCurrent: async () => {},
        });
        expect(staged).toMatchObject({
            sourceRootGeneration: 1,
            sourceRootRevisionToken: initialRevision.token,
            stagedGeneration: 2,
            pageCount: 1,
            resultPath: stagedResultPdfPath,
            resultIdentity: 'result-identity-1',
        });
        await expect(readOcrCatalogV4PreparedDescriptor(descriptorPath)).resolves.toEqual(staged);
        const liveBeforeApply = await openCatalog(root, {expectedDocumentRevision: initialRevision.token});
        await expect(liveBeforeApply?.readPage(1)).resolves.toMatchObject({text: 'initial'});
        await liveBeforeApply?.close?.();

        const nextRevision = revisionInfo('drt1:ocr-index-writer-v4-stage-2', sourcePdfPath);
        const published = await publishPreparedOcrCatalogV4({
            catalogRoot: root,
            descriptor: staged,
            resultPath: stagedResultPdfPath,
            resultIdentity: 'result-identity-1',
            sourcePdfPath,
            nextRevision,
            assertRevisionCurrent: async () => {},
        });
        expect(published).toMatchObject({
            generation: 3,
            parent: 1,
            pageCount: 1,
            mappedPageCount: 1,
            published: true,
        });
        await expect(readOcrCatalogV4PreparedDescriptor(descriptorPath)).resolves.toBeNull();
        const liveAfterApply = await openCatalog(root, {expectedDocumentRevision: nextRevision.token});
        await expect(liveAfterApply?.readPage(1)).resolves.toMatchObject({text: 'staged'});
        expect(liveAfterApply?.header.generation).toBe(3);
        await liveAfterApply?.close?.();
        await expect(readdir(join(root, 'result.pdf.ocr'))).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('rolls back a prepared descriptor without changing the live root', async () => {
        const root = await createCatalogRoot();
        const sourcePdfPath = join(root, 'document.pdf');
        const initialRevision = revisionInfo('drt1:ocr-index-writer-v4-rollback-1', sourcePdfPath);
        await writeOcrIndexV4({
            catalogRoot: root,
            sourcePdfPath,
            documentRevision: initialRevision,
            pageCount: 1,
            pageBatches: batches([page(1, 'initial')]),
            assertRevisionCurrent: async () => {},
        });
        const stagedResultPdfPath = join(root, 'rollback-result.pdf');
        const staged = await prepareOcrCatalogV4Generation({
            catalogRoot: root,
            sourcePdfPath,
            documentRevision: initialRevision,
            pageCount: 1,
            pageBatches: batches([page(1, 'staged')]),
            resultPath: stagedResultPdfPath,
            assertRevisionCurrent: async () => {},
        });
        const staleTime = new Date(Date.now() - OCR_CATALOG_V4_ORPHAN_GRACE_MS - 1_000);
        await utimes(join(root, 'gen-00000002'), staleTime, staleTime);
        await expect(rollbackPreparedOcrCatalogV4(staged, {catalogRoot: root})).resolves.toBe(true);
        await expect(readOcrCatalogV4PreparedDescriptor(
            getOcrCatalogV4PreparedDescriptorPath(stagedResultPdfPath),
        )).resolves.toBeNull();
        const live = await openCatalog(root, {expectedDocumentRevision: initialRevision.token});
        await expect(live?.readPage(1)).resolves.toMatchObject({text: 'initial'});
        await live?.close?.();
        await expect(readdir(join(root, 'gen-00000002'))).rejects.toMatchObject({code: 'ENOENT'});
    });
});

describe('migrateOcrIndexV3ToV4', () => {
    it('references arbitrary v3 page paths without copying their artifacts', async () => {
        const root = await createCatalogRoot();
        const legacyPath = 'legacy/nested/page.json';
        const artifact = {
            rotation: 0,
            render: {
                dpi: 300,
                imagePx: {
                    w: 1200,
                    h: 1600,
                },
            },
            text: 'legacy',
            words: [],
        };
        await mkdir(join(root, 'legacy', 'nested'), {recursive: true});
        await writeFile(join(root, legacyPath), JSON.stringify(artifact));
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
            pages: {1: {path: legacyPath}},
        };
        await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
        await expect(migrateOcrIndexV3ToV4({
            catalogRoot: root,
            documentRevision: revision,
            sourcePdfPath: manifest.source.pdfPath,
            durabilityBoundary: {afterRootRename: async () => {throw new Error('injected directory close failure');}},
            assertRevisionCurrent: async () => {},
        })).rejects.toBeInstanceOf(OcrCatalogCommittedDurabilityError);
        const handle = await openCatalog(root);
        await expect(handle?.readPage(1)).resolves.toEqual(artifact);
        await expect(readdir(join(root, 'gen-00000001', 'pages'))).resolves.toEqual([]);
        const shard = JSON.parse(await readFile(join(root, 'gen-00000001', 'shards', 'shard-000000.json'), 'utf8')) as {pages: Record<string, {
            path: string;
            generation: number
        }>};
        expect(shard.pages['1']).toEqual({
            path: legacyPath,
            generation: 0,
        });
        await handle?.close?.();
    });

    it('streams a sparse logical million-page v3 manifest one shard at a time', async () => {
        const root = await createCatalogRoot();
        const firstPath = 'legacy/first.json';
        const lastPath = 'legacy/last.json';
        await mkdir(join(root, 'legacy'), {recursive: true});
        await writeFile(join(root, firstPath), JSON.stringify({
            rotation: 0,
            render: {
                dpi: 300,
                imagePx: {
                    w: 1200,
                    h: 1600,
                },
            },
            text: 'first',
            words: [],
        }));
        await writeFile(join(root, lastPath), JSON.stringify({
            rotation: 0,
            render: {
                dpi: 300,
                imagePx: {
                    w: 1200,
                    h: 1600,
                },
            },
            text: 'last',
            words: [],
        }));
        const sourcePdfPath = join(root, 'document.pdf');
        const manifest: IOcrIndexV3Manifest = {
            version: 3,
            documentRevision: {token: revision},
            createdAt: requireEpochMs(Date.now()),
            source: {pdfPath: sourcePdfPath},
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
        await writeFile(join(root, 'manifest.json'), JSON.stringify({
            ...manifest,
            legacyPadding: 'x'.repeat(1_100),
        }));
        const result = await migrateOcrIndexV3ToV4({
            catalogRoot: root,
            sourcePdfPath,
            documentRevision: revision,
            assertRevisionCurrent: async () => {},
        });
        expect(result).toMatchObject({
            generation: 1,
            pageCount: 1_000_000,
            mappedPageCount: 2,
        });
        const handle = await openCatalog(root);
        await expect(handle?.readPage(999_999)).resolves.toMatchObject({text: 'last'});
        await expect(readFile(join(root, 'gen-00000001', 'shards', 'shard-003906.json'), 'utf8'))
            .resolves.toContain('999999');
        await handle?.close?.();
    });
});

describe('migrateOcrIndexV3ToV4 artifact validation (SRCH-004)', () => {
    it('drops v3 pages whose artifacts are corrupt instead of publishing them', async () => {
        const root = await createCatalogRoot();
        const goodPath = 'legacy/good.json';
        const truncatedPath = 'legacy/truncated.json';
        const wrongShapePath = 'legacy/wrong-shape.json';
        await mkdir(join(root, 'legacy'), {recursive: true});
        await writeFile(join(root, goodPath), JSON.stringify({
            rotation: 0,
            render: {
                dpi: 300,
                imagePx: {
                    w: 1200,
                    h: 1600,
                },
            },
            text: 'good',
            words: [],
        }));
        await writeFile(join(root, truncatedPath), '{"text":');
        await writeFile(join(root, wrongShapePath), JSON.stringify({text: 5}));
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
                2: {path: truncatedPath},
                3: {path: wrongShapePath},
            },
        };
        await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));

        const result = await migrateOcrIndexV3ToV4({
            catalogRoot: root,
            documentRevision: revision,
            sourcePdfPath: manifest.source.pdfPath,
            assertRevisionCurrent: async () => {},
        });

        expect(result).toMatchObject({
            migrated: true,
            mappedPageCount: 1,
        });
        const shard = JSON.parse(await readFile(join(root, 'gen-00000001', 'shards', 'shard-000000.json'), 'utf8')) as {pages: Record<string, unknown>};
        expect(Object.keys(shard.pages)).toEqual(['1']);
        const handle = await openCatalog(root);
        expect(handle?.header.mappedPageCount).toBe(1);
        await expect(handle?.readPage(2)).resolves.toBeNull();
        await expect(handle?.windowAvailability(1, 3)).resolves.toEqual(new Uint8Array([
            1,
            0,
            0,
        ]));
        await handle?.close?.();
    });
});
