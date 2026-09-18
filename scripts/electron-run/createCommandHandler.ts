import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    basename,
    join,
} from 'node:path';
import { mkdirSync } from 'node:fs';
import {
    countBy,
    maxBy,
} from 'es-toolkit/array';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import {
    COMMAND_EXECUTION_TIMEOUT_MS,
    OPEN_PDF_READY_TIMEOUT_MS,
    OPEN_PDF_TRIGGER_TIMEOUT_MS,
} from '@scripts/electron-run/electronRunTimeouts';
import { screenshotDirPath } from '@scripts/electron-run/electronRunSessionPaths';
import type {
    ISessionState,
    TDevtoolsEvent,
} from '@scripts/electron-run/electronRunSessionTypes';
import type { TElectronRunCommand } from '@scripts/electron-run/electronRunProtocol';

const DEFAULT_CONSOLE_LIMIT = 50;
const DEFAULT_DEVTOOLS_LIMIT = 120;
const DEFAULT_SCREENSHOT_INTERVAL_MS = 1000;
const DEFAULT_SCREENSHOT_COUNT = 5;
const TRUTHY_BOOLEAN_TOKENS = [
    '1',
    'true',
    'yes',
    'y',
    'on',
    'full',
] as const;
const FALSY_BOOLEAN_TOKENS = [
    '0',
    'false',
    'no',
    'n',
    'off',
] as const;
type TTruthyBooleanToken = typeof TRUTHY_BOOLEAN_TOKENS[number];
type TFalsyBooleanToken = typeof FALSY_BOOLEAN_TOKENS[number];
type TRunCommandFunction = (
    page: Page,
    screenshot: (name: string) => Promise<string>,
    sleep: (ms: number) => Promise<void>,
    wait: (ms: number) => Promise<void>,
) => Promise<unknown>;

interface IElectronRunClickCaptureWindow extends Window {
    __electronRunClickCaptureListener?: EventListener;
    __electronRunLastClickEvent?: unknown;
}

interface IElectronRunOpenPdfTrigger {
    token?: string;
    status?: 'pending' | 'resolved' | 'rejected';
    error?: string | null;
}

interface IElectronRunOpenPdfWindow extends Window {__electronRunOpenPdfTrigger?: IElectronRunOpenPdfTrigger;}

const DEVTOOLS_SECTION_VALUES = [
    'summary',
    'console',
    'network',
    'errors',
    'metrics',
    'all',
] as const;
type TDevtoolsSection = typeof DEVTOOLS_SECTION_VALUES[number];
const DEVTOOLS_EVENT_SUMMARY_TEMPLATE: Record<TDevtoolsEvent['kind'], number> = {
    console: 0,
    request: 0,
    response: 0,
    requestfailed: 0,
    pageerror: 0,
    error: 0,
};

function isTruthyBooleanToken(value: string): value is TTruthyBooleanToken {
    return (TRUTHY_BOOLEAN_TOKENS as readonly string[]).includes(value);
}

function isFalsyBooleanToken(value: string): value is TFalsyBooleanToken {
    return (FALSY_BOOLEAN_TOKENS as readonly string[]).includes(value);
}

function sanitizeSnapshotName(name: string) {
    return name
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100) || `screenshot-${Date.now()}`;
}

function parsePositiveInt(value: unknown, fallback: number, max: number) {
    const input = typeof value === 'string' || typeof value === 'number' ? value : '';
    const parsed = Number.parseInt(String(input), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(parsed, max);
}

function parseNonNegativeInt(value: unknown, fallback: number, max: number) {
    const input = typeof value === 'string' || typeof value === 'number' ? value : '';
    const parsed = Number.parseInt(String(input), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }
    return Math.min(parsed, max);
}

function parseBooleanArg(value: unknown, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value !== 'string') {
        return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (isTruthyBooleanToken(normalized)) {
        return true;
    }
    if (isFalsyBooleanToken(normalized)) {
        return false;
    }
    return fallback;
}

function normalizeEventLimit(value: unknown, fallback: number) {
    return parsePositiveInt(value, fallback, 2000);
}

function getDevtoolsSummary(events: readonly TDevtoolsEvent[]) {
    return {
        ...DEVTOOLS_EVENT_SUMMARY_TEMPLATE,
        ...countBy(events, event => event.kind),
    };
}

function parseStringArg(args: readonly unknown[], index: number) {
    const value = args[index];
    if (typeof value !== 'string') {
        return null;
    }
    return value;
}

function parseRequiredStringArg(args: readonly unknown[], index: number, errorMessage: string) {
    const value = parseStringArg(args, index);
    if (!value) {
        throw new Error(errorMessage);
    }
    return value;
}

function parseDevtoolsSection(value: unknown) {
    if (typeof value === 'undefined') {
        return 'summary';
    }
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.toLowerCase();
    if (isDevtoolsSection(normalized)) {
        return normalized;
    }
    return null;
}

function isDevtoolsSection(value: string): value is TDevtoolsSection {
    return (DEVTOOLS_SECTION_VALUES as readonly string[]).includes(value);
}

type TTakeScreenshot = (name: string, fullPage?: boolean) => Promise<string>;

interface ICommandContext {
    sessionState: ISessionState;
    takeScreenshot: TTakeScreenshot;
}

type TSessionCommandHandler = (context: ICommandContext, args: unknown[]) => Promise<unknown> | unknown;

interface IViewerComponentSnapshot {
    exposed?: IViewerComponentExposed | null;
    setupState: IViewerSetupState;
}

interface IViewerVueComponent {
    exposed?: IViewerComponentExposed | null;
    setupState?: IViewerSetupState;
}

interface IViewerComponentExposed {getCurrentPage?: () => number;}

interface IViewerSetupState {
    numPages?: number;
    currentPage?: number;
    isLoading?: boolean;
    workingCopyPath?: string | null;
    activeDocumentRecord?: {tab?: {originalPath?: string | null;} | null;} | null;
}

async function installPageEvaluationShims(page: Page) {
    const source = 'window.__name = window.__name || ((fn) => fn);';
    await page.evaluateOnNewDocument(source);
    await page.evaluate(source);
}

function isErrorDevtoolsEvent(event: TDevtoolsEvent) {
    if (event.kind === 'error' || event.kind === 'pageerror' || event.kind === 'requestfailed') {
        return true;
    }
    if (event.kind === 'console') {
        return event.level === 'error' || event.level === 'warn';
    }
    if (event.kind === 'response') {
        return typeof event.status === 'number' && event.status >= 400;
    }
    return false;
}

async function handleDevtoolsCommand(context: ICommandContext, args: unknown[]) {
    const {
        page,
        devtoolsEvents,
    } = context.sessionState;
    const section = parseDevtoolsSection(args[0]);
    if (!section) {
        throw new Error('Unknown devtools section. Use summary|console|network|errors|metrics|all');
    }
    const limit = normalizeEventLimit(args[1], DEFAULT_DEVTOOLS_LIMIT);
    const events = devtoolsEvents.slice(-limit);

    if (section === 'summary') {
        return {
            section,
            limit,
            totalEvents: devtoolsEvents.length,
            recentEvents: events,
            counts: getDevtoolsSummary(devtoolsEvents),
        };
    }
    if (section === 'console') {
        return {
            section,
            limit,
            events: events.filter(event => event.kind === 'console'),
        };
    }
    if (section === 'network') {
        return {
            section,
            limit,
            events: events.filter(event => event.kind === 'request' || event.kind === 'response' || event.kind === 'requestfailed'),
        };
    }
    if (section === 'errors') {
        return {
            section,
            limit,
            events: events.filter(isErrorDevtoolsEvent),
        };
    }

    const metrics = await page.metrics();
    if (section === 'metrics') {
        return {
            section,
            metrics,
            viewport: page.viewport(),
            url: page.url(),
        };
    }
    return {
        section,
        limit,
        events,
        counts: getDevtoolsSummary(devtoolsEvents),
        metrics,
        viewport: page.viewport(),
        url: page.url(),
    };
}

function commandTimeout(command: string) {
    return delay(COMMAND_EXECUTION_TIMEOUT_MS).then(() => {
        throw new Error(`${command} command timed out after ${Math.round(COMMAND_EXECUTION_TIMEOUT_MS / 1000)}s`);
    });
}

function createSleepFn() {
    return async (ms: number) => {
        const duration = Number.isFinite(ms) ? Math.max(0, ms) : 0;
        await delay(duration);
    };
}

async function handleRunCommand(context: ICommandContext, args: unknown[]) {
    const code = parseRequiredStringArg(args, 0, 'No code provided');
    const asyncFn = new Function(
        'page', 'screenshot', 'sleep', 'wait',
        `return (async () => { ${code} })()`,
    ) as TRunCommandFunction;
    const sleepFn = createSleepFn();

    return Promise.race<unknown>([
        asyncFn(context.sessionState.page, (name: string) => context.takeScreenshot(name, false), sleepFn, sleepFn),
        commandTimeout('run'),
    ]);
}

async function handleClickCommand(context: ICommandContext, args: unknown[]) {
    const { page } = context.sessionState;
    const selector = parseRequiredStringArg(args, 0, 'No selector provided');
    const timeoutMs = parsePositiveInt(args[1], 8_000, 120_000);
    const targetInfo = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) {
            return null;
        }
        const className = typeof el.className === 'string'
            ? el.className
            : ((el.className as SVGAnimatedString | undefined)?.baseVal ?? '');
        const rect = el.getBoundingClientRect();
        return {
            tagName: el.tagName.toLowerCase(),
            id: el.id || null,
            className: className || null,
            text: el.textContent.trim().slice(0, 200),
            rect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            },
        };
    }, selector);

    if (!targetInfo) {
        throw new Error(`Selector not found: ${selector}`);
    }

    await page.evaluate(() => {
        const automationWindow = window as IElectronRunClickCaptureWindow;
        automationWindow.__electronRunLastClickEvent = null;
        const previousListener = automationWindow.__electronRunClickCaptureListener;
        if (previousListener) {
            window.removeEventListener('click', previousListener, true);
        }
        automationWindow.__electronRunClickCaptureListener = function (event: Event) {
            if (!(event instanceof MouseEvent)) {
                return;
            }
            const target = event.target as HTMLElement | null;
            const path = typeof event.composedPath === 'function'
                ? event.composedPath().slice(0, 8).map((node) => {
                    if (!(node instanceof Element)) {
                        return '<non-element>';
                    }
                    const id = node.id ? `#${node.id}` : '';
                    const className = typeof node.className === 'string' && node.className.trim().length > 0
                        ? `.${node.className.trim().replace(/\s+/g, '.')}`
                        : '';
                    return `${node.tagName.toLowerCase()}${id}${className}`;
                })
                : [];
            automationWindow.__electronRunLastClickEvent = {
                type: event.type,
                button: event.button,
                buttons: event.buttons,
                detail: event.detail,
                clientX: event.clientX,
                clientY: event.clientY,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                target: target
                    ? {
                        tagName: target.tagName.toLowerCase(),
                        id: target.id || null,
                        className: (
                            typeof target.className === 'string'
                                ? target.className
                                : ((target.className as SVGAnimatedString | undefined)?.baseVal ?? '')
                        ) || null,
                        text: target.textContent.trim().slice(0, 200),
                    }
                    : null,
                path,
                timestamp: Date.now(),
            };
        };
        window.addEventListener('click', automationWindow.__electronRunClickCaptureListener, {
            capture: true,
            once: true,
        });
    });

    await page.waitForSelector(selector, { timeout: timeoutMs });
    await page.click(selector);
    await delay(40);

    return {
        clicked: selector,
        target: targetInfo,
        event: await page.evaluate(() => {
            const automationWindow = window as IElectronRunClickCaptureWindow;
            return automationWindow.__electronRunLastClickEvent ?? null;
        }),
    };
}

async function handleOpenPdfCommand(context: ICommandContext, args: unknown[]) {
    const { page } = context.sessionState;
    const pdfPath = parseRequiredStringArg(args, 0, 'PDF path required');
    const requestedBasename = basename(pdfPath).toLowerCase();
    await installPageEvaluationShims(page);
    interface IViewerSnapshot {
        viewerIndex: number;
        isVisible: boolean;
        documentPath: string | null;
        numPages: number | null;
        currentPage: number | null;
        isLoading: boolean | null;
        workingCopyPath: string | null;
        renderedPageContainers: number;
        renderedCanvasCount: number;
        renderedTextSpanCount: number;
        visibleSkeletonCount: number;
        visibleLoadingCount: number;
        visibleErrorCount: number;
    }
    interface IOpenPdfState {
        numPages: number | null;
        currentPage: number | null;
        isLoading: boolean | null;
        workingCopyPath: string | null;
        renderedPageContainers: number;
        renderedCanvasCount: number;
        renderedTextSpanCount: number;
        visibleSkeletonCount: number;
        visibleLoadingCount: number;
        visibleErrorCount: number;
        hasViewer: boolean;
        hasEmptyState: boolean;
        viewerIndex: number | null;
        viewerCount: number;
        visibleViewerCount: number;
        matchingViewerCount: number;
        viewers: IViewerSnapshot[];
        openTrigger?: {
            token: string;
            status: 'pending' | 'resolved' | 'rejected';
            error: string | null;
        } | null;
    }

    const isRequestedDocumentLoaded = (documentPath: string | null | undefined) => {
        if (!documentPath) {
            return false;
        }
        return basename(documentPath).toLowerCase() === requestedBasename;
    };
    const isViewerReady = (viewer: Pick<IViewerSnapshot, 'numPages' | 'isLoading' | 'renderedPageContainers' | 'renderedCanvasCount' | 'renderedTextSpanCount'>) => {
        const hasPages = (viewer.numPages ?? 0) > 0 || viewer.renderedPageContainers > 0;
        const notLoading = viewer.isLoading === false || viewer.isLoading === null;
        const hasRenderedContent = viewer.renderedCanvasCount > 0 || viewer.renderedTextSpanCount > 0;
        return hasPages && notLoading && hasRenderedContent;
    };
    const scoreReadyViewer = (viewer: Pick<IViewerSnapshot, 'isVisible' | 'viewerIndex'>) => (
        (viewer.isVisible ? 10_000 : 0) + viewer.viewerIndex
    );
    const findRequestedReadyViewer = (state: IOpenPdfState) => {
        return maxBy(
            state.viewers.filter(viewer => (
                isRequestedDocumentLoaded(viewer.documentPath)
                            && isViewerReady(viewer)
            )),
            scoreReadyViewer,
        ) ?? null;
    };

    const readViewerState = (token?: string) => page.evaluate((requestedPathBasename: string, requestedToken?: string) => {
        const hosts = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer'));
        const isElementVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
                return false;
            }

            let current: HTMLElement | null = element;
            while (current) {
                const style = window.getComputedStyle(current);
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                    return false;
                }
                current = current.parentElement;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const viewers = hosts.map((host, viewerIndex) => {
            const resolveDocumentPath = () => {
                let current: HTMLElement | null = host;
                while (current) {
                    const component = (current as HTMLElement & {__vueParentComponent?: IViewerVueComponent})
                        .__vueParentComponent;
                    const originalPath = component?.setupState?.activeDocumentRecord?.tab?.originalPath;
                    if (typeof originalPath === 'string' && originalPath.length > 0) {
                        return originalPath;
                    }
                    current = current.parentElement;
                }
                return null;
            };
            const resolveViewerComponent = (): IViewerComponentSnapshot | null => {
                let current: HTMLElement | null = host;
                while (current) {
                    const component = (current as HTMLElement & {__vueParentComponent?: IViewerVueComponent})
                        .__vueParentComponent;
                    const setupState = component?.setupState;
                    if (
                        setupState
                        && (
                            'numPages' in setupState
                            || 'currentPage' in setupState
                            || 'workingCopyPath' in setupState
                        )
                    ) {
                        return {
                            exposed: component.exposed ?? null,
                            setupState,
                        };
                    }
                    current = current.parentElement;
                }
                return null;
            };
            const component = resolveViewerComponent();
            const setupState = component?.setupState ?? null;
            const exposed = component?.exposed ?? null;
            const pageContainers = host.querySelectorAll('.page_container');
            const visibleLoadingCount = Array.from(host.querySelectorAll([
                '.pdf-loading',
                '.pdf-loading-overlay',
                '.loading',
                '[data-loading="true"]',
                '[aria-busy="true"]',
            ].join(',')))
                .filter(node => isElementVisible(node as HTMLElement))
                .length;
            const visibleErrorCount = Array.from(host.querySelectorAll([
                '.pdf-error',
                '.error-state',
                '.viewer-error',
                '[role="alert"]',
                '[data-error="true"]',
            ].join(',')))
                .filter(node => isElementVisible(node as HTMLElement))
                .length;
            return {
                viewerIndex,
                isVisible: isElementVisible(host),
                documentPath: resolveDocumentPath() ?? setupState?.workingCopyPath ?? null,
                numPages: setupState?.numPages ?? null,
                currentPage: setupState?.currentPage ?? exposed?.getCurrentPage?.() ?? null,
                isLoading: setupState?.isLoading ?? null,
                workingCopyPath: setupState?.workingCopyPath ?? null,
                renderedPageContainers: pageContainers.length,
                renderedCanvasCount: host.querySelectorAll('.page_container .page_canvas canvas').length,
                renderedTextSpanCount: host.querySelectorAll('.page_container .text-layer span, .page_container .textLayer span').length,
                visibleSkeletonCount: Array.from(host.querySelectorAll('.page_container .document-page-skeleton'))
                    .filter(node => isElementVisible(node as HTMLElement))
                    .length,
                visibleLoadingCount,
                visibleErrorCount,
            };
        });
        const getPathBasename = (path: string | null) => {
            return (path ?? '')
                .replace(/\\/g, '/')
                .split('/')
                .pop()
                ?.toLowerCase() ?? '';
        };
        const scoreViewer = (viewer: typeof viewers[number]) => {
            let score = 0;
            if (requestedPathBasename && getPathBasename(viewer.documentPath) === requestedPathBasename) {
                score += 1_000_000;
            }
            if (viewer.isVisible) {
                score += 10_000;
            }
            if ((viewer.numPages ?? 0) > 0 || viewer.renderedPageContainers > 0) {
                score += 500;
            }
            if (viewer.renderedCanvasCount > 0 || viewer.renderedTextSpanCount > 0) {
                score += 250;
            }
            if (viewer.isLoading === false) {
                score += 100;
            }
            return score;
        };

        const selectedViewer = viewers.reduce<typeof viewers[number] | null>((best, viewer) => {
            if (!best) {
                return viewer;
            }
            return scoreViewer(viewer) > scoreViewer(best) ? viewer : best;
        }, null);

        const automationWindow = window as IElectronRunOpenPdfWindow;
        const trigger = automationWindow.__electronRunOpenPdfTrigger;
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
        const visibleEmptyStates = Array.from(document.querySelectorAll('.empty-state'))
            .filter(node => isElementVisible(node as HTMLElement));
        const selected = selectedViewer ?? {
            viewerIndex: -1,
            documentPath: null,
            numPages: null,
            currentPage: null,
            isLoading: null,
            workingCopyPath: null,
            renderedPageContainers: 0,
            renderedCanvasCount: 0,
            renderedTextSpanCount: 0,
            visibleSkeletonCount: 0,
            visibleLoadingCount: 0,
            visibleErrorCount: 0,
        };
        const matchingViewerCount = viewers.filter((viewer) => {
            return getPathBasename(viewer.documentPath) === requestedPathBasename;
        }).length;

        return {
            numPages: selected.numPages,
            currentPage: selected.currentPage,
            isLoading: selected.isLoading,
            workingCopyPath: selected.workingCopyPath,
            renderedPageContainers: selected.renderedPageContainers,
            renderedCanvasCount: selected.renderedCanvasCount,
            renderedTextSpanCount: selected.renderedTextSpanCount,
            visibleSkeletonCount: selected.visibleSkeletonCount,
            visibleLoadingCount: selected.visibleLoadingCount,
            visibleErrorCount: selected.visibleErrorCount,
            hasViewer: viewers.length > 0,
            hasEmptyState: visibleEmptyStates.length > 0,
            viewerIndex: selected.viewerIndex >= 0 ? selected.viewerIndex : null,
            viewerCount: viewers.length,
            visibleViewerCount: viewers.filter(viewer => viewer.isVisible).length,
            matchingViewerCount,
            viewers,
            openTrigger,
        } satisfies IOpenPdfState;
    }, requestedBasename, token);

    const beforeState = await readViewerState();
    const triggerToken = await page.evaluate((path: string, triggerTimeoutMs: number) => {
        type TElectronRunOpenPdfWindow = Window & {
            __allowRendererFileOpenForAutomation?: unknown;
            __electronRunOpenPdfTrigger?: IElectronRunOpenPdfTrigger;
            __openFileDirect?: unknown;
        };

        const automationWindow = window as TElectronRunOpenPdfWindow;
        const isPathHandler = (value: unknown): value is (path: string) => Promise<boolean> => typeof value === 'function';
        const token = `open-${crypto.randomUUID()}`;
        automationWindow.__electronRunOpenPdfTrigger = {
            token,
            status: 'pending',
            error: null,
        };

        const openFileDirect = automationWindow.__openFileDirect;
        if (!isPathHandler(openFileDirect)) {
            automationWindow.__electronRunOpenPdfTrigger = {
                token,
                status: 'rejected',
                error: 'window.__openFileDirect is not available',
            };
            return token;
        }

        Promise.resolve()
            .then(async () => {
                const allowRendererFileOpenForAutomation = automationWindow.__allowRendererFileOpenForAutomation;
                if (isPathHandler(allowRendererFileOpenForAutomation)) {
                    await allowRendererFileOpenForAutomation(path);
                }

                await Promise.race([
                    openFileDirect(path),
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('openFileDirect trigger timeout')), triggerTimeoutMs);
                    }),
                ]);
                automationWindow.__electronRunOpenPdfTrigger = {
                    token,
                    status: 'resolved',
                    error: null,
                };
            })
            .catch((error: unknown) => {
                const message = getErrorMessage(error);
                automationWindow.__electronRunOpenPdfTrigger = {
                    token,
                    status: 'rejected',
                    error: message,
                };
            });

        return token;
    }, pdfPath, OPEN_PDF_TRIGGER_TIMEOUT_MS);

    const start = Date.now();
    let lastState: IOpenPdfState = beforeState;
    while (Date.now() - start < OPEN_PDF_READY_TIMEOUT_MS) {
        lastState = await readViewerState(triggerToken);

        if (lastState.openTrigger?.status === 'rejected') {
            const triggerError = lastState.openTrigger.error;
            throw new Error(triggerError && triggerError.length > 0 ? triggerError : 'openPdf failed');
        }

        if (findRequestedReadyViewer(lastState)) {
            await delay(250);
            break;
        }

        await delay(250);
    }

    const state = await readViewerState();
    const readyViewer = findRequestedReadyViewer(state);
    if (!readyViewer) {
        const loadedPaths = state.viewers
            .map(viewer => `${viewer.viewerIndex}:${viewer.documentPath ?? '<none>'}${viewer.isVisible ? ':visible' : ''}`)
            .join(', ');
        throw new Error(`openPdf readiness timeout for ${pdfPath} (viewer paths: ${loadedPaths || '<none>'})`);
    }

    const normalizedState: IOpenPdfState = {
        ...state,
        numPages: readyViewer.numPages,
        currentPage: readyViewer.currentPage,
        isLoading: readyViewer.isLoading,
        workingCopyPath: readyViewer.workingCopyPath,
        renderedPageContainers: readyViewer.renderedPageContainers,
        renderedCanvasCount: readyViewer.renderedCanvasCount,
        renderedTextSpanCount: readyViewer.renderedTextSpanCount,
        visibleSkeletonCount: readyViewer.visibleSkeletonCount,
        visibleLoadingCount: readyViewer.visibleLoadingCount,
        visibleErrorCount: readyViewer.visibleErrorCount,
        viewerIndex: readyViewer.viewerIndex,
    };

    return {
        opened: pdfPath,
        state: normalizedState,
    };
}

async function handleHealthCommand(context: ICommandContext) {
    const {
        page,
        consoleMessages,
        devtoolsEvents,
    } = context.sessionState;
    const health = await page.evaluate(() => {
        const automationWindow = window as Window & {
            __openFileDirect?: unknown;
            electronAPI?: unknown;
        };
        const nuxtRoot = document.querySelector('#__nuxt');
        // lib.dom declares document.body non-null, but this probe runs while the
        // renderer may still be parsing, so query for the element instead.
        const body = document.querySelector('body');
        return {
            nuxtRootChildren: nuxtRoot?.children.length ?? 0,
            openFileDirect: typeof automationWindow.__openFileDirect,
            electronAPI: typeof automationWindow.electronAPI,
            bodyTextLength: body === null ? 0 : body.innerText.trim().length,
            title: document.title,
            url: window.location.href,
        };
    });
    const ready = health.openFileDirect === 'function'
        && health.electronAPI === 'object'
        && health.nuxtRootChildren > 0;
    return {
        ready,
        health,
        consoleCount: consoleMessages.length,
        devtoolsEventCount: devtoolsEvents.length,
    };
}

const COMMAND_HANDLERS: Record<Exclude<TElectronRunCommand, 'recording'>, TSessionCommandHandler> = {
    ping() {
        return {
            status: 'ok',
            uptime: process.uptime(),
        };
    },
    async screenshot(context, args) {
        const name = parseStringArg(args, 0) ?? `screenshot-${Date.now()}`;
        const fullPage = parseBooleanArg(args[1]);
        return {
            screenshot: await context.takeScreenshot(name, fullPage),
            fullPage,
        };
    },
    async screenshots(context, args) {
        const baseName = sanitizeSnapshotName(parseStringArg(args, 0) ?? `timelapse-${Date.now()}`);
        const count = parsePositiveInt(args[1], DEFAULT_SCREENSHOT_COUNT, 240);
        const intervalMs = parseNonNegativeInt(args[2], DEFAULT_SCREENSHOT_INTERVAL_MS, 60_000);
        const fullPage = parseBooleanArg(args[3]);
        const captures: Array<{
            index: number;
            path: string;
            timestamp: number
        }> = [];

        for (let index = 0; index < count; index += 1) {
            const ordinal = String(index + 1).padStart(3, '0');
            captures.push({
                index: index + 1,
                path: await context.takeScreenshot(`${baseName}-${ordinal}`, fullPage),
                timestamp: Date.now(),
            });
            if (index < count - 1 && intervalMs > 0) {
                await delay(intervalMs);
            }
        }

        return {
            captures,
            count,
            intervalMs,
            fullPage,
        };
    },
    console(context, args) {
        const level = parseStringArg(args, 0) ?? 'all';
        const limit = normalizeEventLimit(args[1], DEFAULT_CONSOLE_LIMIT);
        const messages = context.sessionState.consoleMessages;
        const filtered = level === 'all'
            ? messages
            : messages.filter((message) => message.type === level);
        return {
            level,
            limit,
            messages: filtered.slice(-limit),
        };
    },
    devtools: handleDevtoolsCommand,
    run: handleRunCommand,
    eval(context, args) {
        const code = parseRequiredStringArg(args, 0, 'No code provided');
        return Promise.race([
            context.sessionState.page.evaluate(code),
            commandTimeout('eval'),
        ]);
    },
    click: handleClickCommand,
    async type(context, args) {
        const selector = parseRequiredStringArg(args, 0, 'Selector and text required');
        const text = parseRequiredStringArg(args, 1, 'Selector and text required');
        await context.sessionState.page.type(selector, text);
        return {
            typed: text,
            into: selector,
        };
    },
    async content(context, args) {
        const selector = parseRequiredStringArg(args, 0, 'No selector provided');
        const el = await context.sessionState.page.$(selector);
        return el ? el.evaluate(element => element.textContent) : null;
    },
    async waitfor(context, args) {
        const selector = parseRequiredStringArg(args, 0, 'No selector provided');
        const timeoutMs = parsePositiveInt(args[1], 10_000, 300_000);
        await context.sessionState.page.waitForSelector(selector, { timeout: timeoutMs });
        return {
            selector,
            found: true,
            timeoutMs,
        };
    },
    async resize(context, args) {
        const width = parsePositiveInt(args[0], 0, 10_000);
        const height = parsePositiveInt(args[1], 0, 10_000);
        if (!width || !height) {
            throw new Error('Width and height required');
        }
        await context.sessionState.page.setViewport({
            width,
            height,
        });
        return {
            resized: {
                width,
                height,
            },
            viewport: context.sessionState.page.viewport(),
        };
    },
    async viewport(context) {
        const { page } = context.sessionState;
        const viewport = page.viewport();
        if (viewport) {
            return {
                viewport,
                source: 'puppeteer',
            };
        }

        return {
            viewport: null,
            source: 'window',
            dimensions: await page.evaluate(() => ({
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                outerWidth: window.outerWidth,
                outerHeight: window.outerHeight,
                devicePixelRatio: window.devicePixelRatio,
            })),
        };
    },
    openPdf: handleOpenPdfCommand,
    health: handleHealthCommand,
    shutdown() {
        throw new Error('Shutdown must be handled by the Electron session controller');
    },
};

function createCommandContext(sessionState: ISessionState): ICommandContext {
    const ssDirPath = screenshotDirPath();
    return {
        sessionState,
        async takeScreenshot(name: string, fullPage = false) {
            mkdirSync(ssDirPath, { recursive: true });
            const filepath = join(ssDirPath, `${sanitizeSnapshotName(name)}.png`);
            await sessionState.page.screenshot({
                path: filepath,
                fullPage,
            });
            return filepath;
        },
    };
}

export function createCommandHandler(getSessionState: () => ISessionState | null) {
    return async function handleCommand(command: TElectronRunCommand, args: unknown[]) {
        const sessionState = getSessionState();
        if (!sessionState) {
            throw new Error('Session not initialized');
        }
        if (command === 'recording') {
            if (args[0] === 'mark' && typeof args[1] === 'string') {
                sessionState.recording?.mark(args[1]);
            }
            return sessionState.recording?.manifest ?? {status: 'disabled'};
        }
        const execute = () => Promise.resolve(COMMAND_HANDLERS[command](createCommandContext(sessionState), args));
        return sessionState.recording
            ? sessionState.recording.command(command, args, execute)
            : execute();
    };
}
