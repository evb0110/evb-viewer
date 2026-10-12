import {createHash} from 'node:crypto';
import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {
    createCanvas, loadImage,
} from '@napi-rs/canvas';
import {
    findFreePort, isProcessAlive, killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {buildNuxtDevServerEnv} from '@scripts/electron-run/electronRunLaunchConfig';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString,
    StandardFonts,
} from 'pdf-lib';
import {chromium} from 'playwright';
import type {loadBrowserWorkspaceRecovery} from '@app/platform/browser/browserWorkspaceRecoveryStore';
import type {
    BrowserContext, Page, Download,
} from 'playwright';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

let devServer: ChildProcess | null = null;
let origin = '';
let serverOutput = '';
interface IBrowserLifecycleTestApi {
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

async function readPersistedDocumentBytes(page: Page, ref: string): Promise<number[]> {
    // Read persisted bytes without creating another document/maintenance lifecycle.
    // Keep browser imports outside Vitest's server-side module transform.
    return page.evaluate(`(async () => {
        const {loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
        const {createEntryFromPersistedRecord} = await import('/_nuxt/platform/browser/browserDocumentRecords.ts');
        const {readBrowserDocumentChunkedEntryBytes} = await import('/_nuxt/platform/browser/browserDocumentChunkStorage.ts');
        const record = await loadRecord(${JSON.stringify(ref)});
        if (!record) return [];
        const entry = createEntryFromPersistedRecord(record);
        return Array.from(entry.storageMode === 'chunked'
            ? await readBrowserDocumentChunkedEntryBytes(entry)
            : entry.data);
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

async function waitForOpenFileReady(page: Page) {
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

function collectConsoleProblems(page: Page) {
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
function keepFileChooserInterceptionEnabled(page: Page) {
    page.on('filechooser', () => {});
}

// Headless pages ignore Page.setWebLifecycleState: they stay visible and keep
// running. A window is frozen instead by pausing its script, which returns
// only once the page has paused. Until the returned resume runs, none of its
// timers, channel messages, storage events or IndexedDB callbacks run, while
// its context keeps its locks, as for a frozen tab.
async function freezeWindow(context: BrowserContext, page: Page) {
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
}, 120_000);

afterAll(async () => {
    await stopServer();
});

async function addNote(page: Page, text: string, position: {
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

function noteTexts(document: PDFDocument) {
    const annots = document.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return new Set(Array.from({length: annots?.size() ?? 0}, (_, index) =>
        annots!.lookup(index, PDFDict).lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText())
        .filter((text): text is string => text !== undefined));
}

// Each recovery record's owner and the notes in its recovery bytes.
async function readRecoveries(page: Page) {
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
function readLeaseOwnerLocks(page: Page) {
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

async function clickCenter(page: Page, selector: string, button: 'left' | 'right' = 'left') {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) {
        throw new Error(`${selector} has no visible box`);
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {button});
}

function paneSelector(paneId: string) {
    return `.editor-pane[data-editor-pane-id="${paneId}"]`;
}

/** The rendered width of page 1 in one pane: its zoom as a person sees it. */
function readPanePageWidth(page: Page, paneId: string) {
    return page.locator(`${paneSelector(paneId)} .page_container[data-page="1"]`).first()
        .evaluate(element => Math.round(element.getBoundingClientRect().width));
}

async function zoomActivePane(page: Page, paneId: string, label: 'Zoom In' | 'Zoom Out', steps: number) {
    for (let step = 0; step < steps; step += 1) {
        const before = await readPanePageWidth(page, paneId);
        await page.locator(`#editor-global-toolbar-host button[aria-label^="${label}"]:not([disabled])`).first().click();
        await expect.poll(() => readPanePageWidth(page, paneId), {timeout: 15_000}).not.toBe(before);
    }
}

describe('browser document lifecycle UI', () => {
    it('reuses dirty recovery bytes for reading changes and protects the next note edit', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        for (let number = 1; number <= 3; number += 1) {
            pdf.addPage([
                612,
                792,
            ]).drawText(`Recovery reading page ${String(number)}`, {
                x: 40,
                y: 740,
                font,
                size: 16,
            });
        }
        const source = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-b/core/w02/app-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), source);
        const observations: unknown[] = [];
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext({
            viewport: {
                width: 1280,
                height: 800,
            },
            recordVideo: {
                dir: evidenceDir,
                size: {
                    width: 1280,
                    height: 800,
                },
            },
        });
        let problems: string[] = [];
        try {
            const page = await context.newPage();
            problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'recovery-reading.pdf',
                mimeType: 'application/pdf',
                buffer: source,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await page.locator('.page_container[data-page="1"]').first().click({position: {
                x: 200,
                y: 200,
            }});
            const input = page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            });
            const acceptedText = 'Accepted note before reading';
            await input.fill(acceptedText);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();

            async function readRecovery() {
                const tab = await page.evaluate(async () => {
                    const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                        const request = indexedDB.open('evb-viewer-browser-documents');
                        request.onsuccess = () => resolveDb(request.result);
                        request.onerror = () => rejectDb(request.error);
                    });
                    try {
                        const records = await new Promise<Array<{checkpoint: {tabs: Array<{
                            isDirty: boolean;
                            currentPage: number | null;
                            zoom: number | null;
                            workingCopyRef: string | null;
                            annotationRecovery?: {payload?: {drafts: Array<{text: string}>}}
                        }>}}>>((resolveRows, rejectRows) => {
                            const request = db.transaction('workspace-recovery', 'readonly').objectStore('workspace-recovery').getAll();
                            request.onsuccess = () => resolveRows(request.result);
                            request.onerror = () => rejectRows(request.error);
                        });
                        const tab = records.flatMap(record => record.checkpoint.tabs).find(candidate => candidate.isDirty);
                        return tab;
                    } finally {db.close();}
                });
                return {
                    tab,
                    bytes: tab?.workingCopyRef ? await readPersistedDocumentBytes(page, tab.workingCopyRef) : [],
                };
            }
            async function savedNoteTexts(recovery: Awaited<ReturnType<typeof readRecovery>>) {
                if (!recovery.bytes.length) return [];
                const saved = await PDFDocument.load(Uint8Array.from(recovery.bytes));
                const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
                return Array.from({length: annots?.size() ?? 0}, (_, index) =>
                    annots!.lookup(index, PDFDict).lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText());
            }
            let initial: Awaited<ReturnType<typeof readRecovery>> | undefined;
            await expect.poll(async () => {
                const recovery = await readRecovery();
                const texts = await savedNoteTexts(recovery);
                if (!texts.includes(acceptedText)) return false;
                initial = recovery;
                return true;
            }, {timeout: 15_000}).toBe(true);
            const initialHash = createHash('sha256').update(Uint8Array.from(initial!.bytes)).digest('hex');
            observations.push({
                event: 'accepted note',
                ref: initial!.tab?.workingCopyRef,
                hash: initialHash,
            });

            for (const number of [
                2,
                3,
            ]) {
                // Trusted reading input; the persisted page is the completion
                // boundary, so there is no negative observation delay.
                await page.locator('.page-controls-display').click();
                const pageInput = page.locator('.page-controls-inline-input');
                await pageInput.fill(String(number));
                await pageInput.press('Enter');
                await page.locator(`.page_container[data-page="${String(number)}"] .textLayer`).filter({hasText: `Recovery reading page ${String(number)}`}).waitFor({state: 'visible'});
                await expect.poll(async () => (await readRecovery()).tab?.currentPage, {timeout: 15_000}).toBe(number);
                const recovery = await readRecovery();
                const hash = createHash('sha256').update(Uint8Array.from(recovery.bytes)).digest('hex');
                observations.push({
                    event: `page ${String(number)}`,
                    ref: recovery.tab?.workingCopyRef,
                    hash,
                });
                expect(recovery.tab?.workingCopyRef).toBe(initial!.tab?.workingCopyRef);
                expect(hash).toBe(initialHash);
            }

            await page.locator('.page-controls-display').click();
            const pageInput = page.locator('.page-controls-inline-input');
            await pageInput.fill('1');
            await pageInput.press('Enter');
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            const draft = 'Protected newer draft after reading';
            await input.fill(draft);
            await expect.poll(async () => savedNoteTexts(await readRecovery()), {timeout: 15_000}).toContain(draft);
            const edited = await readRecovery();
            expect(edited.tab?.workingCopyRef).not.toBe(initial!.tab?.workingCopyRef);
            observations.push({
                event: 'new draft',
                ref: edited.tab?.workingCopyRef,
                drafts: edited.tab?.annotationRecovery?.payload?.drafts,
            });
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            await expect.poll(() => input.inputValue()).toBe(draft);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            const download = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const savedPath = resolve(evidenceDir, 'restored.pdf');
            await (await download).saveAs(savedPath);
            const saved = await PDFDocument.load(readFileSync(savedPath));
            expect(saved.getPageCount()).toBe(3);
            const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            const texts = Array.from({length: annots.size()}, (_, index) =>
                annots.lookup(index, PDFDict).lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText());
            expect(texts).toContain(draft);
            expect(problems).toEqual([]);
            observations.push({
                event: 'recovered Save As',
                texts,
            });
        } finally {
            writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify({
                observations,
                problems,
            }, null, 2));
            await context.close();
            await browser.close();
        }
    }, 90_000);

    it('recovers the current note draft while document note updates keep rejecting', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdf.addPage([
            612,
            792,
        ]).drawText('Sustained note failure recovery', {
            x: 40,
            y: 740,
            font,
            size: 16,
        });
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-a-1108/app-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const browser = await chromium.launch({headless: true});
        const observations: unknown[] = [];
        try {
            for (const retained of [
                false,
                true,
            ]) {
                const context = await browser.newContext({
                    viewport: {
                        width: 1280,
                        height: 800,
                    },
                    recordVideo: {
                        dir: evidenceDir,
                        size: {
                            width: 1280,
                            height: 800,
                        },
                    },
                });
                let problems: string[] = [];
                try {
                    const page = await context.newPage();
                    problems = collectConsoleProblems(page);
                    // Fault setup only; note input and restored Save As remain trusted.
                    await page.route('**/composables/useWorkspaceAnnotationSession.ts*', async route => {
                        const response = await route.fetch();
                        const body = await response.text();
                        const marker = 'const comment = resolveNoteComment(annotationId);';
                        if (!body.includes(marker)) throw new Error('Document note update fault seam was not found');
                        await route.fulfill({
                            response,
                            body: body.replace(marker,
                                'if (Reflect.get(window, "__noteRecoveryFailure")) throw new Error("1108 sustained note update rejection"); ' + marker),
                        });
                    });
                    await page.addInitScript(() => {
                        Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                        Reflect.set(window, '__noteRecoveryFailure', true);
                        Reflect.set(window, 'showSaveFilePicker', undefined);
                        sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                    });
                    await page.goto(origin, {waitUntil: 'domcontentloaded'});
                    await waitForOpenFileReady(page);
                    await page.evaluate(() => Reflect.set(window, '__noteRecoveryFailure', false));
                    keepFileChooserInterceptionEnabled(page);
                    const chooser = page.waitForEvent('filechooser');
                    await page.getByRole('button', {
                        name: 'Open File',
                        exact: true,
                    }).first().click();
                    await (await chooser).setFiles({
                        name: 'sustained-note.pdf',
                        mimeType: 'application/pdf',
                        buffer: bytes,
                    });
                    await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
                    await page.getByRole('button', {
                        name: 'Place a sticky note on the page.',
                        exact: true,
                    }).click();
                    const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
                    if (!bounds) throw new Error('The first PDF page is not visible');
                    await page.mouse.click(bounds.x + 200, bounds.y + 200);
                    const input = page.getByRole('textbox', {
                        name: 'Write annotation note',
                        exact: true,
                    });
                    async function readCheckpoint() {
                        return page.evaluate(async () => {
                            const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                                const request = indexedDB.open('evb-viewer-browser-documents');
                                request.onsuccess = () => resolveDb(request.result);
                                request.onerror = () => rejectDb(request.error);
                            });
                            try {
                                return await new Promise<Array<{checkpoint: {tabs: Array<{
                                    isDirty: boolean;
                                    workingCopyRef: string | null;
                                    annotationRecovery?: {payload?: {drafts: Array<{text: string}>}}
                                }>}}>>((resolveRows, rejectRows) => {
                                    const request = db.transaction('workspace-recovery', 'readonly').objectStore('workspace-recovery').getAll();
                                    request.onsuccess = () => resolveRows(request.result);
                                    request.onerror = () => rejectRows(request.error);
                                });
                            } finally {db.close();}
                        });
                    }
                    if (retained) {
                        await input.fill('Previously accepted text');
                        await page.getByRole('button', {
                            name: 'Minimize note',
                            exact: true,
                        }).click();
                        await expect.poll(async () => {
                            const refs = (await readCheckpoint()).flatMap(record => record.checkpoint.tabs
                                .filter(tab => tab.isDirty && tab.workingCopyRef)
                                .map(tab => tab.workingCopyRef!));
                            const copies = await Promise.all(refs.map(ref => readPersistedDocumentBytes(page, ref)));
                            for (const copy of copies) {
                                if (!copy.length) continue;
                                const saved = await PDFDocument.load(Uint8Array.from(copy));
                                const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
                                for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
                                    const annotation = annots!.lookup(index, PDFDict);
                                    if (annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Text') continue;
                                    const text = annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText();
                                    if (text === 'Previously accepted text') {
                                        observations.push({
                                            retained,
                                            retainedSavedText: text,
                                        });
                                        writeFileSync(resolve(evidenceDir, 'retained-before-failure.pdf'), Uint8Array.from(copy));
                                        return true;
                                    }
                                }
                            }
                            return false;
                        }, {timeout: 15_000}).toBe(true);
                        await page.getByRole('button', {
                            name: 'Open Note',
                            exact: true,
                        }).click();
                    }
                    const draft = retained ? 'Protected newer draft over an older snapshot' : 'Protected draft without a previous snapshot';
                    await page.evaluate(() => Reflect.set(window, '__noteRecoveryFailure', true));
                    await input.fill(draft);
                    await page.waitForFunction(() => document.querySelector('.app-toast-failure')?.textContent?.includes('1108 sustained note update rejection'));
                    await page.screenshot({path: resolve(evidenceDir, `failure-${String(retained)}.png`)});
                    await expect.poll(async () => {
                        const records = await readCheckpoint();
                        observations.push({
                            retained,
                            records,
                        });
                        return records.some(record => record.checkpoint.tabs.some(tab => tab.isDirty && tab.workingCopyRef
                            && tab.annotationRecovery?.payload?.drafts.some(value => value.text === draft)));
                    }, {timeout: 15_000}).toBe(true);
                    await page.screenshot({path: resolve(evidenceDir, `protected-${String(retained)}.png`)});
                    // Renderer restart retains the durable browser owner and database.
                    // The fault remains active in the restarted renderer.
                    await page.reload({waitUntil: 'domcontentloaded'});
                    await waitForOpenFileReady(page);
                    await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
                    await expect.poll(() => input.inputValue()).toBe(draft);
                    await page.screenshot({path: resolve(evidenceDir, `restored-${String(retained)}.png`)});
                    await page.evaluate(() => Reflect.set(window, '__noteRecoveryFailure', false));
                    await page.getByRole('button', {
                        name: 'Minimize note',
                        exact: true,
                    }).click();
                    const download = page.waitForEvent('download');
                    await page.getByRole('button', {
                        name: 'Save options',
                        exact: true,
                    }).click();
                    await page.getByRole('menuitem', {name: /^Save As/u}).click();
                    const savedPath = resolve(evidenceDir, `restored-${String(retained)}.pdf`);
                    await (await download).saveAs(savedPath);
                    const saved = await PDFDocument.load(readFileSync(savedPath));
                    const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
                    const texts: string[] = [];
                    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
                        const annotation = annots!.lookup(index, PDFDict);
                        if (annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Text') continue;
                        const text = annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString);
                        if (text) texts.push(text.decodeText());
                    }
                    expect(texts).toEqual([draft]);
                    expect(problems.filter(problem => !problem.includes('1108 sustained note update rejection'))).toEqual([]);
                    observations.push({
                        retained,
                        restoredDraft: draft,
                        savedTexts: texts,
                        problems,
                    });
                } finally {
                    observations.push({
                        retained,
                        problems,
                    });
                    await context.close();
                }
            }
        } finally {
            writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify(observations, null, 2));
            await browser.close();
        }
    }, 120_000);

    it('retains the note draft and actionable cause when a note update rejects', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdf.addPage([
            612,
            792,
        ]).drawText('Note update failure fixture', {
            x: 40,
            y: 740,
            font,
            size: 16,
        });
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-a-1205/app-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const browser = await chromium.launch({headless: true});
        let context: BrowserContext | undefined;
        let problems: string[] = [];
        const observations: unknown[] = [];
        const reason = 'RUX06 note write rejected by document policy';
        try {
            context = await browser.newContext({
                viewport: {
                    width: 1280,
                    height: 800,
                },
                permissions: [
                    'clipboard-read',
                    'clipboard-write',
                ],
                recordVideo: {
                    dir: evidenceDir,
                    size: {
                        width: 1280,
                        height: 800,
                    },
                },
            });
            const page = await context.newPage();
            problems = collectConsoleProblems(page);
            // Setup rejects the document update boundary before it mutates. All
            // editing, Retry, minimize/reopen and Save As use trusted user input.
            await page.route('**/composables/useWorkspaceAnnotationSession.ts*', async route => {
                const response = await route.fetch();
                const body = await response.text();
                const marker = 'const comment = resolveNoteComment(annotationId);';
                if (!body.includes(marker)) throw new Error('Document note update fault seam was not found');
                await route.fulfill({
                    response,
                    body: body.replace(marker, 'if (Reflect.get(window, "__noteUpdateFailure")) throw new Error("RUX06 note write rejected by document policy"); ' + marker),
                });
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, '__noteUpdateFailure', false);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'note-update.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container[data-page="1"] .page_canvas canvas').first().waitFor({state:'visible'});
            // Establish pane layout before note placement and geometry comparison.
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Annotations',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name:'Place a sticky note on the page.',
                exact:true,
            }).click();
            const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const note = page.locator('.note-window').first();
            const input = page.getByRole('textbox', {
                name:'Write annotation note',
                exact:true,
            });
            await input.pressSequentially('Initial accepted note');
            await page.getByRole('button',{
                name:'Minimize note',
                exact:true,
            }).click();
            await page.getByRole('button',{
                name:'Open Note',
                exact:true,
            }).click();
            await expect.poll(() => input.inputValue()).toBe('Initial accepted note');
            // The textarea echoes a draft before persistence. Arm rejection only
            // after the document's rendered list confirms the initial update,
            // so this fault targets one draft rather than two separate edits.
            await expect.poll(() => page.locator('.note-item-text').allTextContents()).toEqual(['Initial accepted note']);
            observations.push({
                step: 'initial-committed',
                text: await page.locator('.note-item-text').allTextContents(),
            });
            const initialRect = await note.boundingBox();
            const initialInputRect = await input.boundingBox();
            await page.evaluate(() => Reflect.set(window,'__noteUpdateFailure',true));
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
            const typingBounds = await input.boundingBox();
            if (!typingBounds) throw new Error('The note input is not visible');
            await page.mouse.move(typingBounds.x + 20, typingBounds.y + 20, {steps: 10});
            await input.fill('Retained RUX06 draft');
            // Either baseline's inline row or the operation toast acknowledges
            // completion, so a missing fault cannot masquerade as a red proof.
            await page.waitForFunction(() => Boolean(document.querySelector('.note-window__error') || Array.from(document.querySelectorAll('[role="alert"]')).some(element => element.textContent?.includes('Unable to update this note.'))));
            observations.push({
                step:'failure',
                text:await input.inputValue(),
                rect:await note.boundingBox(),
                inline:await note.locator('[role="alert"]').count(),
                alerts:await page.locator('[role="alert"]').allTextContents(),
            });
            await page.screenshot({path:resolve(evidenceDir,'failure.png')});
            expect(await input.inputValue()).toBe('Retained RUX06 draft');
            expect(await note.boundingBox()).toEqual(initialRect);
            expect(await input.boundingBox()).toEqual(initialInputRect);
            expect(await note.locator('[role="alert"]').count()).toBe(0);
            const toast = page.locator('.app-toast-failure:not([data-state="closed"])');
            await expect.poll(() => toast.count()).toBe(1);
            await expect.poll(() => toast.innerText()).toContain(reason);
            await expect.poll(() => toast.innerText()).toContain('Error ID');
            const originalErrorId = /Error ID: ([a-f0-9]{8})/u.exec(await toast.innerText())?.[1];
            expect(originalErrorId).toBeTruthy();
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).first().click();
            await expect.poll(() => toast.count()).toBe(1);
            await expect.poll(() => toast.innerText()).toContain(`Error ID: ${originalErrorId}`);
            observations.push({
                step: 'save-blocked',
                toast: await toast.innerText(),
                text: await input.inputValue(),
            });
            await toast.getByRole('button', {
                name: 'Copy details',
                exact: true,
            }).click();
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            expect(copied).toContain(reason);
            expect(copied).toContain(`Error ID: ${originalErrorId}`);
            writeFileSync(resolve(evidenceDir, 'copied.txt'), copied);

            await input.fill('Retained RUX06 draft plus newer typing');
            await page.waitForFunction(previousId => {
                const failure = document.querySelector('.app-toast-failure:not([data-state="closed"])');
                return failure?.textContent?.includes('RUX06 note write rejected by document policy')
                    && !failure.textContent.includes(`Error ID: ${previousId}`);
            }, originalErrorId);
            await expect.poll(() => toast.count()).toBe(1);
            await page.evaluate(() => Reflect.set(window, '__noteUpdateFailure', false));
            await toast.getByRole('button', {
                name: 'Retry',
                exact: true,
            }).click();
            await page.getByRole('button',{
                name:'Minimize note',
                exact:true,
            }).click();
            await page.getByRole('button',{
                name:'Open Note',
                exact:true,
            }).click();
            await expect.poll(() => input.inputValue()).toBe('Retained RUX06 draft plus newer typing');
            expect(await note.locator('[role="alert"]').count()).toBe(0);
            const download = page.waitForEvent('download');
            await page.getByRole('button',{
                name:'Save options',
                exact:true,
            }).click();
            await page.getByRole('menuitem',{name:/^Save As/u}).click();
            const savedPath=resolve(evidenceDir,'saved.pdf');
            await (await download).saveAs(savedPath);
            const saved=await PDFDocument.load(readFileSync(savedPath));
            const annots=saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'),PDFArray);
            const contents: string[]=[];
            for(let i=0;i<(annots?.size()??0);i++) {
                const annotation=annots!.lookup(i,PDFDict);
                if (annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Text') continue;
                const text=annotation.lookupMaybe(PDFName.of('Contents'),PDFString,PDFHexString);
                if(text) contents.push(text.decodeText());
            }
            expect(contents.filter(text=>text==='Retained RUX06 draft plus newer typing')).toHaveLength(1);
            observations.push({
                step:'retry-saved',
                contents,
            });
            const reopenedContext = await browser.newContext({
                viewport: {
                    width: 1280,
                    height: 800,
                },
                recordVideo: {
                    dir: evidenceDir,
                    size: {
                        width: 1280,
                        height: 800,
                    },
                },
            });
            try {
                const reopened = await reopenedContext.newPage();
                const reopenedProblems = collectConsoleProblems(reopened);
                await reopened.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await reopened.goto(origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(reopened);
                keepFileChooserInterceptionEnabled(reopened);
                const reopenedChooser = reopened.waitForEvent('filechooser');
                await reopened.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await reopenedChooser).setFiles(savedPath);
                await reopened.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
                await expect.poll(() => reopened.getByRole('button', {
                    name: 'Open Note',
                    exact: true,
                }).count()).toBe(1);
                await reopened.getByRole('button', {
                    name: 'Open Note',
                    exact: true,
                }).click();
                const reopenedInput = reopened.getByRole('textbox', {
                    name: 'Write annotation note',
                    exact: true,
                });
                await expect.poll(() => reopenedInput.inputValue()).toBe('Retained RUX06 draft plus newer typing');
                observations.push({
                    step: 'saved-reopened',
                    text: await reopenedInput.inputValue(),
                });
                expect(reopenedProblems).toEqual([]);
                await reopened.screenshot({path: resolve(evidenceDir, 'recovered.png')});
            } finally {
                await reopenedContext.close();
            }
            // The injected writer fault is the expected operation failure. Its
            // existing recovery preparation gate is tracked separately in #1108;
            // preserve those exact diagnostics in evidence rather than hiding them.
            const injectedDiagnostics = [
                reason,
                'Open annotation notes could not be prepared for crash recovery.',
                'did not produce a recovery snapshot; retrying without it',
                'Workspace save did not commit {planKind: null, status: not-saved, reason: note-persistence-failed, phase: pre-write}',
            ];
            expect(problems.filter(problem => !injectedDiagnostics.some(diagnostic => problem.includes(diagnostic)))).toEqual([]);

        } finally {
            writeFileSync(resolve(evidenceDir,'observations.json'),JSON.stringify(observations,null,2));
            writeFileSync(resolve(evidenceDir,'console.json'),JSON.stringify(problems,null,2));
            try {await context?.close();} finally {await browser.close();}
        }
    }, 90_000);

    it('retains a fully visible short indicator page while the center enters a tall page', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        for (const [
            index,
            height,
        ] of [
                120,
                1_000,
                600,
            ].entries()) {
            pdf.addPage([
                400,
                height,
            ]).drawText(`Mixed-size reading page ${String(index + 1)}`, {
                x: 24,
                y: height - 40,
                size: 16,
                font,
            });
        }
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), '.devkit/lane-a-rux2', `app-${String(process.pid)}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const browser = await chromium.launch({headless: true});
        const page = await browser.newPage({
            viewport: {
                width: 900,
                height: 700,
            },
            recordVideo: {dir: evidenceDir},
        });
        const problems = collectConsoleProblems(page);
        const observations: unknown[] = [];
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'mixed-size-reading.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container[data-page="1"] .page_canvas canvas').first().waitFor({state: 'visible'});
            const readPosition = () => page.evaluate(() => {
                const first = document.querySelector<HTMLElement>('.page_container[data-page="1"]')!;
                const second = document.querySelector<HTMLElement>('.page_container[data-page="2"]')!;
                const viewport = first.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
                const view = viewport.getBoundingClientRect();
                const rects = [
                    first,
                    second,
                ].map(element => {
                    const rect = element.getBoundingClientRect();
                    const width = Math.max(0, Math.min(rect.right, view.left + viewport.clientWidth) - Math.max(rect.left, view.left));
                    const height = Math.max(0, Math.min(rect.bottom, view.top + viewport.clientHeight) - Math.max(rect.top, view.top));
                    return {
                        top: rect.top,
                        bottom: rect.bottom,
                        height: rect.height,
                        fraction: width * height / (rect.width * rect.height),
                        fullyVisible: width >= rect.width && height >= rect.height,
                    };
                });
                return {
                    indicator: document.querySelector('.page-controls-current-primary')!.textContent!.trim(),
                    top: viewport.scrollTop,
                    centerY: view.top + viewport.clientHeight / 2,
                    rects,
                };
            });
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            const before = await readPosition();
            observations.push({
                step: 'open',
                ...before,
            });
            const viewer = page.locator('[data-document-viewer-chassis-viewport]').first();
            await viewer.hover();
            await page.mouse.wheel(0, 10);
            await expect.poll(async () => (await readPosition()).top).toBeGreaterThan(before.top);
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            const after = await readPosition();
            observations.push({
                step: 'trusted-wheel',
                ...after,
            });
            await page.screenshot({path: resolve(evidenceDir, 'retained.png')});
            expect(after.rects[0]!.fullyVisible).toBe(true);
            expect(after.centerY).toBeGreaterThan(after.rects[1]!.top);
            expect(after.rects[0]!.fraction).toBeGreaterThan(after.rects[1]!.fraction);
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.mouse.wheel(0, 80);
            await expect.poll(async () => (await readPosition()).top).toBeGreaterThan(after.top);
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            const partial = await readPosition();
            observations.push({
                step: 'greatest-fraction',
                ...partial,
            });
            expect(partial.rects[0]!.fullyVisible).toBe(false);
            expect(partial.rects[0]!.fraction).toBeGreaterThan(partial.rects[1]!.fraction);
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.mouse.wheel(0, 300);
            await expect.poll(async () => (await readPosition()).rects[0]!.fraction).toBe(0);
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('2');
            observations.push({
                step: 'short-page-left-viewport',
                ...await readPosition(),
            });
            await page.screenshot({path: resolve(evidenceDir, 'advanced.png')});
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify(observations, null, 2));
            writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
            try {await page.context().close();} finally {await browser.close();}
        }
    }, 90_000);

    it('retains the readable page and retries failed annotation interaction', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const firstPage = pdf.addPage([
            612,
            792,
        ]);
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        firstPage.drawText('First page for annotation recovery proof', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        pdfPage.drawText('Readable page with an interactive link', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [
                72,
                690,
                390,
                720,
            ],
            Dest: [
                firstPage.ref,
                PDFName.of('XYZ'),
                null,
                null,
                null,
            ],
        }))]));
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-a-rux3/app-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const browser = await chromium.launch({headless: true});
        const page = await browser.newPage({
            viewport: {
                width: 1280,
                height: 800,
            },
            recordVideo: {dir: evidenceDir},
        });
        const problems = collectConsoleProblems(page);
        try {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
            // Setup injects a persistent PDF.js render rejection. The document and
            // all Open/Retry/link interactions still use the normal user path.
            await page.route('**/services/pdfjs/pdfViewerFacade.ts*', async route => {
                const response = await route.fetch();
                const body = await response.text();
                const marker = 'return layer.render({';
                if (!body.includes(marker)) throw new Error('PDF.js annotation render fault seam was not found');
                await route.fulfill({
                    response,
                    body: body.replace(marker,
                        'if (Reflect.get(window, "__annotationLayerFailure") && options.page.pageNumber === 2) throw new Error("RUX03 injected annotation stage failure"); ' + marker),
                });
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, '__annotationLayerFailure', false);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'annotation-interaction.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container[data-page="1"] .page_canvas canvas').first().waitFor({state: 'visible'});
            await page.evaluate(() => Reflect.set(window, '__annotationLayerFailure', true));
            await page.getByRole('button', {
                name: 'Next Page',
                exact: true,
            }).first().click();
            const container = page.locator('.page_container[data-page="2"]').first();
            const canvas = container.locator('.page_canvas canvas').first();
            await canvas.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => problems.some(problem => problem.includes('Failed to render annotation layer for page 2'))).toBe(true);
            await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
            await page.screenshot({path: resolve(evidenceDir, 'failed.png')});
            const failed = await container.evaluate(element => ({
                readiness: (element as HTMLElement).dataset.pageLayerReadiness,
                canvases: Array.from(element.querySelectorAll('canvas')).map(item => ({
                    width: item.width,
                    height: item.height,
                })),
                links: element.querySelectorAll('.annotation-layer a').length,
            }));
            writeFileSync(resolve(evidenceDir, 'failed.json'), JSON.stringify({
                failed,
                problems,
            }, null, 2));
            expect(failed.canvases.some(item => item.width > 0 && item.height > 0)).toBe(true);
            expect(failed.links).toBe(0);
            expect(failed.readiness).not.toBe('ready');
            const toast = page.locator('.app-toast-failure:not([data-state="closed"])').first();
            await expect.poll(() => toast.textContent()).toContain('Page 2 links and annotation interactions could not be loaded.');
            const oldWidth = await canvas.evaluate(element => (element as HTMLCanvasElement).width);
            await page.getByRole('button', {
                name: 'Zoom Out',
                exact: true,
            }).first().click();
            await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).width)).not.toBe(oldWidth);
            await expect.poll(() => problems.filter(problem => problem.includes('Failed to render annotation layer for page 2')).length).toBe(2);
            await expect.poll(() => container.getAttribute('data-page-layer-readiness')).toBe('failed');
            await page.evaluate(() => Reflect.set(window, '__annotationLayerFailure', false));
            await toast.getByRole('button', {
                name: 'Retry',
                exact: true,
            }).click();
            const link = container.locator('.pdf-link-overlay[role="link"]').first();
            await link.waitFor({
                state: 'visible',
                timeout: 15_000,
            });
            await expect.poll(() => container.getAttribute('data-page-layer-readiness')).toBe('ready');
            writeFileSync(resolve(evidenceDir, 'recovered-dom.json'), JSON.stringify(await container.evaluate(element => ({
                readiness: (element as HTMLElement).dataset.pageLayerReadiness,
                links: Array.from(element.querySelectorAll('a')).map(item => item.outerHTML),
            })), null, 2));
            await page.screenshot({path: resolve(evidenceDir, 'layer-recovered.png')});
            await link.click();
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.getByRole('button', {
                name: 'Next Page',
                exact: true,
            }).first().click();
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('2');
            await link.waitFor({state: 'visible'});
            await link.focus();
            await page.keyboard.press('Enter');
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.screenshot({path: resolve(evidenceDir, 'recovered.png')});
            expect(problems.filter(problem => !problem.includes('Failed to render annotation layer for page 2'))).toEqual([]);
            expect(problems.filter(problem => problem.includes('Failed to render annotation layer for page 2'))).toHaveLength(2);
        } finally {
            try {
                writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
                // Finalize the renderer recording before the browser process exits.
                await page.context().close();
            } finally {
                await browser.close();
            }
        }
    }, 90_000);

    // C2/L2/A1: foreign icons paint beside the app's single canonical note marker.
    it('loads a foreign attachment icon from the packaged PDF.js image directory', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        const file = pdf.context.register(pdf.context.flateStream('Foreign attachment', {Type: 'EmbeddedFile'}));
        const fileSpec = pdf.context.register(pdf.context.obj({
            Type: 'Filespec',
            F: PDFString.of('foreign.txt'),
            EF: {F: file},
        }));
        const attachment = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'FileAttachment',
            Rect: [
                100,
                600,
                124,
                624,
            ],
            Name: 'Paperclip',
            FS: fileSpec,
            Contents: PDFString.of('Foreign attachment icon'),
        }));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const foreignText = 'Foreign commented highlight text';
        const ownText = 'Own saved highlight text';
        pdfPage.drawText(foreignText, {
            x: 100,
            y: 700,
            size: 14,
            font,
        });
        pdfPage.drawText(ownText, {
            x: 100,
            y: 550,
            size: 14,
            font,
        });
        const highlightWidth = font.widthOfTextAtSize(foreignText, 14);
        const highlight = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Highlight',
            Rect: [
                100,
                697,
                100 + highlightWidth,
                714,
            ],
            QuadPoints: [
                100,
                714,
                100 + highlightWidth,
                714,
                100,
                697,
                100 + highlightWidth,
                697,
            ],
            C: [
                1,
                1,
                0,
            ],
            CA: 0.3,
            Contents: PDFString.of('Foreign highlight popup'),
        }));
        const ink = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Ink',
            Rect: [
                100,
                640,
                180,
                670,
            ],
            InkList: [[
                100,
                650,
                140,
                660,
                180,
                650,
            ]],
            C: [
                0,
                0,
                1,
            ],
            BS: {W: 3},
            Contents: PDFString.of('Foreign ink popup'),
        }));
        pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj([
            attachment,
            highlight,
            ink,
        ]));
        const fixtureBytes = Buffer.from(await pdf.save());
        writeFileSync(resolve(process.cwd(), `.devkit/browser-foreign-attachment-${process.pid}.pdf`), fixtureBytes);
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({
                viewport: {
                    width: 1280,
                    height: 800,
                },
                recordVideo: {dir: resolve(process.cwd(), `.devkit/browser-annotation-icons-${process.pid}`)},
            });
            const cpu = await page.context().newCDPSession(page);
            await cpu.send('Emulation.setCPUThrottlingRate', {rate: 6});
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const responsePromise = page.waitForResponse(response => response.url().endsWith('/annotation-paperclip.svg'));
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'foreign-attachment.pdf',
                mimeType: 'application/pdf',
                buffer: fixtureBytes,
            });
            const response = await responsePromise;
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            const icon = page.locator('.page_container--rendered .fileAttachmentAnnotation img').first();
            await icon.waitFor({state: 'attached'});
            await expect.poll(() => icon.evaluate(image => (image as HTMLImageElement).complete)).toBe(true);
            const nativePopups = page.locator('.popupAnnotation:visible, .popup:visible, .commentPopup:visible');
            const popupObservations: Array<{
                label: string;
                hover: number;
                click: number
            }> = [];
            const hoverAndClick = async (x: number, y: number, label: string) => {
                const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
                if (!bounds) throw new Error(`${label} page is not visible`);
                const px = bounds.x + x * bounds.width / 612;
                const py = bounds.y + (792 - y) * bounds.height / 792;
                await page.mouse.move(px, py);
                await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
                const hover = await nativePopups.count();
                await page.mouse.click(px, py);
                await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
                const click = await nativePopups.count();
                popupObservations.push({
                    label,
                    hover,
                    click,
                });
                await page.mouse.click(px, py);
                await page.mouse.move(0, 0);
            };
            await hoverAndClick(140, 705, 'foreign Highlight');
            await hoverAndClick(140, 660, 'foreign Ink');
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Annotations',
                exact: true,
            }).click();
            await page.locator('.tool-button[data-tool="select"]').click();
            await hoverAndClick(140, 705, 'foreign Highlight in edit mode');
            await hoverAndClick(140, 660, 'foreign Ink in edit mode');
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.sidebar-wrapper').evaluate(
                element => element.getBoundingClientRect().width,
            )).toBe(0);
            const foreignMarkerCount = await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).count();
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.toolbar-group-item--quick-note button')
                .getAttribute('aria-pressed')).toBe('true');
            // Resolve the click from the settled page, rather than a copied bounding box.
            await page.locator('.page_container[data-page="1"]').first().click({position: {
                x: 300,
                y: 300,
            }});
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).pressSequentially('Canonical note beside a foreign attachment');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await expect.poll(() => page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).count()).toBe(foreignMarkerCount + 1);
            expect(await page.locator('.textAnnotation img:visible').count()).toBe(0);
            // Set up an EVB-authored highlight, then exercise its persisted
            // surface through real clicks and text dragging after Save As.
            const createdHighlight = await page.evaluate(async (text) => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                await api.callActiveWorkspaceCommand?.('handleDisableDragMode');
                const span = Array.from(document.querySelectorAll('.text-layer span'))
                    .find(element => element.textContent === text);
                if (!span?.firstChild) throw new Error('Own highlight text is missing');
                const range = document.createRange();
                range.selectNodeContents(span);
                const selection = document.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
                return api.callActiveWorkspaceCommand?.('highlightSelection');
            }, ownText);
            expect(createdHighlight?.value).toBe(true);
            await page.locator('[data-markup-subtype="Highlight"]').last()
                .locator('[data-annotation-hit-target]').first().click({button: 'right'});
            await page.getByRole('menuitem', {
                name: 'Open Pop-up Note',
                exact: true,
            }).click();
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            })
                .pressSequentially('Own saved highlight comment');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            const downloadPromise = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const savedPath = resolve(process.cwd(), `.devkit/browser-foreign-attachment-saved-${process.pid}.pdf`);
            await (await downloadPromise).saveAs(savedPath);
            const savedPdf = await PDFDocument.load(readFileSync(savedPath));
            const savedAnnots = savedPdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            expect(Array.from({length: savedAnnots.size()}, (_, index) =>
                savedAnnots.lookup(index, PDFDict).lookup(PDFName.of('Subtype'), PDFName).toString(),
            ).filter(subtype => subtype === '/Highlight')).toHaveLength(2);
            expect(Array.from({length: savedAnnots.size()}, (_, index) => {
                const annotation = savedAnnots.lookup(index, PDFDict);
                const contents = annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString);
                return contents?.decodeText();
            })).toContain('Own saved highlight comment');
            // Opening the actual downloaded bytes in a fresh browser page
            // proves this is the saved surface, not the unsaved overlay.
            const reopened = await browser.newPage({
                viewport: {
                    width: 1280,
                    height: 800,
                },
                recordVideo: {dir: resolve(process.cwd(), `.devkit/browser-annotation-icons-saved-${process.pid}`)},
            });
            try {
                await reopened.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await reopened.goto(origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(reopened);
                keepFileChooserInterceptionEnabled(reopened);
                const reopenChooser = reopened.waitForEvent('filechooser');
                await reopened.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await reopenChooser).setFiles(savedPath);
                await reopened.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
                await expect.poll(() => reopened.locator('[data-markup-subtype="Highlight"]').count()).toBe(2);
                const savedHighlight = reopened.locator('[data-markup-subtype="Highlight"]').last();
                const hit = savedHighlight.locator('[data-annotation-hit-target]').first();
                const ownLineBounds = await reopened.locator('.text-layer span').filter({hasText: ownText}).first().boundingBox();
                const savedHitBounds = await hit.boundingBox();
                if (!ownLineBounds || !savedHitBounds) throw new Error('Saved highlight is not visible over its text');
                expect(savedHitBounds.x).toBeLessThan(ownLineBounds.x + ownLineBounds.width / 2);
                expect(savedHitBounds.x + savedHitBounds.width).toBeGreaterThan(ownLineBounds.x + ownLineBounds.width / 2);
                expect(savedHitBounds.y).toBeLessThan(ownLineBounds.y + ownLineBounds.height / 2);
                expect(savedHitBounds.y + savedHitBounds.height).toBeGreaterThan(ownLineBounds.y + ownLineBounds.height / 2);
                await hit.click();
                await expect.poll(() => savedHighlight.getAttribute('class')).toContain('is-selected');
                expect(await reopened.locator('.popupAnnotation:visible, .popup:visible, .commentPopup:visible').count()).toBe(0);
                await reopened.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await reopened.getByRole('tab', {
                    name: 'Annotations',
                    exact: true,
                }).click();
                await reopened.locator('.tool-button[data-tool="select"]').click();
                await reopened.mouse.click(100, 200);
                await expect.poll(() => savedHighlight.getAttribute('class')).not.toContain('is-selected');
                await hit.click();
                await expect.poll(() => savedHighlight.getAttribute('class')).toContain('is-selected');
                await reopened.getByRole('button', {
                    name: 'Text Select',
                    exact: true,
                }).click();
                const line = reopened.locator('.text-layer span').filter({hasText: foreignText}).first();
                const lineBounds = await line.boundingBox();
                if (!lineBounds) throw new Error('Commented highlight text is not visible');
                await reopened.mouse.move(lineBounds.x + 1, lineBounds.y + lineBounds.height / 2);
                await reopened.mouse.down();
                await reopened.mouse.move(lineBounds.x + lineBounds.width - 1, lineBounds.y + lineBounds.height / 2, {steps: 12});
                await reopened.mouse.up();
                await expect.poll(() => reopened.evaluate(() => document.getSelection()?.toString())).toBe(foreignText);
                expect(await reopened.locator('.popupAnnotation:visible, .popup:visible, .commentPopup:visible').count()).toBe(0);
                await reopened.screenshot({path: resolve(process.cwd(), `.devkit/browser-annotation-saved-selection-${process.pid}.png`)});
            } finally {
                await reopened.close();
            }
            console.info('Popup observations', JSON.stringify(popupObservations));
            writeFileSync(resolve(process.cwd(), `.devkit/browser-annotation-popups-${process.pid}.json`), JSON.stringify(popupObservations, null, 2));
            for (const observation of popupObservations) {
                expect(observation.hover, `${observation.label} hover`).toBe(0);
                expect(observation.click, `${observation.label} click`).toBe(0);
            }
            const dimensions = await icon.evaluate((image) => {
                const rect = image.getBoundingClientRect();
                return {
                    naturalWidth: (image as HTMLImageElement).naturalWidth,
                    width: rect.width,
                    height: rect.height,
                    imageStyle: image.getAttribute('style'),
                    containerStyle: image.parentElement?.getAttribute('style'),
                    containerDisplay: image.parentElement && getComputedStyle(image.parentElement).display,
                    scaleFactor: getComputedStyle(image).getPropertyValue('--total-scale-factor'),
                };
            });
            const bytes = await response.body();
            const observation = {
                url: new URL(response.url()).pathname,
                status: response.status(),
                sha256: createHash('sha256').update(bytes).digest('hex'),
                ...dimensions,
            };
            console.info('Foreign annotation image', JSON.stringify(observation));
            writeFileSync(resolve(process.cwd(), `.devkit/browser-annotation-icon-${process.pid}.json`), JSON.stringify(observation, null, 2));
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-annotation-icon-${process.pid}.png`)});
            expect(new URL(response.url()).pathname).toBe('/pdfjs/images/annotation-paperclip.svg');
            expect(response.status()).toBe(200);
            expect(bytes).toEqual(readFileSync(resolve(process.cwd(), 'node_modules/pdfjs-dist/web/images/annotation-paperclip.svg')));
            expect(dimensions.naturalWidth).toBeGreaterThan(0);
            expect(dimensions.width).toBeGreaterThan(0);
            expect(dimensions.height).toBeGreaterThan(0);
            expect(await icon.isVisible()).toBe(true);
            const paintedIcon = await loadImage(Buffer.from(await icon.screenshot()));
            const iconContext = createCanvas(paintedIcon.width, paintedIcon.height).getContext('2d');
            iconContext.drawImage(paintedIcon, 0, 0);
            const pixels = iconContext.getImageData(0, 0, paintedIcon.width, paintedIcon.height).data;
            let inkPixels = 0;
            for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index]! < 128 && pixels[index + 1]! < 128 && pixels[index + 2]! < 128) {
                    inkPixels += 1;
                }
            }
            expect(inkPixels).toBeGreaterThan(0);
            expect(consoleProblems).toEqual([]);
        } finally {
            await Promise.all(browser.contexts().map(context => context.close()));
            await browser.close();
        }
    }, 90_000);

    it('keeps the performance restart notice through Settings remount until reload', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({recordVideo: {dir: resolve(process.cwd(), '.devkit/lane-b/evidence/op-03-video')}});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            const settings = page.locator('nav[aria-label="Workspace"]').getByRole('button', {
                name: 'Settings',
                exact: true,
            });
            const notice = page.locator('.settings-performance-restart-notice');
            const chooseMode = async (label: string, mode: string) => {
                await page.getByRole('button', {
                    name: 'Performance mode',
                    exact: true,
                }).click();
                await page.getByRole('option', {
                    name: label,
                    exact: true,
                }).click();
                await page.waitForFunction(value => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').performanceMode === value, mode);
            };
            await settings.click();
            expect(await notice.count()).toBe(0);
            await chooseMode('Low — minimize background work', 'low');
            await expect.poll(() => notice.textContent()).toBe('Restart to apply this change.');
            await page.getByRole('button', {
                name: 'Recent Files',
                exact: true,
            }).click();
            await settings.click();
            await page.getByRole('button', {
                name: 'Performance mode',
                exact: true,
            }).click();
            await page.keyboard.press('Escape');
            await page.getByRole('listbox').waitFor({state: 'hidden'});
            await page.screenshot({path: resolve(process.cwd(), '.devkit/lane-b/evidence/op-03-remount.png')});
            expect(await notice.count()).toBe(1);
            expect(await notice.textContent()).toBe('Restart to apply this change.');
            expect(await notice.isVisible()).toBe(true);
            await chooseMode('Auto (recommended)', 'auto');
            await expect.poll(() => notice.count()).toBe(0);
            await chooseMode('Low — minimize background work', 'low');
            await expect.poll(() => notice.count()).toBe(1);
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await settings.click();
            expect(await notice.count()).toBe(0);
            await chooseMode('Auto (recommended)', 'auto');
            await expect.poll(() => notice.count()).toBe(1);
            await chooseMode('Low — minimize background work', 'low');
            await expect.poll(() => notice.count()).toBe(0);
        } finally {
            await browser.close();
        }
    }, 120_000);

    // T4: every accepted note belongs to the document's Save As frontier.
    it.each([
        'single',
        'split',
    ])('writes the accepted note through browser Save As from %s view', async (view) => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1600,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const fixture = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
            await (await chooser).setFiles(fixture);
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const text = 'Accepted note survives information routes';
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).pressSequentially(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            expect(await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            if (view === 'split') {
                await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
                await page.getByRole('menuitem', {
                    name: 'Split Right',
                    exact: true,
                }).click();
                await expect.poll(() => page.locator('.editor-pane').count()).toBe(2);
                const panes = await page.locator('.editor-pane').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.editorPaneId!));
                const right = panes[1]!;
                await page.locator(`${paneSelector(right)} .page_container--rendered canvas`).first().waitFor({timeout: 30000});
                await zoomActivePane(page, right, 'Zoom Out', 1);
            }
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
            const savedContents: string[] = [];
            const downloads: Array<Promise<void>> = [];
            page.on('download', download => {
                const index = downloads.length;
                downloads.push((async () => {
                    const path = resolve(process.cwd(), `.devkit/browser-save-as-${process.pid}-${view}-${index}.pdf`);
                    await download.saveAs(path);
                    const bytes = readFileSync(path);
                    const pdf = await PDFDocument.load(bytes);
                    for (const pdfPage of pdf.getPages()) {
                        const annotations = pdfPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
                        for (let i = 0; i < (annotations?.size() ?? 0); i += 1) {
                            const annotation = annotations!.lookup(i, PDFDict);
                            const contents = annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString);
                            if (contents) savedContents.push(contents.decodeText());
                        }
                    }
                    console.info('SAVE_AS_BYTES', JSON.stringify({
                        view,
                        path,
                        byteLength: bytes.length,
                        originalChecksum: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
                        savedChecksum: createHash('sha256').update(bytes).digest('hex'),
                        savedContents,
                    }));
                })());
            });
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            try {
                await expect.poll(() => savedContents, {timeout: 30000}).toContain(text);
            } finally {
                await Promise.all(downloads);
            }
        } finally {
            await browser.close();
        }
    }, 120000);
    it('withdraws hosted diagnostics in another open window and allows an explicit regrant', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const context = await browser.newContext({recordVideo: {dir: resolve(process.cwd(), '.devkit/lane-b/evidence/op-02-video')}});
            const envelopes: string[] = [];
            await context.route('**/api/1/envelope/**', async (route) => {
                envelopes.push(route.request().postData() ?? '');
                await route.fulfill({
                    status: 200,
                    body: '{}',
                });
            });
            await context.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            const first = await context.newPage();
            await first.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(first);
            await first.getByRole('button', {
                name: 'Settings',
                exact: true,
            }).filter({visible: true}).first().click();
            const consent = first.getByRole('switch', {
                name: 'Send privacy-sanitized error diagnostics',
                exact: true,
            });
            await consent.check();
            await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'granted');

            const second = await context.newPage();
            await second.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(second);
            await second.getByRole('button', {
                name: 'Settings',
                exact: true,
            }).filter({visible: true}).first().click();
            const remoteConsent = second.getByRole('switch', {
                name: 'Send privacy-sanitized error diagnostics',
                exact: true,
            });
            const author = second.getByRole('textbox', {
                name: 'Author Name',
                exact: true,
            });
            async function reportInputFailure(phase: string) {
                const previousIds = await second.locator('.app-toast-error-id').allTextContents();
                // Fault a real input handler, then reach it through trusted keyboard
                // input. Unique causes prevent Sentry deduplication hiding a send.
                await second.evaluate((message) => {
                    document.querySelector('#settings-author')!.addEventListener('keydown', () => {
                        throw new Error(message);
                    }, {once: true});
                }, phase);
                await author.press('ArrowRight');
                const receipt = await second.waitForFunction((previous) => {
                    const id = Array.from(document.querySelectorAll('.app-toast-error-id'))
                        .map(element => element.textContent ?? '')
                        .find(text => !previous.includes(text));
                    return id?.replace('Error ID: ', '');
                }, previousIds);
                const id = await receipt.jsonValue();
                if (!id) throw new Error('The visible failure has no Error ID');
                return id;
            }
            const grantedId = await reportInputFailure('granted-control');
            await expect.poll(() => envelopes.some(body => body.includes(grantedId))).toBe(true);
            // The withdrawal happens while the second window cannot run, so it
            // must reach that window when it resumes, before its next report.
            const resumeSecond = await freezeWindow(context, second);
            await consent.uncheck();
            await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'denied');
            await resumeSecond();
            await author.fill('After withdrawal');
            await second.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').authorName === 'After withdrawal');
            const withdrawnId = await reportInputFailure('withdrawn-control');
            const checkedAfterWithdrawal = await remoteConsent.isChecked();
            await consent.check();
            await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'granted');
            await expect.poll(() => remoteConsent.isChecked()).toBe(true);
            const regrantedId = await reportInputFailure('regranted-control');
            await expect.poll(() => envelopes.some(body => body.includes(regrantedId))).toBe(true);
            console.info('Hosted consent evidence', JSON.stringify({
                granted: envelopes.some(body => body.includes(grantedId)),
                withdrawn: envelopes.some(body => body.includes(withdrawnId)),
                regranted: envelopes.some(body => body.includes(regrantedId)),
                checkedAfterWithdrawal,
            }));
            expect(envelopes.some(body => body.includes(withdrawnId))).toBe(false);
            expect(checkedAfterWithdrawal).toBe(false);
        } finally {
            await browser.close();
        }
    }, 120_000);

    // T2/T4: reading an information page keeps accepted work and both live views.
    it('preserves an unsaved note and linked view zoom through Privacy and About routes', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({
                viewport: {
                    width: 1_600,
                    height: 900,
                },
                recordVideo: {dir: resolve(process.cwd(), '.devkit/browser-information-video')},
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'));
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const text = 'Accepted note survives information routes';
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).pressSequentially(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            expect(await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
            await page.getByRole('menuitem', {
                name: 'Split Right',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.editor-pane').count()).toBe(2);
            const panes = await page.locator('.editor-pane').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.editorPaneId!));
            const right = panes[1]!;
            await page.locator(`${paneSelector(right)} .page_container--rendered canvas`).first().waitFor({timeout: 30_000});
            await zoomActivePane(page, right, 'Zoom Out', 1);
            const widths = await Promise.all(panes.map(pane => readPanePageWidth(page, pane)));
            expect(widths[0]).not.toBe(widths[1]);
            await page.screenshot({path: resolve(process.cwd(), '.devkit/browser-information-before.png')});

            for (const informationPage of [
                'privacy',
                'about',
            ]) {
                if (informationPage === 'privacy') {
                    await page.locator(`${paneSelector(right)} .pdf-annotation-editor-note`).last().click();
                    await page.getByRole('button', {
                        name: 'Minimize note',
                        exact: true,
                    }).click();
                    expect(await page.locator(`${paneSelector(right)} .pdf-annotation-editor-note.is-selected`).count()).toBe(1);
                } else {
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                    await page.locator(`${paneSelector(right)} [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle`).click();
                    expect(await page.locator(`${paneSelector(right)} [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle`).getAttribute('aria-pressed')).toBe('true');
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                }
                const currentPage = await page.locator('.page-controls-current-primary:visible').textContent();
                const activeTabs = await page.locator('.tab.is-active[data-tab-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-tab-id')));
                let unexpectedChoosers = 0;
                let unexpectedDownloads = 0;
                const onChooser = () => { unexpectedChoosers += 1; };
                const onDownload = () => { unexpectedDownloads += 1; };
                page.on('filechooser', onChooser);
                page.on('download', onDownload);
                await page.getByRole('button', {
                    name: 'Settings',
                    exact: true,
                }).filter({visible: true}).first().click();
                const tabCount = await page.locator('.tab[data-tab-id]').count();
                await page.getByRole('link', {
                    name: informationPage === 'privacy'
                        ? 'Read the complete privacy notice' : 'Open About and Acknowledgements',
                    exact: true,
                }).filter({visible: true}).click();
                await expect.poll(() => new URL(page.url()).pathname).toBe(`/${informationPage}`);
                await page.locator(`.${informationPage}-document h1`).waitFor();
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}.png`)});
                const documentKeys = [
                    'Backspace',
                    'Delete',
                    'Control+s',
                    'PageDown',
                    'Control+=',
                    'Control+b',
                ];
                for (const key of documentKeys) {
                    await page.keyboard.press(key);
                }
                // Window-level tab and file accelerators must also belong to
                // the visible shell, rather than its retained document owner.
                await page.keyboard.press('Control+Shift+Tab');
                for (const key of [
                    ...documentKeys,
                    'Control+o',
                ]) {
                    await page.keyboard.press(key);
                }
                if (informationPage === 'about') {
                    await page.getByRole('link', {
                        name: 'Back to viewer',
                        exact: true,
                    }).click();
                } else {
                    await page.goBack();
                }
                await expect.poll(() => new URL(page.url()).pathname).toBe('/');
                await page.locator('.editor-pane .tab[data-tab-id]').first().waitFor();
                page.off('filechooser', onChooser);
                page.off('download', onDownload);
                expect(unexpectedChoosers).toBe(0);
                expect(unexpectedDownloads).toBe(0);
                expect(await page.locator('.tab[data-tab-id]').count()).toBe(tabCount);
                // Settings itself is a new empty tab; the document tab in
                // each pane remains selected when returning to it below.
                expect(await page.locator(`${paneSelector(panes[0]!)} .tab.is-active[data-tab-id]`).getAttribute('data-tab-id')).toBe(activeTabs[0]);
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}-returned-shell.png`)});
                await page.locator(`${paneSelector(right)} .tab`).filter({hasText: 'generated-text.pdf'}).click();
                await page.locator('.page-controls-current-primary:visible').waitFor();
                expect(await page.locator('.page-controls-current-primary:visible').textContent()).toBe(currentPage);
                await page.getByRole('button', {
                    name: 'Open Note',
                    exact: true,
                }).filter({visible: true}).last().click();
                expect(await page.getByRole('textbox', {
                    name: 'Write annotation note',
                    exact: true,
                }).inputValue()).toBe(text);
                await page.getByRole('button', {
                    name: 'Minimize note',
                    exact: true,
                }).click();
                expect(await page.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).isEnabled()).toBe(true);
                if (informationPage === 'about') {
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                    expect(await page.locator(`${paneSelector(right)} [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle`).getAttribute('aria-pressed')).toBe('true');
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                }
                expect(await Promise.all(panes.map(pane => readPanePageWidth(page, pane)))).toEqual(widths);
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}-return.png`)});
            }
        } finally {
            await browser.close();
        }
    }, 90_000);

    // T3/C2, issue #1037: foreign FreeText is printable when its viewer supplies
    // the appearance. Explicit /AP remains authoritative (ADR 0003).
    it('prints existing FreeText without AP and preserves explicit appearances', async () => {
        const evidence = resolve(process.cwd(), `.devkit/1037/browser-${process.pid}`);
        mkdirSync(evidence, {recursive: true});
        const browser = await chromium.launch({headless: true});
        const page = await browser.newPage({
            viewport: {
                width: 1_280,
                height: 800,
            },
            recordVideo: {dir: evidence},
        });
        const problems = collectConsoleProblems(page);
        let printStartedAt: number | undefined;
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                window.print = () => {
                    const canvas = document.querySelector<HTMLCanvasElement>('.browser-print-page canvas');
                    if (!canvas) throw new Error('No printed page');
                    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
                    const red: number[][] = [];
                    const cyan: number[][] = [];
                    for (let index = 0; index < pixels.length; index += 4) {
                        const point = [
                            (index / 4) % canvas.width / canvas.width,
                            Math.floor(index / 4 / canvas.width) / canvas.height,
                        ];
                        if (pixels[index]! > 150 && pixels[index + 1]! < 100 && pixels[index + 2]! < 100) red.push(point);
                        if (pixels[index]! < 100 && pixels[index + 1]! > 150 && pixels[index + 2]! > 150) cyan.push(point);
                    }
                    Reflect.set(window.top!, '__freeTextPrint', {
                        red,
                        cyan,
                        image: canvas.toDataURL(),
                    });
                };
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const pdf = await PDFDocument.load(readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')));
            const first = pdf.getPage(0);
            const annotations = first.node.lookup(PDFName.of('Annots'), PDFArray);
            annotations.push(pdf.context.register(pdf.context.obj({
                Type: 'Annot',
                Subtype: 'FreeText',
                F: 4,
                Rect: [
                    72,
                    550,
                    350,
                    630,
                ],
                Contents: PDFHexString.fromText('Foreign FreeText\nПривет мир'),
                DA: PDFString.of('/Helvetica 18 Tf 1 0 0 rg'),
            })));
            const appearance = pdf.context.register(pdf.context.flateStream('0 1 1 rg 0 0 80 80 re f', {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [
                    0,
                    0,
                    80,
                    80,
                ],
                Resources: {},
            }));
            annotations.push(pdf.context.register(pdf.context.obj({
                Type: 'Annot',
                Subtype: 'FreeText',
                F: 4,
                Rect: [
                    400,
                    550,
                    480,
                    630,
                ],
                Contents: PDFString.of('Explicit AP overrides this red text'),
                DA: PDFString.of('/Helvetica 18 Tf 1 0 0 rg'),
                AP: {N: appearance},
            })));
            const input = Buffer.from(await pdf.save());
            writeFileSync(resolve(evidence, 'input.pdf'), input);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'foreign-freetext-print.pdf',
                mimeType: 'application/pdf',
                buffer: input,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.screenshot({path: resolve(evidence, 'opened.png')});
            printStartedAt = Date.now();
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__freeTextPrint'))), {timeout: 15_000}).toBe(true);
            const output = await page.evaluate(() => Reflect.get(window, '__freeTextPrint') as {
                red: number[][];
                cyan: number[][];
                image: string;
            });
            writeFileSync(resolve(evidence, 'printed.png'), Buffer.from(output.image.split(',')[1]!, 'base64'));
            writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({
                elapsedMs: Date.now() - printStartedAt,
                red: output.red.length,
                cyan: output.cyan.length,
                problems,
            }));
            expect(output.red.length).toBeGreaterThan(200);
            expect(output.cyan.length).toBeGreaterThan(1_000);
            // A4 fit centers the letter page vertically. Both appearances keep
            // their source rectangles, and the explicit AP never becomes text.
            expect(output.red.every(([
                x,
                y,
            ]) => x! >= 72 / 612 && x! < 350 / 612 && y! > 0.2 && y! < 0.34)).toBe(true);
            expect(output.cyan.every(([
                x,
                y,
            ]) => x! > 0.65 && x! < 0.79 && y! > 0.2 && y! < 0.34)).toBe(true);
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidence, 'console.json'), JSON.stringify(problems));
            await page.screenshot({path: resolve(evidence, 'final.png')});
            await browser.close();
        }
    }, 90_000);

    // T2/T3, issue #1027: accepted note text reaches recovery bytes, and its
    // icon reaches the printed canvas while the original remains unsaved.
    it('materializes an unsaved note for browser recovery and print without saving the original', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 800,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                // Observe the system-print boundary in every frame without
                // opening a native dialog. The canvas is the printed artifact.
                window.print = () => {
                    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.browser-print-page canvas')];
                    let yellowPixels = 0;
                    for (const canvas of canvases) {
                        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
                        if (!pixels) throw new Error('The print canvas has no pixels');
                        for (let index = 0; index < pixels.length; index += 4) {
                            if (pixels[index]! > 150 && pixels[index + 1]! > 100 && pixels[index + 2]! < 100) {
                                yellowPixels += 1;
                            }
                        }
                    }
                    Reflect.set(window.top!, '__printedNote', {
                        pages: canvases.length,
                        yellowPixels,
                    });
                };
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            // A clean document isolates a newly created /Text note from
            // foreign annotations whose missing appearances have other causes.
            const pdf = await PDFDocument.create();
            const font = await pdf.embedFont(StandardFonts.Helvetica);
            pdf.addPage([
                612,
                792,
            ]).drawText('Browser sticky-note print regression', {
                x: 72,
                y: 720,
                font,
                size: 18,
            });
            await (await chooser).setFiles({
                name: 'browser-note-print.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const text = 'Recovery descriptor regression note';
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).pressSequentially(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            expect(await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => Reflect.get(window, '__printedNote')?.yellowPixels ?? 0), {timeout: 15_000}).toBeGreaterThan(50);
            expect(await page.evaluate(() => Reflect.get(window, '__printedNote').pages)).toBeGreaterThan(0);
            await expect.poll(async () => {
                const rows = await page.evaluate(async () => {
                    const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                        const request = indexedDB.open('evb-viewer-browser-documents');
                        request.onsuccess = () => resolveDb(request.result);
                        request.onerror = () => rejectDb(request.error);
                    });
                    try {
                        const rows = await new Promise<Array<{
                            ref: string;
                            fileName: string;
                            kind: string
                        }>>((resolveRows, rejectRows) => {
                            const request = db.transaction('documents', 'readonly').objectStore('documents').getAll();
                            request.onsuccess = () => resolveRows(request.result);
                            request.onerror = () => rejectRows(request.error);
                        });
                        return rows;
                    } finally {
                        db.close();
                    }
                });
                const bytes = await Promise.all(rows.map(row => readPersistedDocumentBytes(page, row.ref)));
                const encoded = [...text].map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
                return {
                    recovered: rows.some((row, index) => row.fileName.endsWith('.recovery.pdf') && new TextDecoder().decode(Uint8Array.from(bytes[index]!)).toLowerCase().includes(encoded)),
                    originalChanged: rows.some((row, index) => row.kind === 'source' && new TextDecoder().decode(Uint8Array.from(bytes[index]!)).toLowerCase().includes(encoded)),
                };
            }, {timeout: 15_000}).toEqual({
                recovered: true,
                originalChanged: false,
            });
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
        } finally {
            await browser.close();
        }
    }, 90_000);

    // T2 (#1284): a frozen or throttled window is alive while it holds its
    // lease lock. A second window must not take its recovery record, or the
    // owner fences itself on resume and its later notes have no recovery copy.
    it('leaves a frozen window its recovery and recovers its later notes after it closes', async () => {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdf.addPage([
            612,
            792,
        ]).drawText('Frozen owner recovery', {
            x: 72,
            y: 720,
            font,
            size: 18,
        });
        const source = Buffer.from(await pdf.save());
        const firstNote = 'Note before the freeze';
        const secondNote = 'Note after the resume';
        const consoleProblems: string[][] = [];
        const browser = await chromium.launch({headless: true});
        try {
            const context = await browser.newContext({viewport: {
                width: 1_280,
                height: 800,
            }});
            await context.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            async function openWindow(prepare?: (page: Page) => Promise<unknown>) {
                const page = await context.newPage();
                consoleProblems.push(collectConsoleProblems(page));
                await prepare?.(page);
                await page.goto(origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
                return page;
            }
            const owner = await openWindow();
            keepFileChooserInterceptionEnabled(owner);
            const chooser = owner.waitForEvent('filechooser');
            await owner.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'frozen-owner.pdf',
                mimeType: 'application/pdf',
                buffer: source,
            });
            await owner.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await addNote(owner, firstNote, {
                x: 200,
                y: 200,
            });
            await expect.poll(async () => (await readRecoveries(owner)).map(record => [...record.notes]), {timeout: 15_000})
                .toEqual([[firstNote]]);
            const [ownerRecord] = await readRecoveries(owner);
            const ownerId = ownerRecord!.ownerId;
            await expect.poll(async () => (await readLeaseOwnerLocks(owner)).held, {timeout: 15_000}).toContain(ownerId);

            const resumeOwner = await freezeWindow(context, owner);

            // The second window starts as if the owner had been silent for a
            // minute: its clock runs 60 s ahead, past the 30 s after which a
            // silent owner's heartbeat no longer protects its record.
            const second = await openWindow(page => page.addInitScript((aheadMs) => {
                const now = Date.now.bind(Date);
                Date.now = () => now() + aheadMs;
            }, 60_000));
            expect((await readLeaseOwnerLocks(second)).held).toContain(ownerId);
            expect((await readRecoveries(second)).map(record => record.ownerId)).toEqual([ownerId]);
            expect(await second.locator('.page_container').count()).toBe(0);

            await resumeOwner();
            await addNote(owner, secondNote, {
                x: 300,
                y: 400,
            });
            await expect.poll(async () => (await readRecoveries(second)).map(record => [
                record.ownerId,
                [...record.notes].sort(),
            ]), {timeout: 15_000}).toEqual([[
                ownerId,
                [
                    secondNote,
                    firstNote,
                ].sort(),
            ]]);

            // Closing the window releases its lock, the browser's proof that
            // the owner is gone; its record is recoverable at once.
            await owner.close();
            await expect.poll(async () => (await readLeaseOwnerLocks(second)).held, {timeout: 15_000}).not.toContain(ownerId);
            const recovered = await openWindow();
            await recovered.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await expect.poll(
                () => recovered.locator('.pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind="note"]').count(),
                {timeout: 15_000},
            ).toBe(2);
            const download = recovered.waitForEvent('download');
            await recovered.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await recovered.getByRole('menuitem', {name: /^Save As/u}).click();
            const saved = await PDFDocument.load(readFileSync(await (await download).path()));
            expect(noteTexts(saved)).toEqual(new Set([
                firstNote,
                secondNote,
            ]));
            expect(consoleProblems.flat()).toEqual([]);
        } finally {
            await browser.close();
        }
    }, 90_000);

    // T2 (#1313): a duplicated tab copies window.name, so two windows start
    // with one owner id. If the window holding the owner's lease lock gave
    // up the id and kept the lock, the copy waited for that lock forever and
    // none of its notes reached recovery, and the lock outlived the copy, so
    // no other window could recover its record after it closed.
    it.each([
        true,
        false,
    ])('keeps a duplicated window\'s notes recoverable (Web Locks: %s)', async (hasWebLocks) => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-duplicate-${process.pid}-${hasWebLocks ? 'locks' : 'no-locks'}`);
        mkdirSync(evidenceDir, {recursive: true});
        const consoleProblems: string[][] = [];
        const browser = await chromium.launch({headless: true});
        try {
            const context = await browser.newContext({viewport: {
                width: 1_280,
                height: 800,
            }});
            await context.addInitScript((hasLocks) => {
                if (!hasLocks) Object.defineProperty(navigator, 'locks', {value: undefined});
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            }, hasWebLocks);
            async function openWindow(prepare?: (page: Page) => Promise<unknown>) {
                const page = await context.newPage();
                consoleProblems.push(collectConsoleProblems(page));
                keepFileChooserInterceptionEnabled(page);
                await prepare?.(page);
                await page.goto(origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
                return page;
            }
            async function openPdf(page: Page, fileName: string) {
                const pdf = await PDFDocument.create();
                const font = await pdf.embedFont(StandardFonts.Helvetica);
                pdf.addPage([
                    612,
                    792,
                ]).drawText(fileName, {
                    x: 72,
                    y: 720,
                    font,
                    size: 18,
                });
                const chooser = page.waitForEvent('filechooser');
                await page.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await chooser).setFiles({
                    name: fileName,
                    mimeType: 'application/pdf',
                    buffer: Buffer.from(await pdf.save()),
                });
                await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            }

            const original = await openWindow();
            await openPdf(original, 'original.pdf');
            await addNote(original, 'Original note', {
                x: 200,
                y: 200,
            });
            await expect.poll(async () => (await readRecoveries(original)).map(record => [...record.notes]), {timeout: 15_000})
                .toEqual([['Original note']]);
            const [originalRecord] = await readRecoveries(original);
            const originalOwnerId = originalRecord!.ownerId;
            if (hasWebLocks) {
                await expect.poll(async () => (await readLeaseOwnerLocks(original)).held, {timeout: 15_000})
                    .toEqual([originalOwnerId]);
            }
            const readOriginalRecovery = (page: Page) => page.evaluate<Awaited<ReturnType<typeof loadBrowserWorkspaceRecovery>>>(`(async () => {
                const {loadBrowserWorkspaceRecovery} = await import('/_nuxt/platform/browser/browserWorkspaceRecoveryStore.ts');
                return loadBrowserWorkspaceRecovery(${JSON.stringify(originalOwnerId)});
            })()`);
            const beforeFreeze = await readOriginalRecovery(original);
            if (!beforeFreeze) throw new Error('The original has no recovery record before freezing');
            expect(Date.now() - beforeFreeze.updatedAt).toBeLessThan(30_000);
            const resumeOriginal = await freezeWindow(context, original);
            console.info('Frozen duplicate setup', JSON.stringify({
                originalOwnerId,
                heartbeatAt: beforeFreeze.updatedAt,
            }));

            // The copy's instance nonce sorts first, so the nonces alone would
            // make the original give up the id. It cannot answer discovery
            // while frozen: its lock, or its fresh heartbeat without Web Locks,
            // must keep the copy from taking over the original's journal.
            const copy = await openWindow(page => page.addInitScript((windowName) => {
                if (!window.name) window.name = windowName;
                Reflect.set(window, '__evbBrowserWindowTabsState', {recoveryInstanceNonce: '!'});
                if (!navigator.locks) {
                    // Reload at the first asynchronous discovery wait, before
                    // an unproven inherited owner could finish its claim.
                    const setWindowTimeout = window.setTimeout.bind(window);
                    Reflect.set(window, 'setTimeout', (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
                        if (timeout === 60 && !sessionStorage.getItem('evb-test:duplicate-reloaded')) {
                            sessionStorage.setItem('evb-test:duplicate-reloaded', '1');
                            window.location.reload();
                            return 0;
                        }
                        return setWindowTimeout(handler, timeout, ...args);
                    });
                }
            }, `evb-viewer-window:${originalOwnerId.slice('window:'.length)}`));
            if (!hasWebLocks) expect(await copy.evaluate(() => performance.getEntriesByType('navigation')
                .some(entry => 'type' in entry && entry.type === 'reload'))).toBe(true);
            const copyOwnerId = await copy.evaluate(() => `window:${window.name.slice('evb-viewer-window:'.length)}`);
            expect(copyOwnerId).not.toBe(originalOwnerId);
            expect(await copy.locator('.page_container').count()).toBe(0);
            expect(await readOriginalRecovery(copy)).toEqual(beforeFreeze);
            if (hasWebLocks) expect(await readLeaseOwnerLocks(copy)).toEqual({
                held: [
                    originalOwnerId,
                    copyOwnerId,
                ].sort(),
                pending: [],
            });
            console.info('Frozen duplicate started', JSON.stringify({
                originalOwnerId,
                copyOwnerId,
            }));
            await resumeOriginal();
            await openPdf(copy, 'copy.pdf');
            await addNote(copy, 'Copy note', {
                x: 200,
                y: 200,
            });
            await addNote(original, 'Second original note', {
                x: 300,
                y: 400,
            });
            await expect.poll(async () => (await readRecoveries(original)).flatMap(record => [...record.notes]), {timeout: 15_000})
                .toEqual(expect.arrayContaining([
                    'Copy note',
                    'Second original note',
                ]));
            const records = await readRecoveries(original);
            const ownerOf = (note: string) => records.find(record => record.notes.has(note))!.ownerId;
            // Each owner id's lock is held, and no window waits for one.
            if (hasWebLocks) expect(await readLeaseOwnerLocks(original)).toEqual({
                held: [
                    ownerOf('Copy note'),
                    ownerOf('Second original note'),
                ].sort(),
                pending: [],
            });
            expect(records.map(record => [...record.notes].sort().join(', ')).sort()).toEqual([
                'Copy note',
                'Original note, Second original note',
            ]);

            if (!hasWebLocks) {
                // Reload replaces this context, so it recovers its own fresh
                // journal while leaving the original window's work intact.
                await copy.reload({waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(copy);
                await copy.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
                expect(await copy.evaluate(() => `window:${window.name.slice('evb-viewer-window:'.length)}`)).toBe(copyOwnerId);
                const download = copy.waitForEvent('download');
                await copy.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).click();
                await copy.getByRole('menuitem', {name: /^Save As/u}).click();
                const savedPath = resolve(evidenceDir, 'reloaded-copy.pdf');
                await (await download).saveAs(savedPath);
                const saved = await PDFDocument.load(readFileSync(savedPath));
                expect(noteTexts(saved)).toEqual(new Set(['Copy note']));
                await expect.poll(async () => (await readRecoveries(original)).map(record => [...record.notes].sort()), {timeout: 15_000})
                    .toEqual([[
                        'Original note',
                        'Second original note',
                    ]]);
                writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify({
                    originalOwnerId,
                    copyOwnerId,
                    beforeFreeze,
                    afterOriginalEdit: await readOriginalRecovery(original),
                    savedCopyNotes: [...noteTexts(saved)],
                    problems: consoleProblems.flat(),
                }, null, 2));
                expect(consoleProblems.flat()).toEqual([]);
                return;
            }

            // Closing the copy releases its lock and only its lock, and its
            // record is recoverable at once.
            await copy.close();
            await expect.poll(async () => (await readLeaseOwnerLocks(original)).held, {timeout: 15_000})
                .toEqual([ownerOf('Second original note')]);
            const recovered = await openWindow();
            await recovered.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await expect.poll(
                () => recovered.locator('.pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind="note"]').count(),
                {timeout: 15_000},
            ).toBe(1);
            expect(await recovered.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent()).toContain('copy.pdf');
            expect(consoleProblems.flat()).toEqual([]);
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('opens URI destinations by pointer and Enter with no opener or console failure', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-external-url-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const destination = `${origin}/privacy-policy`;
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const sourcePage = pdf.addPage([
            612,
            792,
        ]);
        sourcePage.drawText('Open privacy policy', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        sourcePage.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [
                72,
                694,
                260,
                722,
            ],
            Border: [
                0,
                0,
                0,
            ],
            A: {
                S: 'URI',
                URI: PDFString.of(destination),
            },
        }))]));
        const bytes = Buffer.from(await pdf.save());
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const observations: Array<{
            input: string;
            url: string;
            opener: boolean
        }> = [];
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles({
                name: 'external-uri.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const link = page.locator('.pdf-link-overlay').first();
            await link.waitFor({state: 'visible'});
            for (const input of [
                'pointer',
                'Enter',
            ]) {
                const openedPage = context.waitForEvent('page');
                if (input === 'pointer') {
                    await link.click();
                } else {
                    await link.focus();
                    await link.press('Enter');
                }
                const destinationPage = await openedPage;
                await destinationPage.waitForURL(destination);
                await destinationPage.waitForLoadState('domcontentloaded');
                const opener = await destinationPage.evaluate(() => window.opener !== null);
                observations.push({
                    input,
                    url: destinationPage.url(),
                    opener,
                });
                expect(destinationPage.url()).toBe(destination);
                expect(opener).toBe(false);
                await destinationPage.close();
            }
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'result.json'), JSON.stringify({
                observations,
                problems,
            }, null, 2));
            await browser.close();
        }
    }, 120_000);

    it('starts and opens a PDF without desktop diagnostics or recovery warnings under an Electron-shaped user agent', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            // Embedded Electron-based browsers report this user agent without
            // installing the EVB preload bridge.
            const page = await browser.newPage({
                userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) T3Code(Nightly)/0.0.44 Chrome/146.0.0.0 Electron/44.4.2 Safari/537.36',
                viewport: {
                    width: 1_280,
                    height: 900,
                },
            });
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            expect(await page.evaluate(() => 'electronAPI' in window)).toBe(false);
            expect(await page.locator('.app-toast-failure').count()).toBe(0);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');

            // The reported tab opened in the background. Headless Chromium
            // keeps every page visible, so emulate the tab being hidden and
            // shown again; showing it heartbeats the recovery lease.
            for (const visibilityState of [
                'hidden',
                'visible',
            ]) {
                await page.evaluate(nextState => new Promise<void>((resolveVisibility) => {
                    Object.defineProperty(document, 'visibilityState', {
                        configurable: true,
                        get: () => nextState,
                    });
                    document.dispatchEvent(new Event('visibilitychange'));
                    setTimeout(resolveVisibility, 0);
                }), visibilityState);
            }

            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(consoleProblems).toEqual([]);
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('opens the Start file chooser in the click while the workspace chunk is still loading', async () => {
        const browser = await chromium.launch({headless: true});
        const workspaceModuleRequested = Promise.withResolvers<undefined>();
        const releaseWorkspaceModule = Promise.withResolvers<undefined>();
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            const consoleProblems = collectConsoleProblems(page);
            // Start paints from the tab while the workspace chunk loads. Holding
            // the workspace module keeps that state for as long as the test needs.
            await page.route((url) => url.pathname.endsWith('/workspace-shell/components/DocumentWorkspace.vue')
                && !url.searchParams.has('vue'), async (route) => {
                workspaceModuleRequested.resolve(undefined);
                await releaseWorkspaceModule.promise;
                await route.continue();
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await workspaceModuleRequested.promise;
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            // A browser shows a file chooser only within the click's 5 s user
            // activation.
            const chooserPromise = page.waitForEvent('filechooser', {timeout: 5_000});
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const chooser = await chooserPromise;
            releaseWorkspaceModule.resolve(undefined);
            await chooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');
            expect(consoleProblems).toEqual([]);
        } finally {
            releaseWorkspaceModule.resolve(undefined);
            await browser.close();
        }
    }, 120_000);

    it('keeps the rendered document and tab identity after a corrupt replacement is rejected', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const validChooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const validChooser = await validChooserPromise;
            await validChooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));

            const renderedCanvas = page.locator('.page_container--rendered canvas').first();
            await renderedCanvas.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            const activeTab = page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            );
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            const canvasCountBefore = await page.locator('.page_container--rendered canvas').count();

            const corruptChooserPromise = page.waitForEvent('filechooser');
            await page.keyboard.press('Control+O');
            const corruptChooser = await corruptChooserPromise;
            await corruptChooser.setFiles({
                name: 'corrupt-replacement.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from('%PDF-1.7\ncorrupt and truncated'),
            });

            await page.locator('.app-toast-failure').filter({hasText: 'Failed to open file'}).waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            await expect.poll(() => renderedCanvas.isVisible()).toBe(true);
            expect(await page.locator('.page_container--rendered canvas').count())
                .toBe(canvasCountBefore);
        } finally {
            await browser.close();
        }
    }, 90_000);

    it('shows a literal percent sequence in a browser file name exactly on its tab', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const chooser = await chooserPromise;
            await chooser.setFiles({
                name: 'report%20final.pdf',
                mimeType: 'application/pdf',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')),
            });

            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            const activeTab = page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            );
            await expect.poll(() => activeTab.textContent()).toContain('report%20final.pdf');
            await expect.poll(() => activeTab.getAttribute('aria-label')).toBe('report%20final.pdf');
        } finally {
            await browser.close();
        }
    }, 90_000);

    it.each([
        [
            'removal',
            'Remove from Recent',
            undefined,
        ],
        [
            'clear',
            'Clear Recent Files',
            'Clear History',
        ],
    ] as const)('keeps an open document source when Recent Files %s meets an unreadable dependent record', async (_action, buttonName, confirmName) => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const chooser = await chooserPromise;
            await chooser.setFiles({
                name: 'recent-dependent.pdf',
                mimeType: 'application/pdf',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            // The open document's source record, found by its file name.
            const sourceRef = await page.evaluate(`(async () => {
                const {loadAllRecordKeys, loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                for (const key of await loadAllRecordKeys()) {
                    const found = await loadRecord(key);
                    if (found?.fileName === 'recent-dependent.pdf' && found.kind === 'source') return key;
                }
                return null;
            })()`);
            expect(typeof sourceRef).toBe('string');
            // Opening the file also creates a readable working copy that names the source,
            // which keeps the source by itself. Remove those copies so the unreadable record
            // below is the only dependent of the source.
            await page.evaluate(`(async () => {
                const {loadAllRecordKeys, loadRecord, runObjectStoresTransaction} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                const {DOCUMENTS_STORE} = await import('/_nuxt/platform/browser/browserDocumentConstants.ts');
                const dependents = [];
                for (const key of await loadAllRecordKeys()) {
                    if ((await loadRecord(key))?.sourceRef === ${JSON.stringify(sourceRef)}) dependents.push(key);
                }
                await runObjectStoresTransaction([DOCUMENTS_STORE], 'readwrite', (transaction, setResult) => {
                    for (const key of dependents) transaction.objectStore(DOCUMENTS_STORE).delete(key);
                    setResult(true);
                });
            })()`);
            // A working record that names the source but cannot be decoded. The helper
            // resolves null when its database cannot open, so the write is asserted.
            const planted = await page.evaluate(`(async () => {
                const {runObjectStoresTransaction} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                const {DOCUMENTS_STORE} = await import('/_nuxt/platform/browser/browserDocumentConstants.ts');
                return runObjectStoresTransaction([DOCUMENTS_STORE], 'readwrite', (transaction, setResult) => {
                    transaction.objectStore(DOCUMENTS_STORE).put({
                        ref: 'browser://documents/unreadable-dependent.pdf',
                        sourceRef: ${JSON.stringify(sourceRef)},
                        kind: 'working',
                        storageMode: 'source-proxy',
                    });
                    setResult(true);
                });
            })()`);
            expect(planted).toBe(true);

            await page.getByRole('button', {
                name: 'New Tab',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: buttonName,
                exact: true,
            }).click();
            if (confirmName) {
                await page.getByRole('button', {
                    name: confirmName,
                    exact: true,
                }).click();
            }
            await expect.poll(() => page.getByRole('button', {
                name: 'Remove from Recent',
                exact: true,
            }).count()).toBe(0);
            // The row can leave the list before the detached cleanup that follows the
            // removal has finished. An awaited cleanup of the same ref, serialized behind
            // it, settles the outcome before the stored record is read.
            await page.evaluate(`(async () => {
                const {browserDocumentStore} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                await browserDocumentStore.cleanupDetachedDocument(${JSON.stringify(sourceRef)});
            })()`);
            // Read the stored record and its first chunk on a raw connection: the bytes helper
            // reads nothing whenever its database connection fails to open.
            const stored = await page.evaluate<{
                present: boolean;
                chunkBytes: number | null
            }>(`(async () => {
                const database = await new Promise((resolve, reject) => {
                    const request = indexedDB.open('evb-viewer-browser-documents');
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                const transaction = database.transaction(['documents', 'document-chunks'], 'readonly');
                const read = (store, key) => new Promise((resolve, reject) => {
                    const request = transaction.objectStore(store).get(key);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                const record = await read('documents', ${JSON.stringify(sourceRef)});
                const chunk = record?.storageMode === 'chunked'
                    ? await read('document-chunks', ${JSON.stringify(sourceRef)} + '::' + record.chunkGeneration + '::0')
                    : undefined;
                database.close();
                return {present: Boolean(record), chunkBytes: chunk?.data?.byteLength ?? chunk?.byteLength ?? null};
            })()`);
            expect(stored.present).toBe(true);
            expect(stored.chunkBytes).toBeGreaterThan(0);
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('explains the missing components when an indirect DjVu index is picked alone', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-index-only-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext({
            viewport: {
                width: 1_280,
                height: 900,
            },
            recordVideo: {dir: evidenceDir},
        });
        try {
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.deleteProperty(window, 'showOpenFilePicker');
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.locator('.start-open-panel .open-panel-cta').click();
            await (await chooserPromise).setFiles({
                name: 'café-index.djvu',
                mimeType: 'image/vnd.djvu',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/djvu/sources/indirect/index.djvu')),
            });
            const toast = page.locator('.app-toast-failure');
            await toast.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const text = await toast.innerText();
            writeFileSync(resolve(evidenceDir, 'visible.json'), JSON.stringify({
                text,
                pageErrors,
            }, null, 2));
            await page.screenshot({path: resolve(evidenceDir, 'toast.png')});

            // C4: the failure itself explains why and gives the usable alternatives.
            expect(text).toContain('This DjVu index needs separate component files. Open a bundled DjVu file or use the desktop app.');
            expect(text).not.toContain('The file could not be opened.');
            expect(await toast.count()).toBe(1);
            expect(pageErrors).toEqual([]);
        } finally {
            await context.close();
            await browser.close();
        }
    }, 120_000);

    it('renders a DjVu open, conversion, and generated PDF reopen in the viewer', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const chooser = await chooserPromise;
            await chooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu',
            ));

            const sourceImage = page.locator('[data-testid="document-page-source-image"]').first();
            await sourceImage.waitFor({
                state: 'visible',
                timeout: 90_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('DjVu viewer open did not settle');
                }
            });
            const sourceEvidence = await page.evaluate(() => ({
                bodyText: document.body.innerText,
                sourceImages: document.querySelectorAll('[data-testid="document-page-source-image"]').length,
                sourcePages: document.querySelectorAll('[data-testid="document-page-source-page"]').length,
            }));
            expect(sourceEvidence.sourceImages).toBeGreaterThan(0);
            expect(sourceEvidence.sourcePages).toBeGreaterThan(0);
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-open.png'),
                fullPage: true,
            });

            await page.getByRole('button', {name: /Convert to PDF/}).filter({visible: true}).first().click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const conversionButton = dialog.getByRole('button', {
                name: 'Convert',
                exact: true,
            });
            await page.waitForFunction(() => {
                const button = Array.from(document.querySelectorAll('[role="dialog"] button'))
                    .find(candidate => candidate.textContent?.trim() === 'Convert');
                return button instanceof HTMLButtonElement && !button.disabled;
            }, null, {timeout: 90_000});
            await conversionButton.click();
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-after-convert.png'),
                fullPage: true,
            });

            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Generated PDF reopen did not settle');
                }
            });
            const renderedPdf = page.locator('.page_container--rendered .page_canvas canvas').first();
            await renderedPdf.waitFor({
                state: 'visible',
                timeout: 120_000,
            });
            const pdfEvidence = await page.evaluate(() => ({
                bodyText: document.body.innerText,
                renderedCanvases: document.querySelectorAll('.page_container--rendered .page_canvas canvas').length,
            }));
            expect(pdfEvidence.renderedCanvases).toBeGreaterThan(0);
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-pdf-reopen.png'),
                fullPage: true,
            });
        } finally {
            await browser.close();
        }
    }, 240_000);

    it('renders an externally replaced PDF and reopens that persisted Recent file', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            let openCount = 0;
            const openWithFile = async (filePath: string) => {
                const chooserPromise = page.waitForEvent('filechooser');
                if (openCount === 0) {
                    await page.getByRole('button', {
                        name: 'Open File',
                        exact: true,
                    }).first().click();
                } else {
                    await page.keyboard.press('Control+O');
                }
                await (await chooserPromise).setFiles(filePath);
                openCount += 1;
                await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                    state: 'visible',
                    timeout: 60_000,
                });
                await page.evaluate(async () => {
                    const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                    if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                        throw new Error('PDF viewer open did not settle');
                    }
                });
            };

            await openWithFile(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');

            await openWithFile(resolve(
                process.cwd(),
                'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf',
            ));
            const replacementTab = page.locator('[data-tab-list] [role="tab"][aria-selected="true"]');
            await expect.poll(() => replacementTab.textContent()).toContain('synthetic-annotation-interoperability.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-pdf-replacement-rendered.png'),
                fullPage: true,
            });

            await page.getByRole('button', {name: 'Close tab'}).last().click();
            await page.reload({waitUntil: 'domcontentloaded'});
            const recentReplacement = page.locator(
                '[data-recent-open-actionable="true"] .recent-open',
            ).filter({hasText: 'synthetic-annotation-interoperability.pdf'});
            await recentReplacement.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await recentReplacement.click();
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('synthetic-annotation-interoperability.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-pdf-recent-reopen-rendered.png'),
                fullPage: true,
            });
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('proves a dirty viewer transfer after source loss before target authority readback', async () => {
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext();
        const source = await context.newPage();
        const target = await context.newPage();
        try {
            await source.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await target.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                Reflect.set(window, '__evbTransferAuthorityCommittedReadBarrier', () => new Promise<void>(resolveBarrier => {
                    Reflect.set(window, '__evbReleaseTransferAuthorityCommittedReadBarrier', resolveBarrier);
                }));
            });
            await Promise.all([
                source.goto(origin, {waitUntil: 'domcontentloaded'}),
                target.goto(`${origin}?evbWindowId=2`, {waitUntil: 'domcontentloaded'}),
            ]);
            await Promise.all([
                waitForOpenFileReady(source),
                target.waitForFunction(() => Boolean(Reflect.get(window, '__evbTestApi')), undefined, {timeout: 30_000}),
            ]);

            const chooserPromise = source.waitForEvent('filechooser');
            await source.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf',
            ));
            await source.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Source PDF did not settle');
            });
            const existingTextBox = source.locator('.pdf-annotation-editor-text-box').filter({hasText: 'Editable interoperability text'}).first();
            await existingTextBox.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await existingTextBox.dblclick();
            const noteEditor = source.locator('.pdf-annotation-editor-text-box__editor').last();
            await noteEditor.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await noteEditor.fill('durable transfer edit');
            await expect.poll(() => noteEditor.textContent()).toBe('durable transfer edit');
            await expect.poll(async () => source.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                const state = api.readActiveWorkspaceStateValues?.<{annotationComments?: Array<{
                    text?: string;
                    displayText?: string | null;
                    previewText?: string | null
                }>;}>(['annotationComments']);
                return state?.annotationComments?.some(comment => [
                    comment.text,
                    comment.displayText,
                    comment.previewText,
                ].includes('durable transfer edit')) ?? false;
            }), {timeout: 30_000}).toBe(true);
            await expect.poll(() => noteEditor.isVisible()).toBe(true);
            await noteEditor.blur();
            await expect.poll(async () => source.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                const state = api.readActiveWorkspaceStateValues?.<{dirtyState?: {
                    annotationDirty: boolean;
                    hasAnnotationChanges: boolean;
                };}>(['dirtyState']);
                return state?.dirtyState?.annotationDirty === true
                    && state.dirtyState.hasAnnotationChanges === true;
            }), {timeout: 30_000}).toBe(true);
            await expect.poll(() => source.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).getAttribute('aria-description')).toMatch(/unsaved/i);
            const captured = await source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.callActiveWorkspaceCommand?.('captureSplitPayload');
            });
            expect(captured?.called).toBe(true);
            expect(captured?.value).toEqual(expect.objectContaining({kind: 'pdfSnapshot'}));

            await expect.poll(async () => source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return (await api.listTargetWindows?.())?.some(windowInfo => (
                    windowInfo.windowId === 2
                )) ?? false;
            }), {timeout: 30_000}).toBe(true);

            const transferPromise = source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.transferActiveTabToWindow?.(2);
            });
            await target.waitForFunction(() => typeof Reflect.get(
                window,
                '__evbReleaseTransferAuthorityCommittedReadBarrier',
            ) === 'function', undefined, {timeout: 60_000});
            const provisional = await target.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.getActiveToolbarSnapshot?.() ?? null;
            });
            expect(provisional?.canSave).toBe(false);
            // Until the target reads back authority it offers no way to edit:
            // its note tool is disabled, or absent while it has no document.
            expect(await target.getByRole('button', {
                name: /sticky note/i,
                disabled: false,
            }).count()).toBe(0);
            await source.close();
            await target.evaluate(() => {
                const release = Reflect.get(window, '__evbReleaseTransferAuthorityCommittedReadBarrier');
                if (typeof release !== 'function') throw new Error('Target authority read barrier was not installed');
                release();
            });
            const transferResult = await transferPromise;
            expect(transferResult).toMatchObject({
                success: true,
                targetWindowId: 2,
            });

            await expect.poll(() => target.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent(), {timeout: 60_000}).toContain('synthetic-annotation-interoperability.pdf');
            await target.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Target PDF did not settle after transfer');
            });
            await expect.poll(async () => target.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                const state = api.readActiveWorkspaceStateValues?.<{annotationComments?: Array<{
                    text?: string;
                    displayText?: string | null;
                    previewText?: string | null;
                }>;}>(['annotationComments']);
                return state?.annotationComments?.some(comment => [
                    comment.text,
                    comment.displayText,
                    comment.previewText,
                ].includes('durable transfer edit')) ?? false;
            }), {timeout: 30_000}).toBe(true);
            await expect.poll(() => target.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.getActiveToolbarSnapshot?.()?.canSave ?? false;
            }), {timeout: 30_000}).toBe(true);

            const downloadPromise = target.waitForEvent('download');
            const saveResult = await target.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.callActiveWorkspaceCommand?.('handleSaveAs');
            });
            expect(saveResult?.called).toBe(true);
            expect(saveResult?.value).toBe(true);
            const download = await downloadPromise;
            const savedPath = resolve(process.cwd(), '.devkit/browser-transfer-save-reopen/transferred-edited.pdf');
            await download.saveAs(savedPath);

            // Fresh storage makes the reopen prove the downloaded PDF's bytes.
            const reopened = await browser.newPage();
            try {
                await reopened.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await reopened.goto(origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(reopened);
                const reopenChooserPromise = reopened.waitForEvent('filechooser');
                await reopened.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await reopenChooserPromise).setFiles(savedPath);
                await reopened.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                    state: 'visible',
                    timeout: 60_000,
                });
                await reopened.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Saved transfer PDF did not settle');
                });
                await expect.poll(async () => reopened.evaluate(() => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    const state = api.readActiveWorkspaceStateValues?.<{annotationComments?: Array<{
                        text?: string;
                        displayText?: string | null;
                        previewText?: string | null;
                    }>;}>(['annotationComments']);
                    return state?.annotationComments?.some(comment => [
                        comment.text,
                        comment.displayText,
                        comment.previewText,
                    ].includes('durable transfer edit')) ?? false;
                }), {timeout: 30_000}).toBe(true);
            } finally {
                await reopened.close();
            }
        } finally {
            await browser.close();
        }
    }, 240_000);

    // Sweep #845 item 8: Save As keeps each linked view's zoom.
    it('keeps each linked view zoom through a browser Save As', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_600,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            // Split Right from the tab menu shows the document in a second view.
            await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
            await page.getByRole('menuitem', {
                name: 'Split Right',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.editor-pane').count(), {timeout: 20_000}).toBe(2);
            const [
                leftPane,
                rightPane,
            ] = await page.locator('.editor-pane').evaluateAll(panes => panes.map(pane => (pane as HTMLElement).dataset.editorPaneId ?? ''));
            await page.locator(`${paneSelector(rightPane!)} .page_container--rendered canvas`).first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            // Each view takes its own custom zoom.
            await clickCenter(page, `${paneSelector(leftPane!)} .tab.is-active[data-tab-id]`);
            await zoomActivePane(page, leftPane!, 'Zoom In', 2);
            await clickCenter(page, `${paneSelector(rightPane!)} .tab.is-active[data-tab-id]`);
            await zoomActivePane(page, rightPane!, 'Zoom Out', 2);
            const before = {
                left: await readPanePageWidth(page, leftPane!),
                right: await readPanePageWidth(page, rightPane!),
            };
            expect(before.left).not.toBe(before.right);

            // Save As from the right view's Save options menu.
            const readWorkingCopyPath = () => page.evaluate(() => (
                (Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi)
                    .readActiveWorkspaceStateValues?.<{workingCopyPath?: string | null}>(['workingCopyPath']).workingCopyPath ?? null
            ));
            const workingCopyBefore = await readWorkingCopyPath();
            expect(workingCopyBefore).not.toBeNull();
            const pagesBeforeSaveAs = {
                [leftPane!]: await page.locator(`${paneSelector(leftPane!)} .page_container--rendered[data-page="1"]`).elementHandle(),
                [rightPane!]: await page.locator(`${paneSelector(rightPane!)} .page_container--rendered[data-page="1"]`).elementHandle(),
            };
            expect(pagesBeforeSaveAs[leftPane!]).not.toBeNull();
            expect(pagesBeforeSaveAs[rightPane!]).not.toBeNull();
            const downloadPromise = page.waitForEvent('download');
            await page.locator('button[aria-label="Save options"]:not([disabled])').first().click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            await downloadPromise;
            // The Save As has taken effect once the document moved to a new working copy.
            let workingCopyAfter: string | null = null;
            await expect.poll(async () => {
                workingCopyAfter = await readWorkingCopyPath();
                return workingCopyAfter !== null && workingCopyAfter !== workingCopyBefore;
            }, {timeout: 30_000}).toBe(true);
            // Wait for the replacement page, then read its readiness and width
            // in one browser observation. An outgoing page can detach between
            // separate readiness and geometry reads.
            const readCurrentPaintedPageWidth = async (paneId: string) => {
                await clickCenter(page, `${paneSelector(paneId)} .tab.is-active[data-tab-id]`);
                const observation = await page.waitForFunction(({
                    selector, previousPage, workingCopyPath,
                }) => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    const currentPage = document.querySelector<HTMLElement>(selector);
                    const canvas = currentPage?.querySelector('canvas');
                    const canvasRect = canvas?.getBoundingClientRect();
                    const canvasVisible = canvas && getComputedStyle(canvas).visibility === 'visible';
                    if (!currentPage?.isConnected || currentPage === previousPage
                        || !canvasVisible || !canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0
                        || api.getActiveToolbarSnapshot?.()?.initialVisualReady !== true
                        || api.readActiveWorkspaceStateValues?.<{workingCopyPath?: string | null}>(['workingCopyPath']).workingCopyPath !== workingCopyPath) {
                        return null;
                    }
                    return {width: Math.round(currentPage.getBoundingClientRect().width)};
                }, {
                    selector: `${paneSelector(paneId)} .page_container--rendered[data-page="1"]`,
                    previousPage: pagesBeforeSaveAs[paneId],
                    workingCopyPath: workingCopyAfter,
                }, {timeout: 30_000});
                const measured = await observation.jsonValue();
                if (!measured) {
                    throw new Error('Replacement page observation is unavailable');
                }
                return measured.width;
            };

            expect({
                right: await readCurrentPaintedPageWidth(rightPane!),
                left: await readCurrentPaintedPageWidth(leftPane!),
            }).toEqual(before);
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('finds a regex match while the search worker is still starting', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            const consoleProblems = collectConsoleProblems(page);
            // A first search on a hosted page fetches the worker over the
            // network. Holding that fetch past the 250 ms matching budget
            // checks that the budget counts matching and not worker start-up.
            await page.route(url => url.pathname.includes('browserSearch.worker'), async (route) => {
                await new Promise(resolveDelay => setTimeout(resolveDelay, 1_500));
                await route.continue();
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            const regexToggle = page.locator('.document-search-bar button[aria-label="Use regular expression"]:visible');
            if (await regexToggle.count() === 0) {
                if (await page.locator('[data-testid="document-sidebar"]:visible').count() === 0) {
                    await page.locator('button[aria-label="Toggle Sidebar"]:visible').first().click();
                }
                await page.locator('[data-testid="document-sidebar"] [role="tab"]:visible', {hasText: 'Search'}).first().click();
            }
            await regexToggle.first().click();
            const searchInput = page.locator('.document-search-bar input:visible').first();
            await searchInput.fill('Fir\\w+');
            await searchInput.press('Enter');

            await expect.poll(
                () => page.locator('.document-search-results:visible').first().textContent(),
                {timeout: 30_000},
            ).toMatch(/1 result|Search unavailable/u);
            expect(await page.locator('.document-search-result:visible .document-search-result-highlight').allTextContents())
                .toEqual(['First']);
            expect(consoleProblems).toEqual([]);
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('keeps known PDF regex hits when another document cancels its search', async () => {
        const browser = await chromium.launch({headless: true});
        const releaseWorker = Promise.withResolvers<undefined>();
        try {
            const page = await browser.newPage();
            page.on('console', message => {
                if (message.text().startsWith('Search ')) console.info(message.text());
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            const bytes = [...readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'))];
            await page.evaluate(`(async () => {
                const {browserDocumentStore} = await import('/_nuxt/platform/browserDocumentStore.ts');
                const {createBrowserSearchCapability} = await import('/_nuxt/platform/browser-api/createBrowserSearchCapability.ts');
                const {capability} = createBrowserSearchCapability();
                const refs = [];
                for (const name of ['first.pdf', 'other.pdf']) refs.push(await browserDocumentStore.createStoredDocument(name, Uint8Array.from(${JSON.stringify(bytes)}), {
                    mimeType: 'application/pdf', kind: 'source', retention: 'transient', saveKind: 'pdf',
                }));
                const control = await capability.run(refs[1], 'First');
                if (!control.results.some(hit => hit.excerpt.match === 'First')) throw new Error('PDF text control did not contain First');
                window.__searchPosted = 0;
                const post = Worker.prototype.postMessage;
                Worker.prototype.postMessage = function(message, options) {
                    if (message.type === 'matchPageText') {
                        window.__searchPosted += 1;
                        console.info('Search admission', JSON.stringify(message.payload));
                        this.addEventListener('message', event => console.info('Search reply', JSON.stringify(event.data)));
                    }
                    return post.call(this, message, options);
                };
                const controls = document.createElement('div');
                controls.style.cssText = 'position:fixed;left:16px;top:16px;z-index:2147483647;background:white;color:black;padding:8px';
                controls.innerHTML = '<button id="search-first">Search first PDF</button><button id="search-other">Search other PDF</button><button id="search-cancel-first">Cancel first search</button><output id="search-first-result">Ready</output><output id="search-other-result">Ready</output>';
                document.body.prepend(controls);
                refs.forEach((ref, index) => {
                    const name = index === 0 ? 'first' : 'other';
                    const requestId = 'core4-search-' + name;
                    const output = controls.querySelector('#search-' + name + '-result');
                    controls.querySelector('#search-' + name).addEventListener('click', event => {
                        if (!event.isTrusted) throw new Error('Search requires trusted input');
                        output.textContent = 'Searching';
                        void capability.run(ref, 'Fir(st)', {requestId, useRegex: true}).then(result => {
                            output.textContent = result.results.map(hit => hit.excerpt.match).join(' | ') || 'No results';
                        }, error => { output.textContent = error.message; });
                    });
                });
                controls.querySelector('#search-cancel-first').addEventListener('click', event => {
                    if (!event.isTrusted) throw new Error('Cancel requires trusted input');
                    void capability.cancel('core4-search-first');
                });
            })()`);
            await page.route(url => url.pathname.includes('browserSearch.worker'), async route => {
                await releaseWorker.promise;
                await route.continue().catch(() => undefined);
            });
            await page.locator('#search-first').click();
            await page.locator('#search-other').click();
            await page.waitForFunction(() => Reflect.get(window, '__searchPosted') === 2);
            await page.locator('#search-cancel-first').click();
            releaseWorker.resolve(undefined);
            await expect.poll(() => page.locator('#search-other-result').textContent(), {timeout: 30_000}).toContain('First');
        } finally {
            releaseWorker.resolve(undefined);
            await browser.close();
        }
    }, 120_000);
    it('isolates another document when a DjVu regex is canceled', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            const url = `${origin}/__search-isolation`;
            await page.route(url, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body>Search isolation</body></html>',
            }));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            const result = await page.evaluate<{second: {
                ok: boolean;
                count?: number
            }}>(`(async () => {
            const {searchDjvuWorkerText} = await import('/_nuxt/platform/browser-api/createDjvuWorkerFromPath.ts');
            const worker = text => ({doc:{
                getPagesQuantity:()=>({run:async()=>1}),
                getPagesSizes:()=>({run:async()=>[{width:612,height:792}]}),
                getPage:()=>({getText:()=>({run:async()=>text}),getNormalizedTextZones:()=>({run:async()=>null})})
            }});
            const a = new AbortController(); const b = new AbortController();
            const options = {pageCount:1,matchOptions:{useRegex:true,matchCase:false,wholeWord:false}};
            const first = searchDjvuWorkerText(worker('a'.repeat(250000)+'!'), {...options,query:'a+.a+$',requestId:'review-a',signal:a.signal})
                .then(()=>({ok:true}), e=>({ok:false,name:e.name,message:e.message}));
            await new Promise(r=>setTimeout(r,200));
            const second = searchDjvuWorkerText(worker('hello'), {...options,query:'hello',requestId:'review-b',signal:b.signal})
                .then(r=>({ok:true,count:r.results.length}), e=>({ok:false,name:e.name,message:e.message}));
            await new Promise(r=>setTimeout(r,50)); a.abort();
            return {first:await first, second:await second, secondAborted:b.signal.aborted};
        })()`);
            console.log('REVIEW cross-document cancellation', JSON.stringify(result));
            expect(result.second).toEqual({
                ok:true,
                count:1,
            });
        } finally {await browser.close();}
    }, 90_000);


    it('preserves the regex budget across normalization at the page-text cap', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            const url = `${origin}/__search-normalization`;
            await page.route(url, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body>Search normalization</body></html>',
            }));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            const results = await page.evaluate<Array<{
                size: number;
                remainingMs: number;
                nextMatches?: number;
                error?: string
            }>>(`(async () => {
                const {matchBrowserSearchPageWindow: match} = await import('/_nuxt/platform/browser-api/matchBrowserSearchPageWindow.ts');
                const options = {useRegex: true, matchCase: false, wholeWord: false};
                const results = [];
                for (const size of [1000000, 8388608]) {
                    const budget = {remainingMs: 250};
                    const started = performance.now();
                    try {
                        await match('a'.repeat(size), '^Z', options, 501, 0, budget, new AbortController().signal);
                        const next = await match('Z', '^Z', options, 501, 0, budget, new AbortController().signal);
                        results.push({size, elapsedMs: Math.round(performance.now() - started), remainingMs: budget.remainingMs, nextMatches: next.matches.length});
                    } catch (error) {
                        results.push({size, remainingMs: budget.remainingMs, error: String(error)});
                    }
                }
                return results;
            })()`);
            console.info('Normalization budget', JSON.stringify(results));
            expect(results.every(result => !result.error && result.remainingMs > 0 && result.nextMatches === 1)).toBe(true);
        } finally {
            await browser.close();
        }
    }, 90_000);

    it.each([
        {
            label: 'literal without workers',
            fragmented: false,
        },
        {
            label: 'later fragmented window',
            fragmented: true,
        },
    ])('reconciles search highlight text: $label', async ({fragmented}) => {
        const browser = await chromium.launch({headless: true});
        const evidenceDir = resolve(process.cwd(), `.devkit/search-highlight-regressions/${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        try {
            const page = await browser.newPage();
            const url = `${origin}/__highlight-window`;
            await page.route(url, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body><button id="highlight">Highlight selected result</button><div class="pdfViewer"><div id="ink"></div><div id="layer" class="textLayer"></div></div></body></html>',
            }));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            await page.evaluate(`Promise.all([
                import('/_nuxt/assets/css/main.css'),
                import('/_nuxt/assets/css/pdf-search-highlights.scss'),
            ]).then(() => undefined)`);
            await page.addStyleTag({content: 'body {font: 24px sans-serif} .pdfViewer {position: relative} #ink, #layer {white-space: pre} #layer {position: absolute; inset: 0; color: transparent}'});
            await page.evaluate(`(async () => {
                const {usePdfSearchHighlight} = await import('/_nuxt/modules/pdf-viewer/runtime/composables/usePdfSearchHighlight.ts');
                const {registerTextLayerTextMapping} = await import('/_nuxt/modules/pdf-viewer/engine/search/pdfSearchHighlightDom.ts');
                const fragmented = ${fragmented};
                const items = fragmented ? ['needle', '\\n', ...'needle'] : ['prefix needle'];
                const layer = document.querySelector('#layer');
                document.querySelector('#ink').textContent = items.join('');
                const spans = items.map(text => {
                    const span = document.createElement('span');
                    span.textContent = text;
                    layer.append(span);
                    return span;
                });
                registerTextLayerTextMapping(layer, {textDivs: spans, textContentItemsStr: items});
                if (!fragmented) window.Worker = undefined;
                const highlight = usePdfSearchHighlight();
                document.querySelector('#highlight').addEventListener('click', event => {
                    if (!event.isTrusted) throw new Error('Highlight requires trusted input');
                    const start = fragmented ? 7 : 0;
                    const ordinal = fragmented ? 1 : 0;
                    highlight.highlightPage(layer, {
                        pageIndex: 0, pageText: '', searchQuery: 'needle',
                        searchOptions: {useRegex: fragmented, matchCase: false, wholeWord: false},
                        matches: [{start, end: start + 6, matchIndex: ordinal, pageMatchIndex: ordinal}],
                    }, {pageIndex: 0, startOffset: start, endOffset: start + 6, matchIndex: ordinal, pageMatchIndex: ordinal});
                });
            })()`);
            await page.locator('#highlight').click();
            try {
                await expect.poll(async () => (await page.locator('.pdf-search-highlight--current').allTextContents()).join(''))
                    .toBe('needle');
                expect(await page.locator('#layer').textContent()).toBe(fragmented ? 'needle\nneedle' : 'prefix needle');
                const paint = await page.locator('.pdf-search-highlight--current').first().evaluate(element => ({
                    background: getComputedStyle(element).backgroundColor,
                    width: element.getBoundingClientRect().width,
                }));
                expect(paint.background).not.toBe('rgba(0, 0, 0, 0)');
                expect(paint.width).toBeGreaterThan(0);
                if (fragmented) expect(await page.locator('#layer > span').first().locator('.pdf-search-highlight').count()).toBe(0);
            } finally {
                const label = fragmented ? 'fragmented' : 'literal';
                await page.screenshot({path: resolve(evidenceDir, `${label}.png`)});
                writeFileSync(resolve(evidenceDir, `${label}.json`), JSON.stringify({
                    current: (await page.locator('.pdf-search-highlight--current').allTextContents()).join(''),
                    text: await page.locator('#layer').textContent(),
                }, null, 2));
            }
        } finally {
            await browser.close();
        }
    }, 90_000);

    it.each([
        true,
        false,
    ])('paints authoritative regex highlights while trusted input stays responsive (known text: %s)', async (knownText) => {
        const browser = await chromium.launch({headless: true});
        try {
            // The blank renderer fixture loads product CSS directly.
            const page = await browser.newPage({bypassCSP: true});
            const url = `${origin}/__highlight-responsiveness`;
            await page.route(url, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body><button id="highlight">Highlight</button><button id="respond">Respond</button><output id="response">Ready</output><div class="pdfViewer"><div id="page-ink"></div><div id="text-layer" class="textLayer"></div></div></body></html>',
            }));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            await page.evaluate(`Promise.all([
                import('/_nuxt/assets/css/main.css'),
                import('/_nuxt/assets/css/pdf-search-highlights.scss'),
            ]).then(() => undefined)`);
            await page.addStyleTag({content: '.pdfViewer {position: relative} .textLayer {position: absolute; inset: 0; color: transparent}'});
            await page.evaluate(`(async () => {
                const {usePdfSearchHighlight} = await import('/_nuxt/modules/pdf-viewer/runtime/composables/usePdfSearchHighlight.ts');
                const {registerTextLayerTextMapping} = await import('/_nuxt/modules/pdf-viewer/engine/search/pdfSearchHighlightDom.ts');
                const layer = document.querySelector('#text-layer');
                const span = document.createElement('span');
                const text = 'needle ' + 'a'.repeat(250000) + '!';
                document.querySelector('#page-ink').textContent = text;
                span.textContent = text;
                layer.append(span);
                registerTextLayerTextMapping(layer, {textDivs: [span], textContentItemsStr: [text]});
                const highlight = usePdfSearchHighlight();
                document.querySelector('#highlight').addEventListener('click', event => {
                    if (!event.isTrusted) throw new Error('Highlight requires trusted input');
                    highlight.highlightPage(layer, {
                        pageIndex: 0, pageText: ${knownText ? 'text' : '\'\''}, searchQuery: 'needle|a+.a+$',
                        searchOptions: {useRegex: true, matchCase: false, wholeWord: false},
                        matches: [{start: 0, end: 6, matchIndex: 0, pageMatchIndex: 0}],
                    }, null);
                });
                document.querySelector('#respond').addEventListener('click', event => {
                    if (!event.isTrusted) throw new Error('Response requires trusted input');
                    document.querySelector('#response').textContent = 'Responded';
                });
            })()`);
            // Containment also bounds the pre-fix renderer when its click handler
            // runs the pathological failure tail after the valid needle match.
            let containment: ReturnType<typeof setTimeout> | undefined;
            const action = (async () => {
                const started = performance.now();
                await page.locator('#highlight').click();
                await page.locator('#respond').click();
                await expect.poll(() => page.locator('#response').textContent(), {timeout: 1_000}).toBe('Responded');
                const acknowledgementMs = performance.now() - started;
                expect(acknowledgementMs).toBeLessThan(1_000);
                // A failed match cannot verify backend coordinates in unknown layer text.
                await expect.poll(() => page.locator('.pdf-search-highlight').allTextContents()).toEqual(knownText ? ['needle'] : []);
                if (knownText) {
                    const painted = await page.locator('.pdf-search-highlight').evaluate(element => ({
                        background: getComputedStyle(element).backgroundColor,
                        width: element.getBoundingClientRect().width,
                    }));
                    expect(painted.background).not.toBe('rgba(0, 0, 0, 0)');
                    expect(painted.width).toBeGreaterThan(0);
                }
                console.info('Highlight trusted click acknowledgement', acknowledgementMs);
            })();
            try {
                await Promise.race([
                    action,
                    new Promise<never>((_resolve, reject) => {
                        containment = setTimeout(() => reject(new Error('Renderer highlight blocked trusted input for 3 seconds')), 3_000);
                    }),
                ]);
            } finally {
                clearTimeout(containment);
            }
        } finally {
            await browser.close();
        }
    }, 90_000);

    it('stops a catastrophic DjVu regex at the search budget and keeps the page responsive', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/djvu/search/regex-budget-text-layer.djvu',
            ));
            await page.locator('[data-testid="document-page-source-image"]').first().waitFor({
                state: 'visible',
                timeout: 90_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('DjVu viewer open did not settle');
                }
            });

            const regexToggle = page.locator('.document-search-bar button[aria-label="Use regular expression"]:visible');
            if (await regexToggle.count() === 0) {
                if (await page.locator('[data-testid="document-sidebar"]:visible').count() === 0) {
                    await page.locator('button[aria-label="Toggle Sidebar"]:visible').first().click();
                }
                await page.locator('[data-testid="document-sidebar"] [role="tab"]:visible', {hasText: 'Search'}).first().click();
            }
            await regexToggle.first().click();
            const searchInput = page.locator('.document-search-bar input:visible').first();
            await searchInput.fill('a+.a+$');
            await searchInput.press('Enter');

            // Chromium takes quadratic time to match a+.a+$ over this run of a's,
            // longer than the poll below unbounded. The 250 ms budget stops it in
            // the worker, so the search reports the budget error instead.
            await expect.poll(
                () => page.locator('.document-search-results:visible').first().textContent(),
                {timeout: 30_000},
            ).toMatch(/matching budget/u);
            await regexToggle.first().click();
            await expect.poll(() => regexToggle.first().getAttribute('aria-pressed'), {timeout: 1_000}).toBe('false');
            expect(consoleProblems).toEqual([]);
        } finally {
            await browser.close();
        }
    }, 180_000);

    // #937: identical lines down a page are separate search text, so each
    // copy is a result with its own box on the page.
    it('finds every copy of a line repeated down the page', async () => {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        for (let line = 0; line < 5; line += 1) {
            pdfPage.drawText('The quick brown fox jumps over the lazy dog near the old stone bridge.', {
                font,
                size: 12,
                x: 72,
                y: 700 - line * 40,
            });
        }
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles({
                name: 'repeated-lines.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            const searchInput = page.locator('.document-search-bar input:visible').first();
            if (await searchInput.count() === 0) {
                if (await page.locator('[data-testid="document-sidebar"]:visible').count() === 0) {
                    await page.locator('button[aria-label="Toggle Sidebar"]:visible').first().click();
                }
                await page.locator('[data-testid="document-sidebar"] [role="tab"]:visible', {hasText: 'Search'}).first().click();
            }
            await searchInput.fill('fox');
            await searchInput.press('Enter');
            await page.locator('.document-search-result:visible').first().click({timeout: 30_000});

            await expect.poll(() => page.evaluate(() => ({
                summary: document.querySelector('.document-search-results-header-summary')?.textContent?.trim() ?? '',
                boxRows: new Set(Array.from(document.querySelectorAll('.page_container .pdf-word-box'))
                    .map(box => box.getBoundingClientRect())
                    .filter(rect => rect.width > 0)
                    .map(rect => Math.round(rect.top))).size,
            })), {timeout: 30_000}).toEqual({
                summary: expect.stringMatching(/^5 results\b/u),
                boxRows: 5,
            });
            expect(consoleProblems).toEqual([]);
        } finally {
            await browser.close();
        }
    }, 120_000);
});

describe('optional search-cache mutation completion proof', () => {
    it.each([
        'denied',
        'blocked',
    ] as const)('commits and displays rotation while optional cache is %s', async (fault) => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdfPage.drawText('Optional cache rotation proof', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        const bytes = Buffer.from(await pdf.save());
        const browser = await chromium.launch({headless: true});
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-search-cache-mutation-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, `${fault}-source.pdf`), bytes);
        let page: Page | undefined;
        try {
            page = await browser.newPage({
                viewport: {
                    width: 1280,
                    height: 900,
                },
                recordVideo: {dir: evidenceDir},
            });
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'optional-cache-rotation.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered[data-page="1"] canvas').first().waitFor({timeout: 30000});
            await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Initial real PDF did not settle');
            });
            const workingPath = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{workingCopyPath?: string}>(['workingCopyPath']).workingCopyPath;
            });
            if (!workingPath) throw new Error('Real working document identity is missing');
            if (!await page.locator('[data-thumbnail-page="1"]').first().isVisible()) {
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await page.getByRole('tab', {
                    name: 'Pages',
                    exact: true,
                }).click();
            }
            await page.locator('[data-thumbnail-page="1"]').first().waitFor({state: 'visible'});
            await page.evaluate(async (mode) => {
                const cacheName = 'evb-browser-search-cache';
                const original = IDBFactory.prototype.open;
                Reflect.set(window, '__br02CacheRequests', 0);
                if (mode === 'denied') {
                    IDBFactory.prototype.open = function(name: string, version?: number) {
                        if (name === cacheName) {
                            Reflect.set(window, '__br02CacheRequests', Reflect.get(window, '__br02CacheRequests') + 1);
                            throw new DOMException('BR02 injected optional cache denial', 'SecurityError');
                        }
                        return version === undefined ? original.call(this, name) : original.call(this, name, version);
                    };
                    Reflect.set(window, '__br02ReleaseCache', () => {IDBFactory.prototype.open = original;});
                    return;
                }
                await new Promise<void>((resolveDelete, rejectDelete) => {
                    const request = indexedDB.deleteDatabase(cacheName);
                    request.onsuccess = () => resolveDelete();
                    request.onerror = () => rejectDelete(request.error);
                    request.onblocked = () => rejectDelete(new Error('Healthy initial cache retained an unexpected connection'));
                });
                const legacy = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                    const request = original.call(indexedDB, cacheName, 1);
                    request.onsuccess = () => resolveDb(request.result);
                    request.onerror = () => rejectDb(request.error);
                });
                legacy.onversionchange = () => {};
                IDBFactory.prototype.open = function(name: string, version?: number) {
                    const request = version === undefined ? original.call(this, name) : original.call(this, name, version);
                    if (name === cacheName) request.onblocked = () => {
                        Reflect.set(window, '__br02CacheRequests', Reflect.get(window, '__br02CacheRequests') + 1);
                    };
                    return request;
                };
                Reflect.set(window, '__br02ReleaseCache', () => {IDBFactory.prototype.open = original; legacy.close();});
            }, fault);
            await page.locator('[data-thumbnail-page="1"]').first().click({button: 'right'});
            await page.getByRole('menuitem', {
                name: 'Rotate Clockwise',
                exact: true,
            }).click();
            let storedBytes: number[] = [];
            await expect.poll(async () => {
                storedBytes = await readPersistedDocumentBytes(page!, workingPath);
                if (!storedBytes.length) return null;
                return (await PDFDocument.load(Uint8Array.from(storedBytes))).getPage(0).getRotation().angle;
            }, {timeout: 15000}).toBe(90);
            writeFileSync(resolve(evidenceDir, `${fault}-committed.pdf`), Buffer.from(storedBytes));
            await expect.poll(() => page!.evaluate(() => Reflect.get(window, '__br02CacheRequests'))).toBeGreaterThan(0);
            writeFileSync(resolve(evidenceDir, `${fault}-committed.json`), JSON.stringify({
                workingPath,
                rotation: 90,
                problems,
            }, null, 2));
            await expect.poll(() => page!.locator('.page_container--rendered[data-page="1"]').first().evaluate(element => {
                const r = element.getBoundingClientRect();
                return r.width > r.height;
            }), {timeout: 15000}).toBe(true);
            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(await page.locator('.page_container--rendered[data-page="1"] .textLayer').first().textContent()).toContain('Optional cache rotation proof');
            const download = page.waitForEvent('download');
            await page.locator('button[aria-label="Save options"]').first().click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const savedPath = resolve(evidenceDir, `${fault}-saved.pdf`);
            await (await download).saveAs(savedPath);
            const saved = await PDFDocument.load(readFileSync(savedPath));
            expect(saved.getPage(0).getRotation().angle).toBe(90);
            expect(saved.getPageCount()).toBe(1);
            if (fault === 'denied') expect(problems.length).toBeGreaterThan(0);
            expect(
                problems.every(problem => problem.includes('[search] Optional search-cache invalidation failed')),
                JSON.stringify(problems),
            ).toBe(true);
            writeFileSync(resolve(evidenceDir, `${fault}-result.json`), JSON.stringify({
                workingPath,
                rotation: 90,
                savedRotation: saved.getPage(0).getRotation().angle,
                cacheRequests: await page.evaluate(() => Reflect.get(window, '__br02CacheRequests')),
                problems,
            }, null, 2));
        } finally {
            if (page) {
                await page.screenshot({path: resolve(evidenceDir, `${fault}-final.png`)}).catch(() => {});
                await page.evaluate(() => Reflect.get(window, '__br02ReleaseCache')?.()).catch(() => {});
                const video = page.video();
                await page.close();
                await video?.saveAs(resolve(evidenceDir, `${fault}-proof.webm`));
            }
            await browser.close();
        }
    }, 90000);
    it('keeps rotated search boxes on their words without coordinate warnings', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdfPage.drawText('Optional cache rotation proof', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-a-1094/browser-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const browser = await chromium.launch({headless: true});
        let page: Page | undefined;
        try {
            page = await browser.newPage({
                viewport: {
                    width: 1280,
                    height: 900,
                },
                recordVideo: {dir: evidenceDir},
            });
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'rotated-search.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered[data-page="1"] canvas').first().waitFor({timeout: 30_000});
            await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('PDF did not settle');
            });
            if (!await page.locator('[data-thumbnail-page="1"]').first().isVisible()) {
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await page.getByRole('tab', {
                    name: 'Pages',
                    exact: true,
                }).click();
            }
            await page.locator('[data-thumbnail-page="1"]').first().click({button: 'right'});
            await page.getByRole('menuitem', {
                name: 'Rotate Clockwise',
                exact: true,
            }).click();
            await expect.poll(() => page!.locator('.page_container--rendered[data-page="1"]').first().evaluate(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > rect.height;
            }), {timeout: 15_000}).toBe(true);
            await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Rotated PDF did not settle');
            });
            await page.waitForFunction(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{isPageOperationInProgress?: boolean}>(['isPageOperationInProgress'])?.isPageOperationInProgress === false;
            }, undefined, {timeout: 30_000});
            await page.waitForFunction(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.getActiveToolbarSnapshot?.()?.initialVisualReady === true;
            }, undefined, {timeout: 30_000});
            await page.locator('[data-testid="document-sidebar"] [role="tab"]:visible', {hasText: 'Search'}).first().click();
            const input = page.locator('.document-search-bar input:visible').first();
            await input.pressSequentially('proof');
            expect(await input.inputValue()).toBe('proof');
            writeFileSync(resolve(evidenceDir, 'before-enter.json'), JSON.stringify(await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return {
                    toolbar: api.getActiveToolbarSnapshot?.(),
                    state: api.readActiveWorkspaceStateValues?.([
                        'searchQuery',
                        'isPageOperationInProgress',
                    ]),
                    input: document.querySelector<HTMLInputElement>('.document-search-bar input')?.value,
                };
            }), null, 2));
            await input.press('Enter');
            await expect.poll(() => page!.locator('.document-search-results-header-summary').textContent(), {timeout: 30_000}).toMatch(/^1 result\b/u);
            await page.locator('.document-search-result:visible').first().click();
            const box = page.locator('.page_container[data-page="1"] .pdf-word-box[data-word="proof"]').first();
            await box.waitFor({state: 'visible'});
            const alignment = await box.evaluate(element => {
                const container = element.closest('.page_container')!;
                const canvas = container.querySelector('canvas')!;
                const textLayer = container.querySelector('.textLayer')!;
                const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
                let node: Node | null;
                let wordRange: Range | null = null;
                while ((node = walker.nextNode())) {
                    const at = node.textContent?.indexOf('proof') ?? -1;
                    if (at < 0) continue;
                    wordRange = document.createRange();
                    wordRange.setStart(node, at);
                    wordRange.setEnd(node, at + 5);
                    break;
                }
                if (!wordRange) throw new Error('Rendered proof word is absent');
                const word = wordRange.getBoundingClientRect();
                const highlight = element.getBoundingClientRect();
                const renderedCanvas = canvas.getBoundingClientRect();
                const sx = canvas.width / renderedCanvas.width;
                const sy = canvas.height / renderedCanvas.height;
                const x = Math.floor((word.left - renderedCanvas.left) * sx);
                const y = Math.floor((word.top - renderedCanvas.top) * sy);
                const width = Math.ceil(word.width * sx);
                const height = Math.ceil(word.height * sy);
                const pixels = canvas.getContext('2d')!.getImageData(x, y, width, height).data;
                let darkPixels = 0;
                let paintedPixelsInBox = 0;
                for (let py = 0; py < height; py += 1) {
                    for (let px = 0; px < width; px += 1) {
                        const offset = (py * width + px) * 4;
                        if (pixels[offset]! >= 128 || pixels[offset + 1]! >= 128 || pixels[offset + 2]! >= 128) continue;
                        darkPixels += 1;
                        const clientX = renderedCanvas.left + (x + px + 0.5) / sx;
                        const clientY = renderedCanvas.top + (y + py + 0.5) / sy;
                        if (clientX >= highlight.left && clientX <= highlight.right && clientY >= highlight.top && clientY <= highlight.bottom) paintedPixelsInBox += 1;
                    }
                }
                return {
                    word: word.toJSON(),
                    highlight: highlight.toJSON(),
                    darkPixels,
                    paintedPixelsInBox,
                    wordCenterInsideBox: (word.left + word.right) / 2 >= highlight.left
                        && (word.left + word.right) / 2 <= highlight.right
                        && (word.top + word.bottom) / 2 >= highlight.top
                        && (word.top + word.bottom) / 2 <= highlight.bottom,
                    boxCenterInsideWord: (highlight.left + highlight.right) / 2 >= word.left
                        && (highlight.left + highlight.right) / 2 <= word.right
                        && (highlight.top + highlight.bottom) / 2 >= word.top
                        && (highlight.top + highlight.bottom) / 2 <= word.bottom,
                    canvas: {
                        width: canvas.width,
                        height: canvas.height,
                    },
                };
            });
            writeFileSync(resolve(evidenceDir, 'alignment.json'), JSON.stringify(alignment, null, 2));
            writeFileSync(resolve(evidenceDir, 'console-problems.json'), JSON.stringify(problems, null, 2));
            expect(alignment.darkPixels).toBeGreaterThan(0);
            expect(alignment.paintedPixelsInBox).toBeGreaterThan(0);
            expect(alignment.wordCenterInsideBox).toBe(true);
            expect(alignment.boxCenterInsideWord).toBe(true);
            expect(problems).toEqual([]);
        } finally {
            try {
                if (page) {
                    await page.screenshot({path: resolve(evidenceDir, 'final.png')}).catch(() => {});
                    const video = page.video();
                    await page.close();
                    await video?.saveAs(resolve(evidenceDir, 'proof.webm'));
                }
            } finally {
                await browser.close();
            }
        }
    }, 120_000);

});

it.each([
    'clean-open',
    'two-window-move',
    'two-window-move-source-stays-open',
    'clear-recent',
])('keeps the saved copy source and both notes after Clear Recent Files and Save (mode=%s)', async (mode) => {
    const browser = await chromium.launch({headless:true});
    const observations:unknown[]=[];
    let activePage: Page | null = null;
    const evidenceDir=resolve(process.cwd(),`.devkit/bw03-r2/ui-${process.env.BW03_REV ?? 'green'}-${mode}`);mkdirSync(evidenceDir,{recursive:true});
    try {
        const context=await browser.newContext({
            viewport:{
                width:1280,
                height:900,
            },
            acceptDownloads:true,
        });
        let page=await context.newPage();
        const creator = page;
        activePage = page;
        observations.push({problems: collectConsoleProblems(page)});
        await page.addInitScript(()=>{Reflect.set(window,'__allowRendererFileOpenForAutomation',()=>true);Reflect.set(window,'showSaveFilePicker',undefined);window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode','input');});
        await page.goto(origin,{waitUntil:'domcontentloaded'});await waitForOpenFileReady(page);keepFileChooserInterceptionEnabled(page);
        const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{
            name:'Open File',
            exact:true,
        }).first().click();
        await (await chooser).setFiles({
            name:'review-saved.pdf',
            mimeType:'application/pdf',
            buffer:readFileSync(resolve(process.cwd(),'tests/fixtures/electron/generated-text.pdf')),
        });
        await page.locator('.page_container--rendered canvas').first().waitFor({timeout:30000});
        await addNote(page,'review first saved note',{
            x:160,
            y:180,
        });
        const recoveryCount = () => page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                const request = indexedDB.open('evb-viewer-browser-documents');
                request.onsuccess = () => resolveDb(request.result);
                request.onerror = () => rejectDb(request.error);
            });
            try {
                return await new Promise<number>((resolveCount, rejectCount) => {
                    const request = db.transaction('workspace-recovery').objectStore('workspace-recovery').count();
                    request.onsuccess = () => resolveCount(request.result);
                    request.onerror = () => rejectCount(request.error);
                });
            } finally { db.close(); }
        });
        await expect.poll(recoveryCount, {timeout: 30_000}).toBe(1);
        const firstDownload=page.waitForEvent('download');
        await page.getByRole('button',{
            name:'Save options',
            exact:true,
        }).click();await page.getByRole('menuitem',{name:/^Save As/u}).click();await (await firstDownload).saveAs(resolve(evidenceDir,'first.pdf'));
        await page.evaluate(async()=>{const api=Reflect.get(window,'__evbTestApi') as IBrowserLifecycleTestApi;await api.waitForActiveDocumentOpenSettled?.();});
        await expect.poll(recoveryCount, {timeout: 30_000}).toBe(0);
        observations.push({firstSavedTexts:Array.from(noteTexts(await PDFDocument.load(readFileSync(resolve(evidenceDir,'first.pdf')))))});
        const sourceRef = await page.evaluate(() => {
            const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
            return api.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath;
        });
        if (mode === 'clear-recent') {
            const tabId=await page.locator('.tab.is-active[data-tab-id]').first().getAttribute('data-tab-id');
            await page.getByRole('button',{
                name:'New Tab',
                exact:true,
            }).click();
            await page.getByRole('button',{
                name:'Clear Recent Files',
                exact:true,
            }).click();await page.getByRole('button',{
                name:'Clear History',
                exact:true,
            }).click();
            await expect.poll(()=>page.getByRole('button',{
                name:'Remove from Recent',
                exact:true,
            }).count()).toBe(0);
            observations.push({
                sourceRef,
                sourceAfter:await page.evaluate(`(async()=>{const {loadRecord}=await import('/_nuxt/platform/browser/browserDocumentIdb.ts');return !!await loadRecord(${JSON.stringify(sourceRef)});})()`),
            });
            await page.locator(`.tab[data-tab-id="${tabId}"]`).click();
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout:30000});
        }
        if (mode.startsWith('two-window-move')) {
            const target = await context.newPage();
            await target.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await target.goto(`${origin}?evbWindowId=2`, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(target);
            await expect.poll(() => page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return (await api.listTargetWindows?.())?.some(info => info.windowId === 2);
            }), {timeout: 30_000}).toBe(true);
            expect(await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.transferActiveTabToWindow?.(2);
            })).toMatchObject({success: true});
            await target.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            if (mode === 'two-window-move-source-stays-open') {
                // The test bridge transfers the payload. Complete the departing
                // tab's close through trusted UI while keeping its context alive.
                await page.locator('.tab.is-active .tab-close').click();
                await page.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().waitFor();
            }
            if (mode === 'two-window-move') await page.close();
            page = target;
            activePage = target;
            observations.push({targetProblems: collectConsoleProblems(target)});
        }
        await addNote(page,'review second saved note',{
            x:260,
            y:280,
        });
        const downloads: Download[] = [];
        page.on('download', download => downloads.push(download));
        await page.getByRole('button', {
            name: 'Save',
            exact: true,
        }).click();
        const workingRef = await page.evaluate(() => {
            const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
            return api.readActiveWorkspaceStateValues?.<{workingCopyPath: string}>(['workingCopyPath']).workingCopyPath;
        });
        const savedSource = await page.evaluate(() => {
            const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
            return api.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath;
        });
        await expect.poll(async () => Array.from(noteTexts(await PDFDocument.load(Uint8Array.from(
            await readPersistedDocumentBytes(page, savedSource!),
        )))), {timeout: 15_000}).toEqual(expect.arrayContaining([
            'review first saved note',
            'review second saved note',
        ]));
        await expect.poll(() => downloads.length, {timeout: 15_000}).toBe(1);
        const downloadedPath = resolve(evidenceDir, 'second-download.pdf');
        await downloads[0]!.saveAs(downloadedPath);
        expect(Array.from(noteTexts(await PDFDocument.load(readFileSync(downloadedPath))))).toEqual(expect.arrayContaining([
            'review first saved note',
            'review second saved note',
        ]));
        const savedBytes = await readPersistedDocumentBytes(page, workingRef!);
        const secondPath = resolve(evidenceDir, 'second.pdf');
        writeFileSync(secondPath, Buffer.from(savedBytes));
        const savedTexts = Array.from(noteTexts(await PDFDocument.load(readFileSync(secondPath))));
        observations.push({
            savedTexts,
            toasts: await page.locator('.app-toast-failure').allTextContents(),
        });
        expect(savedTexts).toEqual(expect.arrayContaining([
            'review first saved note',
            'review second saved note',
        ]));
        await page.screenshot({path:resolve(evidenceDir,'after-save.png')});
        if (mode === 'clear-recent') expect(observations).toEqual(expect.arrayContaining([expect.objectContaining({sourceAfter: true})]));
        if (mode === 'two-window-move-source-stays-open') {
            expect(creator.isClosed()).toBe(false);
            // Keep the creator context alive through the receiver's final close.
            observations.push({beforeClose: await readBrowserPayloadCounts(page)});
            await page.locator('.tab.is-active .tab-close').click();
            await page.getByRole('button', {
                name: 'Clear Recent Files',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Clear History',
                exact: true,
            }).click();
            // Terminal transfer protection lasts 60 seconds. Observe collection
            // after it expires and a normal lifecycle event publishes the graph.
            await new Promise(resolveWait => setTimeout(resolveWait, 61_000));
            await page.getByRole('button', {
                name: 'New Tab',
                exact: true,
            }).click();
            expect(creator.isClosed()).toBe(false);
            observations.push({afterFinalClose: await readBrowserPayloadCounts(page)});
            await expect.poll(() => readBrowserPayloadCounts(page), {timeout: 15_000}).toEqual({
                records: 0,
                chunks: 0,
                recovery: 0,
            });
        }

    } finally {
        if (activePage && !activePage.isClosed()) {
            observations.push({toasts: await activePage.locator('.app-toast-failure').allTextContents()});
            await activePage.screenshot({path: resolve(evidenceDir, 'final.png')});
        }
        writeFileSync(resolve(evidenceDir, 'nuxt.log'), serverOutput);
        writeFileSync(resolve(evidenceDir,'observations.json'),JSON.stringify(observations,null,2));
        await browser.close();
    }
},240000);

async function readBrowserPayloadCounts(page: Page) {
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
it.each([
    false,
    true,
])('selects the fragmented second PDF occurrence with trusted search input (regex: %s)', async (regex) => {
    const out = resolve(process.cwd(), '.devkit/core4-r6/app', process.env.PROOF_REVISION ?? 'head', regex ? 'regex-triple' : 'literal-triple');
    mkdirSync(out, {recursive: true});
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const sheet = pdf.addPage([
        612,
        792,
    ]);
    sheet.drawText('needle', {
        x: 72,
        y: 700,
        font,
        size: 24,
    });
    let x = 72;
    for (const [
        index,
        char,
    ] of [...'needle'].entries()) {
        const glyphFont = index % 2 ? bold : font;
        sheet.drawText(char, {
            x,
            y: 650,
            font: glyphFont,
            size: 24,
        });
        x += glyphFont.widthOfTextAtSize(char, 24);
    }
    sheet.drawText('needle', {
        x: 72,
        y: 600,
        font,
        size: 24,
    });
    const bytes = Buffer.from(await pdf.save());
    writeFileSync(resolve(out, 'fixture.pdf'), bytes);
    const browser = await chromium.launch({headless: true});
    let page: Page | undefined;
    try {
        page = await browser.newPage({
            viewport: {
                width: 1280,
                height: 900,
            },
            recordVideo: {dir: out},
        });
        // Setup supplies the reviewer's known backend extraction coordinates,
        // without geometry, at the result-to-UI boundary. The actual fixture,
        // PDF.js text layer, search controls and compositor remain real.
        await page.route('**/runtime/composables/usePdfSearch.ts*', async route => {
            const response = await route.fetch();
            const source = await response.text();
            const marker = 'const resultsWithPageIndex = response.results.map';
            if (!source.includes(marker)) throw new Error('Search result setup seam missing');
            const ordinal = 1;
            const start = 7;
            const setup = `response.results = response.results.slice(0, 1).map(result => ({...result, pageNumber: 1, pageMatchIndex: ${ordinal}, matchIndex: ${ordinal}, startOffset: ${start}, endOffset: ${start + 6}, words: undefined, excerpt: {before: '', match: 'needle', after: ''}})); `;
            await route.fulfill({
                response,
                body: source.replace(marker, setup + marker),
            });
        });
        await page.addInitScript(() => {
            Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            Reflect.set(window, 'showSaveFilePicker', undefined);
            window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
        });
        page.on('console', m => { if (m.type() === 'error') console.log('APP ERROR', m.text()); });
        await page.goto(origin, {waitUntil: 'domcontentloaded'});
        await waitForOpenFileReady(page);
        keepFileChooserInterceptionEnabled(page);
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', {
            name: 'Open File',
            exact: true,
        }).first().click();
        await (await chooser).setFiles({
            name: 'glyph-run-search.pdf',
            mimeType: 'application/pdf',
            buffer: bytes,
        });
        const layer = page.locator('.page_container[data-page="1"] .textLayer').first();
        await page.waitForFunction(() => document.querySelector('.page_container[data-page="1"] .textLayer')?.getAttribute('data-pdf-text-layer-ready') === 'true', undefined, {timeout: 30000});
        writeFileSync(resolve(out, 'text-runs.json'), JSON.stringify(await layer.locator(':scope > span').allTextContents(), null, 2));
        await page.evaluate(async () => {
            const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
            if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('PDF did not settle');
        });
        if (!await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).isVisible()) await page.getByRole('button', {
            name: 'Toggle Sidebar',
            exact: true,
        }).click();
        await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).click();
        if (regex) await page.locator('.document-search-bar button').filter({hasText: '.*'}).click();

        const input = page.locator('.document-search-bar input:visible').first();
        await input.pressSequentially('needle');
        await input.press('Enter');
        await expect.poll(() => page!.locator('.document-search-result:visible').count(), {timeout: 30000}).toBe(1);
        await page.locator('.document-search-result:visible').first().click();
        await expect.poll(async () => (await layer.locator('.pdf-search-highlight--current').allTextContents()).join(''), {timeout: 10000}).toBe('needle');
        const rects = await layer.locator('.pdf-search-highlight--current').evaluateAll(elements => elements.map(el => ({
            text: el.textContent,
            rect: el.getBoundingClientRect().toJSON(),
            color: getComputedStyle(el).backgroundColor,
        })));
        expect(rects.every(rect => rect.rect.width > 0 && rect.color !== 'rgba(0, 0, 0, 0)')).toBe(true);
        expect(rects).toHaveLength(6);
        expect(await layer.locator(':scope > span').last().locator('.pdf-search-highlight').count()).toBe(0);
        writeFileSync(resolve(out, 'paint.json'), JSON.stringify(rects, null, 2));
    } finally {
        if (page) {
            await page.screenshot({path: resolve(out, 'final.png')}).catch(() => {});
            writeFileSync(resolve(out, 'state.json'), JSON.stringify(await page.evaluate(() => ({
                current: [...document.querySelectorAll('.pdf-search-highlight--current')].map(el => el.textContent).join(''),
                all: [...document.querySelectorAll('.textLayer')].map(el => el.textContent),
            })).catch(() => null), null, 2));
            const video = page.video();
            await page.close();
            await video?.saveAs(resolve(out, 'proof.webm'));
        }
        await browser.close();
    }
}, 120000);

it.each([
    'dom',
    'css',
])('real ligature regex overlap preserves the rendered text (%s)', async (mode) => {
    const out = resolve(process.cwd(), '.devkit/core4-r6/app', process.env.PROOF_REVISION ?? 'head', `overlap-${mode}`);
    mkdirSync(out, {recursive: true});
    // Keep actual ligature glyphs and Unicode source ranges in the public PDF.
    const fontData = readFileSync(resolve(process.cwd(), 'public/fonts/annotation/DejaVuSans.ttf'));
    const tables = new Map<string, number>();
    for (let index = 0; index < fontData.readUInt16BE(4); index += 1) {
        const position = 12 + index * 16;
        tables.set(fontData.toString('ascii', position, position + 4), fontData.readUInt32BE(position + 8));
    }
    const cmap = tables.get('cmap')!;
    let glyph = 0;
    for (let index = 0; index < fontData.readUInt16BE(cmap + 2); index += 1) {
        const subtable = cmap + fontData.readUInt32BE(cmap + 4 + index * 8 + 4);
        if (fontData.readUInt16BE(subtable) !== 12) continue;
        for (let group = 0; group < fontData.readUInt32BE(subtable + 12); group += 1) {
            const position = subtable + 16 + group * 12;
            const start = fontData.readUInt32BE(position);
            const end = fontData.readUInt32BE(position + 4);
            if (start <= 0xFB03 && 0xFB03 <= end) glyph = fontData.readUInt32BE(position + 8) + 0xFB03 - start;
        }
    }
    if (!glyph) throw new Error('The public DejaVu font has no ffi ligature');
    const head = tables.get('head')!;
    const hhea = tables.get('hhea')!;
    const hmtx = tables.get('hmtx')!;
    const width = 1000 * fontData.readUInt16BE(hmtx + Math.min(glyph, fontData.readUInt16BE(hhea + 34) - 1) * 4)
        / fontData.readUInt16BE(head + 18);
    const pdf = await PDFDocument.create();
    const sheet = pdf.addPage([
        612,
        792,
    ]);
    const context = pdf.context;
    const fontFile = context.register(context.flateStream(fontData, {Length1: fontData.length}));
    const descriptor = context.register(context.obj({
        Type: 'FontDescriptor',
        FontName: 'DejaVuSans',
        Flags: 4,
        FontBBox: [
            -1021,
            -463,
            1793,
            1232,
        ],
        ItalicAngle: 0,
        Ascent: 928,
        Descent: -236,
        CapHeight: 729,
        StemV: 80,
        FontFile2: fontFile,
    }));
    const gidMap = context.register(context.flateStream(Uint8Array.from([
        0,
        0,
        glyph >> 8,
        glyph & 255,
    ])));
    const descendant = context.register(context.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: 'DejaVuSans',
        CIDSystemInfo: {
            Registry: PDFString.of('Adobe'),
            Ordering: PDFString.of('Identity'),
            Supplement: 0,
        },
        FontDescriptor: descriptor,
        DW: 1000,
        W: [
            1,
            [width],
        ],
        CIDToGIDMap: gidMap,
    }));
    const toUnicode = context.register(context.flateStream(`/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Ligature def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfchar
<0001> <FB03>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`));
    const font = context.register(context.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'DejaVuSans',
        Encoding: 'Identity-H',
        DescendantFonts: [descendant],
        ToUnicode: toUnicode,
    }));
    sheet.node.set(PDFName.of('Resources'), context.obj({Font: {F1: font}}));
    sheet.node.addContentStream(context.register(context.flateStream('BT /F1 36 Tf 72 700 Td <00010001> Tj ET')));
    const bytes = Buffer.from(await pdf.save());
    writeFileSync(resolve(out, 'fixture.pdf'), bytes);
    const browser = await chromium.launch({headless: true});
    let page: Page | undefined;
    try {
        page = await browser.newPage({
            viewport: {
                width: 1280,
                height: 900,
            },
            recordVideo: {dir: out},
        });
        // Geometry-free results exercise the actual text-layer compositor.
        // The matcher still supplies all four real normalized regex ranges.
        await page.route('**/runtime/composables/usePdfSearch.ts*', async route => {
            const response = await route.fetch();
            const source = await response.text();
            const marker = 'const resultsWithPageIndex = response.results.map';
            if (!source.includes(marker)) throw new Error('Search setup seam missing');
            await route.fulfill({
                response,
                body: source.replace(marker,
                    'response.results = response.results.map(result => ({...result, words: undefined})); ' + marker),
            });
        });
        await page.addInitScript(mode => {
            Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            window.localStorage.setItem('pdfHighlightMode', mode);
            window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
        }, mode);
        await page.goto(origin, {waitUntil: 'domcontentloaded'});
        await waitForOpenFileReady(page);
        keepFileChooserInterceptionEnabled(page);
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', {
            name: 'Open File',
            exact: true,
        }).first().click();
        await (await chooser).setFiles({
            name: 'ligature-overlap.pdf',
            mimeType: 'application/pdf',
            buffer: bytes,
        });
        const layer = page.locator('.page_container[data-page="1"] .textLayer').first();
        await page.waitForFunction(() => document.querySelector('.page_container[data-page="1"] .textLayer')?.getAttribute('data-pdf-text-layer-ready') === 'true', undefined, {timeout: 30000});
        await page.evaluate(async () => {
            if (!await (Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi).waitForActiveDocumentOpenSettled?.()) throw new Error('PDF did not settle');
        });
        const before = await layer.textContent();
        expect(before).toBe('ﬃﬃ');
        writeFileSync(resolve(out, 'text-before.json'), JSON.stringify({
            text: before,
            runs: await layer.locator(':scope > span').allTextContents(),
        }, null, 2));
        if (!await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).isVisible()) await page.getByRole('button', {
            name: 'Toggle Sidebar',
            exact: true,
        }).click();
        await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).click();
        await page.evaluate(async () => {
            const monitor = Reflect.get(window, '__evbViewerInvariants') as {waitForSettled: (options: {timeoutMs: number}) => Promise<{
                settled: boolean;
                reason?: string
            }>};
            const outcome = await monitor.waitForSettled({timeoutMs: 10000});
            if (!outcome.settled) throw new Error(outcome.reason ?? 'Sidebar layout did not settle');
        });
        // Sidebar opening can change fit-width, so sample ink in this layout.
        const inkBounds = await layer.locator(':scope > span').evaluate(span => {
            const range = document.createRange();
            range.selectNodeContents(span);
            return range.getBoundingClientRect().toJSON();
        });
        await page.locator('.document-search-bar button').filter({hasText: '.*'}).click();
        const input = page.locator('.document-search-bar input:visible').first();
        await input.pressSequentially('f|if');
        await input.press('Enter');
        await expect.poll(() => page!.locator('.document-search-result:visible').count(), {timeout: 30000}).toBe(4);
        await page.locator('.document-search-result:visible').nth(2).click();
        const readCurrent = () => mode === 'dom'
            ? layer.locator('.pdf-search-highlight--current').allTextContents().then(texts => texts.join(''))
            : page!.evaluate(() => [...CSS.highlights.get('pdf-search-current-match') ?? []].map(range => range.toString()).join(''));
        await expect.poll(readCurrent, {timeout: 10000}).toBe(before);
        const state = {
            before,
            after: await layer.textContent(),
            current: await readCurrent(),
            paint: await layer.locator('.pdf-search-highlight').allTextContents(),
        };
        writeFileSync(resolve(out, 'state.json'), JSON.stringify(state, null, 2));
        expect(state.after).toBe(before);
        expect(state.current).toBe(before);
        const paintBounds = mode === 'dom'
            ? await layer.locator('.pdf-search-highlight').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()))
            : await page.evaluate(() => [...CSS.highlights.get('pdf-search-current-match') ?? []].flatMap(range => range instanceof Range ? [range.getBoundingClientRect().toJSON()] : []));
        writeFileSync(resolve(out, 'geometry.json'), JSON.stringify({
            inkBounds,
            paintBounds,
        }, null, 2));
        expect(paintBounds.every(rect => rect.width > 0 && rect.left >= inkBounds.left - 1 && rect.right <= inkBounds.right + 1)).toBe(true);
    } finally {
        if (page) {
            await page.screenshot({path: resolve(out, 'final.png')}).catch(() => {});
            const video = page.video();
            await page.close();
            await video?.saveAs(resolve(out, 'proof.webm'));
        }
        await browser.close();
    }
}, 120000);

// Public two-page regression PDF. Subsets of DejaVu Sans, Noto Serif Hebrew
// and Noto Sans Syriac retain real glyphs, marks and ToUnicode mappings.
const RTL_SEARCH_PDF_BASE64 =
    'JVBERi0xLjcKJYGBgYEKCjQgMCBvYmoKPDwKL0xlbmd0aDEgMzY4MAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDI2MzMKPj4Kc3RyZWFtCniclVcL' +
    'VJNHFr7zvwKIQCBBULSEQBJEUfMTQBRBBREFRMEWXCv8PKOQgAQfyHZVmnpsbX2g4uqxj61at9FSX6cbUDlFrdBV9+jZ6r70tJa62NZ27dY+gPhn7/8HKO3u' +
    'nu7+w8zcO3PnfvfembkZgACAP2wCGmoz0tLnQQEIAL6bcDQ2I3dRXtrarDXIn0A+PCNv6Rz94ZSLyF9HviV7dv587xTeDjDajPy3i/KmGHf1O/wAvOuRf7LU' +
    'ItRG1Y9Dfd5XkT9TKdhqQYEFfKV538rqhor3ts85j7QLQFFmLhfKpnrfywbwOoNj8WYcGP2qYguuz0U+0mypX19GBU7E+QfIl1XXlAqqGepbyEv2xlmE9bVQ' +
    'SHciXyzZaxUs5fovkjsAfHCefFBbY6t3/w2WIXS+NA8E7gIwy9ib4AOQoFGypiheqVFrRLJA3E/Kf08WuA47GNt85/z+mw6UbkHpBexDCAOIQjFTPCTMIqY4' +
    'nTaCU5hmEd7IqFWcggPyPNXpyrKRl3gh++iWoj+u3/BBwX2iSv9FqPjI4XCsI7uSLPsy17XMmXt1mvH+heVHaseLn6P+g+4exob6DWjtBKJWMZoInd40ARXH' +
    'I0oMMXmIH8HRKbsOidfF+yu6VuV3Wzq62o60vrP3lUO/zuuos71f+Hfiu52OeuLSzjv/jIq6OM3YssO+9411tbbGSN2Z8PAbp355DICCRsSdzDRiFKIQOYJT' +
    'q4IRKZkkKLUmP6KN0Jni4nnNSORgquPD45tr9rc5nSnnth6/8niAUEf3Fb+TX96x7OuHFF/RWGL7y5norMebHRVC5+vn3w3cuC021qHXuyS8dsQ7zKlglBRJ' +
    'Iqv1QBJJNygDKMTUq7VKnr53tLn5qFQfb0862XgV3O6rjSeT2tqoKVd6e69gpZaUCeI58Xss54Sy36JWAqvdPXQv+hOK2tWxZFh9glryBvWDxhhM9+a8nHv6' +
    '8uXTuS/nZB95+rF4i0wm3NLXGdPxmJiea9d6YmIckZFokR8JJElayW7Uy2xEvSoYJ2nWyDsjKw2XlKLpChlNwWx0nfK99rtVXSWl16vER2IXiXZ9TBRO6sjW' +
    'A21+1IplHV1xca0TJ5FE4kOCyFzxzqV9Z1pfGcJYgxijYMyIvcDY66XAgMd8yrbn+LG9u48f3/2QBIpfPvxK/AdR0h/2vv9+7/3urk8Pit3iA/ELhJ2O2lUk' +
    'EQgpFdfQZ92/kW4fq9aatCaNmvpry12q4JsW/BAKx/FOsy2YCUDJq7UtSEvjbCgL7NuecYLjbOjQDLRjU88UyzNKrZLUtzPFA6/hAM4VANAP8WZ5AWiIRskr' +
    'WQUhm8mex3PPUndo8Sn6BsWI24jV5S+fCLxZe3GhF+YiiCZKjXECpcZOiYeD2euKIj0vvbsuzvUhVdnUxhQnbT7/ArG5Oshnl5tlLPccZj6uDpLs4JUqP0aB' +
    'V5nwuHmB9NZ3g6YVbL3QJG4ikeIHF4jKvnMenUbCxE/Wnnp768ZVU7a9aWZGu4zTW4iXx242D3XhHdRoaT5ollcCTynwViuCjLO4BN5PQVrPHWjLnLow0TBe' +
    '6e81mjsSGBJdXXQ0pmRfc1VpemKET1vgxOSFKzcfu8IUP/6K+Gu0qaan0xtiRFflsfRkTrzmb5i7svm9/pffcH1y6PmnksciKuYs0oBnFyMZxCu1nU4np+p7' +
    'IPnWJPp6j6W+hBTMOZIVnFanj1TGJfDcmOAxeDQS4hPi9bophB9iTbxKIkIJBkKWj9Dr9PJKxhWS/1xn7vpNFvGLlc5qQnYXLS4paliRSkhAqjMyIGyGbcmk' +
    'KGdQqnW7c/nCiqjwzKkvKKcVGefZJ52ucswaS8IyyPxvz/zh9mldSNTUV6q3P5P82cEFMzdvqLxwzfgmCSE60dG1enmId+i8xlcn+NOcZP8OsZsN4eQbExVv' +
    'wt0JUHCsZFQkrUMn1CqP1UxgjrOkQRzYsrQoU7xNSKpz9huGzFxLa+avephVAy3ixZ0n50QELyfKF5bbbE2zAiJM0rl5UVQxK6ivQQmxCObxPw79xZSiQN0K' +
    'HbZ4MuMS4nlMYtgapTDhBKflqJINWZPUJk49wxA7Y1ya1bgwtHv97GXU69nLsxe9E+ZVsr7gFNFPDJ6eFKIqUPqOS0szdIbljF0kqsiDtyoSJhr22FMi845O' +
    'TmyenUuhp7eZdjqSdch7aIpS36bmM+3WJivOdDNX6ETukZzXB3fEFDfovLR/Jh5N4o1oOS/bpuD0OirAXzM9fVF0RIAwKjTImMxQxXRhxuhK33GT8zKeGMfa' +
    'swzpKXEWS8kzifkRoaoQx5LCyPiLrbbpmfXPxRf6eGsmSPGZAsC5MPrRMFnKWFJUxhONFImE+BkSL7EYoKGqNfFSrmfxnlPfnyjV60jfU2H6nGdbT5RmU6fa' +
    'RIX0d+JE63m6r62NU+03GMylOWeXhgXp9+eaSwdeo2+4pnjqjpyzx6hP5bwCoXQ+xIAZfGXuh88LmEFqDGTAs3AWPidjSCZZQ7aQZvIqeYtcIj2UN5VGLaZO' +
    'Uh/ROpqna+lTshZqhbNhe2hSkf/Mb+AJL1nJvbzxzqH+u1uuLL9C79syCuUBYa5BBbUN7/cYuIu1BetBphcaWRW0MxWwmnmA9R6sRqNLPSvYUCoW516EAnYR' +
    'tLMU9seggJoOnd6XoIm9DjuYR/AiCko43YpzGG+0TWERxwP4id/d6l/sV/gTnzEaQBg/slNKtyzP7pd+6z09/Se0LxBdG8XRtBdDURgdA0kdsTS3Ir0MUiF8' +
    'gOZUeAwPKCykB2AEguQpnj+QMgmRewZek95O+NphsIQDD6VQDjVsG9vJ3mTvsB+zn3J6jufSuRxu8QDtdssvo2n4CpSknLLU7WGptCEp9133Dfdh9yH3gf4l' +
    '/Qv7E/uN/bH9hr7P+z7qu97X3XeZVf+b3//tU+CLDK1lvNGRqbL9Ek0gGDkPTYEXmTdI0yPGmRE0CyEkZ5DmQEUqYC7UQC00QB2shEo8ffXolwG9j8beCFOx' +
    '8EiVoEQ4zEGZerBhrUO/BbDAJBzNBCvKxyI1G6qxhMOSYV02mSvHvhzXrMW2DCV9/gfU+GHUfERai1ircI0VpSU7BFzz/yGmIbUK1z0Ja1CiFGUFWVu5vEKQ' +
    'PQpHLVZsa1GmBPWuRLlwXF+D6II891M9ebIWG1pUg6UKRyVUG8rWyJqMiM1Dwo9WDa2hPRvr/rP01v6PHyXdSjxrnlPqOzzKIi/tvQ8WGt9A0ikKxuxAQwgW' +
    'avCs++C7cQKQtHlZ+UM5RD63MDzfDHtAJc9vEOqEErALdRYr2EvqhJVgLxWsNmzN5XXYNtRVg72yvAbpyrryKrCbBSvKmMtLcKRKsApgrxZqwqW2HjVYhHoz' +
    '2K1V0khNpWABe90aK0rWV1grsTVL+n9i0Ui7PoL7kAszfUFxR3a4CbNSMeaBmx4hiR75DfHEPEgv/fnrRPD/L2rtz8tJeyPJyns0RI/Q8aPxZSP4uh9oKhFg' +
    'YAfSM4eXGuS9G/IY/gWESVpBCmVuZHN0cmVhbQplbmRvYmoKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCA0Mgo+PgpzdHJlYW0K' +
    'eJwFwUECQCAAALApooNCof+/tA3ZsDssqlNxez265vPbJJcgWicXcwEMCmVuZHN0cmVhbQplbmRvYmoKCjggMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNv' +
    'ZGUKL0xlbmd0aCAzMTUKPj4Kc3RyZWFtCnicXdJfa8MgEADw93yKe+yeYkzTrhACo2XQh/1h2fZu9OwyFiPGPPTbTz3pYEICv9wZPc/yeD6dzeihfHWz7NGD' +
    'Ho1yuMyrkwgDXkZTVBzUKH1WestJ2KIMk/vr4nE6Gz1D20L5FoKLd1fYPKh5wDsoX5xCN5oLbD6OfXC/WvuDExoPDLoOFOrwoydhn8WEMTws6E/4LT7X8PEv' +
    '/H61CDy5op3IWeFihUQnzAWLloXRQfsYRlegUf/iPE8btPwSLqVXIZ2xne6SeJAeWE2qKZa1JTWkJokz0i6qUYq0J+XMe5IkHZLwQBJRu23OHJL4niQptiWp' +
    'pDrvBSmGJJ3UVEkVo31m5fo4idPqWVRfnTOpvjrHqL64XjjGfF7xQGPTb62Sq3Ohi+lmpA7F3owGb5fHzjbOis8vYxmnygplbmRzdHJlYW0KZW5kb2JqCgox' +
    'MCAwIG9iago8PAovTGVuZ3RoMSAyMDkyCi9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggMTM4Mgo+PgpzdHJlYW0KeJyVVVtsFFUY/ufM7Mzsrbvbndmu' +
    '2y2d7ra7XUqX7uzsRQutYLtLpXYLC0poabv2qvQG3RKIoIQ3G2OagIkhBqNSH0yUkiiXRCK+SMID0Rcf1AeNCTGGxGhCUtB0/M/sltRKYpzZOef7//Of77+c' +
    'ywIDABVwGlgYynZ0ZiAICQDhGmpD2d5cvuNY9zzKP6KsZPP7d1757aYNQEQRNufyW9XXl0ZaAbi3UR4anirMSp/JYyivoDwyXpibxd6J85exF8cnT4xNvVd9' +
    'CfE9APJwYrQwIs//+TXa+1GXnECF0Ka/iXIR5fqJqeJx50F4C+V91P/kzHCBfMFeQZkGIE0Vjs+CD74EYH+h49OFqdHNixn0Z+pHfm12Zq6ovwsq+l+k48BA' +
    'l77Cnid5CKNNKBwKBj2eqmAIUSihpTyeuJpMpqoqiCCjvvQjvw59uPSBWKlYnhUlq8VW09jfPXT7865E2/JXQ8quSKSj2p+sFp3nzmbP9zz1ckxNC02iiW+d' +
    '2NmSGd8mmGxbA4G4y+UV0XsMo8qR3wGzjQdC4dQmEo9HWexN6EmW+ODdvXsqNWeoXX3ojLdngrssgabmiCJabV5vNBz1eM2Jsx9f7/N7+4sni33eoOrx1SEl' +
    'tOpZtoX5HtcuBVCHzEGeF8JtJIXZREm4nFhcxYSol5SaTGihYIAXKogs0SzjpH973s45B9uiWldUZDmu99xhydf26VhtrtO1/ZC7smdc0upbdtTu2kJYYnE5' +
    'tcZ0JLfYGkpPv7K7ptNPZL81463n+eiT8b4XBruT2uBzImsJKEJsm8/7RCl39jTzEV2NBg0LHi5XPRmvU2lUAl/+yXJpFXg+WLdWJOaG6KoMugJWt8fjYl50' +
    'SZJkrZFd1RaHdUlta3Sqrr78asNa8S7fibQ7K3mWZYhDcjkqXJKNZTiOtVqdHeHXzFXylnC0VE4g+i3SCBq5j7sUS8kaVZIlQeCDAbolqjYqeJPA8XbzZsEs' +
    '2Mw71gvkHs+KZt6mWcyiYEuvFwAY/SLxwSFyBs8ZuKuEcD9zjSFngp0BOrZAamE/WcYdCm6JOgob3lISXbeEVl5AXDNE+zdVCV6Rb6n11VjdDhtfKzgcdqud' +
    'r5HJKX+daE/G/GZHvWyX7DbZ57RWuAWrm55Wes7NcJOexrL0uKcdDsMNxsxsZ3YzpwwrArDkbhoadGy7D4JxzuDbS1d52v9gIw2rY6sZU5o9iSJPbelDDsAA' +
    'w2E134cusggxdh5a2ct0B+i39Iv6AuVlL6z68AymV8f+0kzpf8UjAEeyzCKYkG0B+QB2l3pmAFSmG7VWE+FMHCHoR1mbfZo22VwuyzwNipAo+WAvMHfXMiYR' +
    'ctu4CaCUGV0NkLBljJ6DXuO+chp6he/h9whOoU5oEhK6vk6jlDT6Tw+uP7i68sfKzyvfrXzz2JoKcJCyc2bEA4Y/ihmMYKCMCd6+r5YxCzvhjTLmoAXulLEJ' +
    'lmG1jHnYwnwCz8AMzMIJOAovwThMQBEZVZwRgzSiLI7OoH4SRlHqgmkYhiiiHaiZxH7vo1lzhjSK/ShyHcN2BC17cHYRPwXyUMDZcwYqeSsgF50xDvPIVUCd' +
    'ijNajLcVPefwzSJa41hjWD+/eQPDf/lTNtg/b0Q7h6MzaK38IwIFmYowhnbzBucEWk0b9WnE/GJomcYvDhHUNBvVSBvoKLYJZKA4W65mSTqObQw0A3dgS2Mo' +
    'Gn6b0Y+CiEYxasgFbI9gZEcM6QC2AXz/Ty3Y0sbR36E35WMeBu8LHRzGbrMZGj/uIfqaUMfjXzOLuISY8r63oM0mYDoy3ftQyxn8+iM+Oh7C6hBjvGLuxNFh' +
    '8G6wMp6/Aa/zR8gKZW5kc3RyZWFtCmVuZG9iagoKMTIgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAyMAo+PgpzdHJlYW0KeJxjYGBg' +
    'YmBhYGZgZWADAABeABUKZW5kc3RyZWFtCmVuZG9iagoKMTQgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAyNDEKPj4Kc3RyZWFtCnic' +
    'XZBLS8QwEMfv/RRz3D2l7Vq8lICsCD2sitUPkMe0BmwSpumh3948ygoOJPCb/7zZdXgerAnA3smpEQNMxmrC1W2kECTOxlZNC9qocFD+1SJ8xWLyuK8Bl8FO' +
    'Dvoe2EcU10A7nJ60k3gG9kYaydgZTl/XMfK4ef+DC9oANXAOGqdY6Cb8q1gwyXLFMO5khIrOP/lz9wht5qZMopzG1QuFJOyMVV9H49C/ROMVWv1P70qWnNS3' +
    'oBzdxOj6sal5pjZT2xS6FDq0h0KyUJfp0uUuR73UL93kvonaiOKS+XB5gTS6sXi/rXc+ZaX3C1j9efEKZW5kc3RyZWFtCmVuZG9iagoKMTYgMCBvYmoKPDwK' +
    'L0xlbmd0aDEgMjM2OAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDE1MjYKPj4Kc3RyZWFtCniclVVdbFNVHP+fe+5HP26/1vvVdXTd7dqOspWtXddt' +
    'DMQxVswIM5vDSeKkQFmRbR3bQAia8KIkJBKIxPiAkIjRRHzQBD94MhLig+HJL16QRB/EJTyYoFFm0vo/t4WxaWK4N+ec//f/d/7nf88FAgBuOAEUducGtg5C' +
    'FAQA2w2UxnJPD48OHNl+GPnfkQ/nRsf63ytf+QvAriCfGB5dn5pr3/ccgHAO+d17p/Oz5jt1l5Fn9guT+flZXL3ofx1X2+TUsf1Xx/tGkL4LQH8pFvL7fD1D' +
    'HrSXUdZVRIFI4WXkmV9zcXrhqOsG+QH5AeRbp0p788J18VkAnsU3pvNHZ8GE35D/juGbyU8XWmNbbwOIRQCub7Y0v1C5CClM/S7TA4FQ5QNyjzsJ3QB6JhuP' +
    'xdjIdHZl06qi65qqiFJc1HR9E5d9RIMCTZMkN5Uk83LOaxcjQd3pCiYG41TYxrndYx3b2iRuZyDgcAc1pU/VeZsUH8hvfnvnsT0Xm6c6BN4IaetMvlW0i+0O' +
    'I+iIDAXfT8y8GHHIvG76Y3He0Kmd1usdLcdPvpJA8ATi5UW4W/kEQog0q2oaImDopK6uTGcsYjJQEuLLdmXn2vWQzSYQsp4jDYE0IUnq9rXuoCle93ob6mTd' +
    'SV1+R8TcYldkqurRNRE7cJDFJH9jJRogAZA2YxlfZzYTMR9uOZ1OYUafIkaiTSlMyrJGRFE9qIV6qG6ItmCDcSfdWRc1y1dJQvFLmdg1LVrfRoTRfs6M+ZoS' +
    'NBBs2ZIon4m0TAeb7Nd7056xNNtZkrsAx7h74ADws3yYCHc26lOiPlXlLih6QlU1lVnKlfvkC3oAerEGaMmgZS0okSbmiIfUFV9xfnhIYhW4xGqFcFXlZp3H' +
    'r73hciTL9wOG0+vlBV/Ib3dRRYsosjPk6vwpHnUSl3Jatklq0DCixiW3Xx5Omo2+TG+nx095zvC419poAxWoGZ9PN7bpr/mj2nm5XqlvR5S9lQDcqnwIEjup' +
    'SDYtRfRZaSO9SHvEOxOZzATbCfYg9zFWG3s3XQW8qruqnScyLu3/Lx1Npzbxq5sSe1KIHPb5Dbc/EMCOVNXWNQ6JZh0OWTm+WQsEZPmBbP0TE83diZDfQciG' +
    'oG73BOVALE4pcSiRzFCq8GZzaylJeS3sbzOpofISH7Ar69z2ZL658flBchxVjVqy8RGVVH49MTgy0l/nErh6sy66jnoaOUq7NwbGD07tyj7eSbdU7gPrRgNr' +
    '6GOdtrIRdb8oSp86fP1GABsvWN9TrxCXU1ck8pXibYr7YlFqNATCZUn22YDFA3DineaFabzXGLf8UOx99ozBq3ANbpIE6SOfkRv43rMsUZvbNXzuBU/fHyDR' +
    'X5npt2dLfWy95XzrUiVZvk1HaAlZsRYJuHGY4DT2pUKcG2RfFiTJn8DutF7uJjt75HmENQgtLAc9UcY7ip7CWDY6sgofQ85zAXKG3cPcKYwNMFRdyQSkSD9K' +
    'OYETBYHjMKZthXdueDhHNkNYWKzlOEHMWj2AM7ivrVuQVndprUqtPgrwsBvXOqwZq1BYOCtcFb4Uvhd+FH4WFisV5omyzy3Zraqssrh0CGApt5TBuXEpVNuJ' +
    '25rlGiQRIwtWLgl2sWy8HekJKz+jCd7gEzWaq/2JGE1hAE7XaB5r+E2NFuAjrGWVFrGuV2ALlGAWjsEcHIBJKMIC7jEF7dABXUjlUFtC+RQUkHsKZmAvJJF6' +
    'EiVTuI489Jq3uAKuBYx1BOd9aLkDvRdwhGHUkh+A/UhvQ3oPcgV4yfKZhMMYLY+SFPq0W+8GzD2Mbw6pB1GWYzwaoW1VjP/PGV7lsdOym0fLEu4wvAJFGGMt' +
    'YIQ8WrOoRbSasarUgrvsQMtuHGlYi5I2qybdFjWHcwYjMDpXq2mVO4pzB3Ra9ADOxRoyxjOkMxaKgsXncT6EyA5Z3DjOJr6PVw9abaXKeetb+vdDgGCHeqz+' +
    'k5dleO8Qq7+XR/VbYMOBfz7s2IHB7c+ADTuMxa889GX6GNaHs/TuYmHPHN5NK62s5x8EsW2lCmVuZHN0cmVhbQplbmRvYmoKCjE4IDAgb2JqCjw8Ci9GaWx0' +
    'ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggMjYKPj4Kc3RyZWFtCnicY2BgYGZgYeBiYGJgZeBgYGNgBwABVwAuCmVuZHN0cmVhbQplbmRvYmoKCjIwIDAgb2Jq' +
    'Cjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggMjU2Cj4+CnN0cmVhbQp4nF2R2UrFMBCG7/sUc3m86qLVFkpBjoi9cMHqA2SZ1oBNwjRF+vZmKUdw' +
    'IIEv/+zJz8PDoJWD/I2MGNHBpLQkXM1GAoHjrHRWViCVcAfFWyzMZrkPHvfV4TLoyUDXQf7uxdXRDqd7aTheQf5KEknpGU6f59HzuFn7jQtqBwX0PUicfKJn' +
    'Zl/YgkHmK7on5IQ//vFP/tgtQhW5TJ0II3G1TCAxPWPWFd566B699Rlq+U9vUhSfxBej6F1676KWso9UReJtouuk1YluIrVlojppItFtJHFodylLk6iJhG3s' +
    '56gcOgvbu8wsNiK/jrjiOGoYUmm8/II1NkSF8wvMqIORCmVuZHN0cmVhbQplbmRvYmoKCjIzIDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5n' +
    'dGggMTcxCj4+CnN0cmVhbQp4nIWRQQ7CIBBF955ibuAMMFAT46JR414uYK1deP8DOI1DKUTs4qUNzP882j7C/noG4yBOEAwEixBHOCIiCUawghO4XjtBfMMl' +
    '7vqqw3tOHV4IQiccmvO4nPkQBuEpjPocitw959jyT9di/pbnXfh7t8W15emQa8+XOk76vulsXeHA6sFb39SEdPYcI9L55N193Um7SPZI7kXc7CNc/6NVPmfr' +
    'Pe36AAygeBMKZW5kc3RyZWFtCmVuZG9iagoKMjUgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAxNzEKPj4Kc3RyZWFtCnichZFBDsIg' +
    'EEX3nmJu4AwwUBPjolHjXi5grV14/wM4jUMpROzipQ3M/zzaPsL+egbjIE4QDASLEEc4IiIJRrCCE7heO0F8wyXu+qrDe04dXghCJxya87ic+RAG4SmM+hyK' +
    '3D3n2PJP12L+ludd+Hu3xbXl6ZBrz5c6Tvq+6Wxd4cDqwVvf1IR09hwj0vnk3X3dSbtI9kjuRdzsI1z/o1U+Z+s97foADKB4EwplbmRzdHJlYW0KZW5kb2Jq' +
    'CgoyNiAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvT2JqU3RtCi9OIDE0Ci9GaXJzdCA5NwovTGVuZ3RoIDg0Nwo+PgpzdHJlYW0KeJzV' +
    'Vt9v2zYQftdfcY/pQyTyKP4aggBOZDfGkLWIs3bY0AfF5jwVjmRIMlb/97sTrWVr4qTYUBSFcSTveOR9p/tIU4IABI2gwBnQoHMBFqz04EFKnVMDEq0DqUDm' +
    'mnoN0jgB0oJ0wgB5Sk9LUQKizKkBVLQJ0lBTc3aWZLf7bYDsbbkOXZL9WK06+I39BNywG3cfkuyy2dU9YHJ+njysuSz7ctOsk7gYJDuPHm/bZrVbhhbOZtPZ' +
    'TAgrhDA5iRECC+ovSTwJkk5z6GhMYvODkM0qIdSE5mZRjI1reH7w1Yf1U+rJ17BPEX1zF/W/43KsadwDX8Ljz5PsulkVZR/gpPgBBRopJAqpVe5+fUWfow1l' +
    '33y/yQ34q6Y+muG/6jxr6r4I3bKttpR0Mug/lfc0s9jddYHmPpbvdmTflOsO8uhwcdF8IiadSkHkO80NMdR6alAhE2pO1KmWk3q9CSCSbNItAxHMo0syDsXK' +
    'KSpDUMvtVajWf/Rg0SfZog/378CJGGRWbQJC/k/iPUBOGF4fmTov2MJzmGQXZRdY/Rw/eS32HQWY1783w9m4Ceuq69s9nExWzV2gyr9pV6Gt6jWczFcEsur3' +
    'rzjOdrsJ9wxaMI7PvhidXAaYFe9BUmWS7D19GElipEydpEoZ1OCNSa03zvI596kT+TA2Uqd0ZhUNlbSps1J4VoxRqbY5SnZCi2lu4oQ2LlV6GFrh0twf7Eb6' +
    'VMZQaGkjhUJJUiyaVLNVIorURqOgn5FIgDBCMipPrRn8SFI/jpUhdCPUo8qH4Q6ZF7fN63lxXW7BvFgyNorjtZrWy2bFdcjGOpxejdRZlcQMWsM3mR1vsNvm' +
    '57qiNQHc07GfY/hi31bl8tsxXIr/SfExga9GcSmPcNwrAc4RH7QBnzOzHpFB4n9lw5jWl7KB/icf0UEeuT6e48NVuGvDn9+QDy+fn+f5MCbw9fhgj/BBO662' +
    'Qs5ACzXcNBbtE6w4ck5fZsWY3Bezwj9mBT5x4viZw4+dlrM+8P0mdM2uXdLzh/0GFMOgAB8dZgt+lcXhFT/EDttmv7y5+xiWgzur00/960XP/8fRwLbrsKrK' +
    'yKrDhQx0ITPQSV03A/bhbVb3IWaCI7+/N9z6AfdfhWzmSQplbmRzdHJlYW0KZW5kb2JqCgoyNyAwIG9iago8PAovU2l6ZSAyOAovUm9vdCAyIDAgUgovSW5m' +
    'byAzIDAgUgovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvWFJlZgovTGVuZ3RoIDkzCi9XIFsgMSAyIDIgXQovSW5kZXggWyAwIDI4IF0KPj4Kc3RyZWFt' +
    'CnicJce5DYAwAATBO/N/EjKZgQBRD23QFAWQQg20Qk5OwGNdspoF8L4GDvChjyFqbcB8l0IWoxSxXKWYdpYS2kNK2TxSRjdJOd0mFT4l21tbsbsA9uefYQE+' +
    'QMUNBwplbmRzdHJlYW0KZW5kb2JqCgpzdGFydHhyZWYKODYwMwolJUVPRg==';

it.each([
    {
        mode: 'dom',
        regex: false,
    },
    {
        mode: 'css',
        regex: false,
    },
    {
        mode: 'dom',
        regex: true,
    },
    {
        mode: 'css',
        regex: true,
    },
])('ordinary RTL search uses logical text and glyph ranges ($mode, regex=$regex)', async ({
    mode, regex,
}) => {
    const out = resolve('.devkit/core4-r7/app', process.env.PROOF_REVISION ?? 'head', `${mode}-${regex}`);
    mkdirSync(out, {recursive: true});
    const bytes = Buffer.from(RTL_SEARCH_PDF_BASE64, 'base64');
    writeFileSync(resolve(out, 'fixture.pdf'), bytes);
    const browser = await chromium.launch({headless: true});
    let page: Page | undefined;
    const observations: unknown[] = [];
    try {
        page = await browser.newPage({
            viewport: {
                width: 1280,
                height: 900,
            },
            recordVideo: {dir: out},
        });
        await page.addInitScript(highlightMode => {
            Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            window.localStorage.setItem('pdfHighlightMode', highlightMode);
            window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
        }, mode);
        await page.goto(origin, {waitUntil: 'domcontentloaded'});
        await waitForOpenFileReady(page);
        keepFileChooserInterceptionEnabled(page);
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', {
            name: 'Open File',
            exact: true,
        }).first().click();
        await (await chooser).setFiles({
            name: 'rtl-search.pdf',
            mimeType: 'application/pdf',
            buffer: bytes,
        });
        await page.waitForFunction(() => document.querySelector('.page_container[data-page="1"] .textLayer')?.getAttribute('data-pdf-text-layer-ready') === 'true', undefined, {timeout: 30000});
        if (!await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).isVisible()) {
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
        }
        await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).click();
        if (regex) await page.locator('.document-search-bar button').filter({hasText: '.*'}).click();
        const input = page.locator('.document-search-bar input:visible').first();
        const current = () => page!.evaluate(highlightMode => {
            const ranges = highlightMode === 'css'
                ? [...CSS.highlights.get('pdf-search-current-match') ?? []].filter((range): range is Range => range instanceof Range)
                : [...document.querySelectorAll('.pdf-search-highlight--current')].map(element => {
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    return range;
                });
            return ranges.map(range => {
                const layer = range.startContainer.parentElement?.closest('.textLayer');
                const run = [...layer?.children ?? []].find(child => child.contains(range.startContainer));
                const ink = document.createRange();
                if (run) ink.selectNodeContents(run);
                return {
                    text: range.toString(),
                    offset: (() => {
                        const prefix = document.createRange();
                        if (layer) prefix.setStart(layer, 0);
                        prefix.setEnd(range.startContainer, range.startOffset);
                        return prefix.toString().length;
                    })(),
                    sourceText: layer?.textContent ?? '',
                    page: Number(layer?.closest<HTMLElement>('.page_container')?.dataset.page),
                    ink: ink.getBoundingClientRect().toJSON(),
                    rects: [...range.getClientRects()].map(rect => rect.toJSON()),
                };
            });
        }, mode);
        const cases = [
            {
                query: 'שלום',
                text: 'שלום',
                count: 2,
            },
            {
                query: 'של',
                text: 'של',
                count: 2,
            },
            {
                query: 'السلام',
                text: 'السلام',
                count: 2,
            },
            {
                query: 'ܫܠܡܐ',
                text: 'ܫܠܡܐ',
                count: 2,
            },
            {
                query: 'office',
                text: 'oﬃce',
                count: 4,
            },
            {
                query: 'abc',
                text: 'abc',
                count: 2,
            },
            {
                query: '123',
                text: '123',
                count: 4,
            },
            {
                query: 'עולם123עולם',
                text: 'עולם123עולם',
                count: 2,
            },
            {
                query: '123 עולם abc',
                text: '123 עולם abc',
                count: 2,
            },
            {
                query: 'שָׁל֑וֹם',
                text: 'שָׁל֑וֹם',
                count: 2,
            },
            {
                query: 'السَّلَام',
                text: 'السَّلَام',
                count: 2,
            },
            {
                query: 'ܫܠܵܡܵܐ',
                text: 'ܫܠܵܡܵܐ',
                count: 2,
            },
        ];
        for (const testCase of cases) {
            await input.fill('');
            await input.press('Enter');
            await expect.poll(() => page!.locator('.document-search-results').innerText()).toContain('Enter a search term');
            await input.pressSequentially(testCase.query);
            await input.press('Enter');
            await expect.poll(async () => {
                const body = await page!.locator('.document-search-results').innerText();
                return body.includes('No results found') || body.includes('results for');
            }, {timeout: 30000}).toBe(true);
            await expect.poll(() => page!.locator('.document-search-results-header-spinner:visible').count()).toBe(0);
            const count = await page.locator('.document-search-result:visible').count();
            observations.push({
                query: testCase.query,
                count,
            });
            writeFileSync(resolve(out, 'outcomes.json'), JSON.stringify(observations, null, 2));
            expect.soft(count).toBe(testCase.count);
            if (count !== testCase.count) continue;
            for (const index of [
                0,
                testCase.count - 1,
            ]) {
                await page.locator('.document-search-result:visible').nth(index).click();
                await expect.poll(async () => (await current()).map(range => range.text).join(''), {timeout: 10000}).toBe(testCase.text);
                await page.evaluate(async () => {
                    const monitor = Reflect.get(window, '__evbViewerInvariants') as {waitForSettled: (options: {timeoutMs: number}) => Promise<{
                        settled: boolean;
                        reason?: string
                    }>};
                    const outcome = await monitor.waitForSettled({timeoutMs: 10000});
                    if (!outcome.settled) throw new Error(outcome.reason ?? 'Viewer did not settle');
                });
                const paint = await current();
                expect([...new Set(paint.map(range => range.page))]).toEqual([index === 0 ? 1 : 2]);
                expect(paint[0]?.offset).toBe(index === 0
                    ? paint[0]?.sourceText.indexOf(testCase.text)
                    : paint[0]?.sourceText.lastIndexOf(testCase.text));
                expect(paint.every(range => range.rects.some(rect => rect.width > 0 && rect.height > 0)
                    && range.rects.every(rect => rect.left >= range.ink.left - 1 && rect.right <= range.ink.right + 1))).toBe(true);
                observations.push({
                    query: testCase.query,
                    index,
                    paint,
                });
            }
            await page.screenshot({path: resolve(out, `${encodeURIComponent(testCase.query)}.png`)});
        }
    } finally {
        writeFileSync(resolve(out, 'outcomes.json'), JSON.stringify(observations, null, 2));
        if (page) {
            await page.screenshot({path: resolve(out, 'final.png')}).catch(() => {});
            const video = page.video();
            await page.close();
            await video?.saveAs(resolve(out, 'proof.webm'));
        }
        await browser.close();
    }
}, 180000);
