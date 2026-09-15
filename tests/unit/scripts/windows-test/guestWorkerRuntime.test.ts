import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
    OnResolveArgs,
    OnResolveOptions,
    OnResolveResult,
    PluginBuild,
} from 'esbuild';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    Browser,
    Page,
} from 'puppeteer-core';
import type {
    IAppLaunchRecord,
    IAppLaunchRequest,
    IWindowsAppLauncher,
} from '@scripts/windows-test/guest/appLaunch';
import {
    GUEST_WORKER_ENTRY_POINT,
    GUEST_WORKER_IMPORT_META_IDENTIFIER,
    guestWorkerAliasPlugin,
    guestWorkerBuildOptions,
    resolveGuestWorkerAlias,
} from '@scripts/windows-test/guest/bundleGuestWorker';
import {
    defaultWinappExecutableForRoot,
    guestWorkerMain,
} from '@scripts/windows-test/guest/guestWorkerMain';
import { createPuppeteerViewerDriver } from '@scripts/windows-test/guest/viewer/createPuppeteerViewerDriver';
import {
    createNativeUiActionLog,
    type INativeUiAdapter,
    type IUiElementRef,
    type IUiSelector,
    type IUiWindowQuery,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import { DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT } from '@scripts/windows-test/guest/native-ui/firstLaunchPrompt';
import {
    createPuppeteerViewerFactory,
    selectViewerPage,
} from '@scripts/windows-test/guest/viewer/createPuppeteerViewerFactory';
import type { IViewerDriver } from '@scripts/windows-test/guest/viewer/viewerDriver';

type TAliasResolver = (args: OnResolveArgs) =>
    | OnResolveResult
    | null
    | undefined
    | Promise<OnResolveResult | null | undefined>;

const repoRoot = process.cwd();

const ownedProcess = {
    pid: 4_242,
    startTime: '2026-09-04T12:00:00.0000000Z',
    executable: 'C:\\Users\\tester\\AppData\\Local\\Programs\\EVB Viewer\\EVB Viewer.exe',
};

function resolveArgs(specifier: string): OnResolveArgs {
    return {
        path: specifier,
        importer: path.join(repoRoot, GUEST_WORKER_ENTRY_POINT),
        namespace: 'file',
        resolveDir: repoRoot,
        kind: 'import-statement',
        pluginData: undefined,
        with: {},
    };
}

function stubPage(url: string, closed = false) {
    return new Proxy({}, { get: (target, property) => {
        if (property === 'url') {
            return () => url;
        }
        if (property === 'isClosed') {
            return () => closed;
        }
        throw new Error(`the stub page has no ${String(property)}`);
    } }) as Page;
}

function stubBrowser(pages: readonly Page[], calls: string[]) {
    return new Proxy({}, { get: (target, property) => {
        if (property === 'then') {
            return undefined;
        }
        if (property === 'pages') {
            return () => Promise.resolve([...pages]);
        }
        if (property === 'disconnect') {
            return () => {
                calls.push('disconnect');
                return Promise.resolve();
            };
        }
        throw new Error(`the stub browser has no ${String(property)}`);
    } }) as Browser;
}

function stubDriver(calls: string[]) {
    return new Proxy({}, { get: (target, property) => () => {
        calls.push(String(property));
        return Promise.resolve();
    } }) as IViewerDriver;
}

function stubFirstLaunchUi(calls: string[]) {
    const actionLog = createNativeUiActionLog();
    const mainWindow: IUiElementRef = {
        handle: 'main-window',
        controlType: 'Window',
        name: 'EVB Viewer',
        automationId: null,
        processId: ownedProcess.pid,
    };
    const promptWindow: IUiElementRef = {
        handle: 'prompt-window',
        controlType: 'Window',
        name: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.title,
        automationId: null,
        processId: ownedProcess.pid,
    };
    const notNow: IUiElementRef = {
        handle: 'not-now',
        controlType: 'Button',
        name: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonName,
        automationId: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonAutomationId,
        processId: ownedProcess.pid,
    };
    let promptVisible = true;
    const adapter: INativeUiAdapter = {
        driver: 'uia3',
        actionLog,
        findWindow: async (query: IUiWindowQuery) => {
            calls.push(`findWindow:${query.titleContains ?? ''}:${query.className ?? ''}`);
            if (query.processId !== ownedProcess.pid) {
                return null;
            }
            if (query.className === 'Chrome_WidgetWin_1') {
                return mainWindow;
            }
            return promptVisible ? promptWindow : null;
        },
        findControl: async (window: IUiElementRef, selector: IUiSelector) => {
            expect(window).toEqual(promptWindow);
            expect(selector).toEqual({
                automationId: notNow.automationId,
                controlType: 'Button',
                name: {exact: notNow.name},
                processId: ownedProcess.pid,
            });
            calls.push('findControl');
            return promptVisible ? [notNow] : [];
        },
        invoke: async (target) => {
            expect(target).toEqual(notNow);
            calls.push('invoke');
            promptVisible = false;
            actionLog.record({
                actionKind: 'pattern',
                action: 'invoke',
                target: notNow.handle,
            });
        },
        setValue: async () => undefined,
        select: async () => undefined,
        sendKeys: async () => undefined,
        waitFor: async () => {
            throw new Error('waitFor is not used by first-launch prompt handling');
        },
        captureTree: async () => ({}),
        screenshot: async () => undefined,
    };
    return {
        adapter,
        actionLog,
    };
}

interface IStubLauncher {
    launcher: IWindowsAppLauncher;
    requests: IAppLaunchRequest[];
    terminated: IAppLaunchRecord[];
}

function stubLauncher(options: {
    browserUrl?: string | null;
    terminates?: boolean;
} = {}): IStubLauncher {
    const requests: IAppLaunchRequest[] = [];
    const terminated: IAppLaunchRecord[] = [];
    const browserUrl = options.browserUrl === undefined ? 'http://127.0.0.1:9333' : options.browserUrl;
    return {
        requests,
        terminated,
        launcher: {
            launch: (request) => {
                requests.push(request);
                return {
                    profile: request.profile,
                    process: ownedProcess,
                    args: [],
                    browserUrl: request.profile === 'instrumentation'
                        ? browserUrl
                        : null,
                };
            },
            terminate: (record) => {
                terminated.push(record);
                return options.terminates === false
                    ? {
                        terminated: false,
                        reason: 'pid 4242 is not owned by this worker; refusing to terminate',
                    }
                    : {
                        terminated: true,
                        reason: 'terminated owned pid 4242',
                    };
            },
        },
    };
}

describe('guest worker entry point', () => {
    it('uses the guest-root WinApp tool path by default', () => {
        expect(defaultWinappExecutableForRoot('C:\\EVBViewerTests')).toBe('C:\\EVBViewerTests\\tools\\winapp\\winapp.exe');
    });

    it('returns without a result when the inbox never receives a job', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-guest-main-'));
        const written: string[] = [];
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            written.push(String(chunk));
            return true;
        });
        try {
            const summary = await guestWorkerMain([
                `--root=${root}`,
                '--wait-ms=0',
            ], {});

            expect(summary).toEqual({
                result: null,
                resultFile: null,
                reason: 'no ready marker appeared in the guest inbox',
            });
        } finally {
            stdout.mockRestore();
        }
        expect(written.join('')).toContain('no ready marker appeared in the guest inbox');
    });
});

describe('guest worker bundle options', () => {
    it('points at the real entry point', () => {
        expect(existsSync(path.join(repoRoot, GUEST_WORKER_ENTRY_POINT))).toBe(true);
    });

    it('resolves workspace aliases to files that exist', () => {
        expect(resolveGuestWorkerAlias(repoRoot, '@scripts/windows-test/guest/guestWorker'))
            .toBe(path.join(repoRoot, 'scripts', 'windows-test', 'guest', 'guestWorker.ts'));
        expect(resolveGuestWorkerAlias(repoRoot, '@tests/windows/native-ui/selectors.json'))
            .toBe(path.join(repoRoot, 'tests', 'windows', 'native-ui', 'selectors.json'));
        expect(resolveGuestWorkerAlias(repoRoot, 'puppeteer-core')).toBeNull();
        expect(() => resolveGuestWorkerAlias(repoRoot, '@scripts/nope/missing'))
            .toThrow('Cannot resolve workspace import');
    });

    it('registers an alias resolver that esbuild can call', async () => {
        const captured: Array<{
            options: OnResolveOptions;
            callback: TAliasResolver;
        }> = [];
        const buildContext = new Proxy({}, { get: (target, property) => {
            if (property !== 'onResolve') {
                throw new Error(`the stub esbuild build has no ${String(property)}`);
            }
            return (options: OnResolveOptions, callback: TAliasResolver) => {
                captured.push({
                    options,
                    callback,
                });
            };
        } }) as PluginBuild;
        const plugin = guestWorkerAliasPlugin(repoRoot);

        await plugin.setup(buildContext);

        expect(plugin.name).toBe('evb-guest-worker-aliases');
        expect(captured).toHaveLength(1);
        const [registration] = captured;
        expect(registration?.options.filter.test('@scripts/windows-test/guest/guestWorker')).toBe(true);
        expect(registration?.options.filter.test('puppeteer-core')).toBe(false);
        const resolved = await registration?.callback(resolveArgs('@contracts/runtimeGuards'));
        expect(resolved).toEqual({ path: path.join(repoRoot, 'packages', 'contracts', 'runtimeGuards.ts') });
    });

    it('builds a node bundle that rewrites import.meta.url', () => {
        const options = guestWorkerBuildOptions({
            outFile: 'dist/windows-test/guestWorker.cjs',
            repoRoot,
        });

        expect(options).toMatchObject({
            bundle: true,
            platform: 'node',
            target: 'node22',
            format: 'cjs',
            sourcemap: 'linked',
            minify: false,
            define: { 'import.meta.url': GUEST_WORKER_IMPORT_META_IDENTIFIER },
        });
        expect(options.entryPoints).toEqual([path.join(repoRoot, GUEST_WORKER_ENTRY_POINT)]);
        expect(options.outfile).toBe(path.join(repoRoot, 'dist', 'windows-test', 'guestWorker.cjs'));
        expect(options.banner?.js).toContain('pathToFileURL(__filename).href');
        expect(options.plugins).toHaveLength(1);
        expect(guestWorkerBuildOptions({
            outFile: 'out.cjs',
            repoRoot,
            minify: true,
            external: ['puppeteer-core'],
        })).toMatchObject({
            minify: true,
            external: [
                '@napi-rs/canvas',
                'puppeteer-core',
            ],
        });
    });
});

describe('puppeteer viewer factory', () => {
    it('prefers the viewer renderer page and falls back to any open page', () => {
        const viewerPage = stubPage('evb-viewer://app/index.html');
        const otherPage = stubPage('devtools://devtools/inspector.html');
        expect(selectViewerPage([
            otherPage,
            viewerPage,
        ])).toBe(viewerPage);
        expect(selectViewerPage([otherPage])).toBe(otherPage);
        expect(() => selectViewerPage([stubPage('about:blank', true)]))
            .toThrow('exposed no renderer page');
        expect(() => selectViewerPage([])).toThrow('exposed no renderer page');
    });

    it('opens an instrumented session over the loopback debugging port', async () => {
        const launcher = stubLauncher();
        const calls: string[] = [];
        const ports: number[] = [];
        const factory = createPuppeteerViewerFactory({
            launcher: launcher.launcher,
            profileDirectory: 'C:\\evb-test\\work\\run\\profile',
            allocatePort: () => Promise.resolve(9_333),
            waitForBrowserReady: (port) => {
                ports.push(port);
                return Promise.resolve();
            },
            connectBrowser: browserUrl => Promise.resolve(stubBrowser(
                [stubPage(`${browserUrl.startsWith('http') ? 'evb-viewer://app/' : 'about:blank'}index.html`)],
                calls,
            )),
            createDriver: () => stubDriver(calls),
        });

        const session = await factory.openInstrumented('C:\\evb-test\\work\\run\\inputs\\source.pdf');

        expect(launcher.requests[0]).toEqual({
            profile: 'instrumentation',
            remoteDebuggingPort: 9_333,
            userDataDirectory: 'C:\\evb-test\\work\\run\\profile',
        });
        expect(ports).toEqual([9_333]);
        expect(calls).toEqual([
            'openDocument',
            'waitUntilReady',
        ]);
        expect(session.process).toEqual(ownedProcess);

        await session.close();
        expect(calls).toContain('disconnect');
        expect(launcher.terminated).toHaveLength(1);
    });

    it('dismisses the owned first-launch prompt before opening an instrumented document', async () => {
        const launcher = stubLauncher();
        const calls: string[] = [];
        const nativeUi = stubFirstLaunchUi(calls);
        const factory = createPuppeteerViewerFactory({
            launcher: launcher.launcher,
            profileDirectory: 'C:\\evb-test\\work\\run\\profile',
            nativeUi: nativeUi.adapter,
            clock: {
                now: () => 0,
                sleep: async () => undefined,
            },
            firstLaunchPromptTimeoutMs: 0,
            allocatePort: () => Promise.resolve(9_333),
            waitForBrowserReady: () => Promise.resolve(),
            connectBrowser: browserUrl => Promise.resolve(stubBrowser(
                [stubPage(`${browserUrl.startsWith('http') ? 'evb-viewer://app/' : 'about:blank'}index.html`)],
                calls,
            )),
            createDriver: () => stubDriver(calls),
        });

        const session = await factory.openInstrumented('C:\\evb-test\\work\\run\\inputs\\source.pdf');

        expect(calls.indexOf('invoke')).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf('invoke')).toBeLessThan(calls.indexOf('openDocument'));
        expect(nativeUi.actionLog.entries()).toHaveLength(1);
        await session.close();
    });

    it('refuses an instrumentation launch that produced no debugging url', async () => {
        const launcher = stubLauncher({ browserUrl: null });
        const factory = createPuppeteerViewerFactory({
            launcher: launcher.launcher,
            profileDirectory: 'C:\\evb-test\\profile',
            allocatePort: () => Promise.resolve(9_444),
            waitForBrowserReady: () => Promise.resolve(),
            connectBrowser: () => Promise.reject(new Error('the browser must not be contacted')),
            createDriver: () => stubDriver([]),
        });

        await expect(factory.openInstrumented('C:\\doc.pdf')).rejects.toThrow('no loopback debugging URL');
    });

    it('launches the acceptance profile with no instrumentation and reports a refused shutdown', async () => {
        const launcher = stubLauncher({ terminates: false });
        const factory = createPuppeteerViewerFactory({
            launcher: launcher.launcher,
            profileDirectory: 'C:\\evb-test\\profile',
            allocatePort: () => Promise.reject(new Error('acceptance must not allocate a debugging port')),
            waitForBrowserReady: () => Promise.reject(new Error('acceptance must not wait for a debugger')),
            connectBrowser: () => Promise.reject(new Error('acceptance must not connect a debugger')),
            createDriver: () => stubDriver([]),
        });

        const session = await factory.launchAcceptance('C:\\evb-test\\inputs\\source.pdf');

        expect(launcher.requests).toEqual([{
            profile: 'acceptance',
            documentPath: 'C:\\evb-test\\inputs\\source.pdf',
        }]);
        await expect(session.close()).rejects.toThrow('refusing to report a clean shutdown');
    });

    it('waits for the owned acceptance window before dismissing the first-launch prompt', async () => {
        const launcher = stubLauncher();
        const calls: string[] = [];
        const nativeUi = stubFirstLaunchUi(calls);
        const factory = createPuppeteerViewerFactory({
            launcher: launcher.launcher,
            profileDirectory: 'C:\\evb-test\\profile',
            nativeUi: nativeUi.adapter,
            clock: {
                now: () => 0,
                sleep: async () => undefined,
            },
            firstLaunchPromptTimeoutMs: 0,
            allocatePort: () => Promise.reject(new Error('acceptance must not allocate a debugging port')),
            waitForBrowserReady: () => Promise.reject(new Error('acceptance must not wait for a debugger')),
            connectBrowser: () => Promise.reject(new Error('acceptance must not connect a debugger')),
            createDriver: () => stubDriver(calls),
        });

        const session = await factory.launchAcceptance('C:\\evb-test\\inputs\\source.pdf');

        expect(calls.slice(0, 2)).toEqual([
            'findWindow:EVB Viewer:Chrome_WidgetWin_1',
            `findWindow:${DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.title}:${DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.className}`,
        ]);
        expect(calls).toContain('invoke');
        expect(nativeUi.actionLog.entries()).toHaveLength(1);
        await session.close();
    });
});

describe('puppeteer viewer driver', () => {
    it('records renderer failures and drives the keyboard without touching a real browser', async () => {
        const handlers = new Map<string, (payload: unknown) => void>();
        const keystrokes: string[] = [];
        const screenshots: string[] = [];
        const keyboard = {
            down: (key: string) => {
                keystrokes.push(`down ${key}`);
                return Promise.resolve();
            },
            up: (key: string) => {
                keystrokes.push(`up ${key}`);
                return Promise.resolve();
            },
            press: (key: string) => {
                keystrokes.push(`press ${key}`);
                return Promise.resolve();
            },
        };
        const page = new Proxy({}, { get: (target, property) => {
            if (property === 'on') {
                return (event: string, handler: (payload: unknown) => void) => {
                    handlers.set(event, handler);
                };
            }
            if (property === 'keyboard') {
                return keyboard;
            }
            if (property === 'screenshot') {
                return (options: { path: string }) => {
                    screenshots.push(options.path);
                    return Promise.resolve();
                };
            }
            throw new Error(`the stub page has no ${String(property)}`);
        } }) as Page;

        const driver = createPuppeteerViewerDriver(page);
        handlers.get('pageerror')?.(new Error('renderer exploded'));
        handlers.get('console')?.({
            type: () => 'error',
            text: () => 'console failure',
        });
        handlers.get('console')?.({
            type: () => 'log',
            text: () => 'ignored chatter',
        });

        const failures = driver.rendererFailures();
        expect(failures).toHaveLength(2);
        expect(failures[0]).toContain('[pageerror] Error: renderer exploded');
        expect(failures[1]).toBe('[console.error] console failure');
        failures.push('mutation must not leak back into the driver');
        expect(driver.rendererFailures()).toHaveLength(2);

        await driver.requestSaveAs();
        await driver.requestPrint();
        await driver.pressKeys([
            'Enter',
            'Escape',
        ]);
        await driver.captureScreenshot('C:\\evb-test\\work\\run\\evidence\\shot.png');

        expect(keystrokes).toEqual([
            'down Control',
            'down Shift',
            'press KeyS',
            'up Shift',
            'up Control',
            'down Control',
            'press KeyP',
            'up Control',
            'press Enter',
            'press Escape',
        ]);
        expect(screenshots).toEqual(['C:\\evb-test\\work\\run\\evidence\\shot.png']);
    });
});
