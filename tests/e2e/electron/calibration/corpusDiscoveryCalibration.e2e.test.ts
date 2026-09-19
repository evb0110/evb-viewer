import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import type { IViewerInvariantReport } from '@app/modules/viewer-invariants/viewerInvariantTypes';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import { createStickyNoteWithPointer } from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    clickVisibleToolbarButton,
    getToolbarCurrentPage,
    goToPageViaToolbar,
    openDjvuInApp,
    openPdfInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { readViewerInvariantReport } from '@tests/e2e/electron/helpers/viewerInvariants';

/**
 * A discovery run, not a gate. It takes ordinary reader actions on documents
 * the owner supplies and records what the user-level invariants say after
 * each. It asserts only that the run itself happened: what it finds is read by
 * a person, because a real document may legitimately be malformed.
 *
 * The manifest stays outside the repository. Each document is opened from a
 * working copy with a neutral name, and the results name a document by its
 * manifest id and hash prefix only.
 */
const MANIFEST_PATH = process.env.EVB_CORPUS_MANIFEST ?? '';
const RESULTS_DIR = resolve(process.env.EVB_CORPUS_RESULTS ?? '.devkit/trial/results');
const ONLY_IDS = (process.env.EVB_CORPUS_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
// Pictures show document content, so they are off unless asked for.
const SCREENSHOTS = process.env.EVB_CORPUS_SCREENSHOTS === '1';
const OPEN_TIMEOUT_MS = 240_000;
const RESIZED_SIZE = [
    1_180,
    820,
] as const;

interface ICorpusEntry {
    format: 'pdf' | 'djvu';
    id: string;
    pages: number;
    path: string;
    sha256: string;
}

interface IStepRecord {
    error?: string;
    ms: number;
    name: string;
    outcome: 'ok' | 'failed';
    pageIndicator?: number | null;
    skipped?: string[];
    toolbarPage?: number | null;
    transition?: unknown;
    unresolved?: string[];
    violations?: Array<{
        evidence: unknown;
        id: string;
        message: string;
    }>;
}

function loadEntries(): ICorpusEntry[] {
    if (!MANIFEST_PATH) {
        return [];
    }
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {entries: ICorpusEntry[]};
    return manifest.entries.filter(entry => ONLY_IDS.length === 0 || ONLY_IDS.includes(entry.id));
}

function summarize(report: IViewerInvariantReport): Pick<IStepRecord, 'pageIndicator' | 'skipped' | 'unresolved' | 'violations'> {
    return {
        pageIndicator: report.observed.pageIndicator,
        skipped: report.skipped.map(entry => entry.id),
        unresolved: report.unresolved.map(entry => entry.id),
        violations: report.violations.map(violation => ({
            evidence: violation.evidence,
            id: violation.id,
            message: violation.message,
        })),
    };
}

async function viewportCentre(page: Page) {
    const point = await evaluateInPage(page, () => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const rect = host?.getBoundingClientRect();
        return rect ? {
            x: Math.round(rect.left + rect.width * 0.6),
            y: Math.round(rect.top + rect.height / 2),
        } : null;
    });
    if (!point) {
        throw new Error('No active workspace host to point at');
    }
    return point;
}

/**
 * Wheel packets at a trackpad's cadence, never waiting for the viewer between
 * them. Returns whether the current page changed: a scroll inside one page, or
 * against the end of a short document, is not a navigation, so no
 * navigation-idle event follows it.
 */
async function wheelBurst(page: Page, totalDeltaY: number, packets = 16) {
    const before = await getToolbarCurrentPage(page);
    const point = await viewportCentre(page);
    await page.mouse.move(point.x, point.y);
    for (let index = 0; index < packets; index += 1) {
        await page.mouse.wheel({deltaY: totalDeltaY / packets});
        await delay(16);
    }
    await delay(300);
    return await getToolbarCurrentPage(page) !== before;
}

/**
 * Reads the checker every frame while something is still moving. Nothing here
 * is a verdict: how long a transition may take is an open question of the
 * behavior contract, so this only measures it.
 */
function sampleTransition(page: Page, durationMs: number) {
    return evaluateInPage(page, async (sampleMs: number) => {
        const invariants = (window as Window & {__evbViewerInvariants?: {checkNow: (options: object) => IViewerInvariantReport}}).__evbViewerInvariants;
        if (!invariants) {
            throw new Error('The viewer invariant handle is not installed on this renderer');
        }
        const end = performance.now() + sampleMs;
        const longest: Record<string, number> = {};
        const runStart = new Map<string, number>();
        let frames = 0;
        let worstFrameGapMs = 0;
        let previous = performance.now();
        while (performance.now() < end) {
            await new Promise<void>(done => requestAnimationFrame(() => done()));
            const now = performance.now();
            worstFrameGapMs = Math.max(worstFrameGapMs, now - previous);
            previous = now;
            frames += 1;
            const seen = new Set(invariants.checkNow({}).violations.map(violation => violation.id as string));
            for (const id of seen) {
                const startedAt = runStart.get(id) ?? now;
                runStart.set(id, startedAt);
                longest[id] = Math.max(longest[id] ?? 0, now - startedAt);
            }
            for (const id of [...runStart.keys()]) {
                if (!seen.has(id)) {
                    runStart.delete(id);
                }
            }
        }
        return {
            frames,
            longestViolationRunMs: Object.fromEntries(Object.entries(longest).map(([
                id,
                ms,
            ]) => [
                id,
                Math.round(ms),
            ])),
            worstFrameGapMs: Math.round(worstFrameGapMs),
        };
    }, durationMs);
}

const entries = loadEntries();

describe.skipIf(entries.length === 0)('corpus discovery run', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: true,
        sessionName: () => `e2e-corpus-discovery-${Date.now()}`,
    });
    const workDirectory = mkdtempSync(join(tmpdir(), 'evb-corpus-trial-'));

    it.each(entries.map(entry => [
        entry.id,
        entry,
    ] as const))('%s', async (_id, entry) => {
        const session = sessionFixture.getSession();
        const {page} = session;
        const steps: IStepRecord[] = [];
        const consoleErrors: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'error') {
                consoleErrors.push(message.text().slice(0, 300));
            }
        });
        page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

        const step = async (name: string, action: () => Promise<Partial<IStepRecord>>) => {
            const startedAt = Date.now();
            try {
                const extra = await action();
                steps.push({
                    ms: Date.now() - startedAt,
                    name,
                    outcome: 'ok',
                    ...extra,
                });
                return true;
            } catch (error) {
                steps.push({
                    error: String(error instanceof Error ? error.message : error).slice(0, 600),
                    ms: Date.now() - startedAt,
                    name,
                    outcome: 'failed',
                });
                return false;
            }
        };
        // The checker reads the PDF page track only. On DjVu it has nothing to
        // settle on, so the wait is kept short and the toolbar reading carries
        // the observation.
        const observe = async (requireNavigationIdle = false) => ({
            ...summarize(await readViewerInvariantReport(page, {
                requireNavigationIdle: requireNavigationIdle && entry.format === 'pdf',
                ...(entry.format === 'djvu' ? {settleTimeoutMs: 1_500} : {}),
            })),
            toolbarPage: await getToolbarCurrentPage(page),
        });

        const copyPath = join(workDirectory, `corpus-${entry.id}.${entry.format}`);
        copyFileSync(entry.path, copyPath);
        try {
            const opened = await step('open', async () => {
                await (entry.format === 'djvu' ? openDjvuInApp : openPdfInApp)(page, copyPath, OPEN_TIMEOUT_MS);
                await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
                const observed = await observe();
                if (SCREENSHOTS) {
                    mkdirSync(RESULTS_DIR, {recursive: true});
                    await page.screenshot({
                        captureBeyondViewport: false,
                        path: join(RESULTS_DIR, `${entry.id}-at-open.png`),
                    });
                }
                return observed;
            });
            if (opened) {
                await step('resize the real window', async () => {
                    const before = await getToolbarCurrentPage(page);
                    await session.command('windowResize', [...RESIZED_SIZE]);
                    const after = await observe();
                    return {
                        ...after,
                        transition: {
                            pageAfter: after.toolbarPage,
                            pageBefore: before,
                        },
                    };
                });
                if (entry.format === 'pdf') {
                    await step('sticky note with the pointer', async () => {
                        await createStickyNoteWithPointer(page, 'trial note', {
                            x: 0.4,
                            y: 0.3,
                        }, 1);
                        return observe();
                    });
                }
                await step('wheel burst down', async () => {
                    const sampling = sampleTransition(page, 2_500);
                    const moved = await wheelBurst(page, 3_200);
                    const transition = await sampling;
                    return {
                        ...await observe(moved),
                        transition,
                    };
                });
                await step('zoom in while a wheel burst is still scrolling', async () => {
                    const sampling = sampleTransition(page, 3_000);
                    const burst = wheelBurst(page, 4_800, 32);
                    await delay(120);
                    await clickVisibleToolbarButton(page, 'Zoom In');
                    await burst;
                    const transition = await sampling;
                    return {
                        ...await observe(true),
                        transition,
                    };
                });
                await step('zoom out', async () => {
                    await clickVisibleToolbarButton(page, 'Zoom Out');
                    return observe();
                });
                if (entry.pages > 2) {
                    await step('go to the middle page by typing it', async () => {
                        const target = Math.ceil(entry.pages / 2);
                        await goToPageViaToolbar(page, target);
                        return observe(true);
                    });
                }
                await step('fit width', async () => {
                    await clickVisibleToolbarButton(page, 'Fit Width');
                    return observe();
                });
                await step('fit height', async () => {
                    await clickVisibleToolbarButton(page, 'Fit Height');
                    return observe();
                });
                await step('toggle the sidebar', async () => {
                    await clickVisibleToolbarButton(page, 'Toggle Sidebar');
                    return observe();
                });
                await step('wheel burst back up', async () => {
                    const sampling = sampleTransition(page, 2_500);
                    const moved = await wheelBurst(page, -3_200);
                    const transition = await sampling;
                    return {
                        ...await observe(moved),
                        transition,
                    };
                });
                await step('second tab and back', async () => {
                    const pageBefore = await getToolbarCurrentPage(page);
                    const other = await createMultiPageTextFixturePdf(`corpus-trial-other-${entry.id}.pdf`, 3);
                    await openPdfInApp(page, other, OPEN_TIMEOUT_MS);
                    await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
                    const point = await evaluateInPage(page, () => {
                        const rect = document.querySelector('[data-tab-id]')?.getBoundingClientRect();
                        return rect ? {
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2),
                        } : null;
                    });
                    if (!point) {
                        throw new Error('The tab bar rendered no tab to click');
                    }
                    await page.mouse.click(point.x, point.y);
                    await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
                    const after = await observe();
                    // A slow restore must not read as a lost place: the page is
                    // read again for a few seconds and every distinct value kept.
                    const pagesSeen = [after.toolbarPage];
                    for (let index = 0; index < 10; index += 1) {
                        await delay(500);
                        const current = await getToolbarCurrentPage(page);
                        if (current !== pagesSeen.at(-1)) {
                            pagesSeen.push(current);
                        }
                    }
                    return {
                        ...after,
                        transition: {
                            pageAfter: pagesSeen.at(-1),
                            pageBefore,
                            pagesSeen,
                        },
                    };
                });
            }
        } finally {
            rmSync(copyPath, {force: true});
            mkdirSync(RESULTS_DIR, {recursive: true});
            writeFileSync(join(RESULTS_DIR, `${entry.id}.json`), JSON.stringify({
                consoleErrors,
                format: entry.format,
                id: entry.id,
                pages: entry.pages,
                sha256Prefix: entry.sha256.slice(0, 12),
                steps,
            }, null, 2));
        }
        // The run is the only thing asserted: every finding is triaged by a person.
        expect(steps.length).toBeGreaterThan(0);
    }, 900_000);
});
