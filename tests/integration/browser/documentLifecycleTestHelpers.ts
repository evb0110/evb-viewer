import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {
    findFreePort, isProcessAlive, killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {buildNuxtDevServerEnv} from '@scripts/electron-run/electronRunLaunchConfig';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString,
} from 'pdf-lib';
import {chromium} from 'playwright';
import type {
    Browser, BrowserContext, Page,
} from 'playwright';
import {
    afterAll, beforeAll, expect,
} from 'vitest';

let devServer: ChildProcess | null = null;

let origin = '';

let serverOutput = '';

let browser: Browser;

export interface IBrowserLifecycleTestApi {
    waitForActiveDocumentOpenSettled?: () => Promise<boolean>;
    callActiveWorkspaceCommand?: <TResult = unknown>(commandName: string, args?: unknown[]) => Promise<{
        called: boolean;
        value: TResult | null;
    }>;
    callActiveWorkspaceSyncCommand?: <TResult = unknown>(commandName: string, args?: unknown[]) => {
        called: boolean;
        value: TResult | null;
    };
    getActiveToolbarSnapshot?: () => {
        canSave: boolean;
        initialVisualReady: boolean;
        viewerCapabilities: {save: boolean}
    } | null;
    readActiveWorkspaceStateValues?: <TValues extends Record<string, unknown> = Record<string, unknown>>(
        propertyNames: string[],
    ) => TValues;
    listTargetWindows?: () => Promise<Array<{
        windowId: number;
        label: string
    }>>;
    transferActiveTabToWindow?: (windowId: number) => Promise<{
        success: boolean;
        error?: string
    }>;
}

export async function readPersistedDocumentBytes(page: Page, ref: string, sha256 = false): Promise<number[]> {
    // Read persisted bytes without creating another document/maintenance lifecycle.
    // Keep browser imports outside Vitest's server-side module transform.
    return page.evaluate(`(async () => {
        const {loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
        const {createEntryFromPersistedRecord} = await import('/_nuxt/platform/browser/browserDocumentRecords.ts');
        const {readBrowserDocumentChunkedEntryBytes} = await import('/_nuxt/platform/browser/browserDocumentChunkStorage.ts');
        const record = await loadRecord(${JSON.stringify(ref)});
        if (!record) return [];
        const entry = createEntryFromPersistedRecord(record);
        const bytes = entry.storageMode === 'chunked'
            ? await readBrowserDocumentChunkedEntryBytes(entry)
            : entry.data;
        return Array.from(${sha256} ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : bytes);
    })()`);
}

async function waitForServer(url: string) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (devServer?.exitCode !== null || devServer.signalCode !== null) {
            throw new Error(`Nuxt exited before becoming ready:\n${serverOutput.slice(-8_000)}`);
        }
        try {
            const response = await fetch(url, {signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))});
            await response.body?.cancel();
            if (response.ok) {
                return;
            }
        } catch {
            // The development server is still compiling or binding.
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    throw new Error(`Timed out waiting for Nuxt:\n${serverOutput.slice(-8_000)}`);
}

export async function waitForOpenFileReady(page: Page) {
    await page.waitForFunction(() => {
        const api = Reflect.get(window, '__evbTestApi') as {isStartupOpenClaimPending?: () => boolean};
        return Boolean(api) && !api.isStartupOpenClaimPending?.();
    }, undefined, {timeout: 30_000});
}

// Behavior contract C2: ordinary use of a well-formed document logs no console
// error or warning and throws no page error. Only these named dev-build
// messages are expected; every other problem fails the test.
const EXPECTED_DEV_CONSOLE_PROBLEMS = [{
    pattern: /^warning: \[[^\]]+\] \[perf\] [\w:-]+ was slow \{/u,
    reason: 'app/utils/devPerf.ts frame-budget timing: dev builds only, fires when the host is busy',
}];

export function collectConsoleProblems(page: Page) {
    const problems: string[] = [];
    page.on('console', (message) => {
        const problem = `${message.type()}: ${message.text()}`;
        if (
            (message.type() === 'error' || message.type() === 'warning')
            && !EXPECTED_DEV_CONSOLE_PROBLEMS.some(expected => expected.pattern.test(problem))
        ) {
            problems.push(problem);
        }
    });
    page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
    return problems;
}

// One-shot waitForEvent listeners otherwise toggle Playwright's chooser
// interception off and on between opens, and a quick second open can race it.
export function keepFileChooserInterceptionEnabled(page: Page) {
    page.on('filechooser', () => {});
}

// Headless pages ignore Page.setWebLifecycleState: they stay visible and keep
// running. A window is frozen instead by pausing its script, which returns
// only once the page has paused. Until the returned resume runs, none of its
// timers, channel messages, storage events or IndexedDB callbacks run, while
// its context keeps its locks, as for a frozen tab.
export async function freezeWindow(context: BrowserContext, page: Page) {
    const session = await context.newCDPSession(page);
    await session.send('Debugger.enable');
    const paused = new Promise<void>(resolvePaused => session.once('Debugger.paused', () => resolvePaused()));
    const pausedEvaluation = session.send('Runtime.evaluate', {expression: 'debugger;'}).catch(() => undefined);
    await paused;
    return async () => {
        await session.send('Debugger.resume');
        await pausedEvaluation;
        await session.detach();
    };
}

async function stopServer() {
    const server = devServer;
    devServer = null;
    if (!server?.pid) {
        return;
    }
    await killProcessTree(server.pid);
    if (isProcessAlive(server.pid)) {
        throw new Error('The browser lifecycle Nuxt process did not exit');
    }
}

beforeAll(async () => {
    const port = await findFreePort();
    origin = `http://127.0.0.1:${String(port)}`;
    const sessionName = `browser-lifecycle-${process.pid}`;
    devServer = spawn(process.execPath, [
        resolve(process.cwd(), 'node_modules/nuxt/bin/nuxt.mjs'),
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
    ], {
        cwd: process.cwd(),
        // The shared launcher isolates build/output/cache, strips Vitest's
        // child environment and keeps Nitro's macOS socket path short.
        env: buildNuxtDevServerEnv({
            ...process.env,
            SENTRY_BROWSER_DSN: `http://consenttest@127.0.0.1:${String(port)}/1`,
        }, port, sessionName),
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    const captureOutput = (chunk: Buffer) => {
        serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
    };
    devServer.stdout?.on('data', captureOutput);
    devServer.stderr?.on('data', captureOutput);
    await once(devServer, 'spawn');
    await waitForServer(origin);
    browser = await chromium.launch({headless: true});
}, 120_000);

afterAll(async () => {
    try {
        await browser?.close();
    } finally {
        await stopServer();
    }
});

export async function addNote(page: Page, text: string, position: {
    x: number;
    y: number
}) {
    await page.getByRole('button', {
        name: 'Place a sticky note on the page.',
        exact: true,
    }).click();
    await page.locator('.page_container[data-page="1"]').first().click({position});
    await page.getByRole('textbox', {
        name: 'Write annotation note',
        exact: true,
    }).fill(text);
    await page.getByRole('button', {
        name: 'Minimize note',
        exact: true,
    }).click();
}

export function noteTexts(document: PDFDocument) {
    const annots = document.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return new Set(Array.from({length: annots?.size() ?? 0}, (_, index) =>
        annots!.lookup(index, PDFDict).lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText())
        .filter((text): text is string => text !== undefined));
}

// Each recovery record's owner and the notes in its recovery bytes.
export async function readRecoveries(page: Page) {
    const records = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
            const request = indexedDB.open('evb-viewer-browser-documents');
            request.onsuccess = () => resolveDb(request.result);
            request.onerror = () => rejectDb(request.error);
        });
        try {
            const rows = await new Promise<Array<{
                ownerId: string;
                checkpoint: {tabs: Array<{
                    isDirty: boolean;
                    workingCopyRef: string | null
                }>}
            }>>((resolveRows, rejectRows) => {
                const request = db.transaction('workspace-recovery', 'readonly').objectStore('workspace-recovery').getAll();
                request.onsuccess = () => resolveRows(request.result);
                request.onerror = () => rejectRows(request.error);
            });
            return rows.map(row => ({
                ownerId: row.ownerId,
                ref: row.checkpoint.tabs.find(tab => tab.isDirty)?.workingCopyRef ?? null,
            }));
        } finally {
            db.close();
        }
    });
    return Promise.all(records.map(async record => ({
        ownerId: record.ownerId,
        notes: record.ref
            ? noteTexts(await PDFDocument.load(Uint8Array.from(await readPersistedDocumentBytes(page, record.ref))))
            : new Set<string>(),
    })));
}

// The lease owners whose lock a window holds, and those a window waits for.
export function readLeaseOwnerLocks(page: Page) {
    return page.evaluate(async () => {
        const {
            held = [],
            pending = [],
        } = await navigator.locks.query();
        const owners = (locks: LockInfo[]) => locks.flatMap(({name}) => (
            name?.startsWith('evb-viewer:browser-lease-owner:')
                ? [name.slice('evb-viewer:browser-lease-owner:'.length)]
                : []
        )).sort();
        return {
            held: owners(held),
            pending: owners(pending),
        };
    });
}

export async function clickCenter(page: Page, selector: string, button: 'left' | 'right' = 'left') {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) {
        throw new Error(`${selector} has no visible box`);
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {button});
}

export function paneSelector(paneId: string) {
    return `.editor-pane[data-editor-pane-id="${paneId}"]`;
}

/** The rendered width of page 1 in one pane: its zoom as a person sees it. */
export function readPanePageWidth(page: Page, paneId: string) {
    return page.locator(`${paneSelector(paneId)} .page_container[data-page="1"]`).first()
        .evaluate(element => Math.round(element.getBoundingClientRect().width));
}

export async function zoomActivePane(page: Page, paneId: string, label: 'Zoom In' | 'Zoom Out', steps: number) {
    for (let step = 0; step < steps; step += 1) {
        const before = await readPanePageWidth(page, paneId);
        await page.locator(`#editor-global-toolbar-host button[aria-label^="${label}"]:not([disabled])`).first().click();
        await expect.poll(() => readPanePageWidth(page, paneId), {timeout: 15_000}).not.toBe(before);
    }
}

export async function readBrowserPayloadCounts(page: Page) {
    return page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
            const request = indexedDB.open('evb-viewer-browser-documents');
            request.onsuccess = () => resolveDb(request.result);
            request.onerror = () => rejectDb(request.error);
        });
        const count = (name: string) => new Promise<number>((resolveCount, rejectCount) => {
            const request = db.transaction(name).objectStore(name).count();
            request.onsuccess = () => resolveCount(request.result);
            request.onerror = () => rejectCount(request.error);
        });
        try {
            const [
                records,
                chunks,
                recovery,
            ] = await Promise.all([
                count('documents'),
                count('document-chunks'),
                count('workspace-recovery'),
            ]);
            return {
                records: records!,
                chunks: chunks!,
                recovery: recovery!,
            };
        } finally { db.close(); }
    });
}

export const lifecycle = {
    get browser() { return browser; },
    get origin() { return origin; },
    get serverOutput() { return serverOutput; },
};
