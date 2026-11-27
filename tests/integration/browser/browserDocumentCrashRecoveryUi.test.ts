import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {chromium, type BrowserContext, type Page} from 'playwright';
import {describe, expect, it} from 'vitest';
import {
    addNote,
    installPickerHandleFixture,
    lifecycle,
    noteTexts,
    readRecoveries,
    settleActiveOpen,
    waitForOpenFileReady,
} from './documentLifecycleTestHelpers';
import {createReadingBook, readReadingView} from './documentReadingTestHelpers';

const FILE_NAME = 'crash-recovery.pdf';
const NOTE = 'Unsaved note that outlives a killed browser';

async function launch(profile: string, options: {failWorkspaceCheckpointWrites?: boolean} = {}) {
    const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        viewport: {width: 1280, height: 900},
        acceptDownloads: true,
    });
    try {
        // The person's file lives at the origin private file system's root, behind a File that acts as its
        // handle; the handle itself survives the restart in the browser's storage.
        await context.addInitScript(installPickerHandleFixture);
        if (options.failWorkspaceCheckpointWrites) {
            await context.addInitScript(() => {
                Reflect.set(window, '__injectedCheckpointWriteFailures', 0);
                const originalPostMessage = Worker.prototype.postMessage;
                Worker.prototype.postMessage = function (
                    this: Worker,
                    message: unknown,
                    transferOrOptions?: StructuredSerializeOptions | Transferable[],
                ) {
                    if (
                        typeof message === 'object' &&
                        message !== null &&
                        'id' in message &&
                        'op' in message &&
                        'args' in message &&
                        (message as {op: unknown}).op === 'writeAtomic' &&
                        Array.isArray((message as {args: unknown}).args) &&
                        typeof (message as {args: unknown[]}).args[0] === 'string' &&
                        ((message as {args: string[]}).args[0] ?? '').startsWith('workspaces/')
                    ) {
                        const count = Number(Reflect.get(window, '__injectedCheckpointWriteFailures') ?? 0);
                        Reflect.set(window, '__injectedCheckpointWriteFailures', count + 1);
                        const id = (message as {id: number}).id;
                        queueMicrotask(() => {
                            this.dispatchEvent(
                                new MessageEvent('message', {
                                    data: {
                                        id,
                                        error: {
                                            name: 'QuotaExceededError',
                                            message: 'Injected workspace checkpoint write failure',
                                        },
                                    },
                                }),
                            );
                        });
                        return;
                    }
                    return originalPostMessage.call(this, message, transferOrOptions as StructuredSerializeOptions);
                };
            });
        }
        await context.addInitScript((fileName) => {
            Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            Reflect.set(window, 'showOpenFilePicker', async () => [new File([], fileName)]);
        }, FILE_NAME);
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
        await waitForOpenFileReady(page);
        return {context, page};
    } catch (error) {
        await context.close().catch(() => undefined);
        throw error;
    }
}

/** SIGKILL for every process of the browser that uses `profile`, as a crash or a forced quit ends it. */
function killBrowser(profile: string) {
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command='])
        .toString()
        .split('\n')
        .flatMap((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
            return match ? [{pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!}] : [];
        });
    const victims = new Set(processes.filter((row) => row.command.includes(profile)).map((row) => row.pid));
    for (let grew = true; grew;) {
        grew = false;
        for (const row of processes) {
            if (!victims.has(row.pid) && victims.has(row.ppid)) {
                victims.add(row.pid);
                grew = true;
            }
        }
    }
    expect(victims.size).toBeGreaterThan(0);
    for (const pid of victims) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // Already gone with its parent.
        }
    }
}

function readUserFile(page: Page) {
    return page
        .evaluate(async (fileName) => {
            const file = await (await (await navigator.storage.getDirectory()).getFileHandle(fileName)).getFile();
            return Array.from(new Uint8Array(await file.arrayBuffer()));
        }, FILE_NAME)
        .then((bytes) => Uint8Array.from(bytes));
}

/** Each store directory's committed revision (1 is the opened destination's bytes), read from the page as recovery would read it. */
function readCommittedRevisions(page: Page) {
    return page.evaluate(async () => {
        const revisions: Record<string, number> = {};
        const documents = await (await navigator.storage.getDirectory()).getDirectoryHandle('documents').catch(() => null);
        for await (const [id, dir] of documents?.entries() ?? []) {
            const manifest = await (dir as FileSystemDirectoryHandle)
                .getFileHandle('manifest.json')
                .then(async (handle) => JSON.parse(await (await handle.getFile()).text()) as {current?: {id: number}})
                .catch(() => null);
            revisions[id] = manifest?.current?.id ?? 1;
        }
        return JSON.stringify(revisions);
    });
}

function writeUserFile(page: Page, bytes: Uint8Array, position = 0) {
    return page.evaluate(
        async ({fileName, content, at}) => {
            const handle = await (await navigator.storage.getDirectory()).getFileHandle(fileName, {create: true});
            const output = await handle.createWritable({keepExistingData: at > 0});
            await output.write({type: 'write', position: at, data: Uint8Array.from(content)});
            await output.close();
        },
        {fileName: FILE_NAME, content: Array.from(bytes), at: position},
    );
}

function readCheckpointFaultState(page: Page) {
    return page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const workspaces = await root.getDirectoryHandle('workspaces').catch(() => null);
        const checkpoints: string[] = [];
        for await (const name of workspaces?.keys() ?? []) {
            checkpoints.push(name);
        }
        const documents = await root.getDirectoryHandle('documents').catch(() => null);
        const manifests: Array<{next: number; drafts?: string; pendingPublish?: unknown; current?: {id: number; openOnly?: true}}> = [];
        for await (const [, dir] of documents?.entries() ?? []) {
            const manifest = await (dir as FileSystemDirectoryHandle)
                .getFileHandle('manifest.json')
                .then(
                    async (handle) =>
                        JSON.parse(await (await handle.getFile()).text()) as {
                            next: number;
                            drafts?: string;
                            pendingPublish?: unknown;
                            current?: {id: number; openOnly?: true};
                        },
                )
                .catch(() => null);
            if (manifest) {
                manifests.push(manifest);
            }
        }
        return {
            injectedFailures: Number(Reflect.get(window, '__injectedCheckpointWriteFailures') ?? 0),
            checkpoints,
            manifests,
        };
    });
}

describe('browser document lifecycle UI', () => {
    it.each(['Menu', 'Start-page'] as const)(
        '#1612 %s Recent activates the recovered PDF and keeps its unsaved note',
        async (route) => {
            const book = await createReadingBook('Crash recovery', FILE_NAME);
            mkdirSync(join(process.cwd(), '.devkit'), {recursive: true});
            const profile = mkdtempSync(join(process.cwd(), '.devkit', 'recent-recovery-profile-'));
            let context: BrowserContext | undefined;
            try {
                let page: Page;
                ({context, page} = await launch(profile));
                const sourceTabs = () => page.locator('[data-tab-list] [role="tab"]').filter({hasText: FILE_NAME});
                const recentRow = () =>
                    page
                        .locator('[data-workspace-active="true"] [data-recent-open-actionable="true"] .recent-open')
                        .filter({hasText: FILE_NAME, visible: true});
                const expectNote = async () => {
                    await page.getByRole('button', {name: 'Open Note', exact: true}).click();
                    const note = page.getByRole('textbox', {name: 'Write annotation note', exact: true});
                    expect(await note.inputValue()).toBe(NOTE);
                    await page.getByRole('button', {name: 'Minimize note', exact: true}).click();
                };
                await writeUserFile(page, book.buffer);
                await page.getByRole('button', {name: 'Open File', exact: true}).first().click();
                await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe('Crash recovery page 1');
                await settleActiveOpen(page);
                await page.getByRole('button', {name: 'Close Tab', exact: true}).click();
                await recentRow().waitFor({state: 'visible'});
                // Persist Recent through a graceful exit before editing and ending the app process.
                await context.close();
                ({context, page} = await launch(profile));
                await recentRow().click();
                await settleActiveOpen(page);
                await addNote(page, NOTE, {x: 90, y: 100});
                await expect
                    .poll(async () => (await readRecoveries(page)).some((record) => record.notes.has(NOTE)), {timeout: 15_000})
                    .toBe(true);

                killBrowser(profile);
                await context.close().catch(() => undefined);
                ({context, page} = await launch(profile));
                await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe('Crash recovery page 1');
                await settleActiveOpen(page);
                expect(await sourceTabs().count()).toBe(1);
                const recoveredTabId = await sourceTabs().getAttribute('data-tab-id');
                expect(recoveredTabId).toBeTruthy();
                await expectNote();

                await page.getByRole('button', {name: 'New Tab', exact: true}).click();
                await recentRow().waitFor({state: 'visible'});
                if (route === 'Menu') {
                    await page.getByRole('button', {name: 'Menu', exact: true}).click();
                    await page.getByRole('menuitem', {name: 'Open Recent', exact: true}).click();
                    await page.getByRole('menuitem', {name: FILE_NAME, exact: true}).click();
                } else {
                    await recentRow().click();
                }
                const activeTab = page.locator('[data-tab-list] [role="tab"][aria-selected="true"]');
                await expect.poll(() => activeTab.textContent(), {timeout: 15_000}).toContain(FILE_NAME);
                await settleActiveOpen(page);
                expect(await sourceTabs().count(), 'Recent must reuse the recovered source tab').toBe(1);
                expect(await activeTab.getAttribute('data-tab-id')).toBe(recoveredTabId);
                await expectNote();
            } finally {
                await context?.close().catch(() => undefined);
                rmSync(profile, {recursive: true, force: true});
            }
        },
        180_000,
    );

    // T2 and T3: a killed browser leaves the unsaved note recoverable, restored bound to its own file; that
    // file changed elsewhere refuses Save and offers Save As.
    it.each(['unchanged', 'changed-elsewhere'] as const)(
        'restores unsaved work after the browser is killed, with the file %s',
        async (scenario) => {
            const book = await createReadingBook('Crash recovery', FILE_NAME);
            // Trailing comment bytes, so changing one keeps the file a PDF.
            const original = Buffer.concat([book.buffer, Buffer.from('\n%'), Buffer.alloc(4096, 32)]);
            const changedAt = original.length - 10;
            mkdirSync(join(process.cwd(), '.devkit'), {recursive: true});
            const profile = mkdtempSync(join(process.cwd(), '.devkit', 'crash-recovery-profile-'));
            let {context, page} = await launch(profile);
            try {
                await writeUserFile(page, original);
                await page.getByRole('button', {name: 'Open File', exact: true}).first().click();
                await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe('Crash recovery page 1');
                await settleActiveOpen(page);
                await addNote(page, NOTE, {x: 90, y: 100});
                await expect
                    .poll(async () => (await readRecoveries(page)).some((record) => record.notes.has(NOTE)), {timeout: 15_000})
                    .toBe(true);
                if (scenario === 'changed-elsewhere') {
                    await writeUserFile(page, Uint8Array.of(88), changedAt);
                }

                killBrowser(profile);
                await context.close().catch(() => undefined);
                ({context, page} = await launch(profile));

                // The document comes back unsaved, at its file, with the note.
                await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe('Crash recovery page 1');
                await settleActiveOpen(page);
                const save = page.locator('.save-split-primary').first();
                await expect.poll(() => save.isDisabled(), {timeout: 15_000}).toBe(false);
                await save.click();
                await expect.poll(() => save.getAttribute('aria-busy'), {timeout: 15_000}).toBe('false');
                const saved = await readUserFile(page);
                if (scenario === 'unchanged') {
                    expect(noteTexts(await PDFDocument.load(saved))).toContain(NOTE);
                    await expect.poll(() => save.isDisabled(), {timeout: 15_000}).toBe(true);
                    return;
                }
                expect(saved[changedAt]).toBe(88);
                expect(noteTexts(await PDFDocument.load(saved))).not.toContain(NOTE);
                expect(await save.isDisabled()).toBe(false);
                await page.getByRole('button', {name: 'Save options', exact: true}).click();
                const download = page.waitForEvent('download');
                await page.evaluate(() => Reflect.set(window, 'showSaveFilePicker', undefined));
                await page.getByRole('menuitem', {name: /^Save As/u}).click();
                expect(noteTexts(await PDFDocument.load(readFileSync(await (await download).path())))).toContain(NOTE);
            } finally {
                await context.close().catch(() => undefined);
                rmSync(profile, {recursive: true, force: true});
            }
        },
        180_000,
    );

    // T2: a page edit is unsaved work from the moment it is committed, before the window records its layout
    // — including when the checkpoint write fails so no checkpoint names the directory.
    it.each([
        ['normal checkpoint write', false],
        ['failed checkpoint write', true],
    ] as const)(
        'restores a page rotation the browser was killed right after (%s)',
        async (_label, failWorkspaceCheckpointWrites) => {
            const book = await createReadingBook('Crash recovery', FILE_NAME);
            mkdirSync(join(process.cwd(), '.devkit'), {recursive: true});
            const profile = mkdtempSync(join(process.cwd(), '.devkit', 'crash-recovery-profile-'));
            let {context, page} = await launch(profile, {failWorkspaceCheckpointWrites});
            try {
                await writeUserFile(page, book.buffer);
                await page.getByRole('button', {name: 'Open File', exact: true}).first().click();
                await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe('Crash recovery page 1');
                await settleActiveOpen(page);
                await page.getByRole('button', {name: 'Toggle Sidebar', exact: true}).click();
                await page.getByRole('tab', {name: 'Pages', exact: true}).click();
                const opened = await readCommittedRevisions(page);
                await page.locator('[data-thumbnail-page="1"]').first().click({button: 'right'});
                await page.getByRole('menuitem', {name: 'Rotate Clockwise', exact: true}).click();
                // The kill follows the rotation's commit within milliseconds, well inside the layout record's delay.
                await expect.poll(() => readCommittedRevisions(page), {interval: 5, timeout: 60_000}).not.toEqual(opened);
                if (failWorkspaceCheckpointWrites) {
                    const storeState = await readCheckpointFaultState(page);
                    expect(storeState.injectedFailures).toBeGreaterThanOrEqual(1);
                    expect(storeState.checkpoints).toEqual([]);
                    expect(storeState.manifests).toEqual(
                        expect.arrayContaining([expect.objectContaining({next: 3, current: expect.objectContaining({id: 2})})]),
                    );
                }
                killBrowser(profile);
                await context.close().catch(() => undefined);
                ({context, page} = await launch(profile));

                await expect
                    .poll(
                        async () => {
                            const box = await page.locator('.page_container--rendered[data-page="1"]').first().boundingBox();
                            return box ? box.width > box.height : false;
                        },
                        {timeout: 30_000},
                    )
                    .toBe(true);
                await settleActiveOpen(page);
                expect(await page.locator('[data-tab-list] [role="tab"]').filter({hasText: FILE_NAME}).count()).toBe(1);
                const save = page.locator('.save-split-primary').first();
                await expect.poll(() => save.isDisabled(), {timeout: 15_000}).toBe(false);
                await save.click();
                await expect.poll(() => save.getAttribute('aria-busy'), {timeout: 15_000}).toBe('false');
                expect((await PDFDocument.load(await readUserFile(page))).getPage(0).getRotation().angle).toBe(90);
            } finally {
                await context.close().catch(() => undefined);
                rmSync(profile, {recursive: true, force: true});
            }
        },
        180_000,
    );
});
