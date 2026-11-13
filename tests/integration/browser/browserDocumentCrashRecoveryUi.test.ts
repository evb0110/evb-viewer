import {execFileSync} from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    chromium, type Page,
} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import {
    addNote, installPickerHandleFixture, lifecycle, noteTexts, readRecoveries, settleActiveOpen, waitForOpenFileReady,
} from './documentLifecycleTestHelpers';
import {
    createReadingBook, readReadingView,
} from './documentReadingTestHelpers';

const FILE_NAME = 'crash-recovery.pdf';
const NOTE = 'Unsaved note that outlives a killed browser';

async function launch(profile: string) {
    const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        viewport: {width: 1280, height: 900},
        acceptDownloads: true,
    });
    // The person's file lives at the origin private file system's root, behind a File that acts as its
    // handle; the handle itself survives the restart in the browser's storage.
    await context.addInitScript(installPickerHandleFixture);
    await context.addInitScript((fileName) => {
        Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
        Reflect.set(window, 'showOpenFilePicker', async () => [new File([], fileName)]);
    }, FILE_NAME);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
    await waitForOpenFileReady(page);
    return {context, page};
}

/** SIGKILL for every process of the browser that uses `profile`, as a crash or a forced quit ends it. */
function killBrowser(profile: string) {
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString().split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
        return match ? [{pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!}] : [];
    });
    const victims = new Set(processes.filter(row => row.command.includes(profile)).map(row => row.pid));
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
    return page.evaluate(async (fileName) => {
        const file = await (await (await navigator.storage.getDirectory()).getFileHandle(fileName)).getFile();
        return Array.from(new Uint8Array(await file.arrayBuffer()));
    }, FILE_NAME).then(bytes => Uint8Array.from(bytes));
}

function writeUserFile(page: Page, bytes: Uint8Array, position = 0) {
    return page.evaluate(async ({fileName, content, at}) => {
        const handle = await (await navigator.storage.getDirectory()).getFileHandle(fileName, {create: true});
        const output = await handle.createWritable({keepExistingData: at > 0});
        await output.write({type: 'write', position: at, data: Uint8Array.from(content)});
        await output.close();
    }, {fileName: FILE_NAME, content: Array.from(bytes), at: position});
}

describe('browser document lifecycle UI', () => {
    // T2 and T3: a killed browser leaves the unsaved note recoverable, restored bound to its own file; that
    // file changed elsewhere refuses Save and offers Save As.
    it.each([
        'unchanged',
        'changed-elsewhere',
    ] as const)('restores unsaved work after the browser is killed, with the file %s', async (scenario) => {
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
            await expect.poll(async () => (await readRecoveries(page)).some(record => record.notes.has(NOTE)), {timeout: 15_000}).toBe(true);
            if (scenario === 'changed-elsewhere') await writeUserFile(page, Uint8Array.of(88), changedAt);

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
    }, 180_000);
});
