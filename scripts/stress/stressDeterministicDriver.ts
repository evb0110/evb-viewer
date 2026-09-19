import { getErrorMessage } from '@contracts/getErrorMessage';
import { setTimeout as delay } from 'node:timers/promises';
import type {
    CDPSession,
    Page,
} from 'puppeteer-core';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    ElectronE2ETimeoutError,
    runWithElectronE2EDeadline,
} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';
import { createFreeTextAnnotationWithPointer } from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openDjvuInApp,
    openPdfInApp,
    saveViaVisibleToolbarWithDeadline,
    setupScrollToPage,
    setTabMemoryPolicyForE2E,
    triggerOpenPathInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    activateWorkspaceTab,
    createNewWorkspaceTab,
    splitActiveWorkspaceDocument,
} from '@tests/e2e/electron/helpers/workspaceTabs';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import type { IStressFixtureRecord } from '@scripts/stress/stressFixtures';
import type {
    IStressStepRecord,
    TStressFixtureId,
    TStressStep,
} from '@scripts/stress/stressTypes';

export interface IStressDeterministicDriverOptions {
    session: IElectronE2ESession;
    fixtures: Map<TStressFixtureId, IStressFixtureRecord>;
    stepTimeoutMs: number;
    log: (line: string) => void;
    signal?: AbortSignal;
    onStepComplete?: (record: IStressStepRecord) => Promise<void> | void;
}

/** Deterministic xorshift so "random" page jumps replay identically across runs. */
export function createSeededRandom(seed: number) {
    let state = (seed >>> 0) || 0x9e3779b9;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x100000000;
    };
}

export function planRandomPages(totalPages: number, count: number, seed: number) {
    const random = createSeededRandom(seed);
    const pages: number[] = [];
    for (let index = 0; index < count; index += 1) {
        pages.push(1 + Math.floor(random() * Math.max(1, totalPages)));
    }
    return pages;
}

const VIEWPORT_SELECTOR = '.editor-pane.is-active [data-document-viewer-chassis-viewport], [data-document-viewer-chassis-viewport], #pdf-viewer';
const WHEEL_QUIET_MS = 300;

interface IWheelProbeWindow extends Window {__evbStressWheelProbe?: {
    scrollEventCount: number;
    mutationCount: number;
    lastActivityAt: number;
    finalScrollTop: number;
    cleanup: () => void;
};}

/**
 * Local wheel helper: the shared E2E settlement helper depends on app-side
 * global typings that the scripts tsconfig cannot see, so this counts scroll
 * events and DOM mutations on the active viewport until a quiet window passes.
 */
async function wheelActiveViewportAndSettle(page: Page, deltaY: number, timeoutMs: number, signal: AbortSignal) {
    const rect = await evaluateInPage(page, (selector: string) => {
        const viewport = document.querySelector<HTMLElement>(selector);
        if (!viewport) {
            return null;
        }
        const box = viewport.getBoundingClientRect();
        const probeWindow = window as IWheelProbeWindow;
        probeWindow.__evbStressWheelProbe?.cleanup();
        const probe = {
            scrollEventCount: 0,
            mutationCount: 0,
            lastActivityAt: performance.now(),
            finalScrollTop: viewport.scrollTop,
            cleanup: () => {},
        };
        const onScroll = () => {
            probe.scrollEventCount += 1;
            probe.lastActivityAt = performance.now();
            probe.finalScrollTop = viewport.scrollTop;
        };
        const observer = new MutationObserver((records) => {
            probe.mutationCount += records.length;
            probe.lastActivityAt = performance.now();
        });
        viewport.addEventListener('scroll', onScroll, {passive: true});
        observer.observe(viewport, {
            childList: true,
            subtree: true,
            attributes: true,
        });
        probe.cleanup = () => {
            viewport.removeEventListener('scroll', onScroll);
            observer.disconnect();
            delete probeWindow.__evbStressWheelProbe;
        };
        probeWindow.__evbStressWheelProbe = probe;
        return {
            x: box.left + box.width / 2,
            y: box.top + box.height / 2,
        };
    }, VIEWPORT_SELECTOR);
    if (!rect) {
        throw new Error('no active document viewport for wheel scrolling');
    }
    signal.throwIfAborted();
    await page.mouse.move(rect.x, rect.y);
    signal.throwIfAborted();
    await page.mouse.wheel({deltaY});
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        await delay(100, undefined, {signal});
        const finalize = Date.now() >= deadline;
        const state = await evaluateInPage(page, (quietMs: number, finalize: boolean) => {
            const probe = (window as IWheelProbeWindow).__evbStressWheelProbe;
            if (!probe) {
                return null;
            }
            const quiet = performance.now() - probe.lastActivityAt >= quietMs;
            const snapshot = {
                scrollEventCount: probe.scrollEventCount,
                mutationCount: probe.mutationCount,
                finalScrollTop: probe.finalScrollTop,
                quiet,
            };
            if (quiet || finalize) {
                probe.cleanup();
            }
            return snapshot;
        }, WHEEL_QUIET_MS, finalize);
        if (!state) {
            throw new Error('wheel probe disappeared (page navigated or reloaded)');
        }
        if (state.quiet || finalize) {
            return state;
        }
    }
}

async function readTotalPages(page: Page) {
    const snapshot = await getWorkspaceToolbarSnapshot(page);
    return snapshot?.totalPages ?? 0;
}

function resolvePageTarget(target: number | 'last' | 'middle', totalPages: number) {
    if (target === 'last') {
        return Math.max(1, totalPages);
    }
    if (target === 'middle') {
        return Math.max(1, Math.floor(totalPages / 2));
    }
    return Math.min(Math.max(1, target), Math.max(1, totalPages));
}

async function waitForOpenError(page: Page, timeoutMs: number, signal: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await getWorkspaceToolbarSnapshot(page).catch(() => null);
        if (snapshot?.hasOpenError) {
            return true;
        }
        await delay(250, undefined, {signal});
    }
    return false;
}

async function pressSearchShortcut(page: Page, query: string, signal: AbortSignal) {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modifier);
    await page.keyboard.press('KeyF');
    await page.keyboard.up(modifier);
    await delay(400, undefined, {signal});
    const focusedInput = await evaluateInPage(page, () => {
        const active = document.activeElement;
        return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    });
    if (!focusedInput) {
        return {searchInputFocused: false};
    }
    signal.throwIfAborted();
    await page.keyboard.type(query, {delay: 5});
    signal.throwIfAborted();
    await page.keyboard.press('Enter');
    return {searchInputFocused: true};
}

interface IStepContext {
    session: IElectronE2ESession;
    page: Page;
    cdp: CDPSession;
    fixtures: Map<TStressFixtureId, IStressFixtureRecord>;
    stepTimeoutMs: number;
    log: (line: string) => void;
}

async function executeStep(context: IStepContext, step: TStressStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    const {
        page,
        session,
    } = context;
    signal.throwIfAborted();
    switch (step.kind) {
        case 'phase':
            return {phase: step.name};
        case 'open': {
            const fixture = context.fixtures.get(step.fixture);
            if (!fixture || !fixture.available) {
                throw new Error(`fixture ${step.fixture} unavailable: ${fixture?.reason ?? 'not generated'}`);
            }
            if (step.inNewTab) {
                await createNewWorkspaceTab(session);
            }
            if (step.expect === 'open-error') {
                await triggerOpenPathInApp(page, fixture.path, context.stepTimeoutMs);
                const surfaced = await waitForOpenError(page, Math.min(30_000, context.stepTimeoutMs), signal);
                if (!surfaced) {
                    throw new Error('expected an open error but none surfaced');
                }
                return {
                    path: fixture.path,
                    openError: true,
                };
            }
            if (fixture.id === 'djvu-reference') {
                await openDjvuInApp(page, fixture.path, context.stepTimeoutMs);
            } else {
                await openPdfInApp(page, fixture.path, context.stepTimeoutMs);
            }
            await waitForViewerInteractive(page, context.stepTimeoutMs);
            return {
                path: fixture.path,
                bytes: fixture.bytes,
                totalPages: await readTotalPages(page),
            };
        }
        case 'goToPage': {
            const totalPages = await readTotalPages(page);
            const visited: number[] = [];
            for (const target of step.pages) {
                signal.throwIfAborted();
                const pageNumber = resolvePageTarget(target, totalPages);
                await setupScrollToPage(page, pageNumber);
                visited.push(pageNumber);
            }
            return {visited};
        }
        case 'randomPages': {
            const totalPages = await readTotalPages(page);
            const pages = planRandomPages(totalPages, step.count, step.seed);
            for (const pageNumber of pages) {
                signal.throwIfAborted();
                await setupScrollToPage(page, pageNumber);
            }
            return {pages};
        }
        case 'wheelBurst': {
            let scrollEvents = 0;
            let mutations = 0;
            let finalScrollTop = 0;
            for (let index = 0; index < step.count; index += 1) {
                signal.throwIfAborted();
                const settlement = await wheelActiveViewportAndSettle(page, step.deltaY, step.settleTimeoutMs ?? 10_000, signal);
                scrollEvents += settlement.scrollEventCount;
                mutations += settlement.mutationCount;
                finalScrollTop = settlement.finalScrollTop;
            }
            return {
                scrollEvents,
                mutations,
                finalScrollTop,
            };
        }
        case 'command': {
            const repeat = step.repeat ?? 1;
            let called = 0;
            for (let index = 0; index < repeat; index += 1) {
                signal.throwIfAborted();
                const result = await callWorkspaceCommand(page, step.name);
                if (!result.called) {
                    throw new Error(`workspace command ${step.name} was not callable`);
                }
                called += 1;
                await waitForWorkspaceToolbarIdle(page, {timeoutMs: context.stepTimeoutMs});
            }
            return {called};
        }
        case 'newTab':
            await createNewWorkspaceTab(session);
            return {};
        case 'activateTab':
            await activateWorkspaceTab(session, step.index);
            await waitForWorkspaceToolbarIdle(page, {timeoutMs: context.stepTimeoutMs});
            return {index: step.index};
        case 'cycleTabs': {
            const tabCount = await evaluateInPage(page, () => document.querySelectorAll('.tab-list .tab[data-tab-id]').length);
            let switches = 0;
            for (let round = 0; round < step.rounds; round += 1) {
                signal.throwIfAborted();
                for (let index = 0; index < tabCount; index += 1) {
                    signal.throwIfAborted();
                    await activateWorkspaceTab(session, index);
                    await waitForWorkspaceToolbarIdle(page, {timeoutMs: context.stepTimeoutMs});
                    switches += 1;
                }
            }
            return {
                tabCount,
                switches,
            };
        }
        case 'split':
            await splitActiveWorkspaceDocument(session, step.direction);
            await waitForWorkspaceToolbarIdle(page, {timeoutMs: context.stepTimeoutMs});
            return {direction: step.direction};
        case 'freeText': {
            const totalPages = Math.max(1, await readTotalPages(page));
            for (let index = 0; index < step.count; index += 1) {
                signal.throwIfAborted();
                const pageNumber = 1 + (index % totalPages);
                context.log(`freeText ${index + 1}/${step.count} page ${pageNumber} scroll`);
                await setupScrollToPage(page, pageNumber);
                signal.throwIfAborted();
                context.log(`freeText ${index + 1}/${step.count} page ${pageNumber} create`);
                await createFreeTextAnnotationWithPointer(page, `${step.text} ${index + 1}`, {
                    x: 0.2 + (index % 5) * 0.12,
                    y: 0.2 + (Math.floor(index / 5) % 4) * 0.15,
                }, pageNumber);
                context.log(`freeText ${index + 1}/${step.count} page ${pageNumber} created`);
            }
            return {created: step.count};
        }
        case 'save':
            await saveViaVisibleToolbarWithDeadline(page, context.stepTimeoutMs);
            await waitForWorkspaceToolbarIdle(page, {timeoutMs: context.stepTimeoutMs});
            return {};
        case 'search':
            return pressSearchShortcut(page, step.query, signal);
        case 'idle':
            await delay(step.ms, undefined, {signal});
            return {ms: step.ms};
        case 'gc':
            await context.cdp.send('HeapProfiler.collectGarbage');
            return {};
        case 'memoryPolicy':
            await setTabMemoryPolicyForE2E(page, step.policy);
            return {policy: step.policy};
    }
}

export async function runStressDeterministicSteps(steps: readonly TStressStep[], options: IStressDeterministicDriverOptions) {
    const records: IStressStepRecord[] = [];
    const cdp = await options.session.page.createCDPSession();
    const context: IStepContext = {
        session: options.session,
        page: options.session.page,
        cdp,
        fixtures: options.fixtures,
        stepTimeoutMs: options.stepTimeoutMs,
        log: options.log,
    };
    let abortRemaining = false;
    try {
        for (const [
            index,
            step,
        ] of steps.entries()) {
            const startedAt = new Date();
            const record: IStressStepRecord = {
                index,
                step,
                startedAt: startedAt.toISOString(),
                durationMs: 0,
                status: 'succeeded',
                error: null,
                detail: {},
            };
            if (abortRemaining || options.signal?.aborted) {
                record.status = 'skipped';
                record.error = 'skipped after a failed open, deadline or cancellation';
                records.push(record);
                continue;
            }
            options.log(`step ${index} ${step.kind}${'name' in step ? ` ${step.name}` : ''}${'fixture' in step ? ` ${step.fixture}` : ''}`);
            try {
                record.detail = await runWithElectronE2EDeadline(
                    `stress step ${index} ${step.kind}`,
                    step.kind === 'idle' ? step.ms + 5_000 : options.stepTimeoutMs,
                    signal => executeStep(context, step, options.signal ? AbortSignal.any([
                        signal,
                        options.signal,
                    ]) : signal),
                );
            } catch (error) {
                record.status = 'failed';
                record.error = getErrorMessage(error);
                if (error instanceof ElectronE2ETimeoutError || (step.kind === 'open' && step.expect !== 'open-error')) {
                    abortRemaining = true;
                }
                options.log(`step ${index} failed: ${record.error}`);
            }
            record.durationMs = Date.now() - startedAt.getTime();
            records.push(record);
            await options.onStepComplete?.(record);
        }
    } finally {
        try {
            await cdp.detach();
        } catch {
            // Renderer gone; nothing to detach from.
        }
    }
    return records;
}
