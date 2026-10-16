import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
    closeSync,
    createReadStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    evaluateInPage, waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    goToPageViaToolbar, openAnnotationsTab,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {readWorkspaceStateValues} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    findCommittedSurfaceContractViolations,
    installCommittedSurfaceSampler,
    selectClaimedOpenTrace,
    stopCommittedSurfaceSampler,
    summarizeCommittedSurfaceTiming,
    waitForCommittedSurfaceSamples,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';

const PAGE_COUNT = 21_601;
const MIDDLE_PAGE = 10_801;
const FIRST_PAINT_BUDGET_MS = 10_000;
// Observe the natural failure without granting a slower open a passing verdict.
const OBSERVATION_TIMEOUT_MS = 120_000;
const NOTE_SENTINEL = 'EVB structure-dense last-page note';
const configuredFixture = process.env.EVB_E2E_LARGE_OPEN_PDF?.trim();
const outputDirectory = resolve(process.env.EVB_E2E_LARGE_OPEN_ARTIFACT_DIR
    || '.devkit/test/electron-e2e-artifacts/large-pdf-opening');

/** A real PDF graph, not a padded tiny graph: the old all-object JSON reader
 * charges over 256 MiB for 200,000 arrays of 24 integer values. The sparse
 * stream crosses the 512 MiB file switch without retaining a large buffer. */
function createStructureDensePdf(directory: string) {
    const path = join(directory, 'structure-dense-21601-pages.pdf');
    const fd = openSync(path, 'w');
    const offsets = [0];
    let position = 0;
    const append = (text: string) => {
        const bytes = Buffer.from(text, 'latin1');
        writeSync(fd, bytes, 0, bytes.length, position);
        position += bytes.length;
    };
    const object = (id: number, contents: string) => {
        offsets[id] = position;
        append(`${id} 0 obj\n${contents}\nendobj\n`);
    };
    const firstPageId = 6;
    const pageId = (page: number) => firstPageId + (page - 1) * 2;
    const annotationId = firstPageId + PAGE_COUNT * 2;
    try {
        append('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
        object(1, '<< /Type /Catalog /Pages 2 0 R /PageLabels 4 0 R >>');
        object(2, `<< /Type /Pages /Count ${PAGE_COUNT} /MediaBox [0 0 612 792] /CropBox [0 0 600 780] /Rotate 0 /Kids [${Array.from({length: PAGE_COUNT}, (_, index) => `${pageId(index + 1)} 0 R`).join(' ')}] >>`);
        object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
        object(4, '<< /Nums [0 << /S /D /P (EVB-) /St 1 >>] >>');
        object(5, '<< /Title (Structure dense opening regression) >>');
        for (let page = 1; page <= PAGE_COUNT; page += 1) {
            const shape = page === MIDDLE_PAGE
                ? '/MediaBox [0 0 900 600] /CropBox [0 0 880 580] /Rotate 90 /UserUnit 1.25'
                : page === PAGE_COUNT ? '/MediaBox [0 0 500 900] /CropBox [0 0 480 880] /Rotate 0 /UserUnit 1.5' : '';
            object(pageId(page), `<< /Type /Page /Parent 2 0 R ${shape} /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId(page) + 1} 0 R${page === PAGE_COUNT ? ` /Annots [${annotationId} 0 R]` : ''} >>`);
            const content = `0.15 0.25 0.45 rg 50 100 300 350 re f\nBT /F1 24 Tf 50 500 Td (EVB visible page ${page}) Tj ET\n`;
            object(pageId(page) + 1, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
        }
        object(annotationId, `<< /Type /Annot /Subtype /Text /Rect [80 600 104 624] /P ${pageId(PAGE_COUNT)} 0 R /Contents (${NOTE_SENTINEL}) /T (EVB regression) /NM (structure-dense-note) /Name /Comment /F 4 >>`);
        for (let index = 0; index < 200_000; index += 1) {
            object(annotationId + 1 + index, `[${Array.from({length: 24}, (_, value) => value).join(' ')}]`);
        }
        const streamId = annotationId + 200_001;
        offsets[streamId] = position;
        const streamLength = 513 * 1024 * 1024;
        append(`${streamId} 0 obj\n<< /Length ${streamLength} >>\nstream\n`);
        position += streamLength;
        append('\nendstream\nendobj\n');
        const xrefOffset = position;
        append(`xref\n0 ${streamId + 1}\n0000000000 65535 f \n`);
        append(offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join(''));
        append(`trailer\n<< /Size ${streamId + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    } finally {
        closeSync(fd);
    }
    return path;
}

async function hashFile(path: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

function readExpectedGeometry(path: string, page: number) {
    const tools = getPdfNativeToolPaths();
    const output = execFileSync(tools.pdfinfo, [
        '-f',
        String(page),
        '-l',
        String(page),
        '-box',
        path,
    ], {encoding: 'utf8'});
    const size = /Page(?:\s+\d+)?\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/u.exec(output);
    const crop = /Page(?:\s+\d+)?\s+CropBox:\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/u.exec(output);
    const rotation = Number(/Page(?:\s+\d+)?\s+rot:\s+(-?\d+)/u.exec(output)?.[1] ?? 0);
    if (!size || !crop) {
        throw new Error(`Poppler did not report page ${page} geometry: ${output}`);
    }
    const width = Number(crop[3]) - Number(crop[1]);
    const height = Number(crop[4]) - Number(crop[2]);
    return {
        page,
        aspect: Math.abs(rotation % 180) === 90 ? height / width : width / height,
    };
}

async function readPaintedPage(page: Page, pageNumber: number) {
    return evaluateInPage(page, (target: number) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"]');
        const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport], #pdf-viewer');
        const container = host?.querySelector<HTMLElement>(`.page_container[data-page="${target}"]`);
        const canvas = container?.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas');
        if (!container?.classList.contains('page_container--rendered') || !canvas?.width || !canvas.height || !viewport) {
            return null;
        }
        const rect = container.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        if (Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top) <= 8) {
            return null;
        }
        const sample = document.createElement('canvas');
        sample.width = 48;
        sample.height = 48;
        const context = sample.getContext('2d', {willReadFrequently: true});
        if (!context) {
            return null;
        }
        context.drawImage(canvas, 0, 0, 48, 48);
        const pixels = context.getImageData(0, 0, 48, 48).data;
        let ink = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index + 3]! > 0 && Math.min(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!) < 240) {
                ink += 1;
            }
        }
        return ink > 0 ? {
            page: target,
            width: rect.width,
            height: rect.height,
            ink,
            text: container.textContent,
        } : null;
    }, pageNumber);
}

describe('Electron E2E - large object-dense PDF opening', () => {
    it('paints promptly while preserving deep geometry, labels, annotations and conformance', async () => {
        mkdirSync(outputDirectory, {recursive: true});
        const scratch = mkdtempSync(join(tmpdir(), 'evb-large-open-'));
        onTestFinished(() => rmSync(scratch, {
            recursive: true,
            force: true,
        }));
        const fixturePath = configuredFixture ? resolve(configuredFixture) : createStructureDensePdf(scratch);
        const sourceHash = await hashFile(fixturePath);
        const expectedGeometry = [
            1,
            MIDDLE_PAGE,
            PAGE_COUNT,
        ].map(page => readExpectedGeometry(fixturePath, page));
        const telemetry: Record<string, unknown> = {
            fixturePath,
            sourceHash,
            bytes: statSync(fixturePath).size,
            expectedGeometry,
        };
        const session = await startElectronE2ESession(`e2e-large-pdf-opening-${Date.now()}`, {extraEnv: {
            EVB_E2E_OPEN_DIALOG_PATH: fixturePath,
            ...(process.env.EVB_E2E_LARGE_OPEN_RECORD === '1' ? {EVB_RECORD_SESSION: '1'} : {}),
        }});
        telemetry.sessionName = session.name;
        const errors: string[] = [];
        session.page.on('pageerror', error => errors.push(String(error)));
        const logPath = join(electronFileLogDir(session.name), 'app.ndjson');
        const readLog = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
        const logStart = readLog().length;
        try {
            await session.page.waitForSelector('.editor-pane.is-active .start-open-panel .open-panel-cta', {visible: true});
            await installCommittedSurfaceSampler(session.page, {sampleCanvasPixels: true});
            const startedAt = Date.now();
            await clickAsUser(session.page, '.editor-pane.is-active .start-open-panel .open-panel-cta');
            await expect.poll(() => readPaintedPage(session.page, 1), {timeout: OBSERVATION_TIMEOUT_MS}).not.toBeNull();
            const firstPage = await readPaintedPage(session.page, 1);
            const firstPaintMs = Date.now() - startedAt;
            Object.assign(telemetry, {
                firstPaintMs,
                firstPage,
            });
            await session.page.waitForSelector('#editor-global-toolbar-host .page-controls-display:not([disabled])', {
                visible: true,
                timeout: OBSERVATION_TIMEOUT_MS,
            });
            const controlsReadyMs = Date.now() - startedAt;
            await waitForCommittedSurfaceSamples(session.page, {
                minimumSamples: 10,
                kind: 'committed-canvas',
                timeoutMs: 2_000,
            });
            const trace = await stopCommittedSurfaceSampler(session.page);
            Object.assign(telemetry, {
                firstPaintMs,
                controlsReadyMs,
                firstPage,
                surfaceTiming: summarizeCommittedSurfaceTiming(trace),
            });
            writeFileSync(join(outputDirectory, 'opening-frames.json'), JSON.stringify(trace, null, 2));
            telemetry.openingViolations = findCommittedSurfaceContractViolations(selectClaimedOpenTrace(trace));
            await session.page.screenshot({path: join(outputDirectory, 'first-page.png')});
            expect.soft(firstPaintMs, 'first painted page within the fixed fixture budget').toBeLessThanOrEqual(FIRST_PAINT_BUDGET_MS);
            expect.soft(controlsReadyMs, 'page navigation enabled within the same budget').toBeLessThanOrEqual(FIRST_PAINT_BUDGET_MS);
            expect.soft(telemetry.openingViolations, 'T5 opening surface progression').toEqual([]);

            const pageObservations = [];
            for (const expected of expectedGeometry) {
                if (expected.page !== 1) {
                    await goToPageViaToolbar(session.page, expected.page);
                }
                await expect.poll(() => readPaintedPage(session.page, expected.page), {timeout: 10_000}).not.toBeNull();
                if (!configuredFixture) {
                    await waitForFunctionInPage(session.page, (pageNumber: number) => document.querySelector(
                        `.editor-pane.is-active .page_container[data-page="${pageNumber}"]`,
                    )?.textContent?.includes(`EVB visible page ${pageNumber}`) === true, {timeout: 10_000}, expected.page);
                }
                const painted = await readPaintedPage(session.page, expected.page);
                const indicator = await readToolbarPageIndicator(session.page);
                pageObservations.push({
                    painted,
                    indicator,
                });
                expect.soft(indicator.renderedPage).toBe(expected.page);
                expect.soft(indicator.totalPagesText?.replace(/\D/gu, '')).toBe(String(PAGE_COUNT));
                expect.soft(Math.abs(painted!.width - painted!.height * expected.aspect), `page ${expected.page} crop/rotation aspect`).toBeLessThanOrEqual(1);
                if (!configuredFixture) {
                    expect.soft(painted!.text).toContain(`EVB visible page ${expected.page}`);
                }
                await session.page.screenshot({path: join(outputDirectory, `page-${expected.page}.png`)});
            }
            telemetry.pageObservations = pageObservations;

            // The visible sentinels above accompany these completion signals;
            // state alone cannot prove labels or annotation contents survived.
            await expect.poll(async () => {
                const state = await readWorkspaceStateValues(session.page, [
                    'pageLabelsResolved',
                    'annotationCommentsStatus',
                ]);
                return state.pageLabelsResolved === true && state.annotationCommentsStatus === 'ready'
                    || /retained qpdf structure exceeds|Failed to import writer PDF annotations/u.test(readLog().slice(logStart));
            }, {timeout: OBSERVATION_TIMEOUT_MS}).toBe(true);
            telemetry.metadata = await readWorkspaceStateValues(session.page, [
                'pageLabelsResolved',
                'annotationCommentsStatus',
                'annotationComments',
            ]);
            if (!configuredFixture) {
                expect.soft((await readToolbarPageIndicator(session.page)).primaryText).toBe(`EVB-${PAGE_COUNT}`);
                await openAnnotationsTab(session.page);
                await waitForFunctionInPage(session.page, (sentinel: string) => document.body.innerText.includes(sentinel), {timeout: 10_000}, NOTE_SENTINEL);
                await session.page.screenshot({path: join(outputDirectory, 'last-page-note.png')});
            }
            await expect.poll(() => {
                const log = readLog().slice(logStart);
                return /"command":"evb-pdf-page-ops\(pdf-conformance\)"[^\n]*"outcome":"(?:resolved|rejected)"/u.test(log)
                    || /"msg":"Worker (?:completed|reported failure)"[^\n]*pdfConformanceWorker/u.test(log);
            }, {timeout: OBSERVATION_TIMEOUT_MS}).toBe(true);
            const log = readLog().slice(logStart);
            telemetry.elapsedMs = Date.now() - startedAt;
            telemetry.rendererErrors = errors;
            writeFileSync(join(outputDirectory, 'app.ndjson'), log);
            const diagnosticFailures = log.split('\n').filter(line => /retained qpdf structure exceeds|"outcome":"rejected"|Failed to import writer PDF annotations|Worker reported failure/u.test(line));
            telemetry.diagnosticFailures = diagnosticFailures;
            expect.soft(diagnosticFailures, 'native metadata completes without errors').toEqual([]);
            expect.soft(errors).toEqual([]);
            expect.soft(await hashFile(fixturePath), 'opening never changes source bytes').toBe(sourceHash);
        } catch (error) {
            telemetry.error = String(error);
            await session.captureFailureArtifacts('large-pdf-opening');
            throw error;
        } finally {
            writeFileSync(join(outputDirectory, 'result.json'), `${JSON.stringify(telemetry, null, 2)}\n`);
            writeFileSync(join(outputDirectory, 'app.ndjson'), readLog().slice(logStart));
            await session.browser.disconnect();
            await session.stop({preserveArtifacts: true});
        }
    }, 8 * 60_000);
});
