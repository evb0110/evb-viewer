import {
    copyFile,
    mkdir,
    mkdtemp,
    open as fsOpen,
    readFile,
    readdir,
    rm,
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
import {
    createFileBackedScanCleanupDetectionResultStore,
    createFileBackedScanCleanupResultStore,
} from '@evb/scan-cleanup/core/fileBackedResultStore';
import {
    preserveScanCleanupJsonEvidence,
    type IScanCleanupEvidenceFileSystem,
} from '@evb/scan-cleanup/core/preserveScanCleanupJsonEvidence';
import {runLosslessScanCleanup} from '@evb/scan-cleanup/core/runLosslessScanCleanup';
import {resolveScanCleanupPageScopeLazy} from '@evb/scan-cleanup/core/pageScope';
import type {
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
    TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';
import type {IPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import type {IScanCleanupDetectionResult} from '@contracts/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';

const roots: string[] = [];

interface IClassificationRecord {
    pageNumber: number;
    classification: string;
}

interface IValueRecord {
    pageNumber: number;
    value: string;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

describe('file-backed scan-cleanup result store', () => {
    it('uses the composed filesystem for creation and cleanup', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-result-store-test-'));
        roots.push(root);
        const calls = {
            mkdtemp: 0,
            open: 0,
            rm: 0,
        };
        const fileSystem = {
            mkdtemp: async (prefix: string) => {
                calls.mkdtemp++;
                return mkdtemp(prefix);
            },
            open: async (path: string, flags: 'r' | 'w+') => {
                calls.open++;
                return fsOpen(path, flags);
            },
            rm: async (
                path: string,
                options: {
                    force: boolean;
                    recursive: boolean;
                },
            ) => {
                calls.rm++;
                return rm(path, options);
            },
        };
        const store = await createFileBackedScanCleanupResultStore<IValueRecord>({
            fileSystem,
            pageCount: 1,
            pageNumberOf: record => record.pageNumber,
            rootDir: root,
        });

        await store.close();

        expect(calls).toEqual({
            mkdtemp: 1,
            open: 2,
            rm: 1,
        });
        expect(await readdir(root)).toEqual([]);
    });

    it('uses the injected filesystem for JSON evidence preservation', async () => {
        const scratch = await mkdtemp(join(tmpdir(), 'scan-cleanup-evidence-scratch-'));
        const evidence = await mkdtemp(join(tmpdir(), 'scan-cleanup-evidence-output-'));
        roots.push(scratch, evidence);
        const report = JSON.stringify({pagesSidecarPath: join(scratch, 'pages.json')});
        await writeFile(join(scratch, 'pages.json'), '{}\n');
        await writeFile(join(scratch, 'scan-cleanup-representation-report.json'), report);
        const calls = {
            copyFile: 0,
            mkdir: 0,
            readdir: 0,
            readFile: 0,
            writeFile: 0,
        };
        const fileSystem: IScanCleanupEvidenceFileSystem = {
            copyFile: async (source, destination) => {
                calls.copyFile++;
                await copyFile(source, destination);
            },
            mkdir: async (path, options) => {
                calls.mkdir++;
                await mkdir(path, options);
                return undefined;
            },
            readdir: async (path, options) => {
                calls.readdir++;
                return readdir(path, options);
            },
            readFile: async (path, encoding) => {
                calls.readFile++;
                return readFile(path, encoding);
            },
            writeFile: async (path, data) => {
                calls.writeFile++;
                await writeFile(path, data);
            },
        };
        const previousEvidenceDir = process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR;
        process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR = evidence;
        try {
            await preserveScanCleanupJsonEvidence(scratch, vi.fn(), fileSystem);
        } finally {
            if (previousEvidenceDir === undefined) {
                delete process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR;
            } else {
                process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR = previousEvidenceDir;
            }
        }

        expect(calls).toEqual({
            copyFile: 2,
            mkdir: 1,
            readdir: 1,
            readFile: 1,
            writeFile: 2,
        });
        expect(JSON.parse(await readFile(join(evidence, 'scan-cleanup-representation-report.json'), 'utf8')))
            .toMatchObject({pagesSidecarPath: join(evidence, 'pages.json')});
    });

    it('omits analysis-only diagnostics from persisted detection records', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-result-store-test-'));
        roots.push(root);
        const store = await createFileBackedScanCleanupDetectionResultStore({
            pageCount: 1,
            rootDir: root,
        });
        const outputModeDiagnostics = {rule: 'blank'} as NonNullable<
            IScanCleanupDetectionResult['outputModeDiagnostics']
        >;
        const result: IScanCleanupDetectionResult = {
            pageNumber: requirePageNumber(1),
            revision: 1,
            classification: 'single-uncut-page',
            confidence: 1,
            cutterXPx: null,
            tier1Verdict: 'single-uncut-page',
            reconciled: false,
            clusterAgreement: 1,
            documentPrior: null,
            recommendedOutputMode: 'grayscale',
            outputModeDiagnostics,
            pagePlanEvidence: {
                pageNumber: requirePageNumber(1),
                rotationDegrees: 0,
                layoutClassification: 'single-uncut-page',
                outputs: {},
            },
        };

        await store.append(result);

        const persisted = await store.getPage(1);
        expect(persisted).not.toHaveProperty('outputModeDiagnostics');
        expect(persisted?.recommendedOutputMode).toBe('grayscale');
        expect(persisted?.pagePlanEvidence).toEqual(result.pagePlanEvidence);
        await store.close();
    });

    it('keeps million-page indexes sparse and limits reads to bounded windows', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-result-store-test-'));
        roots.push(root);
        const store = await createFileBackedScanCleanupResultStore<IClassificationRecord>({
            maxReadPages: 2,
            pageCount: 1_000_000,
            pageNumberOf: record => record.pageNumber,
            rootDir: root,
        });
        await store.append({
            pageNumber: 1,
            classification: 'first',
        });
        await store.append({
            pageNumber: 1_000_000,
            classification: 'last',
        });

        expect(await readdir(root)).toHaveLength(1);
        expect(store.pageCount).toBe(1_000_000);
        expect(store.resultCount).toBe(2);
        expect(await store.getPage(1)).toEqual({
            pageNumber: 1,
            classification: 'first',
        });
        expect(await store.readRange(999_999, 1_000_001)).toEqual([{
            pageNumber: 1_000_000,
            classification: 'last',
        }]);
        await expect(store.readRange(1, 4)).rejects.toThrow('bounded window');

        await store.close();
        await store.close();
        expect(await readdir(root)).toEqual([]);
    });

    it('replaces a record in place and iterates bounded chunks', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-result-store-test-'));
        roots.push(root);
        const store = await createFileBackedScanCleanupResultStore<IValueRecord>({
            maxReadPages: 2,
            pageCount: 4,
            pageNumberOf: record => record.pageNumber,
            rootDir: root,
        });
        await store.append({
            pageNumber: 1,
            value: 'old',
        });
        await store.append({
            pageNumber: 3,
            value: 'three',
        });
        await store.replace(1, {
            pageNumber: 1,
            value: 'new',
        });

        expect(await store.getPage(1)).toEqual({
            pageNumber: 1,
            value: 'new',
        });
        const chunks: Array<{
            firstPageNumber: number;
            records: unknown[]
        }> = [];
        await store.forEachChunk((records, firstPageNumber) => {
            chunks.push({
                firstPageNumber,
                records: [...records],
            });
        });
        expect(chunks).toEqual([
            {
                firstPageNumber: 1,
                records: [{
                    pageNumber: 1,
                    value: 'new',
                }],
            },
            {
                firstPageNumber: 3,
                records: [{
                    pageNumber: 3,
                    value: 'three',
                }],
            },
        ]);

        await store.close();
    });

    it('skips a repeated lossless canvas prepass for a supplied parent canvas', async () => {
        const pageCount = 20_001;
        const forEachChunk = vi.fn(async () => undefined);
        const pageSizeStore: IPdfPageSizeStore = {
            pageCount,
            getPage: vi.fn(),
            readRange: vi.fn(),
            forEachChunk,
            close: vi.fn(async () => undefined),
        };
        const controller = new AbortController();
        controller.abort(new Error('lossless child canceled'));
        const request = {
            options: {matchPageSize: true},
            outputPdfPath: '/tmp/scan-cleanup-output.pdf',
            sourcePdfPath: '/tmp/scan-cleanup-source.pdf',
        } as IRunScanCleanupPipelineRequest;
        const paths = {
            pdfImageCombineBinary: 'pdf-image-combine',
            pdfPageOpsBinary: 'pdf-page-ops',
            pdftoppmBinary: 'pdftoppm',
            qpdfBinary: 'qpdf',
            scanCleanupBinary: 'scan-cleanup',
            tempDir: '/tmp',
        } as IScanCleanupWorkerPaths;
        const dependencies = {} as IRunScanCleanupPipelineDependencies;
        const policy = {} as IScanCleanupRuntimePolicy;
        const dpiSource = {
            detected: false,
            documentDpi: 300,
            getPageRaster: () => undefined,
        };
        const pageNumbers = resolveScanCleanupPageScopeLazy(undefined, pageCount);

        await expect(runLosslessScanCleanup(
            request,
            paths,
            request.sourcePdfPath,
            [],
            pageNumbers,
            pageSizeStore,
            dpiSource,
            '/tmp',
            '/tmp/scan-cleanup-staged.pdf',
            controller.signal,
            vi.fn(),
            (() => undefined) as TScanCleanupLog,
            policy,
            dependencies,
            {documentCanvas: {
                heightPoints: 792,
                heightPx: 3_300,
                widthPoints: 612,
                widthPx: 2_550,
            }},
        )).rejects.toThrow('lossless child canceled');
        expect(forEachChunk).not.toHaveBeenCalled();
        expect(pageSizeStore.readRange).not.toHaveBeenCalled();
    });
});
