import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import type * as TFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';
import type { IOcrPdfPageRequest } from '@electron/ocr/worker/types';

const probe = vi.hoisted(() => {
    const state = {
        invocations: [] as string[][],
        textByPage: new Map<number, string>(),
        fail: false,
    };
    const runPdftotext = (_command: string, args: string[]) => {
        state.invocations.push(args);
        if (state.fail) {
            return Promise.reject(new Error('pdftotext exploded'));
        }
        const firstPage = Number(args[args.indexOf('-f') + 1]);
        const lastPage = Number(args[args.indexOf('-l') + 1]);
        const pages: string[] = [];
        for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
            pages.push(state.textByPage.get(pageNumber) ?? '');
        }
        return Promise.resolve({
            stdout: `${pages.join('\f')}\f`,
            stderr: '',
            exitCode: 0,
        });
    };
    return {
        state,
        runPdftotext,
    };
});

vi.mock('@electron/features/ocr/worker/runOcrCommand', () => ({runOcrCommand: probe.runPdftotext}));

const catalogReads = vi.hoisted(() => ({
    files: [] as string[],
    recording: false,
}));

vi.mock('node:fs/promises', async (importActual) => {
    const actual = await importActual<typeof TFsPromises>();
    const readFile = ((...args: Parameters<typeof actual.readFile>) => {
        const target = String(args[0]);
        if (catalogReads.recording && /\.ocr[\\/]/u.test(target)) {
            catalogReads.files.push(target.split(/[\\/]/u).at(-1) ?? target);
        }
        return actual.readFile(...args);
    }) as typeof actual.readFile;
    const open = ((...args: Parameters<typeof actual.open>) => {
        const target = String(args[0]);
        if (catalogReads.recording && /\.ocr[\\/]/u.test(target)) {
            catalogReads.files.push(target.split(/[\\/]/u).at(-1) ?? target);
        }
        return actual.open(...args);
    }) as typeof actual.open;
    return {
        ...actual,
        default: {
            ...actual,
            readFile,
            open,
        },
        readFile,
        open,
    };
});

vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: () => Promise.resolve()}));

const { selectOcrPagesForSupersession } = await import('@electron/features/ocr/worker/selectOcrPagesForSupersession');
const {
    getOcrPageSelectionCount,
    iterateOcrPageRequestBatches,
    validateCreateSearchablePdfPayload,
} = await import('@electron/features/ocr/contracts');
const { writeOcrIndexV3 } = await import('@electron/ocr/worker/indexWriter');

let tempDir: string | null = null;

async function createSourcePdf(pageCount: number) {
    tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-supersession-'));
    const pdf = await PDFDocument.create();
    for (let page = 1; page <= pageCount; page += 1) {
        pdf.addPage([
            200,
            300,
        ]);
    }
    const path = join(tempDir, 'source.pdf');
    await writeFile(path, await pdf.save());
    return path;
}

function pageRequests(pageNumbers: readonly number[]): IOcrPdfPageRequest[] {
    return pageNumbers.map(pageNumber => ({
        pageNumber,
        languages: ['eng'],
    }));
}

function runSelection(
    sourcePdfPath: string,
    pageNumbers: readonly number[],
    logs: Array<[string, string]>,
) {
    return selectOcrPagesForSupersession({
        sourcePdfPath,
        documentRevisionToken: requireDocumentRevisionToken('revision-1'),
        pages: pageRequests(pageNumbers),
        supersessionPolicy: 'missing-only',
        pdftotextBinary: '/fake/pdftotext',
        log: (level, message) => {
            logs.push([
                level,
                message,
            ]);
        },
        signal: new AbortController().signal,
    });
}

const CURRENT_REVISION = requireDocumentRevisionToken('revision-1');

async function writeCatalogWithOcrWorker(
    sourcePdfPath: string,
    pageNumbers: readonly number[],
    pageCount = pageNumbers.length,
) {
    await writeOcrIndexV3(
        sourcePdfPath,
        {
            version: 1,
            documentRef: requireDocumentRef(sourcePdfPath),
            authority: 'electron-working-copy',
            token: CURRENT_REVISION,
            contentRevision: 1,
            mintedAt: requireEpochMs(1),
        },
        pageNumbers.map(pageNumber => ({
            pageNumber,
            text: `evb ocr text ${pageNumber}`,
            words: [{
                text: 'evb',
                x: 10,
                y: 20,
                width: 30,
                height: 12,
            }],
            imageWidth: 1200,
            imageHeight: 1600,
        })),
        pageCount,
        ['eng'],
        300,
        () => {},
    );
}

async function readManifestGenerations(sourcePdfPath: string) {
    const manifest = JSON.parse(await readFile(join(`${sourcePdfPath}.ocr`, 'manifest.json'), 'utf8')) as {pages: Record<string, {
        path: string;
        generation?: string;
    }>;};
    return Object.fromEntries(Object.entries(manifest.pages)
        .map(([
            pageNumber,
            mapping,
        ]) => [
            Number(pageNumber),
            mapping.generation,
        ]));
}

async function readArtifactGenerations(sourcePdfPath: string) {
    const manifest = JSON.parse(await readFile(join(`${sourcePdfPath}.ocr`, 'manifest.json'), 'utf8')) as {pages: Record<string, {path: string}>;};
    const generations: Record<number, string | undefined> = {};
    for (const [
        pageNumber,
        mapping,
    ] of Object.entries(manifest.pages)) {
        const artifact = JSON.parse(await readFile(join(`${sourcePdfPath}.ocr`, mapping.path), 'utf8')) as {canonicalText?: {generation?: string};};
        generations[Number(pageNumber)] = artifact.canonicalText?.generation;
    }
    return generations;
}

/** A v3 catalog as written before the manifest carried per-page generations. */
async function writeCatalogWithoutManifestGenerations(
    sourcePdfPath: string,
    pageNumbers: readonly number[],
    revisionToken: string,
) {
    const catalogDir = `${sourcePdfPath}.ocr`;
    await mkdir(catalogDir, {recursive: true});
    const pages: Record<number, {path: string}> = {};
    for (const pageNumber of pageNumbers) {
        const pageFile = `page-${String(pageNumber).padStart(4, '0')}.json`;
        pages[pageNumber] = {path: pageFile};
        await writeFile(join(catalogDir, pageFile), JSON.stringify({
            rotation: 0,
            render: {
                dpi: 300,
                imagePx: {
                    w: 1200,
                    h: 1600,
                },
            },
            text: `evb ocr text ${pageNumber}`,
            words: [],
            canonicalText: {
                source: 'evb-ocr',
                generation: 'legacy-run',
                contentDigest: 'a'.repeat(64),
            },
        }));
    }
    await writeFile(join(catalogDir, 'manifest.json'), JSON.stringify({
        version: 3,
        documentRevision: {token: revisionToken},
        createdAt: 1753500000000,
        source: {pdfPath: sourcePdfPath},
        pageCount: pageNumbers.length,
        pageBox: 'crop',
        ocr: {
            engine: 'tesseract',
            languages: ['eng'],
            renderDpi: 300,
        },
        pages,
    }));
}

function recordCatalogReads() {
    catalogReads.files = [];
    catalogReads.recording = true;
}

function expectBoundedCatalogReads() {
    expect(catalogReads.files.length).toBeGreaterThan(0);
    expect(catalogReads.files.length).toBeLessThanOrEqual(3);
    expect(catalogReads.files.every(file => file === 'manifest.json')).toBe(true);
}

afterEach(async () => {
    probe.state.invocations = [];
    probe.state.textByPage = new Map();
    probe.state.fail = false;
    catalogReads.files = [];
    catalogReads.recording = false;
    if (tempDir) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        tempDir = null;
    }
});

describe('OCR supersession page selection', () => {
    it('keeps million-page selections scalar and expands only bounded worker batches', () => {
        for (const pageCount of [
            100_001,
            1_000_001,
        ]) {
            const validated = validateCreateSearchablePdfPayload(
                '/tmp/source.pdf',
                {
                    kind: 'all',
                    pageCount,
                    languages: ['eng'],
                },
                'request-1',
            );
            expect(validated.pages).toEqual({
                kind: 'all',
                pageCount,
                languages: ['eng'],
            });
            expect(getOcrPageSelectionCount(validated.pages)).toBe(pageCount);

            let batchCount = 0;
            let coveredPages = 0;
            let previousLastPage = 0;
            for (const pageBatch of iterateOcrPageRequestBatches(validated.pages)) {
                expect(pageBatch.length).toBeLessThanOrEqual(5_000);
                expect(pageBatch[0]?.pageNumber).toBe(previousLastPage + 1);
                previousLastPage = pageBatch.at(-1)?.pageNumber ?? previousLastPage;
                coveredPages += pageBatch.length;
                batchCount += 1;
            }

            expect(coveredPages).toBe(pageCount);
            expect(previousLastPage).toBe(pageCount);
            expect(batchCount).toBe(Math.ceil(pageCount / 5_000));

            const earlyIterator = iterateOcrPageRequestBatches(validated.pages);
            const firstBatch = earlyIterator.next();
            expect(firstBatch.done).toBe(false);
            expect(firstBatch.value).toHaveLength(5_000);
            expect(earlyIterator.return?.(undefined).done).toBe(true);

            expect(() => validateCreateSearchablePdfPayload(
                '/tmp/source.pdf',
                Array.from({length: 100_001}, () => ({
                    pageNumber: 1,
                    languages: ['eng'],
                })),
                'request-2',
            )).toThrow(/maximum size/u);
        }
    });

    it('probes existing text with one process per contiguous page run', async () => {
        const sourcePdfPath = await createSourcePdf(6);
        probe.state.textByPage = new Map([
            [
                1,
                'chapter one',
            ],
            [
                2,
                'chapter two',
            ],
            [
                4,
                'chapter four',
            ],
            [
                5,
                'chapter five',
            ],
            [
                6,
                'chapter six',
            ],
        ]);

        const contiguous = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
            4,
            5,
            6,
        ], []);
        expect(probe.state.invocations).toHaveLength(1);
        expect(contiguous.pages.map(page => page.pageNumber)).toEqual([3]);

        probe.state.invocations = [];
        const sparse = await runSelection(sourcePdfPath, [
            1,
            2,
            5,
            6,
        ], []);
        expect(probe.state.invocations).toHaveLength(2);
        expect(sparse.pages).toEqual([]);
    });

    it('keeps the page to text mapping aligned across a batched probe', async () => {
        const sourcePdfPath = await createSourcePdf(5);
        probe.state.textByPage = new Map([[
            2,
            'only page two carries text',
        ]]);

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
            4,
            5,
        ], []);

        expect(selection.pages.map(page => page.pageNumber)).toEqual([
            1,
            3,
            4,
            5,
        ]);
        expect(selection.diagnostics).toEqual([{
            code: 'OCR_EXISTING_TEXT_SKIPPED',
            severity: 'info',
            pageNumber: 2,
            message: expect.stringContaining('native-text'),
        }]);
    });

    it('reports a failed text probe instead of silently treating pages as text bearing', async () => {
        const sourcePdfPath = await createSourcePdf(3);
        probe.state.fail = true;
        const logs: Array<[string, string]> = [];

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
        ], logs);

        expect(selection.pages).toEqual([]);
        expect(logs.some(([
            level,
            message,
        ]) => level === 'warn' && message.includes('pdftotext exploded'))).toBe(true);
        expect(selection.warnings.some(warning => warning.includes('pdftotext exploded'))).toBe(true);
    });

    it('recognises its own OCR output from the manifest without opening page artifacts', async () => {
        const sourcePdfPath = await createSourcePdf(3);
        await writeCatalogWithOcrWorker(sourcePdfPath, [
            1,
            2,
            3,
        ]);
        recordCatalogReads();

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
        ], []);

        expect(selection.pages).toEqual([]);
        expect(selection.diagnostics.map(diagnostic => diagnostic.pageNumber)).toEqual([
            1,
            2,
            3,
        ]);
        expectBoundedCatalogReads();
    });

    it('keeps pages from an earlier run current after a partial re-OCR', async () => {
        const sourcePdfPath = await createSourcePdf(3);
        await writeCatalogWithOcrWorker(sourcePdfPath, [
            1,
            2,
            3,
        ]);
        await writeCatalogWithOcrWorker(sourcePdfPath, [2], 3);
        recordCatalogReads();

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
        ], []);

        expect(selection.pages).toEqual([]);
        expectBoundedCatalogReads();
        const generations = await readManifestGenerations(sourcePdfPath);
        expect(generations[2]).not.toBe(generations[1]);
        expect(generations[3]).toBe(generations[1]);
        expect(generations).toEqual(await readArtifactGenerations(sourcePdfPath));
    });

    it('keeps a catalog written before the manifest carried generations from forcing a re-OCR', async () => {
        const sourcePdfPath = await createSourcePdf(3);
        await writeCatalogWithoutManifestGenerations(sourcePdfPath, [
            1,
            2,
            3,
        ], CURRENT_REVISION);
        recordCatalogReads();

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
        ], []);

        expect(selection.pages).toEqual([]);
        expectBoundedCatalogReads();
    });

    it('ignores a catalog left behind by an earlier document revision', async () => {
        const sourcePdfPath = await createSourcePdf(2);
        await writeCatalogWithoutManifestGenerations(sourcePdfPath, [
            1,
            2,
        ], requireDocumentRevisionToken('revision-0'));
        recordCatalogReads();

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
        ], []);

        expect(selection.pages.map(page => page.pageNumber)).toEqual([
            1,
            2,
        ]);
        expectBoundedCatalogReads();
    });

    it('reports degraded text visibility analysis instead of swallowing it', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-supersession-'));
        const sourcePdfPath = join(tempDir, 'broken.pdf');
        await writeFile(sourcePdfPath, 'not a pdf at all');
        probe.state.textByPage = new Map([[
            1,
            'existing text',
        ]]);
        const logs: Array<[string, string]> = [];

        const selection = await runSelection(sourcePdfPath, [1], logs);

        expect(selection.pages).toEqual([]);
        expect(logs.some(([
            level,
            message,
        ]) => level === 'warn' && message.includes('qpdf is unavailable'))).toBe(true);
        expect(selection.warnings.some(warning => warning.includes('qpdf is unavailable'))).toBe(true);
    });
});
