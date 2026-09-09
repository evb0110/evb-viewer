import {
    copyFile,
    mkdir,
    mkdtemp,
    open,
    readdir,
    rename,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {
    afterAll,
    describe,
    expect,
    it,
} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import {
    runScanCleanupDetection,
    type IScanCleanupDetectionDependencies,
    type IScanCleanupDetectionRetention,
} from '@evb/scan-cleanup/core/detection';
import {readPdfPageSizes} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    createCliRenderers,
    resolveCliNativeToolPath,
    runCliNativeToolCommand,
    runCliScanCleanupSidecar,
} from '@scripts/scanCleanupCliAdapters';

const MIB = 1024 * 1024;
const PAGE_COUNT = 8;
// 520 MiB free leaves an 8-MiB budget after the 512-MiB reserve. One page of
// this fixture costs about 3.1 MiB staged beside the copy its render publishes
// from, so two pages fit and the 24.8-MiB document does not.
const AVAILABLE_SCRATCH_BYTES = 520 * MIB;

const fileSystem: NonNullable<IScanCleanupDetectionDependencies['fileSystem']> = {
    copyFile: (source, destination) => copyFile(source, destination),
    mkdir: async (path, options) => {
        await mkdir(path, options);
        return undefined;
    },
    mkdtemp: prefix => mkdtemp(prefix),
    open: (path, flags) => open(path, flags),
    readFile: async path => readFile(path, 'utf8'),
    readdir: (path, options) => readdir(path, options),
    rm: (path, options) => rm(path, options),
    stat: (path) => stat(path),
    writeFile: (path, data) => writeFile(path, data),
};

const scanCleanupBinary = resolveCliNativeToolPath(
    'evb-scan-cleanup',
    'scan-cleanup',
    process.cwd(),
    process.env.EVB_SCAN_CLEANUP_PATH,
) ?? (() => {
    const debugBuild = join(process.cwd(), 'native', 'target', 'debug', 'evb-scan-cleanup');
    return existsSync(debugBuild) ? debugBuild : null;
})();
const pdftoppmBinary = resolveCliNativeToolPath('pdftoppm', 'poppler', process.cwd());
const pdfinfoBinary = resolveCliNativeToolPath('pdfinfo', 'poppler', process.cwd());

const dirs: string[] = [];
const resultStores: Array<{close: () => Promise<void>}> = [];

afterAll(async () => {
    await Promise.all(resultStores.splice(0).map(store => store.close()));
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        force: true,
        recursive: true,
    })));
});

interface ICliDocument {directory: string;}

/**
 * A short document with varying crop sizes and real ink on every page, so the
 * sidecar has something to classify and the largest page is not the first one
 * the window happens to stage.
 */
async function writeVariableGeometryPdf(path: string) {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < PAGE_COUNT; index += 1) {
        const widthPoints = 400 - index % 3 * 16;
        const heightPoints = 300 - index % 2 * 12;
        const page = pdf.addPage([
            widthPoints,
            heightPoints,
        ]);
        for (let line = 0; line < 12; line += 1) {
            page.drawRectangle({
                x: 40,
                y: heightPoints - 40 - line * 16,
                width: widthPoints - 80,
                height: 6,
            });
        }
    }
    await writeFile(path, await pdf.save());
}

describe.skipIf(
    scanCleanupBinary === null || pdftoppmBinary === null || pdfinfoBinary === null,
)('scan cleanup detection against the real sidecar under a bounded window', () => {
    it('analyzes every page of a document that does not fit the scratch budget whole', async () => {
        const temporaryRoot = await mkdtemp(join(tmpdir(), 'scan-cleanup-window-e2e-'));
        dirs.push(temporaryRoot);
        const sourcePdfPath = join(temporaryRoot, 'source.pdf');
        await writeVariableGeometryPdf(sourcePdfPath);
        const pageSizes = await readPdfPageSizes(sourcePdfPath, {
            pdfinfoBinary: pdfinfoBinary!,
            tempDir: temporaryRoot,
            runCommand: runCliNativeToolCommand,
            log: () => undefined,
        });
        expect(pageSizes).toHaveLength(PAGE_COUNT);

        const documentDirectory = join(temporaryRoot, 'document');
        const stagedPath = (pageNumber: number, dpi: number) =>
            join(documentDirectory, `page-${String(pageNumber)}-${String(dpi)}.png`);
        // Keyed by the file the run actually holds, so a page released twice
        // or released without ever being retained cannot lower the peak the
        // window bound is asserted against.
        const residentRasters = new Set<string>();
        const rasterKey = (pageNumber: number, dpi: number) => `${String(pageNumber)}-${String(dpi)}`;
        let peakResidentPages = 0;
        const retention: IScanCleanupDetectionRetention<ICliDocument> = {
            async openDocument() {
                await rm(documentDirectory, {
                    force: true,
                    recursive: true,
                });
                await mkdir(documentDirectory, {recursive: true});
                return {directory: documentDirectory};
            },
            pageCount: () => Promise.resolve(PAGE_COUNT),
            pageSizes: () => Promise.resolve(pageSizes),
            rasterPages: () => Promise.resolve({
                detected: false,
                pages: new Set<number>(),
            }),
            retainedPaths: () => Promise.resolve(new Map()),
            // Private to one render: the sidecar polls for the staged path, so
            // it may only ever observe a complete raster there.
            // pdftoppm derives its own output name by dropping the extension,
            // so a private scratch path still has to end in .png.
            rasterScratchPath: (_document, pageNumber, dpi) => Promise.resolve(join(
                documentDirectory,
                `page-${String(pageNumber)}-${String(dpi)}.${randomUUID()}.part.png`,
            )),
            stagedRasterPath: (_document, pageNumber, dpi) => Promise.resolve(stagedPath(pageNumber, dpi)),
            async retain(input) {
                const path = stagedPath(input.pageNumber, input.dpi);
                await rename(input.scratchPath, path);
                residentRasters.add(rasterKey(input.pageNumber, input.dpi));
                peakResidentPages = Math.max(peakResidentPages, residentRasters.size);
                return {
                    dpi: input.dpi,
                    height: input.height,
                    pageNumber: input.pageNumber,
                    path,
                    sizeBytes: input.sizeBytes,
                    width: input.width,
                };
            },
            async releaseRaster(_document, pageNumber, dpi) {
                residentRasters.delete(rasterKey(pageNumber, dpi));
                await rm(stagedPath(pageNumber, dpi), {force: true});
            },
            release: () => Promise.resolve(),
        };
        const renderers = createCliRenderers(runCliNativeToolCommand);
        const diagnostics: string[] = [];

        const detection = await runScanCleanupDetection(
            {
                ownerId: 'scan-cleanup-window-e2e',
                documentRevision: 'revision',
                sourcePdfPath,
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
            },
            new AbortController().signal,
            retention,
            {
                fileSystem,
                getTempDir: () => temporaryRoot,
                getAvailableScratchBytes: () => Promise.resolve(AVAILABLE_SCRATCH_BYTES),
                getPdftoppmBinary: () => pdftoppmBinary!,
                resolveBinary: () => scanCleanupBinary,
                renderPage: renderers.renderPage,
                renderPagePpm: renderers.renderPagePpm,
                runSidecar: runCliScanCleanupSidecar,
            },
            {rasterConcurrency: 2},
            () => undefined,
            (_level, message) => {
                diagnostics.push(message);
            },
        );
        resultStores.push(detection.resultStore);

        expect(detection.results.map(result => result.pageNumber))
            .toEqual(Array.from({length: PAGE_COUNT}, (_, index) => index + 1));
        const admissionDiagnostic = diagnostics
            .find(message => message.startsWith('Scan cleanup detection staged raster admission'));
        // Named up front: without it the assertions below fail as a property
        // read on undefined instead of saying the run published no admission.
        expect(admissionDiagnostic, 'detection published no staged raster admission diagnostic')
            .toBeDefined();
        const admission = JSON.parse(admissionDiagnostic!
            .replace('Scan cleanup detection staged raster admission ', '')) as {
            admitted: boolean;
            budgetBytes: number;
            windowPages: number;
            wholeDocumentBytes: number;
        };
        // These two assertions fail when the fixture's real per-page cost has
        // drifted away from the scratch figure the test hands the run, which is
        // only diagnosable against the numbers admission actually measured.
        const admissionDetail = `${admissionDiagnostic!}, `
            + `${String(Math.round(admission.wholeDocumentBytes / PAGE_COUNT / MIB))} MiB per page measured, `
            + `${String(Math.round(AVAILABLE_SCRATCH_BYTES / MIB))} MiB free scratch declared`;
        expect(admission.admitted, `staged raster admission refused the run: ${admissionDetail}`).toBe(true);
        expect(
            admission.windowPages,
            `staged raster window did not narrow below the ${String(PAGE_COUNT)}-page document: ${admissionDetail}`,
        ).toBeLessThan(PAGE_COUNT);
        // The document could not be staged whole; the window is what fits.
        expect(admission.wholeDocumentBytes).toBeGreaterThan(admission.budgetBytes);
        expect(peakResidentPages).toBeLessThanOrEqual(admission.windowPages);
        // Whatever the run kept is inside the window, and nothing else is left
        // behind in the document directory.
        const remaining = await readdir(documentDirectory);
        expect(remaining.filter(name => !name.includes('.part.')).length)
            .toBeLessThanOrEqual(admission.windowPages);
        // No private render scratch outlives the run.
        expect(remaining.filter(name => name.includes('.part.'))).toEqual([]);
    }, 300_000);
});
