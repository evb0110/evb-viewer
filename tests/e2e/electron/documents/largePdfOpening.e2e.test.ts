import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
    chmodSync,
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
import {delay} from 'es-toolkit/promise';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    evaluateInPage, waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    goToPageViaToolbar, openAnnotationsTab, openPdfInApp, scrollToPageWithWheel,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {
    callWorkspaceCommand, getLatestAutomationEventId, readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import type {IWorkspaceExposeProbeWindow} from '@tests/e2e/electron/helpers/workspaceExpose';
import {readViewerInvariantReport} from '@tests/e2e/electron/helpers/viewerInvariants';
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
function createStructureDensePdf(directory: string, includeScrollLink = false) {
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
            const annotations = page === PAGE_COUNT ? ` /Annots [${annotationId} 0 R]`
                : includeScrollLink && page === 2 ? ` /Annots [${annotationId + 1} 0 R]` : '';
            object(pageId(page), `<< /Type /Page /Parent 2 0 R ${shape} /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId(page) + 1} 0 R${annotations} >>`);
            const content = `0.15 0.25 0.45 rg 50 100 300 350 re f\nBT /F1 24 Tf 50 500 Td (EVB visible page ${page}) Tj ET\n`;
            object(pageId(page) + 1, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
        }
        object(annotationId, `<< /Type /Annot /Subtype /Text /Rect [80 600 104 624] /P ${pageId(PAGE_COUNT)} 0 R /Contents (${NOTE_SENTINEL}) /T (EVB regression) /NM (structure-dense-note) /Name /Comment /F 4 >>`);
        if (includeScrollLink) {
            object(annotationId + 1, `<< /Type /Annot /Subtype /Link /Rect [50 480 350 525] /Border [0 0 0] /Dest [${pageId(4)} 0 R /Fit] >>`);
        }
        const extraObjectCount = includeScrollLink ? 1 : 0;
        for (let index = 0; index < 200_000; index += 1) {
            object(annotationId + 1 + extraObjectCount + index, `[${Array.from({length: 24}, (_, value) => value).join(' ')}]`);
        }
        const streamId = annotationId + 200_001 + extraObjectCount;
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
    it('keeps a 21601-page PDF responsive and its toolbar accurate after scrollbar drags and wheel scrolling', async () => {
        const artifacts = join(outputDirectory, 'segmented-scroll');
        mkdirSync(artifacts, {recursive: true});
        const scratch = mkdtempSync(join(tmpdir(), 'evb-segmented-scroll-'));
        onTestFinished(() => rmSync(scratch, {
            recursive: true,
            force: true,
        }));
        const fixturePath = createStructureDensePdf(scratch);
        // R5: the reported 3.5–12 s stalls must fail, with room for slower CI.
        const frameGapBoundMs = 2_000;
        // A row crossing the segment end extends the range by at most one row
        // and its gutter; the fixture's tallest page is under twice the usual.
        const segmentHeightPx = 8_388_608;
        const observations: Array<Record<string, unknown>> = [];
        const telemetry: Record<string, unknown> = {
            fixturePath,
            frameGapBoundMs,
            segmentHeightPx,
            observations,
        };
        interface IFrameSamplerWindow extends Window {__evbStopLargePdfFrames?: () => number[];}
        const session = await startElectronE2ESession(`e2e-large-pdf-segmented-scroll-${Date.now()}`, {extraEnv: {
            EVB_E2E_OPEN_DIALOG_PATH: fixturePath,
            ...(process.env.EVB_E2E_LARGE_OPEN_RECORD === '1' ? {EVB_RECORD_SESSION: '1'} : {}),
        }});
        telemetry.sessionName = session.name;
        // Classic scrollbars on Linux and Windows end in arrow buttons, a
        // scrollbar width long; pressing one steps a line instead of dragging.
        const arrowButtons = process.platform !== 'darwin';
        const readViewport = () => evaluateInPage(session.page, (hasArrowButtons: boolean) => {
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"]');
            const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport], #pdf-viewer');
            const firstPage = host?.querySelector<HTMLElement>('.page_container[data-page]');
            if (!viewport || !firstPage) throw new Error('Missing document viewport or page');
            const rect = viewport.getBoundingClientRect();
            const centre = {
                x: rect.left + viewport.clientLeft + viewport.clientWidth / 2,
                y: rect.top + viewport.clientTop + viewport.clientHeight / 2,
            };
            const container = document.elementsFromPoint(centre.x, centre.y)
                .map(element => element.closest<HTMLElement>('.page_container[data-page]'))
                .find(element => element && viewport.contains(element));
            const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
            const trackTop = rect.top + viewport.clientTop;
            const buttonLength = hasArrowButtons ? scrollbarWidth : 0;
            const thumbStart = trackTop + buttonLength;
            const thumbEnd = trackTop + viewport.clientHeight - buttonLength;
            const fraction = viewport.scrollTop / (viewport.scrollHeight - viewport.clientHeight);
            // The thumb's length differs by platform; 4 px inside it at either
            // end, and the proportional point between, which is its centre
            // exactly mid-track, land on it whatever that length is.
            return {
                centre,
                centrePage: container ? Number(container.dataset.page) : null,
                centreText: container?.textContent ?? null,
                pageHeight: firstPage.getBoundingClientRect().height,
                scrollHeight: viewport.scrollHeight,
                scrollTop: viewport.scrollTop,
                scrollbarWidth,
                scrollbarX: rect.right - scrollbarWidth / 2,
                thumbY: fraction < 0.01 ? thumbStart + 4
                    : fraction > 0.99 ? thumbEnd - 4
                        : thumbStart + fraction * (thumbEnd - thumbStart),
                trackTop: trackTop + 1,
                trackBottom: trackTop + viewport.clientHeight - 1,
            };
        }, arrowButtons);
        const dragScrollbar = async (destination: 'top' | 'bottom') => {
            const viewport = await readViewport();
            expect(viewport.scrollbarWidth, 'trusted drag needs a classic scrollbar').toBeGreaterThan(0);
            await session.page.mouse.move(viewport.scrollbarX, viewport.thumbY);
            await session.page.mouse.down();
            try {
                await session.page.mouse.move(viewport.scrollbarX,
                    destination === 'bottom' ? viewport.trackBottom : viewport.trackTop, {steps: 30});
            } finally {
                await session.page.mouse.up();
            }
        };
        const observeAction = async (action: string, perform: () => Promise<void>) => {
            const before = await readViewport();
            const afterEventId = await getLatestAutomationEventId(session.page);
            await evaluateInPage(session.page, async () => {
                const gapsMs: number[] = [];
                let previous = performance.now();
                let frameId = 0;
                const sample = (now: number) => {
                    gapsMs.push(now - previous);
                    previous = now;
                    frameId = requestAnimationFrame(sample);
                };
                (window as IFrameSamplerWindow).__evbStopLargePdfFrames = () => {
                    cancelAnimationFrame(frameId);
                    return [
                        ...gapsMs,
                        performance.now() - previous,
                    ];
                };
                frameId = requestAnimationFrame(sample);
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            });
            await perform();
            const settleDeadline = Date.now() + 10_000;
            // This is the requested observation window, not a retry of input.
            await delay(2_000);
            const frameGapsMs = await evaluateInPage(session.page, () => {
                const probe = window as IFrameSamplerWindow;
                const gaps = probe.__evbStopLargePdfFrames!();
                delete probe.__evbStopLargePdfFrames;
                return gaps;
            });
            const invariants = await readViewerInvariantReport(session.page, {settleTimeoutMs: Math.max(1, settleDeadline - Date.now())});
            const viewport = await readViewport();
            const indicator = await readToolbarPageIndicator(session.page);
            // A scrollbar's final page can report idle before mouseup. Require
            // idle for this gesture's settled page, without demanding a second
            // report after release or accepting an intermediate page's event.
            const navigationIdle = await evaluateInPage(session.page, (input: {
                afterEventId: number;
                page: number | null;
            }) => (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getAutomationEvents()
                .findLast(event => event.id > input.afterEventId
                    && event.type === 'navigation-idle' && event.detail.page === input.page) ?? null, {
                afterEventId,
                page: indicator.renderedPage,
            });
            const painted = viewport.centrePage === null ? null : await readPaintedPage(session.page, viewport.centrePage);
            const longestFrameGapMs = Math.max(...frameGapsMs);
            observations.push({
                action,
                before,
                viewport,
                indicator,
                painted,
                longestFrameGapMs,
                frameGapsMs,
                navigationIdle,
                invariants,
            });
            await session.page.screenshot({path: join(artifacts, `${action}.png`)});
            expect.soft(frameGapsMs.length, `${action}: painting continues`).toBeGreaterThan(2);
            expect.soft(longestFrameGapMs, `${action}: R5 longest frame gap (ms)`).toBeLessThan(frameGapBoundMs);
            expect.soft(navigationIdle, `${action}: the settled page reports navigation idle`).not.toBeNull();
            expect.soft(invariants.violations.filter(violation => [
                'S0-viewer-settled',
                'R1-toolbar-page-visible',
            ].includes(violation.id)), `${action}: settled R1`).toEqual([]);
            expect.soft(indicator.renderedPage, `${action}: readable toolbar`).not.toBeNull();
            expect.soft(viewport.centrePage, `${action}: R1 page under viewport centre`).toBe(indicator.renderedPage);
            expect.soft(viewport.centreText, `${action}: the named page has its own text`).toContain(`EVB visible page ${indicator.renderedPage}`);
            expect.soft(painted, `${action}: the visible page is painted`).not.toBeNull();
            expect.soft(viewport.scrollHeight, `${action}: physical scroll segment stays bounded`).toBeLessThanOrEqual(segmentHeightPx + 2 * viewport.pageHeight);
            return viewport;
        };
        try {
            await session.page.waitForSelector('.editor-pane.is-active .start-open-panel .open-panel-cta', {visible: true});
            await clickAsUser(session.page, '.editor-pane.is-active .start-open-panel .open-panel-cta');
            await expect.poll(() => readPaintedPage(session.page, 1), {timeout: OBSERVATION_TIMEOUT_MS}).not.toBeNull();
            expect((await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [2.1])).called).toBe(true);
            await expect.poll(() => readPaintedPage(session.page, 1), {timeout: 10_000}).not.toBeNull();
            const setup = await readViewerInvariantReport(session.page, {});
            expect(setup.violations.filter(violation => violation.id === 'S0-viewer-settled')).toEqual([]);
            expect((await readToolbarPageIndicator(session.page)).renderedPage).toBe(1);
            const initial = await readViewport();
            telemetry.initialViewport = initial;
            // All but two fixture pages share this height; the other two are taller.
            // Even this lower bound is far above the physical scroll range at 210%.
            telemetry.minimumDocumentHeightPx = initial.pageHeight * PAGE_COUNT;
            expect(initial.scrollHeight, 'segmentation is exercised at 210%').toBeLessThan(initial.pageHeight * PAGE_COUNT / 2);
            expect(initial.scrollHeight).toBeLessThanOrEqual(segmentHeightPx + 2 * initial.pageHeight);
            const bottom = await observeAction('drag-bottom', () => dragScrollbar('bottom'));
            expect.soft(bottom.centrePage, 'drag crosses thousands of pages to the segment boundary').toBeGreaterThan(1_000);
            const top = await observeAction('drag-top', () => dragScrollbar('top'));
            expect.soft(top.centrePage, 'drag back traverses the physical segment').toBeLessThan(bottom.centrePage!);
            const wheel = await observeAction('wheel-down', async () => {
                const {centre} = await readViewport();
                await session.page.mouse.move(centre.x, centre.y);
                for (let step = 0; step < 60; step += 1) {
                    await session.page.mouse.wheel({deltaY: 1_200});
                }
            });
            expect.soft(wheel.centrePage, 'wheel input moves the visible document').toBeGreaterThan(top.centrePage!);
        } catch (error) {
            telemetry.error = String(error);
            await session.captureFailureArtifacts('large-pdf-segmented-scroll');
            throw error;
        } finally {
            writeFileSync(join(artifacts, 'result.json'), `${JSON.stringify(telemetry, null, 2)}\n`);
            await session.browser.disconnect();
            await session.stop({preserveArtifacts: true});
        }
    }, 4 * 60_000);

    it.skipIf(process.platform === 'win32')('paints and navigates while the document annotation import is pending', async () => {
        const artifacts = join(outputDirectory, 'pending-annotations');
        mkdirSync(artifacts, {recursive: true});
        const scratch = mkdtempSync(join(tmpdir(), 'evb-pending-annotations-'));
        onTestFinished(() => rmSync(scratch, {
            recursive: true,
            force: true,
        }));
        const fixturePath = createStructureDensePdf(scratch, true);
        const toolPath = join(scratch, 'page-ops.sh');
        const realTool = join(process.cwd(), '.tmp/pdf-page-ops', `${process.platform}-${process.arch}`, 'bin/evb-pdf-page-ops');
        const quote = (value: string) => `'${value.replaceAll('\'', '\'\\\'\'')}'`;
        const gates = [
            'page-sizes',
            'parse-annotations',
        ] as const;
        writeFileSync(toolPath, [
            '#!/bin/sh',
            'case "$1" in page-sizes|parse-annotations)',
            `  gate=${quote(scratch)}/"$1"`,
            '  if [ -e "$gate.arm" ]; then',
            '    : > "$gate.held"',
            '    while [ -e "$gate.arm" ]; do sleep 0.05; done',
            '  fi;;',
            'esac',
            `exec ${quote(realTool)} "$@"`,
            '',
        ].join('\n'));
        chmodSync(toolPath, 0o700);
        const release = (gate: typeof gates[number]) => rmSync(join(scratch, `${gate}.arm`), {force: true});
        const session = await startElectronE2ESession(`e2e-pending-annotations-${Date.now()}`, {extraEnv: {
            EVB_E2E_OPEN_DIALOG_PATH: fixturePath,
            EVB_PDF_PAGE_OPS_PATH: toolPath,
            EVB_AUTOMATION_DEVICE_SCALE_FACTOR: '2',
            ...(process.env.EVB_E2E_LARGE_OPEN_RECORD === '1' ? {EVB_RECORD_SESSION: '1'} : {}),
        }});
        try {
            await openPdfInApp(session.page, fixturePath, 30_000);
            await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
            const recent = '.editor-pane.is-active .recent-row--data button.recent-open';
            await session.page.waitForSelector(recent, {visible: true});
            for (const gate of gates) writeFileSync(join(scratch, `${gate}.arm`), '');
            await installCommittedSurfaceSampler(session.page, {sampleCanvasPixels: false});
            await clickAsUser(session.page, recent);
            await expect.poll(() => evaluateInPage(session.page, () => {
                const progress = document.querySelector('.workspace-host__opening-progress [role="progressbar"]');
                const box = progress?.getBoundingClientRect();
                return Boolean(box && box.width > 0 && box.height > 0 && getComputedStyle(progress!).visibility !== 'hidden');
            }), {timeout: 1_000}).toBe(true);
            await expect.poll(() => existsSync(join(scratch, 'page-sizes.held')), {timeout: 15_000}).toBe(true);
            // L2/T5: explain the open immediately without inventing a page shape.
            await session.page.screenshot({path: join(artifacts, 'discovering-page-shape.png')});
            release('page-sizes');
            await expect.poll(() => existsSync(join(scratch, 'parse-annotations.held')), {timeout: 15_000}).toBe(true);
            // Source pixels and links do not depend on importing the other 21,600 pages.
            await expect.poll(() => readPaintedPage(session.page, 1), {timeout: 5_000}).not.toBeNull();
            await waitForCommittedSurfaceSamples(session.page, {
                kind: 'committed-canvas',
                minimumSamples: 10,
            });
            const openingTrace = await stopCommittedSurfaceSampler(session.page);
            writeFileSync(join(artifacts, 'opening-frames.json'), JSON.stringify(openingTrace, null, 2));
            expect(openingTrace.frames.some(frame => frame.kind === 'opening-progress')).toBe(true);
            expect(findCommittedSurfaceContractViolations(openingTrace)).toEqual([]);
            expect(existsSync(join(scratch, 'parse-annotations.arm'))).toBe(true);
            await goToPageViaToolbar(session.page, 2);
            await expect.poll(() => readPaintedPage(session.page, 2), {timeout: 5_000}).not.toBeNull();
            const link = '.editor-pane.is-active .page_container[data-page="2"] .pdf-link-overlay';
            await session.page.waitForSelector(link, {visible: true});
            await clickAsUser(session.page, link);
            await expect.poll(() => readPaintedPage(session.page, 4), {timeout: 5_000}).not.toBeNull();
            expect((await readToolbarPageIndicator(session.page)).renderedPage).toBe(4);
            await session.page.screenshot({path: join(artifacts, 'source-painted-during-import.png')});
            release('parse-annotations');
            await goToPageViaToolbar(session.page, PAGE_COUNT);
            await openAnnotationsTab(session.page);
            await waitForFunctionInPage(session.page, (sentinel: string) => document.body.innerText.includes(sentinel), {timeout: 60_000}, NOTE_SENTINEL);
            await session.page.screenshot({path: join(artifacts, 'imported-note.png')});
        } finally {
            gates.forEach(release);
            await session.browser.disconnect();
            await session.stop({preserveArtifacts: true});
        }
    }, 150_000);

    it('keeps painted pages and their links usable after free scrolling', async () => {
        const artifacts = join(outputDirectory, 'free-scroll');
        mkdirSync(artifacts, {recursive: true});
        const scratch = mkdtempSync(join(tmpdir(), 'evb-large-scroll-'));
        onTestFinished(() => rmSync(scratch, {
            recursive: true,
            force: true,
        }));
        const fixturePath = createStructureDensePdf(scratch, true);
        const telemetry: Record<string, unknown> = {fixturePath};
        const session = await startElectronE2ESession(`e2e-large-pdf-free-scroll-${Date.now()}`, {extraEnv: {
            EVB_E2E_OPEN_DIALOG_PATH: fixturePath,
            ...(process.env.EVB_E2E_LARGE_OPEN_RECORD === '1' ? {EVB_RECORD_SESSION: '1'} : {}),
        }});
        telemetry.sessionName = session.name;
        try {
            await session.page.waitForSelector('.editor-pane.is-active .start-open-panel .open-panel-cta', {visible: true});
            await installCommittedSurfaceSampler(session.page, {sampleCanvasPixels: false});
            await clickAsUser(session.page, '.editor-pane.is-active .start-open-panel .open-panel-cta');
            await expect.poll(() => readPaintedPage(session.page, 1), {timeout: OBSERVATION_TIMEOUT_MS}).not.toBeNull();
            const opening = await stopCommittedSurfaceSampler(session.page);
            telemetry.openingTiming = summarizeCommittedSurfaceTiming(selectClaimedOpenTrace(opening));
            writeFileSync(join(artifacts, 'opening-frames.json'), JSON.stringify(opening, null, 2));

            await installCommittedSurfaceSampler(session.page, {sampleCanvasPixels: true});
            // R2/L2: reaching a page by the wheel must leave its painted
            // content usable. A settled canvas alone does not prove that
            // its interactive layer survived the opening handoff.
            await scrollToPageWithWheel(session.page, 2);
            await expect.poll(() => readPaintedPage(session.page, 2), {timeout: 10_000}).not.toBeNull();
            await session.page.screenshot({path: join(artifacts, 'scrolled-page-2.png')});
            const scroll = await stopCommittedSurfaceSampler(session.page);
            writeFileSync(join(artifacts, 'scroll-frames.json'), JSON.stringify(scroll, null, 2));
            telemetry.scrollFrameIntervalsMs = scroll.frames.slice(1).map((frame, index) => frame.elapsedMs - scroll.frames[index]!.elapsedMs);
            const competingSkeletons = scroll.frames.flatMap(frame => (frame.visiblePdfPageVisuals ?? [])
                .filter(visual => visual.canonicalCanvasVisible && visual.canonicalCanvasNonblank && visual.skeletonVisible)
                .map(visual => ({
                    frame: frame.frame,
                    page: visual.pageNumber,
                })));
            expect.soft(competingSkeletons, 'a painted visible page is never covered by a loading skeleton').toEqual([]);
            const linkSelector = '.editor-pane.is-active .page_container[data-page="2"] .pdf-link-overlay';
            await session.page.waitForSelector(linkSelector, {
                visible: true,
                timeout: 10_000,
            });
            await clickAsUser(session.page, linkSelector);
            await expect.poll(async () => ({
                painted: await readPaintedPage(session.page, 4) !== null,
                indicator: (await readToolbarPageIndicator(session.page)).renderedPage,
            }), {timeout: 10_000}).toEqual({
                painted: true,
                indicator: 4,
            });
            await session.page.screenshot({path: join(artifacts, 'link-destination-page-4.png')});
        } catch (error) {
            telemetry.error = String(error);
            await session.captureFailureArtifacts('large-pdf-free-scroll');
            throw error;
        } finally {
            writeFileSync(join(artifacts, 'result.json'), `${JSON.stringify(telemetry, null, 2)}\n`);
            await session.browser.disconnect();
            await session.stop({preserveArtifacts: true});
        }
    }, 4 * 60_000);

    it('paints promptly while preserving deep geometry, labels and annotations', async () => {
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
