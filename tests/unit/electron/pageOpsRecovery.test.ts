import {EventEmitter} from 'node:events';
import {copyFile, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {afterEach, expect, it, vi} from 'vitest';
import {cast} from '@tests/helpers/cast';
import {SerializableError} from '@contracts/serializableError';
import type * as TAppTempDir from '@electron/utils/appTempDir';
import * as store from '@electron/file-access/documentStore';
import {pageOpsMainBindings} from '@electron/features/page-ops/main/pageOpsMainBindings';

const state = vi.hoisted(() => ({root: '', refuseRetry: false, edits: vi.fn(), repairs: vi.fn()}));
vi.mock('electron', () => ({
    app: {getPath: () => state.root},
    BrowserWindow: {fromWebContents: () => null},
    dialog: {},
    webContents: {fromId: () => undefined},
}));
vi.mock('@electron/utils/appTempDir', async original => ({...await original<typeof TAppTempDir>(), getAppTempDir: () => state.root}));
vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedWritePath: async (path: string) => path}));
vi.mock('@electron/features/page-ops/main/qpdf', () => ({
    getPdfPageCount: async (path: string) => (await PDFDocument.load(await readFile(path))).getPageCount(),
}));
vi.mock('@electron/features/page-ops/main/pageMetadataRemap', () => ({
    resolvePageMetadataSourceTargets: async () => undefined,
    applyPageMetadataRemap: async () => {},
}));
vi.mock('@electron/features/page-ops/main/pageStructure', () => ({deletePageRanges: (...args: unknown[]) => state.edits(...args)}));
vi.mock('@electron/pdf/pdfAppendBase', () => ({rewritePdfWithQpdf: (...args: unknown[]) => state.repairs(...args)}));

const fixtures = resolve('native/pdf-page-ops/tests/fixtures/damaged-recovery');
afterEach(async () => {
    await store.setDocumentStoreRootForTests(null);
    if (state.root) await rm(state.root, {recursive: true, force: true});
    vi.clearAllMocks();
});

it.each([false, true])('desktop recovery keeps the user file and rolls back a refused retry: %s', async refuseRetry => {
    state.root = await mkdtemp(join(tmpdir(), 'page-recovery-'));
    state.refuseRetry = refuseRetry;
    await store.setDocumentStoreRootForTests(join(state.root, 'store'));
    const original = join(state.root, 'original.pdf');
    await copyFile(join(fixtures, 'object-identity.pdf'), original);
    const baseline = await readFile(original);
    const entry = await store.openDocumentFromFile(original, {ownerWebContentsId: 7});
    const before = store.documentRevisionToken(entry);
    state.edits.mockImplementation(async (source: string, target: string) => {
        const bytes = await readFile(source);
        if (bytes.includes(Buffer.from('99 0 obj')) || state.refuseRetry) {
            throw new SerializableError({code: 'corrupt-xref', message: 'PDF object 7 0 is not at its xref offset'});
        }
        const pdf = await PDFDocument.load(bytes);
        pdf.removePage(0);
        await writeFile(target, await pdf.save());
        return {pageCount: 1};
    });
    state.repairs.mockImplementation(async (_source: string, target: string) => copyFile(join(fixtures, 'healthy.pdf'), target));
    const sender = Object.assign(new EventEmitter(), {id: 7, isDestroyed: () => false});
    const pending = pageOpsMainBindings.delete({sender: cast(sender), senderId: 7}, entry.ref, [1], 2, {expectedDocumentRevisionToken: before});
    if (refuseRetry) {
        await expect(pending).rejects.toThrow('not at its xref offset');
        expect(store.documentRevisionToken(entry)).toBe(before);
        expect(Buffer.from(await store.readOpenDocument(entry, 0, store.statOpenDocument(entry).size))).toEqual(baseline);
        // A later successful write must remain possible on the restored revision.
        await store.rewriteDocument(entry, (_source, target) => copyFile(join(fixtures, 'healthy.pdf'), target), 'write');
    } else {
        await expect(pending).resolves.toMatchObject({success: true, pageCount: 1});
        const bytes = await store.readOpenDocument(entry, 0, store.statOpenDocument(entry).size);
        expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    }
    expect(state.edits).toHaveBeenCalledTimes(2);
    expect(state.repairs).toHaveBeenCalledTimes(1);
    expect(await readFile(original)).toEqual(baseline);
});
