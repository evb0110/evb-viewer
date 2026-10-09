import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
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
import type {TOcrTextSupersessionPolicy} from '@contracts/electronApiOcr';
import type { IOcrPdfPageRequest } from '@electron/features/ocr/pipeline/types';

const probe = vi.hoisted(() => {
    const state = {
        invocations: [] as string[][],
        textByPage: new Map<number, string>(),
        visibilityByPage: new Map<number, Record<string, unknown>>(),
        visibilityFailure: null as string | null,
        fail: false,
    };
    const runPdftotext = async (_command: string, args: string[]) => {
        if (args[0] === 'ocr-text-visibility') {
            if (state.visibilityFailure !== null) {
                throw new Error(state.visibilityFailure);
            }
            const {readFile} = await import('node:fs/promises');
            const pagesFile = await readFile(args[args.indexOf('--pages-file') + 1]!, 'utf8');
            return {
                stdout: JSON.stringify({
                    format: 'evb-pdf-ocr-text-visibility',
                    schemaVersion: 3,
                    pages: pagesFile.trim().split('\n').map(Number).map(pageNumber => ({
                        pageNumber,
                        evbOcrLayer: false,
                        paintedText: false,
                        hiddenText: false,
                        uncertain: null,
                        unsupported: null,
                        evbOcrLines: null,
                        ...state.visibilityByPage.get(pageNumber),
                    })),
                }),
                stderr: '',
                exitCode: 0,
            };
        }
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

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: probe.runPdftotext}));

const { selectOcrPagesForSupersession } = await import('@electron/features/ocr/pipeline/selectOcrPagesForSupersession');
const {
    getOcrPageSelectionCount,
    iterateOcrPageRequestBatches,
    validateCreateSearchablePdfPayload,
} = await import('@electron/features/ocr/contracts');

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
    supersessionPolicy: TOcrTextSupersessionPolicy = 'missing-only',
) {
    return selectOcrPagesForSupersession({
        sourcePdfPath,
        pages: pageRequests(pageNumbers),
        supersessionPolicy,
        pdftotextBinary: '/fake/pdftotext',
        pdfPageOpsBinary: '/fake/evb-pdf-page-ops',
        tempDir: tempDir!,
        log: (level, message) => {
            logs.push([
                level,
                message,
            ]);
        },
        signal: new AbortController().signal,
    });
}

afterEach(async () => {
    probe.state.invocations = [];
    probe.state.textByPage = new Map();
    probe.state.visibilityByPage = new Map();
    probe.state.visibilityFailure = null;
    probe.state.fail = false;
    if (tempDir) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        tempDir = null;
    }
});

describe('OCR supersession page selection', () => {
    it('accepts one request language and rejects multiple languages across pages', () => {
        expect(validateCreateSearchablePdfPayload(
            '/tmp/source.pdf',
            {
                kind: 'all',
                pageCount: 2,
                languages: ['eng'],
            },
            'single-language',
        ).pages).toMatchObject({languages: ['eng']});

        expect(() => validateCreateSearchablePdfPayload(
            '/tmp/source.pdf',
            {
                kind: 'all',
                pageCount: 2,
                languages: [
                    'eng',
                    'rus',
                ],
            },
            'multiple-languages',
        )).toThrow('OCR recognition accepts one language per request');

        expect(() => validateCreateSearchablePdfPayload(
            '/tmp/source.pdf',
            [
                {
                    pageNumber: 1,
                    languages: ['eng'],
                },
                {
                    pageNumber: 2,
                    languages: ['rus'],
                },
            ],
            'per-page-languages',
        )).toThrow('OCR recognition accepts one language per request');
    });

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
        // A page kept for its own text is information about the run, never a
        // warning the renderer presents as a failed page.
        expect(selection.warnings.filter(warning => warning.includes('Skipped page'))).toEqual([]);
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
        expect(selection.diagnostics).toHaveLength(3);
        expect(selection.diagnostics.every(diagnostic => diagnostic.severity === 'warning')).toBe(true);
        expect(logs.some(([
            level,
            message,
        ]) => level === 'warn' && message.includes('pdftotext exploded'))).toBe(true);
        expect(selection.warnings.some(warning => warning.includes('pdftotext exploded'))).toBe(true);
    });

    it('lets replace-all continue when the text probe fails', async () => {
        const sourcePdfPath = await createSourcePdf(3);
        probe.state.fail = true;

        const replaceEvb = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
        ], [], 'replace-evb');
        // Without an EVB OCR layer in the page streams there is nothing to replace.
        expect(replaceEvb.pages).toEqual([]);

        const replaceAll = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
        ], [], 'replace-all');
        expect(replaceAll.pages.map(page => page.pageNumber)).toEqual([
            1,
            2,
            3,
        ]);
    });

    it('reports degraded text visibility analysis instead of swallowing it', async () => {
        const sourcePdfPath = await createSourcePdf(1);
        probe.state.textByPage = new Map([[
            1,
            'existing text',
        ]]);
        probe.state.visibilityByPage = new Map([[
            1,
            {hiddenText: true},
        ]]);
        probe.state.visibilityFailure = 'evb-pdf-page-ops exploded';
        const logs: Array<[string, string]> = [];

        const selection = await runSelection(sourcePdfPath, [1], logs);

        // Unread text is the document's own, never a layer OCR may replace.
        expect(selection.pages).toEqual([]);
        expect(logs.some(([
            level,
            message,
        ]) => level === 'warn' && message.includes('evb-pdf-page-ops exploded'))).toBe(true);
        expect(selection.warnings.some(warning => warning.includes('could not be inspected'))).toBe(true);
    });

    it('keeps a page whose visible text follows a hidden layer and repairs a hidden-only page', async () => {
        const sourcePdfPath = await createSourcePdf(2);
        probe.state.textByPage = new Map([
            [
                1,
                'stale hidden note Harbor lantern signal',
            ],
            [
                2,
                'Qu1et rneadow',
            ],
        ]);
        probe.state.visibilityByPage = new Map([
            [
                1,
                {
                    paintedText: true,
                    hiddenText: true,
                },
            ],
            [
                2,
                {hiddenText: true},
            ],
        ]);

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
        ], []);

        expect(selection.pages.map(page => page.pageNumber)).toEqual([2]);
        expect(selection.diagnostics).toEqual([expect.objectContaining({
            pageNumber: 1,
            severity: 'info',
        })]);
        // A preserved page is information about the run, never a warning on it.
        expect(selection.warnings).toEqual([]);
    });

    it('skips a page the writer cannot replace instead of failing the run after recognition', async () => {
        const sourcePdfPath = await createSourcePdf(2);
        probe.state.textByPage = new Map([[
            1,
            'hidden words',
        ]]);
        probe.state.visibilityByPage = new Map([
            [
                1,
                {
                    hiddenText: true,
                    unsupported: 'hidden text shares a content stream with an inline image',
                },
            ],
            [
                2,
                {unsupported: 'text clipping rendering modes cannot be replaced safely'},
            ],
        ]);

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
        ], []);

        expect(selection.pages).toEqual([]);
        expect(selection.diagnostics).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                severity: 'warning',
                message: expect.stringContaining('inline image'),
            }),
            expect.objectContaining({
                pageNumber: 2,
                severity: 'warning',
                message: expect.stringContaining('clipping'),
            }),
        ]);
    });
});
