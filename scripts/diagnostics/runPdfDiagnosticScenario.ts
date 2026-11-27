import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import type {Page} from 'puppeteer-core';
import {delay} from 'es-toolkit/promise';
import {startDiagnosticFrameCapture} from '@scripts/diagnostics/diagnosticFrameCapture';
import {type IElectronE2ESession, startPdfDiagnosticsElectronSession} from '@scripts/diagnostics/startPdfDiagnosticsElectronSession';
import {evaluateInPage, waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {openPdfInApp} from '@tests/e2e/electron/helpers/viewerCore';
import {
    disablePdfDiagnosticSession,
    enablePdfDiagnosticSession,
    type IPdfDiagnosticSessionOptions,
} from '@tests/e2e/electron/helpers/pdfDiagnosticSession';

export interface IPdfDiagnosticsContext {
    artifacts: {
        writeJson: (path: string, payload: unknown) => void;
        writeText: (path: string, text: string) => void;
    };
    capture: {start: (options: Parameters<typeof startDiagnosticFrameCapture>[1]) => ReturnType<typeof startDiagnosticFrameCapture>};
    navigation: {
        clickToolbarButton: (
            label: string,
            options?: {
                dispatch?: 'dom' | 'mouse';
                nextButtonFallback?: boolean;
            },
        ) => Promise<{
            clicked: boolean;
            label: string | null;
            pageText: string[];
            x: number | null;
            y: number | null;
        }>;
        waitForPageCanvas: (pageNumber: number, timeoutMs?: number) => Promise<void>;
    };
    page: Page;
    sampling: {
        atOffsets: <TSample>(
            startedAtMs: number,
            offsetsMs: readonly number[],
            collect: (offsetMs: number) => Promise<TSample>,
        ) => Promise<TSample[]>;
        repeat: <TSample>(
            options: {
                count: number;
                delayMs: number;
            },
            collect: (startedAtMs: number) => Promise<TSample>,
        ) => Promise<TSample[]>;
    };
    session: IElectronE2ESession;
    trace: {
        collectNavigation: () => Promise<unknown[]>;
        collectRender: () => Promise<unknown[]>;
        reset: () => Promise<void>;
    };
}

interface IPdfDiagnosticScenario<TState> {
    afterDiagnosticsEnabled?: (context: IPdfDiagnosticsContext, state: TState) => Promise<void>;
    cleanup?: (context: IPdfDiagnosticsContext, state: TState) => Promise<void>;
    diagnostics: IPdfDiagnosticSessionOptions;
    fixtureError: string;
    name: string;
    openTimeoutMs?: number;
    pdfPath: string;
    prepare?: (context: IPdfDiagnosticsContext) => Promise<TState> | TState;
    run: (context: IPdfDiagnosticsContext, state: TState) => Promise<void>;
    skipDefaultOpen?: boolean;
}

function writeJson(path: string, payload: unknown) {
    const outputPath = resolve(path);
    mkdirSync(dirname(outputPath), {recursive: true});
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeText(path: string, text: string) {
    const outputPath = resolve(path);
    mkdirSync(dirname(outputPath), {recursive: true});
    writeFileSync(outputPath, text);
}

async function collectWindowEntries(page: Page, readerName: '__getPdfNavLog' | '__getPdfRenderTrace') {
    return evaluateInPage(
        page,
        (name) => {
            const diagnosticWindow = window as Window & {
                __getPdfNavLog?: () => unknown;
                __getPdfRenderTrace?: () => unknown;
            };
            const reader = diagnosticWindow[name];
            const entries = typeof reader === 'function' ? reader() : [];
            return Array.isArray(entries) ? entries.map((entry: unknown) => entry) : [];
        },
        readerName,
    );
}

function createContext(session: IElectronE2ESession, diagnostics: IPdfDiagnosticSessionOptions): IPdfDiagnosticsContext {
    return {
        artifacts: {
            writeJson,
            writeText,
        },
        capture: {start: (options) => startDiagnosticFrameCapture(session.page, options)},
        navigation: {
            clickToolbarButton: async (label, options = {}) => {
                const selector = '.page-controls button[aria-label]';
                const targetOptions = {
                    dispatch: options.dispatch ?? 'dom',
                    label,
                    nextButtonFallback: options.nextButtonFallback ?? false,
                    selector,
                };
                await waitForFunctionInPage(
                    session.page,
                    (target: typeof targetOptions) =>
                        Array.from(document.querySelectorAll<HTMLButtonElement>(target.selector)).some((button) => {
                            const ariaLabel = button.getAttribute('aria-label') ?? '';
                            const rect = button.getBoundingClientRect();
                            const style = window.getComputedStyle(button);
                            return (
                                (ariaLabel === target.label || ariaLabel.startsWith(`${target.label} (`)) &&
                                !button.disabled &&
                                button.getAttribute('aria-disabled') !== 'true' &&
                                rect.width > 8 &&
                                rect.height > 8 &&
                                style.display !== 'none' &&
                                style.visibility !== 'hidden'
                            );
                        }),
                    {timeout: 30_000},
                    targetOptions,
                );
                const target = await evaluateInPage(
                    session.page,
                    (options: typeof targetOptions) => {
                        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(options.selector));
                        const isEnabled = (button: HTMLButtonElement) => {
                            const rect = button.getBoundingClientRect();
                            const style = window.getComputedStyle(button);
                            return (
                                !button.disabled &&
                                button.getAttribute('aria-disabled') !== 'true' &&
                                rect.width > 8 &&
                                rect.height > 8 &&
                                style.display !== 'none' &&
                                style.visibility !== 'hidden'
                            );
                        };
                        const button =
                            buttons.find((candidate) => {
                                const ariaLabel = candidate.getAttribute('aria-label') ?? '';
                                return (ariaLabel === options.label || ariaLabel.startsWith(`${options.label} (`)) && isEnabled(candidate);
                            }) ??
                            (options.nextButtonFallback
                                ? (buttons.find(
                                      (candidate) =>
                                          Boolean(candidate.querySelector('.i-ph-caret-right, .iconify.i-ph-caret-right')) &&
                                          isEnabled(candidate),
                                  ) ?? buttons.find(isEnabled))
                                : null);
                        const rect = button?.getBoundingClientRect() ?? null;
                        if (options.dispatch === 'dom') {
                            button?.click();
                        }
                        return {
                            clicked: Boolean(button),
                            label: button?.getAttribute('aria-label') ?? null,
                            pageText: Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                                .filter((element) => {
                                    const elementRect = element.getBoundingClientRect();
                                    const elementStyle = window.getComputedStyle(element);
                                    return (
                                        elementRect.width > 0 &&
                                        elementRect.height > 0 &&
                                        elementStyle.display !== 'none' &&
                                        elementStyle.visibility !== 'hidden'
                                    );
                                })
                                .map((element) => element.textContent.trim()),
                            x: rect ? Math.round(rect.left + rect.width / 2) : null,
                            y: rect ? Math.round(rect.top + rect.height / 2) : null,
                        };
                    },
                    targetOptions,
                );
                if (!target.clicked || target.x === null || target.y === null) {
                    throw new Error(`Unable to click the ${label} toolbar button`);
                }
                if (options.dispatch === 'mouse') {
                    await session.page.mouse.click(target.x, target.y);
                }
                return target;
            },
            waitForPageCanvas: async (pageNumber, timeoutMs = 30_000) => {
                await waitForFunctionInPage(
                    session.page,
                    (targetPage: number) => {
                        const container = document.querySelector<HTMLElement>(`.page_container[data-page="${targetPage}"]`);
                        return Boolean(
                            container?.classList.contains('page_container--rendered') && container.querySelector('.page_canvas canvas'),
                        );
                    },
                    {timeout: timeoutMs},
                    pageNumber,
                );
            },
        },
        page: session.page,
        sampling: {
            atOffsets: async (startedAtMs, offsetsMs, collect) => {
                const samples = [];
                for (const offsetMs of offsetsMs) {
                    const waitMs = Math.max(0, startedAtMs + offsetMs - Date.now());
                    if (waitMs > 0) {
                        await delay(waitMs);
                    }
                    samples.push(await collect(offsetMs));
                }
                return samples;
            },
            repeat: async (options, collect) => {
                const samples = [];
                const startedAtMs = Date.now();
                for (let index = 0; index < options.count; index += 1) {
                    samples.push(await collect(startedAtMs));
                    await delay(options.delayMs);
                }
                return samples;
            },
        },
        session,
        trace: {
            collectNavigation: () => collectWindowEntries(session.page, '__getPdfNavLog'),
            collectRender: () => collectWindowEntries(session.page, '__getPdfRenderTrace'),
            reset: () => enablePdfDiagnosticSession(session.page, diagnostics),
        },
    };
}

export async function runPdfDiagnosticScenario<TState = undefined>(scenario: IPdfDiagnosticScenario<TState>) {
    if (!existsSync(scenario.pdfPath)) {
        throw new Error(scenario.fixtureError);
    }

    const session = await startPdfDiagnosticsElectronSession(scenario.name);
    const context = createContext(session, scenario.diagnostics);
    let state: TState | undefined;
    try {
        state = scenario.prepare ? await scenario.prepare(context) : undefined;
        await enablePdfDiagnosticSession(session.page, scenario.diagnostics);
        await scenario.afterDiagnosticsEnabled?.(context, state as TState);
        if (!scenario.skipDefaultOpen) {
            await openPdfInApp(session.page, scenario.pdfPath, scenario.openTimeoutMs ?? 60_000);
        }
        await scenario.run(context, state as TState);
    } finally {
        if (state !== undefined) {
            await scenario.cleanup?.(context, state).catch(() => {});
        }
        await disablePdfDiagnosticSession(session.page).catch(() => {});
        await session.stop();
    }
}
