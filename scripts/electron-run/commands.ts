import { basename, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { delay } from 'es-toolkit/promise';
import {
    COMMAND_EXECUTION_TIMEOUT_MS,
    OPEN_PDF_READY_TIMEOUT_MS,
    OPEN_PDF_TRIGGER_TIMEOUT_MS,
    screenshotDirPath,
    type ISessionState,
} from './shared';

export function createCommandHandler(getSessionState: () => ISessionState | null) {
    return async function handleCommand(command: string, args: unknown[]): Promise<unknown> {
        const sessionState = getSessionState();
        if (!sessionState) {
            throw new Error('Session not initialized');
        }

        const {
            page,
            consoleMessages,
        } = sessionState;
        const ssDirPath = screenshotDirPath();

        switch (command) {
            case 'ping':
                return { status: 'ok', uptime: process.uptime() };

            case 'screenshot': {
                const name = (args[0] as string) ?? `screenshot-${Date.now()}`;
                mkdirSync(ssDirPath, { recursive: true });
                const filepath = join(ssDirPath, `${name}.png`);
                await page.screenshot({ path: filepath });
                return { screenshot: filepath };
            }

            case 'console': {
                const level = (args[0] as string) ?? 'all';
                const filtered = level === 'all'
                    ? consoleMessages
                    : consoleMessages.filter((message) => message.type === level);
                return { messages: filtered.slice(-50) };
            }

            case 'run': {
                const code = args[0] as string;
                if (!code) {
                    throw new Error('No code provided');
                }

                const screenshotFn = async (name: string) => {
                    mkdirSync(ssDirPath, { recursive: true });
                    const filepath = join(ssDirPath, `${name}.png`);
                    await page.screenshot({ path: filepath });
                    return filepath;
                };
                const sleepFn = async (ms: number) => {
                    const duration = Number.isFinite(ms) ? Math.max(0, ms) : 0;
                    await delay(duration);
                };

                const asyncFn = new Function(
                    'page', 'screenshot', 'sleep', 'wait',
                    `return (async () => { ${code} })()`,
                );

                return await Promise.race([
                    asyncFn(page, screenshotFn, sleepFn, sleepFn),
                    delay(COMMAND_EXECUTION_TIMEOUT_MS).then(() => {
                        throw new Error(`run command timed out after ${Math.round(COMMAND_EXECUTION_TIMEOUT_MS / 1000)}s`);
                    }),
                ]);
            }

            case 'eval': {
                const code = args[0] as string;
                if (!code) {
                    throw new Error('No code provided');
                }
                return await Promise.race([
                    page.evaluate(code),
                    delay(COMMAND_EXECUTION_TIMEOUT_MS).then(() => {
                        throw new Error(`eval command timed out after ${Math.round(COMMAND_EXECUTION_TIMEOUT_MS / 1000)}s`);
                    }),
                ]);
            }

            case 'click': {
                const selector = args[0] as string;
                if (!selector) {
                    throw new Error('No selector provided');
                }
                await page.click(selector);
                return { clicked: selector };
            }

            case 'type': {
                const [
                    selector,
                    text,
                ] = args as [string, string];
                if (!selector || !text) {
                    throw new Error('Selector and text required');
                }
                await page.type(selector, text);
                return { typed: text, into: selector };
            }

            case 'content': {
                const selector = args[0] as string;
                if (!selector) {
                    throw new Error('No selector provided');
                }
                const el = await page.$(selector);
                if (!el) {
                    return null;
                }
                return await el.evaluate(element => element.textContent);
            }

            case 'resize': {
                const [
                    width,
                    height,
                ] = args as [number, number];
                if (!width || !height) {
                    throw new Error('Width and height required');
                }
                await page.setViewport({ width, height });
                return { resized: { width, height } };
            }

            case 'viewport': {
                const viewport = page.viewport();
                return { viewport };
            }

            case 'openPdf': {
                const pdfPath = args[0] as string;
                if (!pdfPath) {
                    throw new Error('PDF path required');
                }
                const requestedBasename = basename(pdfPath).toLowerCase();
                type TOpenPdfState = {
                    numPages: number | null;
                    currentPage: number | null;
                    isLoading: boolean | null;
                    workingCopyPath: string | null;
                    renderedPageContainers: number;
                    renderedCanvasCount: number;
                    renderedTextSpanCount: number;
                    visibleSkeletonCount: number;
                    hasViewer: boolean;
                    hasEmptyState: boolean;
                    openTrigger?: {
                        token: string;
                        status: 'pending' | 'resolved' | 'rejected';
                        error: string | null;
                    } | null;
                };

                const isRequestedDocumentLoaded = (workingCopyPath: string | null | undefined) => {
                    if (!workingCopyPath) {
                        return false;
                    }
                    return basename(workingCopyPath).toLowerCase() === requestedBasename;
                };

                const readViewerState = async (token?: string) => await page.evaluate((requestedToken?: string) => {
                    const host = document.querySelector('#pdf-viewer') as (HTMLElement & {
                        __vueParentComponent?: {
                            setupState?: {
                                numPages?: number;
                                currentPage?: number;
                                isLoading?: boolean;
                                workingCopyPath?: string | null;
                            };
                        };
                    }) | null;
                    const setupState = host?.__vueParentComponent?.setupState;
                    const trigger = (window as any).__electronRunOpenPdfTrigger as {
                        token?: string;
                        status?: 'pending' | 'resolved' | 'rejected';
                        error?: string | null;
                    } | undefined;
                    const openTrigger = (
                        requestedToken
                        && trigger
                        && trigger.token === requestedToken
                    )
                        ? {
                            token: trigger.token ?? '',
                            status: trigger.status ?? 'pending',
                            error: trigger.error ?? null,
                        }
                        : null;

                    return {
                        numPages: setupState?.numPages ?? null,
                        currentPage: setupState?.currentPage ?? null,
                        isLoading: setupState?.isLoading ?? null,
                        workingCopyPath: setupState?.workingCopyPath ?? null,
                        renderedPageContainers: document.querySelectorAll('.page_container').length,
                        renderedCanvasCount: document.querySelectorAll('.page_container .page_canvas canvas').length,
                        renderedTextSpanCount: document.querySelectorAll('.page_container .text-layer span, .page_container .textLayer span').length,
                        visibleSkeletonCount: Array.from(document.querySelectorAll('.page_container .pdf-page-skeleton'))
                            .filter((node) => {
                                const element = node as HTMLElement;
                                if (!element.isConnected) {
                                    return false;
                                }
                                const style = window.getComputedStyle(element);
                                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                                    return false;
                                }
                                const rect = element.getBoundingClientRect();
                                return rect.width > 0 && rect.height > 0;
                            })
                            .length,
                        hasViewer: Boolean(host),
                        hasEmptyState: Boolean(document.querySelector('.empty-state')),
                        openTrigger,
                    } satisfies TOpenPdfState;
                }, token);

                const beforeState = await readViewerState();
                const triggerToken = await page.evaluate((path: string, triggerTimeoutMs: number) => {
                    const token = `open-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                    (window as any).__electronRunOpenPdfTrigger = {
                        token,
                        status: 'pending',
                        error: null,
                    };

                    const openFileDirect = (window as any).__openFileDirect;
                    if (typeof openFileDirect !== 'function') {
                        (window as any).__electronRunOpenPdfTrigger = {
                            token,
                            status: 'rejected',
                            error: 'window.__openFileDirect is not available',
                        };
                        return token;
                    }

                    Promise.resolve()
                        .then(async () => {
                            await Promise.race([
                                openFileDirect(path),
                                new Promise((_, reject) => {
                                    setTimeout(() => reject(new Error('openFileDirect trigger timeout')), triggerTimeoutMs);
                                }),
                            ]);
                            (window as any).__electronRunOpenPdfTrigger = {
                                token,
                                status: 'resolved',
                                error: null,
                            };
                        })
                        .catch((error: unknown) => {
                            const message = error instanceof Error ? error.message : String(error);
                            (window as any).__electronRunOpenPdfTrigger = {
                                token,
                                status: 'rejected',
                                error: message,
                            };
                        });

                    return token;
                }, pdfPath, OPEN_PDF_TRIGGER_TIMEOUT_MS);

                const start = Date.now();
                let lastState: TOpenPdfState = beforeState;
                while (Date.now() - start < OPEN_PDF_READY_TIMEOUT_MS) {
                    lastState = await readViewerState(triggerToken as string);

                    if (lastState.openTrigger?.status === 'rejected') {
                        throw new Error(lastState.openTrigger.error || 'openPdf failed');
                    }

                    const hasPages = (lastState.numPages ?? 0) > 0 || lastState.renderedPageContainers > 0;
                    const notLoading = lastState.isLoading === false || lastState.isLoading === null;
                    const hasDocumentUi = lastState.hasViewer && !lastState.hasEmptyState;
                    const hasRenderedContent = lastState.renderedCanvasCount > 0 || lastState.renderedTextSpanCount > 0;
                    const requestedDocLoaded = isRequestedDocumentLoaded(lastState.workingCopyPath);

                    if (hasPages && hasDocumentUi && notLoading && hasRenderedContent && requestedDocLoaded) {
                        await delay(250);
                        break;
                    }

                    await delay(250);
                }

                const state = await readViewerState();
                if (
                    !state.hasViewer
                    || state.hasEmptyState
                    || state.renderedPageContainers <= 0
                    || (state.renderedCanvasCount <= 0 && state.renderedTextSpanCount <= 0)
                    || !isRequestedDocumentLoaded(state.workingCopyPath)
                ) {
                    const loadedPath = state.workingCopyPath ?? '<none>';
                    throw new Error(`openPdf readiness timeout for ${pdfPath} (loaded: ${loadedPath})`);
                }

                return {
                    opened: pdfPath,
                    state,
                };
            }

            case 'health': {
                const health = await page.evaluate(() => {
                    return {
                        bodyExists: document.body !== null,
                        openFileDirect: typeof (window as any).__openFileDirect,
                        electronAPI: typeof (window as any).electronAPI,
                        title: document.title,
                        url: window.location.href,
                    };
                });
                return { health, consoleCount: consoleMessages.length };
            }

            default:
                throw new Error(`Unknown command: ${command}`);
        }
    };
}
