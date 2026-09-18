import {
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { createLargeScannedFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { openPdfInApp } from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { startTrustedWheelFling } from '@tests/e2e/electron/helpers/startTrustedWheelFling';
import {
    installViewportPageSampler,
    isToolbarPageVisible,
    readViewportPageObservation,
    waitForViewportQuiet,
} from '@tests/e2e/electron/helpers/viewportPageObservation';
import type { IViewportPageSample } from '@tests/e2e/electron/helpers/viewportPageObservation';
import {
    dismissRuntimeErrorReports,
    isRendererErrorReportClean,
    observeRendererErrors,
    readRuntimeErrorReportDetails,
    readVisibleErrorSurfaces,
} from '@tests/e2e/electron/helpers/rendererErrorObservation';
import type { IRendererErrorObserver } from '@tests/e2e/electron/helpers/rendererErrorObservation';

// A fast trackpad fling on macOS keeps sending wheel events for one to three
// seconds after the fingers leave the glass. The reported defect is what a
// person sees during that tail: a click on a navigation control does nothing,
// the toolbar page counter freezes on a number the window no longer shows, and
// closing the tab mid-fling raises an error surface.
//
// Every assertion below reads the window: the toolbar's rendered text and the
// page rectangles that actually cover the viewport rectangle. The viewer's own
// automation snapshots are used for setup only, never to decide a property.

const FIXTURE_PAGE_COUNT = 431;
const FLING_START_PAGE = 200;
const FLING_INITIAL_DELTA_Y = 520;
const FLING_FINAL_DELTA_Y = 18;
const FLING_DURATION_MS = 3_200;
// Late enough that the burst is unmistakably in its inertial tail, early
// enough that more than two seconds of tail follow the click.
const CLICK_AFTER_MS = 1_000;
const CLOSE_AFTER_MS = 400;
// A separate, ordinary gesture after the burst has ended. Not a fling.
const FOLLOW_UP_WHEEL_DELTA_Y = 180;
const FOLLOW_UP_WHEEL_MS = 600;
const FOLLOW_UP_RESPONSE_DEADLINE_MS = 500;
const FOLLOW_UP_MIN_SCROLL_PX = 8;
const NAVIGATION_DEADLINE_MS = 2_000;
const HOLD_AFTER_BURST_MS = 2_000;
const ARTIFACT_DIR = resolve(process.cwd(), '.devkit', 'test', 'fling-navigation-handoff');

interface IPoint {
    x: number;
    y: number;
}

function writeArtifact(name: string, payload: unknown) {
    const path = resolve(ARTIFACT_DIR, name);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
    return path;
}

async function resolveViewportCentre(page: Page) {
    const point = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const viewport = host?.querySelector<HTMLElement>(
            '[data-document-viewer-chassis-viewport], #pdf-viewer',
        ) ?? null;
        if (!viewport) {
            return null;
        }
        const rect = viewport.getBoundingClientRect();
        return {
            x: Math.round(rect.left + (rect.width / 2)),
            y: Math.round(rect.top + (rect.height / 2)),
        };
    });
    if (!point) {
        throw new Error('The active PDF viewport rectangle was not found');
    }
    return point;
}

async function resolveClickablePoint(page: Page, selector: string, ariaLabel?: string) {
    const point = await page.evaluate((input: {
        ariaLabel: string | null;
        selector: string;
    }) => {
        const candidate = Array.from(document.querySelectorAll<HTMLElement>(input.selector))
            .find((element) => {
                const label = element.getAttribute('aria-label')?.trim() ?? '';
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                const labelMatches = input.ariaLabel === null
                    || label === input.ariaLabel
                    || label.startsWith(`${input.ariaLabel} (`);
                return labelMatches
                    && !(element as HTMLButtonElement).disabled
                    && element.getAttribute('aria-disabled') !== 'true'
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0;
            });
        if (!candidate) {
            return null;
        }
        const rect = candidate.getBoundingClientRect();
        const x = Math.round(rect.left + (rect.width / 2));
        const y = Math.round(rect.top + (rect.height / 2));
        // A trusted click lands on whatever owns that point, so refuse a
        // control that something else covers.
        return document.elementFromPoint(x, y)?.closest(input.selector) === candidate
            ? {
                x,
                y,
            }
            : null;
    }, {
        ariaLabel: ariaLabel ?? null,
        selector,
    });
    if (!point) {
        throw new Error(`No hittable element for ${selector}${ariaLabel ? ` [${ariaLabel}]` : ''}`);
    }
    return point as IPoint;
}

/**
 * Runs a decaying wheel burst and delivers one trusted click part-way through
 * it, without pausing the burst.
 */
async function flingAndClickDuringTail(page: Page, target: IPoint, options: {
    clickAfterMs?: number;
    durationMs?: number;
} = {}) {
    const durationMs = options.durationMs ?? FLING_DURATION_MS;
    const clickAfterMs = options.clickAfterMs ?? CLICK_AFTER_MS;
    const centre = await resolveViewportCentre(page);
    const sampler = await installViewportPageSampler(page);
    const fling = await startTrustedWheelFling(page, {
        x: centre.x,
        y: centre.y,
        initialDeltaY: FLING_INITIAL_DELTA_Y,
        finalDeltaY: FLING_FINAL_DELTA_Y,
        durationMs,
    });

    await delay(clickAfterMs);
    await page.mouse.click(target.x, target.y);
    const clickElapsedMs = Date.now() - fling.startedAt;

    const dispatchedWheelEvents = await fling.finished;
    await delay(HOLD_AFTER_BURST_MS);
    const samples = await sampler.read();
    await sampler.stop();

    return {
        clickElapsedMs,
        dispatchedWheelEvents,
        samples,
    };
}

function summarizeSamples(samples: IViewportPageSample[]) {
    return {
        frameCount: samples.length,
        first: samples.at(0) ?? null,
        last: samples.at(-1) ?? null,
        pageTimeline: samples
            .filter((sample, index) => index === 0 || sample.viewportPage !== samples[index - 1]?.viewportPage)
            .map(sample => ({
                elapsedMs: sample.elapsedMs,
                toolbarText: sample.toolbarText,
                viewportPage: sample.viewportPage,
            })),
        toolbarTimeline: samples
            .filter((sample, index) => index === 0 || sample.toolbarText !== samples[index - 1]?.toolbarText)
            .map(sample => ({
                elapsedMs: sample.elapsedMs,
                toolbarText: sample.toolbarText,
            })),
    };
}

describe('Electron E2E - navigation and tab close during a trackpad fling', () => {
    let pdfPath: string | null = null;
    let totalPages = 0;
    let suiteErrors: IRendererErrorObserver | null = null;
    let openErrorSurfaces: unknown = null;
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: false,
        sessionName: () => `e2e-fling-navigation-${Date.now()}`,
        timeoutMs: 240_000,
    });

    const goToPageForSetup = async (page: Page, pageNumber: number) => {
        // Setup only. The action under test is always trusted input.
        const jump = await callWorkspaceCommand(page, 'handleGoToPage', [pageNumber]);
        expect(jump.called).toBe(true);
        await waitForViewportQuiet(page);
    };

    beforeAll(async () => {
        const session = sessionFixture.getSession();
        pdfPath = await createLargeScannedFixturePdf(
            `fling-navigation-source-${Date.now()}.pdf`,
            FIXTURE_PAGE_COUNT,
            0,
        );
        await openPdfInApp(session.page, pdfPath, 90_000);

        // Continuous single-page mode is the mode the reported defect used and
        // the only mode where "the page that occupies the viewport" has one
        // answer. Both switches are setup, not the behavior under test.
        const toolbar = await getWorkspaceToolbarSnapshot(session.page);
        if (toolbar?.continuousScroll !== true) {
            expect((await callWorkspaceCommand(session.page, 'handleToggleContinuousScroll')).called).toBe(true);
        }
        expect((await callWorkspaceCommand(session.page, 'handleFitWidth')).called).toBe(true);
        await session.page.waitForFunction(() => {
            const api = (window as Window & {__evbTestApi?: {getActiveToolbarSnapshot?: () => {
                continuousScroll?: boolean;
                zoomMode?: string;
            } | null;};}).__evbTestApi;
            const snapshot = api?.getActiveToolbarSnapshot?.();
            return snapshot?.continuousScroll === true && snapshot.zoomMode === 'fit-width';
        }, {timeout: 20_000});
        totalPages = (await getWorkspaceToolbarSnapshot(session.page))?.totalPages ?? 0;
        expect(totalPages).toBe(FIXTURE_PAGE_COUNT);
        // The lanes that run this suite do not build every native tool, so a
        // document open can file an unrelated runtime error report. It is
        // recorded as evidence and cleared, so a later report can be charged
        // to the interaction that produced it.
        openErrorSurfaces = await readVisibleErrorSurfaces(session.page);
        suiteErrors = await observeRendererErrors(session.page);
    }, 240_000);

    const collectSuiteErrorEvidence = async (page: Page) => ({
        openErrorSurfaces,
        report: await suiteErrors?.collect() ?? null,
        runtimeErrorReports: await readRuntimeErrorReportDetails(page),
    });

    // P3. Applies to continuous single-page mode only: there the viewport shows
    // one dominant page, so "the page the toolbar names" and "the page the
    // window shows" are comparable. Paged and multi-page spread modes need a
    // different rule and are deliberately out of scope here.
    it('names the page the window shows after a fling settles', async () => {
        const session = sessionFixture.getSession();
        await goToPageForSetup(session.page, FLING_START_PAGE);

        const centre = await resolveViewportCentre(session.page);
        const sampler = await installViewportPageSampler(session.page);
        const fling = await startTrustedWheelFling(session.page, {
            x: centre.x,
            y: centre.y,
            initialDeltaY: FLING_INITIAL_DELTA_Y,
            finalDeltaY: FLING_FINAL_DELTA_Y,
            durationMs: FLING_DURATION_MS,
        });
        const dispatchedWheelEvents = await fling.finished;
        await waitForViewportQuiet(session.page);
        const samples = await sampler.read();
        await sampler.stop();
        const settled = await readViewportPageObservation(session.page);

        const artifact = writeArtifact('fling-toolbar-sync.json', {
            dispatchedWheelEvents,
            errorEvidence: await collectSuiteErrorEvidence(session.page),
            scenario: 'p3-toolbar-names-the-visible-page',
            settled,
            summary: summarizeSamples(samples),
        });

        expect(dispatchedWheelEvents, artifact).toBeGreaterThan(150);
        expect(settled.viewportPage, artifact).not.toBeNull();
        expect(settled.viewportPage, artifact).toBeGreaterThan(FLING_START_PAGE);
        expect(isToolbarPageVisible(settled), artifact).toBe(true);
    }, 180_000);

    // P1 and P2. The click is delivered by page.mouse.click on the real toolbar
    // control while the wheel burst is still running, and the burst is never
    // paused for it.
    it('lets a navigation click win over the rest of the fling', async () => {
        const session = sessionFixture.getSession();
        await goToPageForSetup(session.page, FLING_START_PAGE);
        const firstPagePoint = await resolveClickablePoint(
            session.page,
            '.page-controls button[aria-label]',
            'First Page',
        );

        const run = await flingAndClickDuringTail(session.page, firstPagePoint);
        await waitForViewportQuiet(session.page);
        const settled = await readViewportPageObservation(session.page);

        const afterClick = run.samples.filter(sample => sample.elapsedMs >= run.clickElapsedMs);
        const arrival = afterClick.find(sample => sample.viewportPage === 1);
        const departures = arrival
            ? afterClick.filter(sample => (
                sample.elapsedMs > arrival.elapsedMs
                && sample.viewportPage !== null
                && sample.viewportPage !== 1
            ))
            : [];
        const artifact = writeArtifact('fling-navigation-click.json', {
            arrival,
            errorEvidence: await collectSuiteErrorEvidence(session.page),
            clickElapsedMs: run.clickElapsedMs,
            departures: departures.slice(0, 40),
            departureCount: departures.length,
            dispatchedWheelEvents: run.dispatchedWheelEvents,
            scenario: 'p1-p2-navigation-click-during-fling',
            settled,
            summary: summarizeSamples(run.samples),
        });

        // P1: the click reaches its target while the tail is still running.
        expect(arrival, artifact).toBeDefined();
        expect(arrival!.elapsedMs - run.clickElapsedMs, artifact).toBeLessThanOrEqual(NAVIGATION_DEADLINE_MS);
        // P2: nothing the superseded scroll finishes later moves the window off
        // the page the navigation chose.
        expect(departures.map(sample => ({
            elapsedMs: sample.elapsedMs,
            viewportPage: sample.viewportPage,
        })), artifact).toEqual([]);
        expect(settled.viewportPage, artifact).toBe(1);
        // P3 again. Requiring the toolbar to name a page the window actually
        // shows, rather than the requested page, is what catches the reported
        // counter freeze: the toolbar can read the target while the superseded
        // scroll has carried the window somewhere else.
        expect(isToolbarPageVisible(settled), artifact).toBe(true);
    }, 180_000);

    // P5. Winning over the tail must not cost the document its scrolling. Once
    // the burst is over and the navigation has landed, the next ordinary wheel
    // gesture is a new intention and has to move the window again.
    it('keeps the next wheel gesture working after a navigation lands during a fling', async () => {
        const session = sessionFixture.getSession();
        await goToPageForSetup(session.page, FLING_START_PAGE);
        const firstPagePoint = await resolveClickablePoint(
            session.page,
            '.page-controls button[aria-label]',
            'First Page',
        );

        await flingAndClickDuringTail(session.page, firstPagePoint);
        await waitForViewportQuiet(session.page);
        const before = await readViewportPageObservation(session.page);

        const centre = await resolveViewportCentre(session.page);
        const sampler = await installViewportPageSampler(session.page);
        const gesture = await startTrustedWheelFling(session.page, {
            x: centre.x,
            y: centre.y,
            initialDeltaY: FOLLOW_UP_WHEEL_DELTA_Y,
            finalDeltaY: FOLLOW_UP_WHEEL_DELTA_Y,
            durationMs: FOLLOW_UP_WHEEL_MS,
        });
        const dispatchedWheelEvents = await gesture.finished;
        const gestureSamples = await sampler.read();
        await sampler.stop();
        await waitForViewportQuiet(session.page);
        const after = await readViewportPageObservation(session.page);

        const firstMovement = gestureSamples.find(
            sample => sample.scrollTop >= before.scrollTop + FOLLOW_UP_MIN_SCROLL_PX,
        );
        const artifact = writeArtifact('fling-follow-up-gesture.json', {
            after,
            before,
            dispatchedWheelEvents,
            errorEvidence: await collectSuiteErrorEvidence(session.page),
            firstMovement,
            scenario: 'p5-wheel-gesture-after-navigation-during-fling',
            summary: summarizeSamples(gestureSamples),
        });

        expect(before.viewportPage, artifact).toBe(1);
        expect(firstMovement, artifact).toBeDefined();
        expect(firstMovement!.elapsedMs, artifact).toBeLessThanOrEqual(FOLLOW_UP_RESPONSE_DEADLINE_MS);
        expect(after.scrollTop, artifact).toBeGreaterThan(before.scrollTop);
        expect(after.viewportPage, artifact).toBeGreaterThan(1);
        expect(isToolbarPageVisible(after), artifact).toBe(true);
    }, 180_000);

    // P4. Closing the tab in the middle of the tail must not surface an error.
    it('closes the tab mid-fling without an error surface', async () => {
        const session = sessionFixture.getSession();
        await goToPageForSetup(session.page, FLING_START_PAGE);
        const closingTabLabel = await session.page.evaluate(() => (
            document.querySelector<HTMLElement>('.tab.is-active')?.innerText.trim() ?? ''
        ));
        expect(closingTabLabel).not.toBe('');
        const closePoint = await resolveClickablePoint(session.page, '.tab.is-active .tab-close');
        // Anything an earlier phase reported is dismissed first, the way a
        // person would, so this property measures only the tab close.
        const dismissedBefore = await dismissRuntimeErrorReports(session.page);
        const errors = await observeRendererErrors(session.page);

        try {
            // Close early in the burst, while the viewer still has the most
            // page work in flight, which is where a destroyed transport and a
            // superseded page metric load can surface as an error.
            const run = await flingAndClickDuringTail(session.page, closePoint, {clickAfterMs: CLOSE_AFTER_MS});
            const report = await errors.collect();
            // Closing the last document tab leaves the start page, so the
            // observable outcome is that this document's tab is gone and no
            // viewer surface is left behind.
            const closedState = await session.page.evaluate((label: string) => {
                const centre = document.elementFromPoint(
                    Math.round(window.innerWidth / 2),
                    Math.round(window.innerHeight / 2),
                );
                return {
                    bodyText: document.body.innerText.slice(0, 2_000),
                    // What the middle of the window shows. A closed document
                    // must not still be painted there.
                    centreShowsViewer: Boolean(centre?.closest('#pdf-viewer')),
                    mountedViewerCount: document.querySelectorAll('#pdf-viewer').length,
                    surviving: Array.from(document.querySelectorAll<HTMLElement>('.tab'))
                        .map(tab => tab.innerText.trim())
                        .filter(text => text === label),
                    title: document.title,
                };
            }, closingTabLabel);
            const artifact = writeArtifact('fling-close-tab.json', {
                closedState,
                closingTabLabel,
                clickElapsedMs: run.clickElapsedMs,
                dismissedBefore,
                dispatchedWheelEvents: run.dispatchedWheelEvents,
                report,
                runtimeErrorReports: await readRuntimeErrorReportDetails(session.page),
                scenario: 'p4-close-tab-during-fling',
                summary: summarizeSamples(run.samples),
            });

            expect(report.baselineErrorSurfaces, artifact).toEqual([]);
            expect(closedState.surviving, artifact).toEqual([]);
            expect(closedState.centreShowsViewer, artifact).toBe(false);
            expect(isRendererErrorReportClean(report), `${artifact} ${JSON.stringify(report)}`).toBe(true);
        } finally {
            errors.dispose();
        }
    }, 180_000);
});
