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
