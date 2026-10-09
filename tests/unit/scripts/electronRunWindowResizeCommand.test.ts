import {
    createContext,
    runInContext,
} from 'node:vm';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Page } from 'puppeteer-core';
import { createCommandHandler } from '@scripts/electron-run/createCommandHandler';
import {
    isElectronRunCommand,
    parseElectronRunCommandRequest,
} from '@scripts/electron-run/electronRunProtocol';
import type { ISessionState } from '@scripts/electron-run/electronRunSessionTypes';
import { cast } from '@tests/helpers/cast';

// The window a person resizes is the native one. These cases keep the two
// commands apart: `windowResize` must move the native window through its own
// frame arithmetic, and `emulateViewport` must never touch it.

interface INativeWindowModel {
    contentWidth: number;
    contentHeight: number;
    frameWidth: number;
    frameHeight: number;
    minimumContentWidth: number;
    /** A maximized window keeps the window manager's size whatever it is asked. */
    maximized: boolean;
    /** Whether the window manager honors leaving maximized. */
    honorsRestore: boolean;
    normalContentWidth: number;
    normalContentHeight: number;
    resizeRequests: Array<{
        width: number;
        height: number;
    }>;
}

function createNativeWindowModel(overrides: Partial<INativeWindowModel> = {}): INativeWindowModel {
    return {
        contentWidth: 900,
        contentHeight: 668,
        frameWidth: 0,
        frameHeight: 32,
        minimumContentWidth: 0,
        maximized: false,
        honorsRestore: true,
        normalContentWidth: 1024,
        normalContentHeight: 700,
        resizeRequests: [],
        ...overrides,
    };
}

function stubRendererWindow(model: INativeWindowModel) {
    vi.stubGlobal('window', {
        get innerWidth() {
            return model.contentWidth;
        },
        get innerHeight() {
            return model.contentHeight;
        },
        get outerWidth() {
            return model.contentWidth + model.frameWidth;
        },
        get outerHeight() {
            return model.contentHeight + model.frameHeight;
        },
        devicePixelRatio: 2,
        electronAPI: {host: {restoreNormalWindow() {
            if (model.maximized && model.honorsRestore) {
                model.maximized = false;
                model.contentWidth = model.normalContentWidth;
                model.contentHeight = model.normalContentHeight;
            }
            return Promise.resolve({
                fullScreen: false,
                maximized: model.maximized,
                supported: true,
            });
        }}},
        resizeTo(width: number, height: number) {
            model.resizeRequests.push({
                width,
                height,
            });
            if (model.maximized) {
                return;
            }
            model.contentWidth = Math.max(model.minimumContentWidth, width - model.frameWidth);
            model.contentHeight = height - model.frameHeight;
        },
    });
}

function createHandlerForModel(model: INativeWindowModel) {
    stubRendererWindow(model);
    const setViewport = vi.fn();
    const viewport = vi.fn(() => null);
    const page = cast<Page>({
        evaluate: <TArgs extends unknown[], TResult>(
            pageFunction: (...args: TArgs) => TResult,
            ...args: TArgs
        ) => Promise.resolve(pageFunction(...args)),
        setViewport,
        viewport,
    });
    const sessionState = cast<ISessionState>({page});
    return {
        handleCommand: createCommandHandler(() => sessionState),
        setViewport,
    };
}

describe('electron run window resize command', () => {
    it('accepts the two size commands and no longer accepts the ambiguous name', () => {
        expect(isElectronRunCommand('windowResize')).toBe(true);
        expect(isElectronRunCommand('emulateViewport')).toBe(true);
        expect(isElectronRunCommand('resize')).toBe(false);
        expect(parseElectronRunCommandRequest({
            command: 'windowResize',
            args: [
                640,
                480,
            ],
        })).toEqual({
            command: 'windowResize',
            args: [
                640,
                480,
            ],
        });
    });

    it('resizes the native window so the content area gets the requested size', async () => {
        const model = createNativeWindowModel();
        const {handleCommand} = createHandlerForModel(model);

        const result = await handleCommand('windowResize', [
            '640',
            '480',
        ]) as {
            after: {contentSize: {
                width: number;
                height: number;
            };};
            before: {contentSize: {width: number;};};
            settled: boolean;
        };

        // The request names the whole window, so the frame has to be added
        // back or the document would lose the frame's worth of layout.
        expect(model.resizeRequests).toEqual([{
            width: 640,
            height: 512,
        }]);
        expect(result.before.contentSize.width).toBe(900);
        expect(result.after.contentSize).toEqual({
            width: 640,
            height: 480,
        });
        expect(result.settled).toBe(true);
    });

    it('leaves maximized first so the requested size is the one the window keeps', async () => {
        const model = createNativeWindowModel({
            contentWidth: 1280,
            contentHeight: 692,
            maximized: true,
        });
        const {handleCommand} = createHandlerForModel(model);

        const result = await handleCommand('windowResize', [
            '900',
            '672',
        ]) as {windowState: {maximized: boolean;};};

        expect(result.windowState.maximized).toBe(false);
        expect(model.maximized).toBe(false);
        expect({
            width: model.contentWidth,
            height: model.contentHeight,
        }).toEqual({
            width: 900,
            height: 672,
        });
    });

    it('refuses to resize a window that stays maximized', async () => {
        const model = createNativeWindowModel({
            contentWidth: 1280,
            contentHeight: 692,
            maximized: true,
            honorsRestore: false,
        });
        const {handleCommand} = createHandlerForModel(model);

        await expect(handleCommand('windowResize', [
            '900',
            '672',
        ])).rejects.toThrow(/did not leave its native placement.*maximized=true/u);
        expect(model.contentWidth).toBe(1280);
    });

    it('refuses a size the native window did not reach', async () => {
        const model = createNativeWindowModel({minimumContentWidth: 700});
        const {handleCommand} = createHandlerForModel(model);

        await expect(handleCommand('windowResize', [
            '320',
            '480',
            '10',
        ])).rejects.toThrow(/did not reach 320x480; it settled at 700x480/u);
    });

    it('requires both dimensions', async () => {
        const {handleCommand} = createHandlerForModel(createNativeWindowModel());

        await expect(handleCommand('windowResize', ['640'])).rejects.toThrow('Width and height required');
        await expect(handleCommand('emulateViewport', [
            '0',
            '480',
        ])).rejects.toThrow('Width and height required');
    });

    it('emulates a viewport without moving the native window', async () => {
        const model = createNativeWindowModel();
        const {
            handleCommand,
            setViewport,
        } = createHandlerForModel(model);

        const result = await handleCommand('emulateViewport', [
            '1280',
            '820',
        ]) as {emulated: {
            width: number;
            height: number;
        };};

        expect(setViewport).toHaveBeenCalledWith({
            width: 1280,
            height: 820,
        });
        expect(result.emulated).toEqual({
            width: 1280,
            height: 820,
        });
        expect(model.resizeRequests).toEqual([]);
        expect(model.contentWidth).toBe(900);
    });
});

interface IOpenedDocumentModel {
    originalPath: string;
    workingCopyPath: string;
    totalPages: number;
    hasOpenError: boolean;
    paintedPages: number;
}

// What the renderer shows for the active tab: the app's automation API and
// the viewer's laid-out pages, as `openPdf` reads them.
function createRendererView() {
    const view: {active: IOpenedDocumentModel | null} = {active: null};
    const rect = (top: number, bottom: number, width: number) => ({
        top,
        bottom,
        width,
        height: bottom - top,
    });
    const viewer = {
        getBoundingClientRect: () => rect(0, 800, 900),
        querySelectorAll: (selector: string) => (selector === '.page_container--rendered'
            ? Array.from({length: view.active?.paintedPages ?? 0}, () => ({
                getBoundingClientRect: () => rect(16, 640, 600),
                querySelector: () => ({
                    width: 1200,
                    height: 1560,
                }),
            }))
            : []),
    };
    return {
        view,
        globals: {
            __evbTestApi: {
                getActiveToolbarSnapshot: () => (view.active
                    ? {
                        hasPdf: true,
                        hasOpenError: view.active.hasOpenError,
                        currentPage: 1,
                        totalPages: view.active.totalPages,
                    }
                    : null),
                readActiveWorkspaceStateValues: () => ({
                    originalPath: view.active?.originalPath ?? null,
                    workingCopyPath: view.active?.workingCopyPath ?? null,
                    totalPages: view.active?.totalPages,
                }),
            },
            document: {
                querySelector: () => (view.active ? viewer : null),
                querySelectorAll: (selector: string) => (selector === '#pdf-viewer' && view.active ? [viewer] : []),
            },
        },
    };
}

describe('electron run openPdf command', () => {
    // Puppeteer sends a page function to the renderer as source text, so it
    // runs without this script's module scope. This page does the same: each
    // function is compiled again inside a context that holds only page globals.
    function createHandlerForPage(pageGlobals: Record<string, unknown>) {
        const pageContext = createContext({
            document: {
                querySelector: () => null,
                querySelectorAll: () => [],
            },
            ...pageGlobals,
            crypto: globalThis.crypto,
            setTimeout,
        });
        pageContext.window = pageContext;
        const page = cast<Page>({
            evaluateOnNewDocument: () => Promise.resolve(),
            evaluate: (pageFunction: string | ((...args: unknown[]) => unknown), ...args: unknown[]) => Promise.resolve(
                typeof pageFunction === 'string'
                    ? runInContext(pageFunction, pageContext)
                    : (runInContext(`(${pageFunction.toString()})`, pageContext) as (...pageArgs: unknown[]) => unknown)(...args),
            ),
        });
        return createCommandHandler(() => cast<ISessionState>({page}));
    }

    it('fails at once with the page error when the in-page open rejects', async () => {
        const handleCommand = createHandlerForPage({
            __allowRendererFileOpenForAutomation: () => Promise.resolve(true),
            __openFileDirect: () => Promise.reject(new Error('Document open was refused')),
        });

        await expect(handleCommand('openPdf', ['/documents/refused.pdf'])).rejects.toThrow(/^Document open was refused$/u);
    });

    it('fails at once when the renderer does not open the document', async () => {
        const handleCommand = createHandlerForPage({
            __allowRendererFileOpenForAutomation: () => Promise.resolve(false),
            __openFileDirect: () => Promise.resolve(false),
        });

        await expect(handleCommand('openPdf', ['/documents/missing.pdf'])).rejects.toThrow('The renderer did not open /documents/missing.pdf');
    });

    it('returns the opened document once its first page is painted', async () => {
        const renderer = createRendererView();
        const handleCommand = createHandlerForPage({
            ...renderer.globals,
            __allowRendererFileOpenForAutomation: () => Promise.resolve(true),
            __openFileDirect: () => {
                renderer.view.active = {
                    originalPath: '/documents/report.pdf',
                    workingCopyPath: '/tmp/working-copies/report.pdf',
                    totalPages: 4,
                    hasOpenError: false,
                    paintedPages: 0,
                };
                setTimeout(() => {
                    if (renderer.view.active) {
                        renderer.view.active.paintedPages = 1;
                    }
                }, 250);
                return Promise.resolve(true);
            },
        });

        await expect(handleCommand('openPdf', ['/documents/report.pdf'])).resolves.toEqual({
            opened: '/documents/report.pdf',
            state: {
                originalPath: '/documents/report.pdf',
                workingCopyPath: '/tmp/working-copies/report.pdf',
                numPages: 4,
                currentPage: 1,
                hasPdf: true,
                hasOpenError: false,
                paintedPageCount: 1,
            },
        });
    });

    it('waits for a repeat open instead of returning the tab that already shows the file', async () => {
        const renderer = createRendererView();
        renderer.view.active = {
            originalPath: '/documents/report.pdf',
            workingCopyPath: '/tmp/working-copies/report.pdf',
            totalPages: 4,
            hasOpenError: false,
            paintedPages: 1,
        };
        const handleCommand = createHandlerForPage({
            ...renderer.globals,
            __allowRendererFileOpenForAutomation: () => Promise.resolve(true),
            __openFileDirect: () => new Promise((resolve) => {
                setTimeout(() => {
                    renderer.view.active = {
                        originalPath: '/documents/report.pdf',
                        workingCopyPath: '/tmp/working-copies/report-2.pdf',
                        totalPages: 4,
                        hasOpenError: false,
                        paintedPages: 1,
                    };
                    resolve(true);
                }, 300);
            }),
        });

        const result = await handleCommand('openPdf', ['/documents/report.pdf']) as {state: {workingCopyPath: string;};};

        expect(result.state.workingCopyPath).toBe('/tmp/working-copies/report-2.pdf');
    });

    it('fails at once when the document opens into an error state', async () => {
        const renderer = createRendererView();
        const handleCommand = createHandlerForPage({
            ...renderer.globals,
            __allowRendererFileOpenForAutomation: () => Promise.resolve(true),
            __openFileDirect: () => {
                renderer.view.active = {
                    originalPath: '/documents/damaged.pdf',
                    workingCopyPath: '/tmp/working-copies/damaged.pdf',
                    totalPages: 0,
                    hasOpenError: true,
                    paintedPages: 0,
                };
                return Promise.resolve(true);
            },
        });

        await expect(handleCommand('openPdf', ['/documents/damaged.pdf'])).rejects.toThrow('The renderer opened /documents/damaged.pdf with an open error');
    });
});
