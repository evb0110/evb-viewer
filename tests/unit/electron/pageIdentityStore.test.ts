import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDeleteIdentityDelta,
    createDeleteRangeIdentityDelta,
    createDeleteRangesIdentityDelta,
    createIdentityDelta,
    createInsertIdentityDelta,
    createMoveIdentityDelta,
    createPageMoveRangesIdentityDelta,
    createReorderIdentityDelta,
    createRotateIdentityDelta,
    commitPageIdentityDelta,
    derivePageIdentity,
    readPageIdentity,
} from '@electron/file-access/pageIdentityStore';
import {rebasePageIdentitySidecarRevision} from '@electron/file-access/rebasePageIdentitySidecarRevision';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireEpochMs} from '@contracts/timestamps';
import {writeWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import * as ocrIndexWriter from '@electron/features/ocr/worker/indexWriterV4';

const fsGuards = vi.hoisted(() => ({
    forbidCopy: false,
    forbidRead: false,
}));

vi.mock('node:fs/promises', async importActual => {
    const actual = await importActual<typeof FsPromises>();
    const readFile = ((...args: Parameters<typeof actual.readFile>) => {
        if (fsGuards.forbidRead && !String(args[0]).endsWith('.evb-revision.json')) {
            return Promise.reject(new Error('whole-manifest read is forbidden'));
        }
        return actual.readFile(...args);
    }) as typeof actual.readFile;
    const copyFile = ((...args: Parameters<typeof actual.copyFile>) => {
        if (fsGuards.forbidCopy) {
            return Promise.reject(new Error('whole-manifest copy is forbidden'));
        }
        return actual.copyFile(...args);
    }) as typeof actual.copyFile;
    return {
        ...actual,
        default: {
            ...actual,
            readFile,
            copyFile,
        },
        readFile,
        copyFile,
    };
});

const OLD_TOKEN = requireDocumentRevisionToken('drt1:test:old');
const NEW_TOKEN = requireDocumentRevisionToken('drt1:test:new');

describe('page identity deltas', () => {
    let root = '';

    async function publishRevisionSidecar(path: string, token: TDocumentRevisionToken) {
        await writeWorkingCopyRevisionSidecar(path, {
            sidecarVersion: 1,
            version: 1,
            documentRef: requireDocumentRef(path),
            authority: 'electron-working-copy',
            token,
            contentRevision: token === OLD_TOKEN ? 1 : 2,
            mintedAt: requireEpochMs(1),
            updatedAt: requireEpochMs(1),
        });
    }

    function nextRevisionInfo(path: string) {
        return {
            version: 1 as const,
            documentRef: requireDocumentRef(path),
            authority: 'electron-working-copy' as const,
            token: NEW_TOKEN,
            contentRevision: 2,
            mintedAt: requireEpochMs(2),
        };
    }

    function createRevisionInfo(
        path: string,
        token: TDocumentRevisionToken,
        contentRevision: number,
        mintedAt: number,
    ) {
        return {
            version: 1 as const,
            documentRef: requireDocumentRef(path),
            authority: 'electron-working-copy' as const,
            token,
            contentRevision,
            mintedAt: requireEpochMs(mintedAt),
        };
    }

    afterEach(async () => {
        vi.restoreAllMocks();
        fsGuards.forbidCopy = false;
        fsGuards.forbidRead = false;
        await rm(root, {
            recursive: true,
            force: true,
        });
    });
    it('conserves every surviving page through delete and reorder', () => {
        expect(createDeleteIdentityDelta(5, [
            2,
            4,
        ]).pages).toEqual([
            {fromPageNumber: 1},
            {fromPageNumber: 3},
            {fromPageNumber: 5},
        ]);
        expect(createReorderIdentityDelta(3, [
            3,
            1,
            2,
        ]).pages).toEqual([
            {fromPageNumber: 3},
            {fromPageNumber: 1},
            {fromPageNumber: 2},
        ]);
    });

    it('mints durable identities only for inserted pages', () => {
        const delta = createInsertIdentityDelta(3, 1, 2);
        if (delta.pages === undefined) {
            throw new Error('Expected the small insert delta to use page entries');
        }
        const {pages} = delta;
        expect(pages).toHaveLength(5);
        expect(pages[0]).toEqual({fromPageNumber: 1});
        expect(pages.slice(1, 3).every(page => 'insertedId' in page)).toBe(true);
        expect(pages.slice(3)).toEqual([
            {fromPageNumber: 2},
            {fromPageNumber: 3},
        ]);
    });

    it('uses an identity delta for lossless rotate so OCR can be rebound without re-OCR', () => {
        expect(createIdentityDelta(3)).toEqual({
            previousPageCount: 3,
            pages: [
                {fromPageNumber: 1},
                {fromPageNumber: 2},
                {fromPageNumber: 3},
            ],
        });
    });

    it('keeps million-page rotate and move deltas bounded', () => {
        const pageCount = 1_000_000;
        const rotate = createRotateIdentityDelta(pageCount, [500_000]);
        if (!('ranges' in rotate)) {
            throw new Error('Expected the large rotate delta to use ranges');
        }
        const {ranges: rotateRanges} = rotate;
        expect(rotate.nextPageCount).toBe(pageCount);
        expect(rotateRanges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 500_000,
            },
            {
                kind: 'touch',
                toPageNumber: 500_000,
                count: 1,
                reason: 'rotate',
            },
            {
                kind: 'retain',
                fromPageNumber: 500_001,
                toPageNumber: 500_001,
                count: 500_000,
            },
        ]);

        const moveToEnd = createMoveIdentityDelta(pageCount, 1, pageCount);
        expect(moveToEnd.pages).toBeUndefined();
        expect(moveToEnd.ranges).toEqual([
            {
                kind: 'move',
                fromPageNumber: 2,
                toPageNumber: 1,
                count: pageCount - 1,
            },
            {
                kind: 'move',
                fromPageNumber: 1,
                toPageNumber: pageCount,
                count: 1,
            },
        ]);

        const moveToFront = createMoveIdentityDelta(pageCount, 900_000, 1);
        expect(moveToFront.pages).toBeUndefined();
        expect(moveToFront.ranges).toEqual([
            {
                kind: 'move',
                fromPageNumber: 900_000,
                toPageNumber: 1,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 1,
                toPageNumber: 2,
                count: 899_999,
            },
            {
                kind: 'retain',
                fromPageNumber: 900_001,
                toPageNumber: 900_001,
                count: 100_000,
            },
        ]);

        const deleteRange = createDeleteRangeIdentityDelta(pageCount, 900_000, 1);
        expect(deleteRange.pages).toBeUndefined();
        expect(deleteRange.nextPageCount).toBe(pageCount - 1);
        expect(deleteRange.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 899_999,
            },
            {
                kind: 'delete',
                fromPageNumber: 900_000,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 900_001,
                toPageNumber: 900_000,
                count: 100_000,
            },
        ]);

        const deleteAllButFirst = createDeleteRangesIdentityDelta(pageCount, [{
            startPage: 2,
            endPage: pageCount,
        }]);
        expect(deleteAllButFirst.pages).toBeUndefined();
        expect(deleteAllButFirst.nextPageCount).toBe(1);
        expect(deleteAllButFirst.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 1,
            },
            {
                kind: 'delete',
                fromPageNumber: 2,
                count: pageCount - 1,
            },
        ]);
    });

    it('keeps multi-page moves correct when the final destination overlaps the source interval', () => {
        const pageCount = 1_000_000;
        const forward = createMoveIdentityDelta(pageCount, 400_000, 400_001, 2);
        expect(forward.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 399_999,
            },
            {
                kind: 'move',
                fromPageNumber: 400_002,
                toPageNumber: 400_000,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 400_000,
                toPageNumber: 400_001,
                count: 2,
            },
            {
                kind: 'retain',
                fromPageNumber: 400_003,
                toPageNumber: 400_003,
                count: 599_998,
            },
        ]);

        const backward = createMoveIdentityDelta(pageCount, 400_002, 400_001, 2);
        expect(backward.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 400_000,
            },
            {
                kind: 'move',
                fromPageNumber: 400_002,
                toPageNumber: 400_001,
                count: 2,
            },
            {
                kind: 'move',
                fromPageNumber: 400_001,
                toPageNumber: 400_003,
                count: 1,
            },
            {
                kind: 'retain',
                fromPageNumber: 400_004,
                toPageNumber: 400_004,
                count: 599_997,
            },
        ]);
    });

    it('keeps the legacy page permutation exact for overlapping small moves', () => {
        expect(createMoveIdentityDelta(6, 2, 3, 2)).toEqual({
            previousPageCount: 6,
            pages: [
                {fromPageNumber: 1},
                {fromPageNumber: 4},
                {fromPageNumber: 2},
                {fromPageNumber: 3},
                {fromPageNumber: 5},
                {fromPageNumber: 6},
            ],
        });
        expect(createMoveIdentityDelta(6, 4, 2, 2)).toEqual({
            previousPageCount: 6,
            pages: [
                {fromPageNumber: 1},
                {fromPageNumber: 4},
                {fromPageNumber: 5},
                {fromPageNumber: 2},
                {fromPageNumber: 3},
                {fromPageNumber: 6},
            ],
        });
    });

    it('rejects duplicate inserted identities in a legacy page delta', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-duplicate-insert-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 3,
                identitySeed: 'duplicate-insert-fixture',
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await expect(commitPageIdentityDelta(path, {
            previousPageCount: 3,
            pages: [
                {fromPageNumber: 1},
                {insertedId: 'inserted-page'},
                {insertedId: 'inserted-page'},
                {fromPageNumber: 2},
            ],
        }, nextRevisionInfo(path))).rejects.toThrow('duplicate or invalid inserted identities');
    });

    it('maps a million-page non-contiguous move with selected-range-sized output', () => {
        const pageCount = 1_000_000;
        const delta = createPageMoveRangesIdentityDelta({
            pageCount,
            ranges: [
                {
                    startPage: 2,
                    endPage: 3,
                },
                {
                    startPage: 5,
                    endPage: 5,
                },
            ],
            insertAt: pageCount,
        });
        expect(delta.pages).toBeUndefined();
        expect(delta.nextPageCount).toBe(pageCount);
        expect(delta.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 4,
                toPageNumber: 2,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 6,
                toPageNumber: 3,
                count: 999_995,
            },
            {
                kind: 'move',
                fromPageNumber: 2,
                toPageNumber: 999_998,
                count: 2,
            },
            {
                kind: 'move',
                fromPageNumber: 5,
                toPageNumber: 1_000_000,
                count: 1,
            },
        ]);

        expect(createPageMoveRangesIdentityDelta({
            pageCount: 6,
            ranges: [
                {
                    startPage: 2,
                    endPage: 2,
                },
                {
                    startPage: 4,
                    endPage: 5,
                },
            ],
            insertAt: 6,
        }).pages).toEqual([
            {fromPageNumber: 1},
            {fromPageNumber: 3},
            {fromPageNumber: 6},
            {fromPageNumber: 2},
            {fromPageNumber: 4},
            {fromPageNumber: 5},
        ]);
    });

    it('publishes one million-page identities as a sparse sidecar', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-million-'));
        const path = join(root, 'working.pdf');
        const pageCount = 1_000_000;
        const identitySeed = 'million-page-fixture';
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount,
                identitySeed,
                ranges: [{
                    startPage: 1,
                    count: pageCount,
                    identitySeed,
                    identityStart: 0,
                }],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await commitPageIdentityDelta(
            path,
            createMoveIdentityDelta(pageCount, 1, pageCount),
            nextRevisionInfo(path),
        );

        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            pageIds?: unknown;
            ranges?: unknown[];
            pageCount: number;
        };
        expect(sidecar.pageCount).toBe(pageCount);
        expect(sidecar.pageIds).toBeUndefined();
        expect(sidecar.ranges).toHaveLength(2);
        await expect(readPageIdentity(path, 1, pageCount)).resolves.toBe(
            derivePageIdentity(identitySeed, 1),
        );
        await expect(readPageIdentity(path, pageCount, pageCount)).resolves.toBe(
            derivePageIdentity(identitySeed, 0),
        );
    });

    it('publishes a sparse touched-page delta without changing its identity', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-touch-'));
        const path = join(root, 'working.pdf');
        const pageCount = 5_000;
        const identitySeed = 'touch-fixture';
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount,
                identitySeed,
                ranges: [{
                    startPage: 1,
                    count: pageCount,
                    identitySeed,
                    identityStart: 0,
                }],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await commitPageIdentityDelta(
            path,
            createRotateIdentityDelta(pageCount, [2_500]),
            nextRevisionInfo(path),
        );

        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            ranges?: Array<{
                count: number;
                startPage: number
            }>;
            pageCount: number;
        };
        expect(sidecar.pageCount).toBe(pageCount);
        expect(sidecar.ranges).toEqual([{
            startPage: 1,
            count: pageCount,
            identitySeed,
            identityStart: 0,
        }]);
        await expect(readPageIdentity(path, 2_500, pageCount)).resolves.toBe(
            derivePageIdentity(identitySeed, 2_499),
        );
    });

    it('migrates an oversized v1 identity array through bounded v2 ranges', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-v1-migration-'));
        const path = join(root, 'working.pdf');
        const pageCount = 5_000;
        const pageIds = Array.from({length: pageCount}, (_value, index) => (
            `legacy-page-${String(index).padStart(4, '0')}-${'x'.repeat(900)}`
        ));
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 1,
                documentRevisionToken: OLD_TOKEN,
                pageIds,
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await commitPageIdentityDelta(
            path,
            createMoveIdentityDelta(pageCount, 1, pageCount),
            nextRevisionInfo(path),
        );

        const migrated = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            pageIds?: unknown;
            pageCount: number;
            ranges?: Array<{
                count: number;
                pageIds?: string[]
            }>;
            version: number;
            storage: string;
        };
        expect(migrated.version).toBe(2);
        expect(migrated.storage).toBe('ranges');
        expect(migrated.pageCount).toBe(pageCount);
        expect(migrated.pageIds).toBeUndefined();
        expect(migrated.ranges).toHaveLength(2);
        expect(migrated.ranges?.every(range => range.count <= 4_096)).toBe(true);
        expect(migrated.ranges?.every(range => range.pageIds !== undefined)).toBe(true);
        await expect(readPageIdentity(path, 1, pageCount)).resolves.toBe(pageIds[1]);
        await expect(readPageIdentity(path, pageCount, pageCount)).resolves.toBe(pageIds[0]);
    }, 30_000);

    it('routes a range-only delta through OCR v4 before the v3 fallback', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-ocr-v4-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 3,
                identitySeed: 'ocr-v4-fixture',
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);
        const remap = vi.spyOn(ocrIndexWriter, 'remapOcrCatalogV4PageRanges')
            .mockResolvedValue(true);
        const delta = {
            previousPageCount: 3,
            nextPageCount: 3,
            ranges: [
                {
                    kind: 'move' as const,
                    fromPageNumber: 2,
                    toPageNumber: 1,
                    count: 1,
                },
                {
                    kind: 'move' as const,
                    fromPageNumber: 1,
                    toPageNumber: 2,
                    count: 1,
                },
                {
                    kind: 'retain' as const,
                    fromPageNumber: 3,
                    toPageNumber: 3,
                    count: 1,
                },
            ],
        };
        await commitPageIdentityDelta(path, delta, nextRevisionInfo(path));

        expect(remap).toHaveBeenCalledWith(path, delta, nextRevisionInfo(path));
        expect(delta).not.toHaveProperty('pages');
        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            pageIds: string[];
            documentRevisionToken: string;
        };
        expect(sidecar.documentRevisionToken).toBe(NEW_TOKEN);
        expect(sidecar.pageIds).toEqual([
            'page-b',
            'page-a',
            'page-c',
        ]);
    });

    it('migrates a million-page legacy OCR catalog without reading or copying its manifest', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-ocr-v3-large-'));
        const path = join(root, 'working.pdf');
        const pageCount = 1_000_000;
        const ocrPath = `${path}.ocr`;
        await mkdir(ocrPath);
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(join(ocrPath, 'manifest.json'), JSON.stringify({
                version: 3,
                documentRevision: {token: OLD_TOKEN},
                createdAt: 1,
                source: {pdfPath: path},
                pageCount,
                pageBox: 'crop',
                ocr: {
                    engine: 'tesseract',
                    languages: ['eng'],
                    renderDpi: 300,
                },
                pages: {},
            })),
        ]);
        const remap = vi.spyOn(ocrIndexWriter, 'remapOcrCatalogV4PageRanges')
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        const migrate = vi.spyOn(ocrIndexWriter, 'migrateOcrIndexV3ToV4')
            .mockResolvedValue(null);
        fsGuards.forbidRead = true;
        fsGuards.forbidCopy = true;
        const parseSpy = vi.spyOn(JSON, 'parse')
            .mockImplementation(() => {
                throw new Error('whole-manifest parse is forbidden');
            });
        const delta = createMoveIdentityDelta(pageCount, 1, pageCount);
        const nextRevision = nextRevisionInfo(path);

        await commitPageIdentityDelta(path, delta, nextRevision);

        expect(migrate).toHaveBeenCalledWith({
            catalogRoot: ocrPath,
            sourcePdfPath: path,
            workingCopyPath: path,
        });
        expect(remap).toHaveBeenCalledTimes(2);
        expect(remap).toHaveBeenLastCalledWith(path, delta, nextRevision);
        expect(parseSpy).not.toHaveBeenCalled();
    });

    it('rejects publication when the existing sidecar belongs to an older revision', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-stale-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 3,
                identitySeed: 'stale-fixture',
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, NEW_TOKEN),
        ]);

        await expect(commitPageIdentityDelta(
            path,
            createIdentityDelta(3),
            nextRevisionInfo(path),
        )).rejects.toThrow('Page identity state belongs to a stale document revision');
    });

    it('fails closed when a content-only rebase sees a malformed identity sidecar', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-rebase-corrupt-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 3,
                identitySeed: 'rebase-corrupt-fixture',
                pageIds: ['page-a'],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await expect(rebasePageIdentitySidecarRevision(
            path,
            createRevisionInfo(path, OLD_TOKEN, 1, 1),
            nextRevisionInfo(path),
        )).rejects.toMatchObject({code: 'PAGE_IDENTITY_SIDECAR_CORRUPT'});
    });

    it('rejects a rebase whose previous revision does not fence the identity sidecar', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-rebase-stale-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 3,
                identitySeed: 'rebase-stale-fixture',
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await expect(rebasePageIdentitySidecarRevision(
            path,
            createRevisionInfo(path, NEW_TOKEN, 2, 2),
            nextRevisionInfo(path),
        )).rejects.toThrow('Page identity state belongs to a stale document revision');
    });

    it('rejects a rebase of an existing identity sidecar without a previous revision', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-rebase-unfenced-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 3,
                identitySeed: 'rebase-unfenced-fixture',
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await expect(rebasePageIdentitySidecarRevision(
            path,
            null,
            nextRevisionInfo(path),
        )).rejects.toThrow('without a current document revision');
    });

    it('rebases a legacy identity sidecar without changing its page IDs', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-rebase-v1-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 1,
                documentRevisionToken: OLD_TOKEN,
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await rebasePageIdentitySidecarRevision(
            path,
            createRevisionInfo(path, OLD_TOKEN, 1, 1),
            nextRevisionInfo(path),
        );

        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            version: number;
            documentRevisionToken: string;
            pageIds?: string[];
            ranges?: Array<{pageIds?: string[]}>
        };
        expect(sidecar.version).toBe(1);
        expect(sidecar.documentRevisionToken).toBe(NEW_TOKEN);
        expect(sidecar.pageIds ?? sidecar.ranges?.flatMap(range => range.pageIds ?? [])).toEqual([
            'page-a',
            'page-b',
            'page-c',
        ]);
    });

});
