import {
    mkdtemp,
    readFile,
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
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import type {
    IPdfPageSize,
    IPdfPageSizeStore,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {runLosslessScanCleanup} from '@evb/scan-cleanup/core/runLosslessScanCleanup';
import type {
    IRunScanCleanupPipelineDependencies,
    IScanCleanupPageRasterSource,
    IScanCleanupWorkerPaths,
    TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';
import type {TEmitScanCleanupProgress} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {resolveScanCleanupPageScopeLazy} from '@evb/scan-cleanup/core/pageScope';

const roots: string[] = [];

const options: IScanCleanupOptions = {
    preserveOriginalQuality: true,
    layoutMode: 'auto',
    outputMode: 'auto',
    readingOrder: 'ltr',
    thickness: 0,
    crop: false,
    matchPageSize: false,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 0,
        topMm: 0,
        rightMm: 0,
        bottomMm: 0,
    },
    despeckle: false,
    skipBlankPages: false,
    pageOverrides: {},
};

const policy: IScanCleanupRuntimePolicy = {
    rasterConcurrency: 2,
    rasterStreaming: true,
    logicalCpus: 4,
    totalRamBytes: 8 * 1024 ** 3,
};

function pageGeometry(pageNumber: number): IPdfPageSize {
    return {
        pageNumber,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 612,
        heightPoints: 792,
        rotation: 0,
    };
}

function paths(root: string): IScanCleanupWorkerPaths {
    return {
        qpdfBinary: '/qpdf',
        pdftoppmBinary: '/pdftoppm',
        pdfimagesBinary: '/pdfimages',
        scanCleanupBinary: '/scan-cleanup',
        pdfImageCombineBinary: '/pdf-image-combine',
        pdfPageOpsBinary: '/pdf-page-ops',
        provenanceStampSupport: false,
        tempDir: root,
    };
}

function analysisMetadata() {
    return {
        layoutClassification: 'single-uncut-page',
        cutterXPx: null,
        rotationDegrees: 0,
        canvasScope: 'document',
        excluded: false,
        blankOutputsSkipped: 0,
        outputCount: 1,
        outputs: [{
            half: 'full',
            sourceRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 100,
                heightPx: 100,
            },
            cropRect: {
                xPx: 0,
                yPx: 0,
                widthPx: 100,
                heightPx: 100,
            },
            contentBox: {
                xPx: 0,
                yPx: 0,
                widthPx: 100,
                heightPx: 100,
            },
            inputWidthPx: 100,
            inputHeightPx: 100,
        }],
    };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('runLosslessScanCleanup', () => {
    it('publishes a bounded compact-source budget for a full run above one batch', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-lossless-budget-test-'));
        roots.push(root);
        const sourcePdfPath = join(root, 'source.pdf');
        const stagedPdfPath = join(root, 'staged.pdf');
        const outputPdfPath = join(root, 'output.pdf');
        const documentPageCount = 1_025;
        await writeFile(sourcePdfPath, '%PDF-lossless-source');

        const pageSizeStore: IPdfPageSizeStore = {
            pageCount: documentPageCount,
            getPage: vi.fn(async pageNumber => pageGeometry(pageNumber)),
            readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) => {
                const pages: IPdfPageSize[] = [];
                for (let pageNumber = firstPageNumber; pageNumber < lastPageNumberExclusive; pageNumber += 1) {
                    pages.push(pageGeometry(pageNumber));
                }
                return pages;
            }),
            forEachChunk: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
        };
        const sourceDpi: IScanCleanupPageRasterSource = {
            detected: true,
            documentDpi: 300,
            getPageRaster: vi.fn((pageNumber: number) => ({
                dpi: 300,
                width: 2_550,
                height: 3_300,
                hasBilevelLayer: true,
                backgroundDpi: 120,
                pageNumber,
            })),
        };
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (
            _binaryPath,
            manifestPath,
            _signal,
            _log,
            onProgress,
        ) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>};
            for (const [
                index,
                page,
            ] of manifest.pages.entries()) {
                await writeFile(page.pageMetadataPath, JSON.stringify(analysisMetadata()));
                onProgress({
                    stage: 'page-complete',
                    completedPages: index + 1,
                    totalPages: manifest.pages.length,
                    pageNumber: index + 1,
                });
            }
        });
        const renderRaster: IRunScanCleanupPipelineDependencies['renderPage'] = async (
            _paths,
            _log,
            _pageNumber,
            _source,
            outputPath,
        ) => {
            await writeFile(outputPath, 'P6\n1 1\n255\n\0\0\0');
        };
        const dependencies: IRunScanCleanupPipelineDependencies = {
            getPageCount: vi.fn(async () => documentPageCount),
            getPageSizeStore: vi.fn(async () => pageSizeStore),
            detectSourceDpi: vi.fn(async () => sourceDpi),
            renderPage: renderRaster,
            renderPagePpm: renderRaster,
            runSidecar,
            runCommand: vi.fn(async (_command, args) => {
                const outputPath = args[args.indexOf('--output') + 1]!;
                await writeFile(outputPath, '%PDF-1.7\n%%EOF\n');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }),
            getAvailableScratchBytes: vi.fn(async () => null),
            hashNativeBinary: vi.fn(async () => 'a'.repeat(64)),
        };
        await runLosslessScanCleanup(
            {
                sourcePdfPath,
                outputPdfPath,
                options,
            },
            paths(root),
            sourcePdfPath,
            [],
            resolveScanCleanupPageScopeLazy(undefined, documentPageCount),
            pageSizeStore,
            sourceDpi,
            root,
            stagedPdfPath,
            new AbortController().signal,
            vi.fn<TEmitScanCleanupProgress>(),
            vi.fn<TScanCleanupLog>(),
            policy,
            dependencies,
        );

        const report = JSON.parse(await readFile(
            join(root, 'scan-cleanup-representation-report.json'),
            'utf8',
        )) as {compactSourceBudget: {
            compactLayeredPages: number;
            maxOutputBytes: number;
        } | null;};
        expect(report.compactSourceBudget).toMatchObject({compactLayeredPages: documentPageCount});
        expect(report.compactSourceBudget?.maxOutputBytes).toBeGreaterThan(0);
    }, 30_000);
});
