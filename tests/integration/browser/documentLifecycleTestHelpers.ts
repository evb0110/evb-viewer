import {
    existsSync, readFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString,
} from 'pdf-lib';
import {chromium} from 'playwright';
import type {
    Browser, BrowserContext, Page, FileChooser,
} from 'playwright';
import {
    afterAll, beforeAll, expect, inject,
} from 'vitest';

export {clickCenter} from './clickCenter';

declare module 'vitest' {
    export interface ProvidedContext {
        browserIntegrationOrigin: string;
        browserIntegrationServerOutputPath: string;
    }
}

const origin = inject('browserIntegrationOrigin');

let browser: Browser;

export interface IBrowserLifecycleTestApi {
    getActiveWorkspaceHandle?: () => unknown;
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

/** The bytes the store holds for `ref`: its manifest's current revision, read from the origin private file system. */
export async function readPersistedDocumentBytes(page: Page, ref: string, sha256 = false): Promise<number[]> {
    return page.evaluate(async ({documentRef, digest}) => {
        const id = documentRef.slice('browser://documents/'.length).split('/')[0]!;
        const root = await navigator.storage.getDirectory();
        let dir: FileSystemDirectoryHandle;
        try {
            dir = await (await root.getDirectoryHandle('documents')).getDirectoryHandle(id);
        } catch {
            return [];
        }
        const manifest = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text()) as {current?: {file: string; length: number}};
        if (!manifest.current) return [];
        const file = await (await dir.getFileHandle(manifest.current.file)).getFile();
        const bytes = new Uint8Array(await file.slice(0, manifest.current.length).arrayBuffer());
        return Array.from(digest ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : bytes);
    }, {documentRef: ref, digest: sha256});
}

export async function waitForOpenFileReady(page: Page) {
    await page.waitForFunction(() => {
        const api = Reflect.get(window, '__evbTestApi') as {isStartupOpenClaimPending?: () => boolean};
        return Boolean(api) && !api.isStartupOpenClaimPending?.();
    }, undefined, {timeout: 30_000});
}

export async function settleActiveOpen(page: Page) {
    // File chooser delivery can finish before the lazy active workspace mounts.
    await page.waitForFunction(() => {
        const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
        return Boolean(testApi?.getActiveWorkspaceHandle?.());
    }, undefined, {timeout: 30_000});
    await page.evaluate(async () => {
        const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
        if (!await testApi?.waitForActiveDocumentOpenSettled?.()) throw new Error('PDF viewer open did not settle');
    });
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

// A structured-cloneable picker handle whose bytes and writes use real OPFS.
// Keep this installer closure-free for page.evaluate and page.addInitScript.
export function installPickerHandleFixture() {
    Object.defineProperties(File.prototype, {
        kind: {get: () => 'file'},
        getFile: {value: async function (this: File) {
            const root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle(this.name, {create: true});
            const file = await handle.getFile();
            return new File([await file.arrayBuffer()], file.name, {
                type: file.type,
                lastModified: file.lastModified,
            });
        }},
        createWritable: {value: async function (this: File) {
            const root = await navigator.storage.getDirectory();
            return (await root.getFileHandle(this.name, {create: true})).createWritable();
        }},
        isSameEntry: {value: async function (this: File, other: FileSystemHandle) {
            return this.name === other.name;
        }},
    });
}

export async function openPdfFromChooser(page: Page, fixture: Parameters<FileChooser['setFiles']>[0]) {
    await page.addInitScript(() => {
        Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
        Reflect.set(window, 'showSaveFilePicker', undefined);
        window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
    });
    await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
    await waitForOpenFileReady(page);
    keepFileChooserInterceptionEnabled(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', {
        name: 'Open File',
        exact: true,
    }).first().click();
    await (await chooser).setFiles(fixture);
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

beforeAll(async () => {
    browser = await chromium.launch({headless: true});
    // HTTP readiness precedes the cold client and document-worker graphs.
    // Complete one real open here so per-document hooks start with a ready app.
    const page = await browser.newPage();
    try {
        await openPdfFromChooser(page, resolve('tests/fixtures/electron/generated-text.pdf'));
        await page.locator('.page_container--rendered canvas').first().waitFor();
        await settleActiveOpen(page);
    } finally {
        await page.context().close();
    }
}, 120_000);

afterAll(async () => {
    await browser?.close();
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

export function noteTexts(document: PDFDocument, subtype?: '/Text') {
    return new Set(document.getPages().flatMap(page => {
        const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
        return Array.from({length: annots?.size() ?? 0}, (_, index) => {
            const annotation = annots!.lookup(index, PDFDict);
            if (subtype && annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== subtype) return undefined;
            return annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText();
        }).filter((text): text is string => text !== undefined);
    }));
}

// Each window checkpoint's owner and the notes its unsaved document holds: in its bytes or in its drafts.
export async function readRecoveries(page: Page, subtype?: '/Text') {
    const records = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const readJson = async (dir: FileSystemDirectoryHandle, name: string) => JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) as unknown;
        let workspaces: FileSystemDirectoryHandle;
        try {
            workspaces = await root.getDirectoryHandle('workspaces');
        } catch {
            return [];
        }
        const rows = [];
        for await (const name of workspaces.keys()) {
            if (!/^[\w-]+\.json$/u.test(name)) continue;
            const checkpoint = ((await readJson(workspaces, name)) as {layout: {tabs: Array<{
                isDirty: boolean;
                workingCopyRef: string | null;
                currentPage: number | null;
                zoom: number | null;
                annotationRecovery?: {payload?: {
                    drafts: Array<{text: string}>;
                    entities?: Array<{kind: string; contents?: string; text?: string}>;
                }}
            }>}}).layout;
            const tab = checkpoint.tabs.find(candidate => candidate.isDirty);
            const id = tab?.workingCopyRef?.slice('browser://documents/'.length).split('/')[0];
            if (tab && id) {
                try {
                    const dir = await (await root.getDirectoryHandle('documents')).getDirectoryHandle(id);
                    const manifest = await readJson(dir, 'manifest.json') as {drafts?: string};
                    if (manifest.drafts) tab.annotationRecovery = await readJson(dir, manifest.drafts) as NonNullable<typeof tab.annotationRecovery>;
                } catch {
                    // The directory is gone: the checkpoint names a document it cannot restore.
                }
            }
            rows.push({ownerId: name.slice(0, -'.json'.length), checkpoint, tab});
        }
        return rows;
    });
    return Promise.all(records.map(async record => {
        const bytes = record.tab?.workingCopyRef
            ? await readPersistedDocumentBytes(page, record.tab.workingCopyRef)
            : [];
        const notes = bytes.length > 0 ? noteTexts(await PDFDocument.load(Uint8Array.from(bytes)), subtype) : new Set<string>();
        // Unsaved notes are the drafts' text and the notes among the unsaved entities.
        const payload = record.tab?.annotationRecovery?.payload;
        for (const draft of payload?.drafts ?? []) notes.add(draft.text);
        for (const entity of payload?.entities ?? []) {
            if (entity.kind === 'note' || (!subtype && typeof entity.contents === 'string')) notes.add(entity.contents ?? entity.text ?? '');
        }
        notes.delete('');
        return {...record, bytes, notes};
    }));
}

// The windows whose lock a window holds, and those a window waits for: a held window lock means the window is alive.
export function readWindowLocks(page: Page) {
    return page.evaluate(async () => {
        const {
            held = [],
            pending = [],
        } = await navigator.locks.query();
        const owners = (locks: LockInfo[]) => locks.flatMap(({name}) => (
            name?.startsWith('evb-window:')
                ? [name.slice('evb-window:'.length)]
                : []
        )).sort();
        return {
            held: owners(held),
            pending: owners(pending),
        };
    });
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

/** The store's document directories with the length of each one's current bytes, and the window checkpoints. */
export async function readBrowserPayloadCounts(page: Page) {
    return page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const entries = async (name: string) => {
            try {
                const names: string[] = [];
                for await (const entry of (await root.getDirectoryHandle(name)).keys()) names.push(entry);
                return names;
            } catch {
                return [];
            }
        };
        const documents = await root.getDirectoryHandle('documents').catch(() => null);
        const sizes: number[] = [];
        for (const id of await entries('documents')) {
            const manifest = await (await (await documents!.getDirectoryHandle(id)).getFileHandle('manifest.json')).getFile()
                .then(async file => JSON.parse(await file.text()) as {current?: {length: number}})
                .catch(() => ({}) as {current?: {length: number}});
            sizes.push(manifest.current?.length ?? 0);
        }
        return {
            documents: sizes.length,
            sizes,
            checkpoints: (await entries('workspaces')).filter(name => /^[\w-]+\.json$/u.test(name)).length,
        };
    });
}

export const lifecycle = {
    get browser() { return browser; },
    get origin() { return origin; },
    // The server writes its log only once it prints something; a failure report must not fail on its absence.
    get serverOutput() { return existsSync(inject('browserIntegrationServerOutputPath')) ? readFileSync(inject('browserIntegrationServerOutputPath'), 'utf8') : ''; },
};
