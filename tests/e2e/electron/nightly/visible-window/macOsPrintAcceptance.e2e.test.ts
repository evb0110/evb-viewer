import {execFile} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    resolve,
} from 'node:path';
import {promisify} from 'node:util';
import {decode} from 'fast-png';
import {
    afterAll,
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {resolvePlatformArchTag} from '@electron/utils/platformArch';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    EXACT_PDF_FIXTURE_MANIFEST,
    readExactPdfFixtureIdentity,
    validateExactPdfFixtureIdentity,
} from '@scripts/ci/stageExactPdfFixture';
import {
    createMultiPageTextFixturePdf,
    resolveLargePdfFixtureAvailability,
} from '@tests/e2e/electron/helpers/fixtures';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {createVisibleWindowElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import type {TDocumentRef} from '@contracts/documentRef';
import {
    requirePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const execFileAsync = promisify(execFile);
const MACOS_PRINT_ACCEPTANCE_ENABLE_ENV = 'EVB_E2E_MACOS_PRINT_ACCEPTANCE';
const MACOS_PRINT_ACCEPTANCE_OUTPUT_ENV = 'EVB_E2E_MACOS_PRINT_OUTPUT_PATH';
const LARGE_PDF_FIXTURE_ENV = 'EVB_E2E_LARGE_PDF_FIXTURE';
const PRINT_DIALOG_TEST_MODE_ENV = 'EVB_PRINT_DIALOG_TEST_MODE';
const PRINT_ACCEPTANCE_TIMEOUT_MS = 15 * 60_000;
const PRINT_DIALOG_AUTOMATION_TIMEOUT_MS = 6 * 60_000;
const PRINT_DIALOG_AUTOMATION_WAIT_SECONDS = 300;
const PRINT_VALIDATION_DPI = 96;
const MIN_PRINT_INK_PIXELS = 500;
const MIN_PRINT_LIGHT_BACKGROUND_RATIO = 0.5;
const MIN_PRINT_LUMINANCE_RANGE = 32;
const MIN_PRINT_DISTINCT_COLOR_BUCKETS = 8;
const exactFixtureExpectation = EXACT_PDF_FIXTURE_MANIFEST.localZaliznyak882;
const configuredFixturePath = process.env[LARGE_PDF_FIXTURE_ENV]?.trim() ?? '';
const configuredOutputPath = process.env[MACOS_PRINT_ACCEPTANCE_OUTPUT_ENV]?.trim() ?? '';
const fixture = configuredFixturePath
    ? resolveLargePdfFixtureAvailability()
    : {
        path: null,
        reason: `${LARGE_PDF_FIXTURE_ENV} must point to the exact local 882-page fixture`,
        required: false,
    };
const outputPath = isAbsolute(configuredOutputPath) ? configuredOutputPath : null;
const acceptanceEnabled = process.platform === 'darwin'
    && process.env[MACOS_PRINT_ACCEPTANCE_ENABLE_ENV] === '1'
    && isAbsolute(configuredOutputPath);
const acceptanceDescribe = acceptanceEnabled ? describe : describe.skip;
const acceptanceDir = resolve(process.cwd(), '.devkit', 'tmp', `macos-print-acceptance-${Date.now()}`);
const renderedFirstPagePrefix = join(acceptanceDir, 'printed-first-page');
const renderedFirstPagePath = `${renderedFirstPagePrefix}.png`;
const printLayoutSmokeDir = resolve(process.cwd(), '.devkit', 'tmp', `macos-print-layout-smoke-${Date.now()}`);
const printLayoutSmokeOutputPath = join(printLayoutSmokeDir, 'facing-first-single-output.pdf');
const printLayoutSmokeDescribe = process.platform === 'darwin' ? describe : describe.skip;
const printLayoutSmokeSessionEnv = {
    EVB_PRINT_DIALOG_TEST_MODE: 'print-to-pdf',
    EVB_PRINT_DIALOG_TEST_OUTPUT_PATH: printLayoutSmokeOutputPath,
};

afterAll(() => {
    rmSync(acceptanceDir, {
        force: true,
        recursive: true,
    });
    rmSync(printLayoutSmokeDir, {
        force: true,
        recursive: true,
    });
});

function escapeAppleScriptString(value: string) {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function buildMacOsPrintDialogScript(targetPath: string, electronPid: number) {
    const targetDirectory = dirname(targetPath);
    const targetFileName = basename(targetPath);
    return `
set targetDirectory to ${escapeAppleScriptString(targetDirectory)}
set targetFileName to ${escapeAppleScriptString(targetFileName)}
set targetPid to ${electronPid}
tell application "System Events"
    set deadline to (current date) + ${PRINT_DIALOG_AUTOMATION_WAIT_SECONDS}
    set printProcess to missing value
    set printWindow to missing value
    repeat until printProcess is not missing value
        set targetProcesses to every application process whose unix id is targetPid
        if (count of targetProcesses) > 0 then
            set candidateProcess to item 1 of targetProcesses
            set frontmost of candidateProcess to true
            if (count of windows of candidateProcess) > 0 then
                set candidateWindow to window 1 of candidateProcess
                if exists sheet 1 of candidateWindow then
                    set printProcess to candidateProcess
                    set printWindow to candidateWindow
                end if
            end if
        end if
        if printProcess is missing value then
            if (current date) > deadline then
                error "Timed out waiting for the macOS print sheet"
            end if
            delay 0.25
        end if
    end repeat

    tell printProcess
        set printSheet to sheet 1 of printWindow
        set pdfButtons to every button of printSheet whose title is "PDF"
        if (count of pdfButtons) = 0 then
            set pdfButtons to every button of printSheet whose description is "PDF"
        end if
        if (count of pdfButtons) = 0 then
            error "The macOS print sheet has no PDF menu button"
        end if

        -- This is the acceptance interaction point: open PDF and choose Save as PDF….
        set pdfButton to item 1 of pdfButtons
        click pdfButton
        set pdfMenu to menu 1 of pdfButton
        set saveAsItems to every menu item of pdfMenu whose title starts with "Save as PDF"
        if (count of saveAsItems) = 0 then
            error "The macOS PDF menu has no Save as PDF item"
        end if
        click item 1 of saveAsItems

        set saveSheet to missing value
        repeat until saveSheet is not missing value
            if exists sheet 1 of printWindow then
                set candidateSheet to sheet 1 of printWindow
                if (count of text fields of candidateSheet) > 0 then
                    set saveSheet to candidateSheet
                end if
            end if
            if saveSheet is missing value then
                if (current date) > deadline then
                    error "Timed out waiting for the macOS PDF save sheet"
                end if
                delay 0.25
            end if
        end repeat

        set fileFields to every text field of saveSheet
        if (count of fileFields) = 0 then
            error "The macOS PDF save sheet has no filename field"
        end if
        set value of item 1 of fileFields to targetFileName
        click item 1 of fileFields
        keystroke "g" using {command down, shift down}

        set locationSheet to missing value
        repeat until locationSheet is not missing value
            if exists sheet 1 of saveSheet then
                set locationSheet to sheet 1 of saveSheet
            end if
            if locationSheet is missing value then
                if (current date) > deadline then
                    error "Timed out waiting for the macOS save-location sheet"
                end if
                delay 0.25
            end if
        end repeat
        set locationFields to every text field of locationSheet
        if (count of locationFields) = 0 then
            error "The macOS save-location sheet has no folder field"
        end if
        set value of item 1 of locationFields to targetDirectory
        keystroke return

        repeat while exists sheet 1 of saveSheet
            if (current date) > deadline then
                error "Timed out closing the macOS save-location sheet"
            end if
            delay 0.25
        end repeat

        set saveButtons to every button of saveSheet whose title is "Save"
        if (count of saveButtons) > 0 then
            click item 1 of saveButtons
        else
            keystroke return
        end if
        delay 0.5
        if exists sheet 1 of saveSheet then
            set replaceButtons to every button of sheet 1 of saveSheet whose title starts with "Replace"
            if (count of replaceButtons) > 0 then
                click item 1 of replaceButtons
            end if
        end if
    end tell
end tell
`;
}

async function completeMacOsPrintDialog(targetPath: string, electronPid: number) {
    await execFileAsync('osascript', [
        '-e',
        buildMacOsPrintDialogScript(targetPath, electronPid),
    ], {
        maxBuffer: 64 * 1024,
        timeout: PRINT_DIALOG_AUTOMATION_TIMEOUT_MS,
    });
}

function resolveBundledPdftoppmPath() {
    const executable = resolve(
        process.cwd(),
        'resources',
        'poppler',
        resolvePlatformArchTag(),
        'bin',
        'pdftoppm',
    );
    if (!existsSync(executable)) {
        throw new Error(`Missing bundled pdftoppm: ${executable}`);
    }
    return executable;
}

function resolveBundledQpdfPath() {
    const executable = process.platform === 'win32' ? 'qpdf.exe' : 'qpdf';
    const path = resolve(
        process.cwd(),
        'resources',
        'qpdf',
        resolvePlatformArchTag(),
        'bin',
        executable,
    );
    if (!existsSync(path)) {
        throw new Error(`Missing bundled qpdf: ${path}`);
    }
    return path;
}

async function renderPdfPage(pdfPath: string, pageNumber: number, outputPrefix = renderedFirstPagePrefix) {
    mkdirSync(dirname(outputPrefix), {recursive: true});
    await execFileAsync(resolveBundledPdftoppmPath(), [
        '-png',
        '-singlefile',
        '-r',
        String(PRINT_VALIDATION_DPI),
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        pdfPath,
        outputPrefix,
    ], {
        maxBuffer: 128 * 1024,
        timeout: 30_000,
    });
}

interface IPrintRasterMetrics {
    totalPixels: number;
    nonWhitePixels: number;
    substantialLightPixels: number;
    luminanceVariance: number;
    luminanceRange: number;
    distinctColorBuckets: number;
}

interface IPrintRasterRegion {
    startXRatio: number;
    endXRatio: number;
}

function inspectPrintedPageRaster(
    pngPath: string,
    region: IPrintRasterRegion = {
        startXRatio: 0,
        endXRatio: 1,
    },
): IPrintRasterMetrics {
    const image = decode(readFileSync(pngPath));
    const channelCount = Math.floor(image.data.length / (image.width * image.height));
    if (channelCount < 3) {
        throw new Error(`Printed page PNG has fewer than three color channels: ${channelCount}`);
    }

    const startX = Math.max(0, Math.min(image.width, Math.floor(image.width * region.startXRatio)));
    const endX = Math.max(startX, Math.min(image.width, Math.ceil(image.width * region.endXRatio)));
    const totalPixels = (endX - startX) * image.height;
    let nonWhitePixels = 0;
    let substantialLightPixels = 0;
    let luminanceMinimum = 255;
    let luminanceMaximum = 0;
    let luminanceMean = 0;
    let luminanceM2 = 0;
    let sampleCount = 0;
    const distinctColorBuckets = new Set<number>();

    for (let y = 0; y < image.height; y += 1) {
        for (let x = startX; x < endX; x += 1) {
            const offset = (y * image.width + x) * channelCount;
            const alpha = channelCount >= 4 ? image.data[offset + 3] ?? 255 : 255;
            const red = image.data[offset] ?? 255;
            const green = image.data[offset + 1] ?? 255;
            const blue = image.data[offset + 2] ?? 255;
            if (
                alpha > 8
                && (
                    red < 245
                    || green < 245
                    || blue < 245
                )
            ) {
                nonWhitePixels += 1;
            }

            if (alpha <= 8) {
                continue;
            }

            const luminance = (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
            if (luminance >= 220) {
                substantialLightPixels += 1;
            }
            luminanceMinimum = Math.min(luminanceMinimum, luminance);
            luminanceMaximum = Math.max(luminanceMaximum, luminance);
            sampleCount += 1;
            const delta = luminance - luminanceMean;
            luminanceMean += delta / sampleCount;
            luminanceM2 += delta * (luminance - luminanceMean);
            distinctColorBuckets.add((red >> 4) << 8 | (green >> 4) << 4 | (blue >> 4));
        }
    }

    return {
        totalPixels,
        nonWhitePixels,
        substantialLightPixels,
        luminanceVariance: sampleCount > 0 ? luminanceM2 / sampleCount : 0,
        luminanceRange: sampleCount > 0 ? luminanceMaximum - luminanceMinimum : 0,
        distinctColorBuckets: distinctColorBuckets.size,
    };
}

acceptanceDescribe('Electron E2E - macOS PDF print acceptance', () => {
    const sessionFixture = createVisibleWindowElectronE2ESessionFixture({
        sessionName: () => `e2e-macos-print-acceptance-${Date.now()}`,
        timeoutMs: PRINT_ACCEPTANCE_TIMEOUT_MS,
    });

    it('prints page 1 of the exact 882-page PDF through the real system sheet', async () => {
        const session = sessionFixture.getSession();
        if (!configuredFixturePath) {
            throw new Error(`${LARGE_PDF_FIXTURE_ENV} must point to the exact local 882-page fixture`);
        }
        if (!fixture.path) {
            throw new Error(`Exact fixture is unavailable: ${fixture.reason}`);
        }
        const electronPid = getSessionInfo(session.name)?.electronPid;
        if (!electronPid) {
            throw new Error(`Electron PID is unavailable for ${session.name}`);
        }
        if (process.env[PRINT_DIALOG_TEST_MODE_ENV]?.trim()) {
            throw new Error(`${PRINT_DIALOG_TEST_MODE_ENV} must be unset for native macOS print acceptance`);
        }
        if (outputPath === null) {
            throw new Error(`${MACOS_PRINT_ACCEPTANCE_OUTPUT_ENV} must be an absolute output path`);
        }
        if (existsSync(outputPath)) {
            throw new Error(`Refusing to overwrite an existing print acceptance output: ${outputPath}`);
        }
        onTestFinished(() => rmSync(outputPath, {force: true}));
        mkdirSync(dirname(outputPath), {recursive: true});

        const sourceIdentity = await readExactPdfFixtureIdentity(fixture.path, {
            maxBytes: exactFixtureExpectation.bytes,
            timeoutMs: PRINT_ACCEPTANCE_TIMEOUT_MS,
        });
        validateExactPdfFixtureIdentity(sourceIdentity, exactFixtureExpectation);

        await openPdfInApp(session.page, fixture.path, PRINT_ACCEPTANCE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, PRINT_ACCEPTANCE_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, PRINT_ACCEPTANCE_TIMEOUT_MS);
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const pageNumbers: TPageNumber[] = [requirePageNumber(1)];
        const printPromise = session.page.evaluate(async ({
            path,
            pageNumbers,
        }: {
            path: TDocumentRef;
            pageNumbers: TPageNumber[];
        }) => {
            const printPdfPath = (window as IE2EWindow).electronAPI?.documentPdf?.printPdfPath;
            if (!printPdfPath) {
                throw new Error('electronAPI.documentPdf.printPdfPath is unavailable');
            }

            return printPdfPath(path, 'macos-print-acceptance.pdf', {
                pageNumbers,
                viewMode: 'single',
                orientation: 'auto',
            });
        }, {
            path: workingCopyPath,
            pageNumbers,
        });
        void printPromise.catch(() => undefined);

        await completeMacOsPrintDialog(outputPath, electronPid);
        const printResult = await printPromise;
        expect(printResult).toEqual(expect.objectContaining({success: true}));
        expect(existsSync(outputPath)).toBe(true);

        const qpdfPath = resolveBundledQpdfPath();
        await execFileAsync(qpdfPath, [
            '--check',
            outputPath,
        ], {
            maxBuffer: 128 * 1024,
            timeout: 60_000,
        });
        const {stdout: pageCountOutput} = await execFileAsync(qpdfPath, [
            '--show-npages',
            outputPath,
        ], {
            maxBuffer: 16 * 1024,
            timeout: 60_000,
        });
        expect(Number.parseInt(pageCountOutput.trim(), 10)).toBe(1);

        await renderPdfPage(outputPath, 1);
        const rasterMetrics = inspectPrintedPageRaster(renderedFirstPagePath);
        expect(rasterMetrics.totalPixels).toBeGreaterThan(0);
        expect(rasterMetrics.nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);
        expect(rasterMetrics.substantialLightPixels).toBeGreaterThan(
            rasterMetrics.totalPixels * MIN_PRINT_LIGHT_BACKGROUND_RATIO,
        );
        expect(
            rasterMetrics.luminanceRange > MIN_PRINT_LUMINANCE_RANGE
            || rasterMetrics.luminanceVariance > MIN_PRINT_LUMINANCE_RANGE
            || rasterMetrics.distinctColorBuckets >= MIN_PRINT_DISTINCT_COLOR_BUCKETS,
        ).toBe(true);
    }, PRINT_ACCEPTANCE_TIMEOUT_MS);
});

printLayoutSmokeDescribe('Electron E2E - macOS PDF print composition smoke', () => {
    const sessionFixture = createVisibleWindowElectronE2ESessionFixture({
        sessionName: () => `e2e-macos-print-layout-smoke-${Date.now()}`,
        extraEnv: printLayoutSmokeSessionEnv,
        timeoutMs: PRINT_ACCEPTANCE_TIMEOUT_MS,
    });

    it('composes first-page-single output as uniform landscape spreads before native handoff', async () => {
        const session = sessionFixture.getSession();

        rmSync(printLayoutSmokeOutputPath, {force: true});
        mkdirSync(printLayoutSmokeDir, {recursive: true});
        onTestFinished(() => rmSync(printLayoutSmokeOutputPath, {force: true}));

        const sourcePath = await createMultiPageTextFixturePdf(
            'macos-print-layout-four-pages.pdf',
            4,
        );
        await openPdfInApp(session.page, sourcePath, PRINT_ACCEPTANCE_TIMEOUT_MS);
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const pageNumbers: TPageNumber[] = [
            requirePageNumber(1),
            requirePageNumber(2),
            requirePageNumber(3),
            requirePageNumber(4),
        ];
        const printResult = await session.page.evaluate(async ({
            path,
            pageNumbers,
        }: {
            path: TDocumentRef;
            pageNumbers: TPageNumber[];
        }) => {
            const printPdfPath = (window as IE2EWindow).electronAPI?.documentPdf?.printPdfPath;
            if (!printPdfPath) {
                throw new Error('electronAPI.documentPdf.printPdfPath is unavailable');
            }

            return printPdfPath(path, 'facing-first-single-print-smoke.pdf', {
                pageNumbers,
                viewMode: 'facing-first-single',
                orientation: 'auto',
            });
        }, {
            path: workingCopyPath,
            pageNumbers,
        });

        expect(printResult).toEqual(expect.objectContaining({success: true}));
        expect(existsSync(printLayoutSmokeOutputPath)).toBe(true);

        const qpdfPath = resolveBundledQpdfPath();
        await execFileAsync(qpdfPath, [
            '--check',
            printLayoutSmokeOutputPath,
        ], {
            maxBuffer: 128 * 1024,
            timeout: 60_000,
        });
        const {stdout: pageCountOutput} = await execFileAsync(qpdfPath, [
            '--show-npages',
            printLayoutSmokeOutputPath,
        ], {
            maxBuffer: 16 * 1024,
            timeout: 60_000,
        });
        expect(Number.parseInt(pageCountOutput.trim(), 10)).toBe(3);

        const sheetPaths: string[] = [];
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const outputPrefix = join(printLayoutSmokeDir, `facing-first-single-page-${pageNumber}`);
            const sheetPath = `${outputPrefix}.png`;
            await renderPdfPage(printLayoutSmokeOutputPath, pageNumber, outputPrefix);
            sheetPaths.push(sheetPath);
            const rasterMetrics = inspectPrintedPageRaster(sheetPath);
            expect(rasterMetrics.totalPixels).toBeGreaterThan(0);
            expect(rasterMetrics.nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);
        }
        const firstPageSheetPath = sheetPaths[0]!;
        expect(inspectPrintedPageRaster(firstPageSheetPath, {
            startXRatio: 0,
            endXRatio: 0.5,
        }).nonWhitePixels).toBeLessThan(MIN_PRINT_INK_PIXELS);
        expect(inspectPrintedPageRaster(firstPageSheetPath, {
            startXRatio: 0.5,
            endXRatio: 1,
        }).nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);

        const facingSheetPath = sheetPaths[1]!;
        expect(inspectPrintedPageRaster(facingSheetPath, {
            startXRatio: 0,
            endXRatio: 0.5,
        }).nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);
        expect(inspectPrintedPageRaster(facingSheetPath, {
            startXRatio: 0.5,
            endXRatio: 1,
        }).nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);

        const trailingPageSheetPath = sheetPaths[2]!;
        expect(inspectPrintedPageRaster(trailingPageSheetPath, {
            startXRatio: 0,
            endXRatio: 0.5,
        }).nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);
        expect(inspectPrintedPageRaster(trailingPageSheetPath, {
            startXRatio: 0.5,
            endXRatio: 1,
        }).nonWhitePixels).toBeLessThan(MIN_PRINT_INK_PIXELS);
    }, PRINT_ACCEPTANCE_TIMEOUT_MS);
});
