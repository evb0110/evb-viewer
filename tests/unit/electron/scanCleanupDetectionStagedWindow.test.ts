import {
    copyFile,
    mkdir,
    mkdtemp,
    open as fsOpen,
    readFile,
    readdir,
    rename,
    rm,
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
    vi,
} from 'vitest';
import {
    runScanCleanupDetection,
    type IScanCleanupDetectionRetention,
} from '@evb/scan-cleanup/core/detection';
import type {IScanCleanupDetectionRequest} from '@contracts/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    INativeScanCleanupManifestV3,
    INativeScanCleanupPageV3,
    TNativeScanCleanupProgressV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import type {TScanCleanupRunSidecar} from '@evb/scan-cleanup/core/types';
import type {IPdfPageSize} from '@evb/scan-cleanup/core/pdfPageSizes';

const MIB = 1024 * 1024;
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

const fileSystem = {
    copyFile,
    mkdir: async (path: string, options?: {recursive?: boolean}) => {
        await mkdir(path, options);
        return undefined;
    },
    readFile: async (path: string, encoding: 'utf8') => readFile(path, encoding),
    mkdtemp,
    open: async (path: string, flags: 'r' | 'w+') => fsOpen(path, flags),
    readdir,
    rm: async (
        path: string,
        options: {
            force: boolean;
            recursive?: boolean;
        },
    ) => rm(path, options),
    stat: async (path: string) => {
        const info = await stat(path);
        return {
            isFile: () => info.isFile(),
            size: info.size,
        };
    },
    writeFile: async (path: string, data: string | Uint8Array) => {
        await writeFile(path, data);
    },
};

const dirs: string[] = [];
const resultStores: Array<{close: () => Promise<void>}> = [];

afterEach(async () => {
    await Promise.all(resultStores.splice(0).map(store => store.close()));
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        force: true,
        recursive: true,
    })));
});

/**
 * Page geometry equivalent to the 148-page fixture reported in issue #108.
 *
 * The source PDF is copyrighted, so only its measurements are reproduced: seven
 * crop sizes, mostly landscape, with page 147 at the reported 841.89 × 633.89
 * points. Summed through the production estimate this reaches 629.41 MiB of
 * decoded rasters, the same whole-document footprint that used to refuse the
 * document outright, with the same 6.70 MiB largest page.
 */
const FIXTURE_GEOMETRY: ReadonlyArray<[widthPoints: number, heightPoints: number, pages: number]> = [
    [
        841.89,
        633.89,
        1,
    ],
    [
        700,
        568,
        1,
    ],
    [
        694,
        522,
        73,
    ],
    [
        672,
        500,
        6,
    ],
    [
        660,
        486,
        1,
    ],
    [
        648,
        470,
        65,
    ],
    [
        506,
        786,
        1,
    ],
];

function fixturePageSizes(): IPdfPageSize[] {
    // Interleaved so no run of the document shares one geometry, then page 147
    // is pinned to the reported outlier.
    const pool = FIXTURE_GEOMETRY.flatMap(([
        widthPoints,
        heightPoints,
        pages,
    ]) => Array.from({length: pages}, () => ({
        widthPoints,
        heightPoints,
    })));
    // 71 is coprime with 148, so this is a permutation of the pool rather than
    // a resampling of it: every crop size appears exactly as often as reported.
    const ordered = Array.from({length: pool.length}, (_, index) => pool[index * 71 % pool.length]!);
    const largest = ordered.findIndex(size => size.widthPoints === 841.89);
    [
        ordered[largest],
        ordered[146],
    ] = [
        ordered[146]!,
        ordered[largest]!,
    ];
    return ordered.map((size, index) => ({
        pageNumber: index + 1,
        xPoints: 0,
        yPoints: 0,
        widthPoints: size.widthPoints,
        heightPoints: size.heightPoints,
        rotation: 0,
    }));
}

function createRequest(): IScanCleanupDetectionRequest {
    return {
        ownerId: 'owner',
        sourcePdfPath: '/tmp/input.pdf',
        documentRevision: 'revision',
        options: {
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'auto',
            readingOrder: 'ltr',
            thickness: 0,
            crop: true,
            matchPageSize: false,
            pageAlignment: 'top-center',
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
            skipBlankPages: false,
            pageOverrides: {},
        },
    };
}

interface IStagedManifestPages {pages: Array<Pick<INativeScanCleanupPageV3, 'inputPath' | 'sourcePageIndex' | 'pageMetadataPath'>>;}

/**
 * The part of the real manifest this fake reads, derived from the protocol type
 * so a renamed field fails to compile here instead of silently parsing as
 * `undefined` and taking the fallback path.
 */
type TStagedManifest = Pick<INativeScanCleanupManifestV3, 'stagedInputWindow' | 'stagedInputPeakPixels'> & IStagedManifestPages;

interface IHarnessOptions {
    pageSizes: IPdfPageSize[];
    availableScratchBytes: number | null;
    rasterConcurrency: number;
    /** Pages whose render rejects, simulating a failed page. */
    failingPages?: ReadonlySet<number>;
    /**
     * Pages whose private scratch path is created as a directory, so the
     * unlink of a failed render's leftovers is refused the way a filesystem
     * that will not release the file refuses it.
     */
    undeletableScratchPages?: ReadonlySet<number>;
    onRender?: (pageNumber: number) => void | Promise<void>;
}

/**
 * A detection harness whose retention behaves like the production one: a render
 * writes to a private scratch file and is published onto the page's stable path
 * by an atomic rename, so a raster is either absent or complete.
 */
function createHarness(tempDir: string, options: IHarnessOptions) {
    const resident = new Set<number>();
    const renderedPages: number[] = [];
    const releasedPages: number[] = [];
    const scratchPaths: string[] = [];
    let peakResident = 0;
    const stagedPath = (pageNumber: number, dpi: number) =>
        join(tempDir, `page-${String(pageNumber)}-${String(dpi)}.png`);
    const retention: IScanCleanupDetectionRetention<{id: string}> = {
        openDocument: vi.fn(async () => ({id: 'document'})),
        pageCount: vi.fn(async () => options.pageSizes.length),
        pageSizes: vi.fn(async () => options.pageSizes),
        rasterPages: vi.fn(async () => ({
            detected: false,
            pages: new Set<number>(),
        })),
        retainedPaths: vi.fn(async () => new Map()),
        rasterScratchPath: vi.fn(async (_document, pageNumber, dpi) => {
            const path = `${stagedPath(pageNumber, dpi)}.${String(renderedPages.length)}.part`;
            // `rm` refuses a directory unless it is recursive, so this is the
            // one refusal a test can stage on any filesystem.
            if (options.undeletableScratchPages?.has(pageNumber)) await mkdir(path, {recursive: true});
            scratchPaths.push(path);
            return path;
        }),
        stagedRasterPath: vi.fn(async (_document, pageNumber, dpi) => stagedPath(pageNumber, dpi)),
        retain: vi.fn(async input => {
            const path = stagedPath(input.pageNumber, input.dpi);
            await rename(input.scratchPath, path);
            resident.add(input.pageNumber);
            peakResident = Math.max(peakResident, resident.size);
            return {
                dpi: input.dpi,
                height: input.height,
                pageNumber: input.pageNumber,
                path,
                sizeBytes: input.sizeBytes,
                width: input.width,
            };
        }),
        releaseRaster: vi.fn(async (_document, pageNumber, dpi) => {
            releasedPages.push(pageNumber);
            resident.delete(pageNumber);
            await rm(stagedPath(pageNumber, dpi), {force: true});
        }),
        release: vi.fn(async () => undefined),
    };
    const renderPage = vi.fn(async (
        _paths: unknown,
        _log: unknown,
        pageNumber: number,
        _source: string,
        outputPath: string,
    ) => {
        renderedPages.push(pageNumber);
        await options.onRender?.(pageNumber);
        if (options.failingPages?.has(pageNumber)) {
            throw new Error(`pdftoppm failed for page ${String(pageNumber)}`);
        }
        // Page-distinct bytes after IEND, which decoders ignore: a window that
        // handed native the wrong page's raster would be visible in what the
        // sidecar read, not just in the paths the manifest named.
        await writeFile(outputPath, Buffer.concat([
            PNG_1X1,
            Buffer.from(`page-${String(pageNumber)}`),
        ]));
    });
    return {
        retention,
        renderPage,
        resident,
        renderedPages,
        releasedPages,
        scratchPaths,
        peakResident: () => peakResident,
        stagedPath,
        dependencies: (runSidecar: TScanCleanupRunSidecar) => ({
            fileSystem,
            getTempDir: () => tempDir,
            getAvailableScratchBytes: vi.fn(async () => options.availableScratchBytes),
            getPdftoppmBinary: () => 'pdftoppm',
            resolveBinary: () => 'evb-scan-cleanup',
            renderPage,
            renderPagePpm: vi.fn(),
            runSidecar,
        }),
    };
}

/**
 * A sidecar that speaks the staged-input lease protocol the Rust binary
 * implements: it announces every page before reading it, blocks until the
 * producer publishes that raster, and hands the lease back afterwards. It never
 * touches an input it has not leased.
 */
function createLeaseSidecar(options: {
    concurrency?: number;
    /** Pages re-read after the batch, as document reconciliation does. */
    reconcilePages?: readonly number[];
    onLeaseAcquired?: (pageNumber: number) => void;
} = {}) {
    const manifests: TStagedManifest[] = [];
    const leases: Array<{
        event: 'acquired' | 'released';
        pageNumber: number
    }> = [];
    const readBytes = new Map<number, string>();
    const runSidecar = vi.fn(async (
        _binary: string,
        manifestPath: string,
        signal: AbortSignal,
        _log: unknown,
        onProgress: (progress: TNativeScanCleanupProgressV3) => void,
    ) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TStagedManifest;
        manifests.push(manifest);
        const totalPages = manifest.pages.length;
        const acquire = async (pageNumber: number, inputPath: string) => {
            leases.push({
                event: 'acquired',
                pageNumber,
            });
            onProgress({
                stage: 'page-input-required',
                completedPages: 0,
                totalPages,
                pageNumber: requirePageNumber(pageNumber),
            });
            const deadline = Date.now() + 5_000;
            for (;;) {
                signal.throwIfAborted();
                try {
                    readBytes.set(pageNumber, (await readFile(inputPath)).toString('base64'));
                    options.onLeaseAcquired?.(pageNumber);
                    return;
                } catch (error) {
                    if (Date.now() > deadline) throw error;
                    await new Promise(resolve => setTimeout(resolve, 1));
                }
            }
        };
        const release = (pageNumber: number) => {
            leases.push({
                event: 'released',
                pageNumber,
            });
            onProgress({
                stage: 'page-input-released',
                completedPages: 0,
                totalPages,
                pageNumber: requirePageNumber(pageNumber),
            });
        };
        let completedPages = 0;
        let nextIndex = 0;
        await Promise.all(Array.from(
            {length: Math.min(options.concurrency ?? 1, manifest.stagedInputWindow ?? 1, totalPages)},
            async () => {
                while (nextIndex < totalPages) {
                    const page = manifest.pages[nextIndex]!;
                    nextIndex += 1;
                    const pageNumber = page.sourcePageIndex + 1;
                    await acquire(pageNumber, page.inputPath);
                    await writeFile(page.pageMetadataPath, JSON.stringify({
                        layoutClassification: pageNumber % 3 === 0 ? 'two-page-spread' : 'single-uncut-page',
                        layoutConfidence: 0.8,
                        cutterXPx: pageNumber % 3 === 0 ? 100 : null,
                        rotationDegrees: 0,
                        canvasScope: 'page',
                        excluded: false,
                        blankOutputsSkipped: 0,
                        outputCount: pageNumber % 3 === 0 ? 2 : 1,
                    }));
                    completedPages += 1;
                    onProgress({
                        stage: 'page-analyzed',
                        completedPages,
                        totalPages,
                        pageNumber: requirePageNumber(pageNumber),
                        classification: pageNumber % 3 === 0 ? 'two-page-spread' : 'single-uncut-page',
                        confidence: 0.8,
                    });
                    release(pageNumber);
                }
            },
        ));
        // The document-level pass revisits pages the window has long dropped.
        for (const pageNumber of options.reconcilePages ?? []) {
            const page = manifest.pages.find(candidate => candidate.sourcePageIndex + 1 === pageNumber)!;
            await acquire(pageNumber, page.inputPath);
            release(pageNumber);
        }
        for (const page of manifest.pages) {
            const pageNumber = page.sourcePageIndex + 1;
            onProgress({
                stage: 'page-complete',
                completedPages: totalPages,
                totalPages,
                pageNumber: requirePageNumber(pageNumber),
                classification: pageNumber % 3 === 0 ? 'two-page-spread' : 'single-uncut-page',
                confidence: 0.8,
                // Progress carries a cutter only for the pages that have one:
                // the protocol has no null here, unlike page metadata.
                ...(pageNumber % 3 === 0 ? {cutterXPx: 100} : {}),
                reconciled: true,
                clusterAgreement: 1,
            });
        }
    });
    return {
        runSidecar,
        manifests,
        leases,
        readBytes,
    };
}

function admissionDiagnostics(log: ReturnType<typeof vi.fn>) {
    const entry = log.mock.calls.find(([
        ,
        message,
    ]) => typeof message === 'string' && message.startsWith('Scan cleanup detection staged raster admission'));
    if (entry === undefined) {
        throw new Error('detection published no staged raster admission diagnostics');
    }
    return JSON.parse((entry[1] as string).replace(
        'Scan cleanup detection staged raster admission ',
        '',
    )) as Record<string, number | boolean | null>;
}

describe('runScanCleanupDetection staged raster window', () => {
    it('analyzes a document whose whole manifest exceeds the budget but whose window fits', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-window-'));
        dirs.push(tempDir);
        const pageCount = 30;
        // The admission fixture the regression was found with: 30 pages of
        // 3,000 × 3,000 at 150 DPI, and 700 MiB free scratch, which leaves a
        // 188-MiB budget. The document needs 1.6 GiB; a two-page window needs
        // 104 MiB.
        const harness = createHarness(tempDir, {
            pageSizes: Array.from({length: pageCount}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 1_440,
                heightPoints: 1_440,
                rotation: 0,
            })),
            availableScratchBytes: 700 * MIB,
            rasterConcurrency: 2,
        });
        const sidecar = createLeaseSidecar({concurrency: 2});
        const log = vi.fn();

        const detection = await runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            harness.retention,
            harness.dependencies(sidecar.runSidecar),
            {rasterConcurrency: 2},
            () => undefined,
            log,
        );
        resultStores.push(detection.resultStore);

        expect(detection.results.map(result => result.pageNumber))
            .toEqual(Array.from({length: pageCount}, (_, index) => index + 1));
        const diagnostics = admissionDiagnostics(log);
        expect(diagnostics.admitted).toBe(true);
        expect(diagnostics.wholeDocumentBytes as number).toBeGreaterThan(diagnostics.budgetBytes as number);
        expect(diagnostics.windowBytes as number).toBeLessThanOrEqual(diagnostics.budgetBytes as number);
        expect(harness.peakResident()).toBeLessThanOrEqual(diagnostics.windowPages as number);
    });

    it('completes a 148-page variable-geometry document inside a bounded window', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-window-'));
        dirs.push(tempDir);
        const pageSizes = fixturePageSizes();
        const harness = createHarness(tempDir, {
            pageSizes,
            // Below the ~2.46 GiB the whole-document estimate used to demand,
            // and above the smallest safe window.
            availableScratchBytes: 900 * MIB,
            rasterConcurrency: 2,
        });
        const sidecar = createLeaseSidecar({
            concurrency: 2,
            reconcilePages: [
                1,
                74,
                147,
            ],
        });
        const log = vi.fn();

        const detection = await runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            harness.retention,
            harness.dependencies(sidecar.runSidecar),
            {rasterConcurrency: 2},
            () => undefined,
            log,
        );
        resultStores.push(detection.resultStore);

        expect(detection.results).toHaveLength(148);
        expect(detection.results.map(result => result.pageNumber))
            .toEqual(Array.from({length: 148}, (_, index) => index + 1));
        const diagnostics = admissionDiagnostics(log);
        // The reported fixture staged 629.41 MiB of decoded rasters over its
        // 148 pages under the old single-copy estimate. Admission now doubles
        // each page, because a render and the published raster coexist while
        // the render is in flight, and compares that against one window.
        const singleCopyBytes = pageSizes.reduce((total, size) => {
            const pixelBytes = Math.ceil(size.widthPoints * 150 / 72)
                * Math.ceil(size.heightPoints * 150 / 72)
                * 3;
            return total + pixelBytes + Math.max(64 * 1024, Math.ceil(pixelBytes * 0.01));
        }, 0);
        expect(singleCopyBytes).toBe(659_984_381);
        expect(diagnostics.wholeDocumentBytes).toBe(singleCopyBytes * 2);
        expect(diagnostics.pages).toBe(148);
        expect(diagnostics.admitted).toBe(true);
        expect(diagnostics.windowPages as number).toBeLessThan(148);
        expect(harness.peakResident()).toBeLessThanOrEqual(diagnostics.windowPages as number);
        // Reconciliation re-read three pages the window had already dropped,
        // so those pages were rendered a second time at the identical path.
        expect(harness.renderedPages.length).toBeGreaterThan(148);
        const manifest = sidecar.manifests[0]!;
        expect(manifest.stagedInputWindow).toBe(diagnostics.windowPages);
        // Page 147's 841.89 × 633.89 crop is the document's largest raster.
        expect(manifest.stagedInputPeakPixels).toBe(1_754 * 1_321);
        expect(manifest.pages.map(page => page.sourcePageIndex))
            .toEqual(Array.from({length: 148}, (_, index) => index));
    });

    it('produces identical output at window sizes of one, two and normal concurrency', async () => {
        const pageSizes = Array.from({length: 9}, (_, index) => ({
            pageNumber: index + 1,
            xPoints: 0,
            yPoints: 0,
            // Deliberately uneven: the window admits pages by the largest ones,
            // so a narrower window must still classify the same pixels.
            widthPoints: 1_440 - index % 3 * 96,
            heightPoints: 1_440,
            rotation: 0,
        }));
        // 3,000 × 3,000 pages cost 54 MiB staged with their native copy, so
        // free space picks the window: 572 MiB admits one page, 632 MiB admits
        // two, and 4 GiB admits the producer's normal concurrency.
        const runs = await Promise.all([
            572 * MIB,
            632 * MIB,
            4_096 * MIB,
        ].map(async availableScratchBytes => {
            const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-window-'));
            dirs.push(tempDir);
            const harness = createHarness(tempDir, {
                pageSizes,
                availableScratchBytes,
                rasterConcurrency: 2,
            });
            const sidecar = createLeaseSidecar({
                concurrency: 2,
                reconcilePages: [
                    2,
                    9,
                ],
            });
            const log = vi.fn();
            const detection = await runScanCleanupDetection(
                createRequest(),
                new AbortController().signal,
                harness.retention,
                harness.dependencies(sidecar.runSidecar),
                {rasterConcurrency: 2},
                () => undefined,
                log,
            );
            resultStores.push(detection.resultStore);
            return {
                diagnostics: admissionDiagnostics(log),
                peakResident: harness.peakResident(),
                readBytes: [...sidecar.readBytes].sort((left, right) => left[0] - right[0]),
                results: detection.results,
                manifestPages: sidecar.manifests[0]!.pages.map(page => page.sourcePageIndex),
            };
        }));

        expect(runs.map(run => run.diagnostics.windowPages)).toEqual([
            1,
            2,
            4,
        ]);
        expect(runs.map(run => run.diagnostics.renderConcurrency)).toEqual([
            1,
            2,
            2,
        ]);
        for (const run of runs) {
            expect(run.peakResident).toBeLessThanOrEqual(run.diagnostics.windowPages as number);
        }
        // The comparison has teeth only if every page's raster is distinct.
        expect(new Set(runs[0]!.readBytes.map(([
            ,
            bytes,
        ]) => bytes)).size).toBe(runs[0]!.readBytes.length);
        // Same classifications, same page order, same pixels handed to native.
        expect(runs[1]!.results).toEqual(runs[0]!.results);
        expect(runs[2]!.results).toEqual(runs[0]!.results);
        expect(runs[1]!.readBytes).toEqual(runs[0]!.readBytes);
        expect(runs[2]!.readBytes).toEqual(runs[0]!.readBytes);
        expect(runs[1]!.manifestPages).toEqual(runs[0]!.manifestPages);
        expect(runs[2]!.manifestPages).toEqual(runs[0]!.manifestPages);
    });

    it('leaves the rasters still inside the window to the cache when detection published', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-window-'));
        dirs.push(tempDir);
        const harness = createHarness(tempDir, {
            pageSizes: Array.from({length: 4}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 480,
                heightPoints: 480,
                rotation: 0,
            })),
            availableScratchBytes: 4_096 * MIB,
            rasterConcurrency: 2,
        });
        const sidecar = createLeaseSidecar();

        const detection = await runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            harness.retention,
            harness.dependencies(sidecar.runSidecar),
            {rasterConcurrency: 2},
            () => undefined,
        );
        resultStores.push(detection.resultStore);

        // A published run leaves what the window still holds behind, exactly as
        // an ordinary page render does; nothing else survives it.
        expect(harness.resident.size).toBeGreaterThan(0);
        expect(harness.resident.size).toBeLessThanOrEqual(4);
    });

    it('drops every staged raster when the run is canceled', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-window-'));
        dirs.push(tempDir);
        const controller = new AbortController();
        const harness = createHarness(tempDir, {
            pageSizes: Array.from({length: 12}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 480,
                heightPoints: 480,
                rotation: 0,
            })),
            availableScratchBytes: 4_096 * MIB,
            rasterConcurrency: 2,
        });
        const publish = vi.fn();
        const sidecar = createLeaseSidecar({onLeaseAcquired: pageNumber => {
            if (pageNumber === 3) controller.abort(new Error('canceled by the user'));
        }});

        await expect(runScanCleanupDetection(
            createRequest(),
            controller.signal,
            harness.retention,
            harness.dependencies(sidecar.runSidecar),
            {rasterConcurrency: 2},
            publish,
        )).rejects.toThrow('canceled by the user');

        expect(harness.resident.size).toBe(0);
        expect(new Set(harness.releasedPages)).toEqual(new Set(harness.renderedPages));
        // Nothing was published as a completed detection.
        expect(publish.mock.calls.every(([
            ,
            progress,
        ]) => (progress as {stage: string}).stage !== 'completed')).toBe(true);
        expect(harness.retention.release).toHaveBeenCalledOnce();
    });

    it('rolls the staged window back when a page render fails', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-window-'));
        dirs.push(tempDir);
        const harness = createHarness(tempDir, {
            pageSizes: Array.from({length: 8}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 480,
                heightPoints: 480,
                rotation: 0,
            })),
            availableScratchBytes: 4_096 * MIB,
            rasterConcurrency: 2,
            failingPages: new Set([5]),
        });
        const sidecar = createLeaseSidecar();

        // The staging failure is the cause worth reporting, not the abort it
        // raises inside the sidecar.
        await expect(runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            harness.retention,
            harness.dependencies(sidecar.runSidecar),
            {rasterConcurrency: 2},
            () => undefined,
        )).rejects.toThrow('pdftoppm failed for page 5');

        expect(harness.resident.size).toBe(0);
    });

    it('reports a partial raster it could not drop without replacing the render failure', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-window-'));
        dirs.push(tempDir);
        const harness = createHarness(tempDir, {
            pageSizes: Array.from({length: 8}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 480,
                heightPoints: 480,
                rotation: 0,
            })),
            availableScratchBytes: 4_096 * MIB,
            rasterConcurrency: 2,
            failingPages: new Set([3]),
            undeletableScratchPages: new Set([3]),
        });
        const sidecar = createLeaseSidecar();
        const log = vi.fn();

        // The render failure still reaches the caller: the leaked scratch is a
        // diagnostic, never the reported cause.
        await expect(runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            harness.retention,
            harness.dependencies(sidecar.runSidecar),
            {rasterConcurrency: 2},
            () => undefined,
            log,
        )).rejects.toThrow('pdftoppm failed for page 3');

        const leaked = harness.scratchPaths.find(path => path.includes('page-3-'));
        expect(leaked).toBeDefined();
        const warnings = log.mock.calls.filter(([
            level,
            message,
        ]) => level === 'warn' && typeof message === 'string' && message.includes(leaked!));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]![1]).toContain('could not drop the partial detection raster');
        // A render that simply failed leaves nothing behind and says nothing:
        // the refusal is what is worth a line, not every failed page.
        expect(log.mock.calls.filter(([
            level,
            message,
        ]) => level === 'warn'
            && typeof message === 'string'
            && message.includes('could not drop the partial detection raster'))).toHaveLength(1);
    });
});
