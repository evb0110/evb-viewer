import { join } from 'node:path';
import {
    mkdirSync,
    realpathSync,
} from 'node:fs';
import { countBy } from 'es-toolkit/array';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import {
    COMMAND_EXECUTION_TIMEOUT_MS,
    OPEN_PDF_READY_TIMEOUT_MS,
    OPEN_PDF_TRIGGER_TIMEOUT_MS,
} from '@scripts/electron-run/electronRunTimeouts';
import { resizeElectronWindowContentArea } from '@scripts/electron-run/resizeElectronWindow';
import { activateElectronMenuItem } from '@scripts/electron-run/activateElectronMenuItem';
import type { TApplicationMenuItemQuery } from '@electron/menu';
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
const WINDOW_RESIZE_SETTLE_TIMEOUT_MS = 10_000;
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

function parseWindowSizeArgs(args: unknown[]) {
    const width = parsePositiveInt(args[0], 0, 10_000);
    const height = parsePositiveInt(args[1], 0, 10_000);
    if (!width || !height) {
        throw new Error('Width and height required');
    }
    return {
        width,
        height,
    };
}

function parseMenuItemQueryArgs(args: unknown[]): TApplicationMenuItemQuery {
    const value = parseRequiredStringArg(args, 1, 'Usage: activateMenuItem id|accelerator <value>');
    if (args[0] === 'id') {
        return {id: value};
    }
    if (args[0] === 'accelerator') {
        return {accelerator: value};
    }
    throw new Error('Usage: activateMenuItem id|accelerator <value>');
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

interface IOpenPdfState {
    /** The active workspace, as the app's automation API reports it. */
    activeDocument: {
        originalPath: string | null;
        workingCopyPath: string | null;
        numPages: number;
        currentPage: number;
        hasPdf: boolean;
        hasOpenError: boolean;
    } | null;
    /** Pages of the active viewer whose canvas is painted and on screen. */
    paintedPageCount: number;
    openTrigger: Required<IElectronRunOpenPdfTrigger> | null;
}

function normalizeDocumentPath(path: string) {
    return path.replace(/\\/gu, '/').toLowerCase();
}

function resolveRealPath(path: string) {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

// Reads the open from the app's automation API and the painted page canvases,
// never from framework internals. The function runs in the page from its
// source text, so it uses page globals only.
function readOpenPdfState(page: Page, triggerToken: string) {
    return page.evaluate((requestedToken: string): IOpenPdfState => {
        const automationWindow = window as IElectronRunOpenPdfWindow;
        const trigger = automationWindow.__electronRunOpenPdfTrigger;
        const openTrigger = trigger?.token === requestedToken
            ? {
                token: trigger.token,
                status: trigger.status ?? 'pending',
                error: trigger.error ?? null,
            }
            : null;

        const api = automationWindow.__evbTestApi;
        const toolbar = api?.getActiveToolbarSnapshot?.() ?? null;
        const workspace = api?.readActiveWorkspaceStateValues?.([
            'originalPath',
            'workingCopyPath',
            'totalPages',
        ]) ?? null;

        const isShown = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const shownViewers = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer')).filter(isShown);
        const activeViewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer');
        const viewer = activeViewer && shownViewers.includes(activeViewer)
            ? activeViewer
            : (shownViewers.length === 1 ? shownViewers[0] ?? null : null);
        const viewerRect = viewer?.getBoundingClientRect() ?? null;
        const paintedPageCount = viewer && viewerRect
            ? Array.from(viewer.querySelectorAll<HTMLElement>('.page_container--rendered')).filter((pageElement) => {
                const pageRect = pageElement.getBoundingClientRect();
                const visibleHeight = Math.min(pageRect.bottom, viewerRect.bottom) - Math.max(pageRect.top, viewerRect.top);
                const canvas = pageElement.querySelector('canvas');
                return visibleHeight > 8 && pageRect.width > 0 && Boolean(canvas && canvas.width > 0 && canvas.height > 0);
            }).length
            : 0;

        const workspacePages = workspace?.totalPages;
        return {
            activeDocument: toolbar && workspace
                ? {
                    originalPath: typeof workspace.originalPath === 'string' ? workspace.originalPath : null,
                    workingCopyPath: typeof workspace.workingCopyPath === 'string' ? workspace.workingCopyPath : null,
                    numPages: typeof workspacePages === 'number' && workspacePages > 0 ? workspacePages : toolbar.totalPages,
                    currentPage: toolbar.currentPage,
                    hasPdf: toolbar.hasPdf,
                    hasOpenError: toolbar.hasOpenError,
                }
                : null,
            paintedPageCount,
            openTrigger,
        };
    }, triggerToken);
}

function describeOpenPdfState(state: IOpenPdfState) {
    const active = state.activeDocument;
    return active
        ? `active document ${active.originalPath ?? '<none>'}, ${active.numPages} pages, ${state.paintedPageCount} painted, open ${state.openTrigger?.status ?? 'unknown'}`
        : '__evbTestApi reports no active workspace';
}

async function handleOpenPdfCommand(context: ICommandContext, args: unknown[]) {
    const { page } = context.sessionState;
    const pdfPath = parseRequiredStringArg(args, 0, 'PDF path required');
    const requestedPaths = new Set([
        pdfPath,
        resolveRealPath(pdfPath),
    ].map(normalizeDocumentPath));
    await installPageEvaluationShims(page);

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

                const opened = await Promise.race([
                    openFileDirect(path),
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('openFileDirect trigger timeout')), triggerTimeoutMs);
                    }),
                ]);
                // The renderer answers false when it refuses or fails the open,
                // and logs the reason to its console.
                automationWindow.__electronRunOpenPdfTrigger = opened === false
                    ? {
                        token,
                        status: 'rejected',
                        error: `The renderer did not open ${path}; its console errors say why (electron:run console error)`,
                    }
                    : {
                        token,
                        status: 'resolved',
                        error: null,
                    };
            })
            .catch((error: unknown) => {
                // This function runs in the page, where none of this module's
                // imports exist, so the message is read here directly. An error
                // from another world (the preload bridge) is not instanceof the
                // page's Error, so its message is read by shape.
                const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined;
                automationWindow.__electronRunOpenPdfTrigger = {
                    token,
                    status: 'rejected',
                    error: typeof message === 'string' ? message : String(error),
                };
            });

        return token;
    }, pdfPath, OPEN_PDF_TRIGGER_TIMEOUT_MS);

    // The open call has to finish first: before it does, the active tab can
    // still be an earlier tab that shows the same file.
    const isRequestedDocument = (state: IOpenPdfState) => state.openTrigger?.status === 'resolved'
        && state.activeDocument?.originalPath != null
        && requestedPaths.has(normalizeDocumentPath(state.activeDocument.originalPath));
    const startedAt = Date.now();
    let state = await readOpenPdfState(page, triggerToken);
    while (!(
        isRequestedDocument(state)
        && state.activeDocument?.hasPdf === true
        && state.activeDocument.numPages > 0
        && state.paintedPageCount > 0
    )) {
        if (state.openTrigger?.status === 'rejected') {
            const triggerError = state.openTrigger.error;
            throw new Error(triggerError !== null && triggerError.length > 0 ? triggerError : 'openPdf failed');
        }
        if (isRequestedDocument(state) && state.activeDocument?.hasOpenError === true) {
            throw new Error(`The renderer opened ${pdfPath} with an open error`);
        }
        if (Date.now() - startedAt >= OPEN_PDF_READY_TIMEOUT_MS) {
            throw new Error(`openPdf readiness timeout for ${pdfPath} (${describeOpenPdfState(state)})`);
        }
        await delay(100);
        state = await readOpenPdfState(page, triggerToken);
    }

    return {
        opened: pdfPath,
        state: {
            ...state.activeDocument,
            paintedPageCount: state.paintedPageCount,
        },
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
    async windowResize(context, args) {
        const size = parseWindowSizeArgs(args);
        const result = await resizeElectronWindowContentArea(
            context.sessionState.page,
            size,
            parsePositiveInt(args[2], WINDOW_RESIZE_SETTLE_TIMEOUT_MS, 120_000),
        );
        if (!result.settled) {
            throw new Error(
                `The window content area did not reach ${String(size.width)}x${String(size.height)}; `
                + `it settled at ${String(result.after.contentSize.width)}x${String(result.after.contentSize.height)}. `
                + 'Either the display is too small for that window plus its frame '
                + '(on Linux see EVB_XVFB_SCREEN), or an active viewport emulation overrides the reported size.',
            );
        }
        return result;
    },
    activateMenuItem(context, args) {
        return activateElectronMenuItem(context.sessionState.page, parseMenuItemQueryArgs(args));
    },
    async emulateViewport(context, args) {
        const size = parseWindowSizeArgs(args);
        await context.sessionState.page.setViewport(size);
        return {
            emulated: size,
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
