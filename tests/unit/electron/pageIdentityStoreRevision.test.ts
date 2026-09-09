import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {
    awaitPageIdentityStoreInitialization,
    commitPageIdentityDelta,
    createIdentityDelta,
    createReorderIdentityDelta,
    forgetPageIdentityStoreInitialization,
    schedulePageIdentityStoreInitialization,
} from '@electron/file-access/pageIdentityStore';
import {rebasePageIdentitySidecarRevision} from '@electron/file-access/rebasePageIdentitySidecarRevision';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireEpochMs} from '@contracts/timestamps';
import {requirePageNumber} from '@contracts/pageNumbers';
import {writeWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {resolveDocumentOcrPage} from '@electron/features/ocr/main/documentTextCatalog';
import {
    loadCompactSearchIndex,
    loadSearchIndex,
    persistCompactSearchIndex,
    persistCompactSearchIndexStreaming,
} from '@electron/features/search/public';
import * as searchPublic from '@electron/features/search/public';

vi.mock('@electron/pdf/pdfPageCount', () => ({getPdfPageCount: vi.fn(async () => 3)}));

const OLD_TOKEN = requireDocumentRevisionToken('drt1:test:old');
const NEW_TOKEN = requireDocumentRevisionToken('drt1:test:new');
const OCR_PAGE_TEXTS = [
    'one',
    'two',
    'three',
];

async function describeOcrPageFiles(ocrPath: string) {
    const names = (await readdir(ocrPath)).filter(name => name !== 'manifest.json').sort();
    const described = await Promise.all(names.map(async name => [
        name,
        (await stat(join(ocrPath, name))).ino,
    ] as const));
    return Object.fromEntries(described);
}

describe('page identity revision fencing', () => {
    let root = '';
    let scheduledPath = '';

    afterEach(async () => {
        if (scheduledPath) {
            forgetPageIdentityStoreInitialization(scheduledPath);
            scheduledPath = '';
        }
        if (root) {
            await rm(root, {
                force: true,
                recursive: true,
            });
            root = '';
        }
        vi.mocked(getPdfPageCount).mockReset();
        vi.mocked(getPdfPageCount).mockResolvedValue(3);
    });

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

    async function seedOcrdWorkingCopy() {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-'));
        const path = join(root, 'working.pdf');
        const ocrPath = `${path}.ocr`;
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            mkdir(ocrPath),
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
        await Promise.all(OCR_PAGE_TEXTS.map((text, index) => writeFile(
            join(ocrPath, `page-${index + 1}.json`),
            JSON.stringify({
                rotation: 0,
                render: {
                    dpi: 300,
                    imagePx: {
                        w: 1200,
                        h: 1600,
                    },
                },
                text,
                words: [],
            }),
        )));
        await writeFile(join(ocrPath, 'manifest.json'), JSON.stringify({
            version: 3,
            documentRevision: {token: OLD_TOKEN},
            createdAt: 1,
            source: {pdfPath: path},
            pageCount: 3,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {
                1: {
                    path: 'page-1.json',
                    generation: 'ocr-run-one',
                },
                2: {
                    path: 'page-2.json',
                    generation: 'ocr-run-one',
                },
                3: {
                    path: 'page-3.json',
                    generation: 'ocr-run-two',
                },
            },
        }));
        await writeFile(`${path}.index.json`, JSON.stringify({
            schemaVersion: 7,
            documentRevision: {token: OLD_TOKEN},
            pdfPath: path,
            createdAt: 1,
            pageCount: 3,
            pages: OCR_PAGE_TEXTS.map((text, index) => ({
                pageNumber: requirePageNumber(index + 1),
                text,
            })),
        }));
        await persistCompactSearchIndex(path, {
            documentRevision: OLD_TOKEN,
            pageCount: 3,
            pages: OCR_PAGE_TEXTS.map((text, index) => ({
                pageNumber: requirePageNumber(index + 1),
                text,
            })),
        });
        return {
            path,
            ocrPath,
            newToken: NEW_TOKEN,
        };
    }

    it('rebases an empty range sidecar without inventing a page identity', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-rebase-empty-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 0,
                identitySeed: 'rebase-empty-fixture',
                ranges: [],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await rebasePageIdentitySidecarRevision(
            path,
            createRevisionInfo(path, OLD_TOKEN, 1, 1),
            nextRevisionInfo(path),
        );

        await expect(readFile(`${path}.evb-pages.json`, 'utf8'))
            .resolves
            .toContain(`"documentRevisionToken":"${NEW_TOKEN}"`);
        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            pageCount: number;
            ranges: unknown[];
            identitySeed?: string;
        };
        expect(sidecar.pageCount).toBe(0);
        expect(sidecar.ranges).toEqual([]);
        expect(sidecar.identitySeed).toBe('rebase-empty-fixture');
    });

    it('does not recreate a removed working-copy directory after background initialization is cancelled', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-cancel-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, '%PDF fixture');
        vi.mocked(getPdfPageCount).mockClear();
        let releasePageCount!: (pageCount: number) => void;
        vi.mocked(getPdfPageCount).mockImplementationOnce(() => new Promise(resolve => {
            releasePageCount = resolve;
        }));
        scheduledPath = path;
        schedulePageIdentityStoreInitialization(
            path,
            createRevisionInfo(
                path,
                requireDocumentRevisionToken('drt1:test:cancelled'),
                1,
                1,
            ),
        );

        expect(getPdfPageCount).not.toHaveBeenCalled();
        const task = awaitPageIdentityStoreInitialization(path);
        const rejection = expect(task).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(getPdfPageCount).toHaveBeenCalled());
        forgetPageIdentityStoreInitialization(path);
        const signal = vi.mocked(getPdfPageCount).mock.calls.at(-1)?.[1]?.signal;
        expect(signal?.aborted).toBe(true);
        await rm(root, {
            recursive: true,
            force: true,
        });
        releasePageCount(3);
        await rejection;
        await expect(stat(root)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(readFile(`${path}.evb-pages.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('publishes deferred initialization with the revision current when initialization starts', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-revision-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, '%PDF fixture');
        scheduledPath = path;
        schedulePageIdentityStoreInitialization(path, createRevisionInfo(path, OLD_TOKEN, 1, 1));

        await publishRevisionSidecar(path, NEW_TOKEN);
        await awaitPageIdentityStoreInitialization(path);

        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {documentRevisionToken: string};
        expect(sidecar.documentRevisionToken).toBe(NEW_TOKEN);
        forgetPageIdentityStoreInitialization(path);
    });

    it('rejects deferred initialization when the working copy revision changes during page discovery', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-revision-race-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, '%PDF fixture');
        await publishRevisionSidecar(path, OLD_TOKEN);
        let releasePageCount!: (pageCount: number) => void;
        vi.mocked(getPdfPageCount).mockImplementationOnce(() => new Promise(resolve => {
            releasePageCount = resolve;
        }));
        scheduledPath = path;
        schedulePageIdentityStoreInitialization(path, createRevisionInfo(path, OLD_TOKEN, 1, 1));

        const task = awaitPageIdentityStoreInitialization(path);
        await vi.waitFor(() => expect(getPdfPageCount).toHaveBeenCalled());
        await publishRevisionSidecar(path, NEW_TOKEN);
        releasePageCount(3);

        await expect(task).rejects.toThrow('Page identity state belongs to a stale document revision');
        await expect(readFile(`${path}.evb-pages.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
        forgetPageIdentityStoreInitialization(path);
    });

    it('conserves page IDs, OCR, and both search indexes through one structural delta', async () => {
        const {
            path, ocrPath, newToken,
        } = await seedOcrdWorkingCopy();
        await commitPageIdentityDelta(path, createReorderIdentityDelta(3, [
            3,
            1,
            2,
        ]), nextRevisionInfo(path));

        const pageIdentity = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            version: number;
            storage: string;
            documentRevisionToken: string;
            pageIds: string[];
        };
        expect(pageIdentity).toMatchObject({
            version: 2,
            storage: 'ranges',
            documentRevisionToken: newToken,
            pageIds: [
                'page-c',
                'page-a',
                'page-b',
            ],
        });
        const ocrManifest = JSON.parse(await readFile(join(ocrPath, 'manifest.json'), 'utf8')) as {
            documentRevision: {token: string};
            pages: Record<string, {generation?: string}>;
        };
        expect(ocrManifest.documentRevision.token).toBe(newToken);
        expect([
            ocrManifest.pages['1']?.generation,
            ocrManifest.pages['2']?.generation,
            ocrManifest.pages['3']?.generation,
        ]).toEqual([
            'ocr-run-two',
            'ocr-run-one',
            'ocr-run-one',
        ]);
        await publishRevisionSidecar(path, newToken);
        await expect(resolveDocumentOcrPage(path, newToken, 1)).resolves.toMatchObject({page: {text: 'three'}});
        await expect(loadSearchIndex(path, newToken)).resolves.toMatchObject({
            pageCount: 3,
            pages: [
                {
                    pageNumber: 1,
                    text: 'three',
                },
                {
                    pageNumber: 2,
                    text: 'one',
                },
                {
                    pageNumber: 3,
                    text: 'two',
                },
            ],
        });
        await expect(loadCompactSearchIndex(path, {documentRevision: newToken})).resolves.toMatchObject({
            pageCount: 3,
            pages: [
                {
                    pageNumber: 1,
                    text: 'three',
                },
                {
                    pageNumber: 2,
                    text: 'one',
                },
                {
                    pageNumber: 3,
                    text: 'two',
                },
            ],
        });
    });

    it('leaves every OCR page file untouched when rotate or crop bumps the revision', async () => {
        const {
            path, ocrPath, newToken,
        } = await seedOcrdWorkingCopy();
        const before = await describeOcrPageFiles(ocrPath);
        await commitPageIdentityDelta(path, createIdentityDelta(3), nextRevisionInfo(path));

        expect(await describeOcrPageFiles(ocrPath)).toEqual(before);
        await publishRevisionSidecar(path, newToken);
        await expect(resolveDocumentOcrPage(path, newToken, 2)).resolves.toMatchObject({
            pageCount: 3,
            page: {
                pageNumber: 2,
                text: 'two',
            },
        });
    });

    it('invalidates sparse high-page-count search sidecars without loading or persisting them', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-xlarge-'));
        const path = join(root, 'working.pdf');
        const pageCount = 201;
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 1,
                documentRevisionToken: OLD_TOKEN,
                pageIds: Array.from({length: pageCount}, (_value, index) => `page-${index}`),
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
            writeFile(`${path}.index.json`, JSON.stringify({
                schemaVersion: 7,
                documentRevision: {token: OLD_TOKEN},
                pdfPath: path,
                createdAt: 1,
                pageCount,
                pages: [{
                    pageNumber: 1,
                    text: 'sparse',
                }],
            })),
        ]);
        await persistCompactSearchIndexStreaming(path, {
            documentRevision: OLD_TOKEN,
            pageCount,
        }, [{
            pageNumber: requirePageNumber(1),
            text: 'sparse',
        }]);

        const loadLegacy = vi.spyOn(searchPublic, 'loadSearchIndex');
        const loadCompact = vi.spyOn(searchPublic, 'loadCompactSearchIndex');
        const persistCompact = vi.spyOn(searchPublic, 'persistCompactSearchIndex');
        await commitPageIdentityDelta(path, createIdentityDelta(pageCount), nextRevisionInfo(path));

        expect(loadLegacy).not.toHaveBeenCalled();
        expect(loadCompact).not.toHaveBeenCalled();
        expect(persistCompact).not.toHaveBeenCalled();
        await expect(stat(`${path}.index.json`)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(stat(`${path}.index.evb-search-v2.bin`)).rejects.toMatchObject({code: 'ENOENT'});
    });
});
