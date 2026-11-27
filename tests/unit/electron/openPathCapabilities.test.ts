import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join, sep} from 'path';

interface ITestOwner extends EventEmitter {
    id: number;
    destroyed: boolean;
    isDestroyed: () => boolean;
}

function createOwner(id: number): ITestOwner {
    const owner: ITestOwner = Object.assign(new EventEmitter(), {
        id,
        destroyed: false,
        isDestroyed: () => owner.destroyed,
    });

    return owner;
}

function triggerDestroyed(owner: ITestOwner) {
    owner.emit('destroyed');
}

function triggerRenderProcessGone(owner: ITestOwner) {
    owner.emit('render-process-gone');
}

function triggerMainFrameNavigation(owner: ITestOwner) {
    owner.emit('did-start-navigation', {}, 'app://reload', false, true);
}

describe('open path capabilities', () => {
    const originalAppStateDir = process.env.EVB_APP_STATE_DIR;
    let tempRoot = '';

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-open-path-capability-test-'));
    });

    afterEach(async () => {
        if (originalAppStateDir === undefined) {
            delete process.env.EVB_APP_STATE_DIR;
        } else {
            process.env.EVB_APP_STATE_DIR = originalAppStateDir;
        }
        const {resetPathValidatorCachesForTests} = await import('@electron/utils/pathValidator');
        resetPathValidatorCachesForTests();
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
        vi.useRealTimers();
    });

    it('expires grants after a day', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        const filePath = join(tempRoot, 'opened.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const {allowOpenPath, requireOpenPath} = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath)).not.toBeNull();
        expect(() => requireOpenPath(filePath)).not.toThrow();

        vi.setSystemTime(24 * 60 * 60 * 1000 + 1_001);

        expect(() => requireOpenPath(filePath)).toThrow('Path not allowed');
    });

    it('authorizes an exact path whose filename ends in whitespace', async () => {
        const filePath = join(tempRoot, 'exact-percent-%25.pdf ');
        writeFileSync(filePath, new Uint8Array([1]));

        const {allowOpenPath, requireOpenPath} = await import('@electron/file-access/openPathCapabilities');
        expect(allowOpenPath(filePath)).toBe(filePath);
        expect(requireOpenPath(filePath)).toBe(filePath);
    });

    it('compares aliases by identity while returning the requested spelling', async () => {
        const target = join(tempRoot, 'café.pdf');
        const requested = join(tempRoot, 'link.pdf');
        writeFileSync(target, 'document');
        symlinkSync(target, requested);
        const canonical = realpathSync.native(target);
        const {allowOpenPath, requireOpenPath, removeAllowedOpenPath} = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(requested, 47)).toBe(requested);
        expect(requireOpenPath(canonical, 47)).toBe(canonical);
        expect(requireOpenPath(requested, 47)).toBe(requested);
        expect(() => requireOpenPath(requested, 48)).toThrow('Path not allowed');
        removeAllowedOpenPath(canonical);
        expect(() => requireOpenPath(requested, 47)).toThrow('Path not allowed');
    });

    it('clears grants when the owning webContents is destroyed', async () => {
        const filePath = join(tempRoot, 'owned.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(42);
        const {allowOpenPath, requireOpenPath} = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath, owner as never)).not.toBeNull();
        expect(() => requireOpenPath(filePath, owner as never)).not.toThrow();

        triggerDestroyed(owner);

        expect(() => requireOpenPath(filePath, owner as never)).toThrow('Path not allowed');
    });

    it('clears grants when the owning renderer process crashes', async () => {
        const filePath = join(tempRoot, 'crashed.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(43);
        const {allowOpenPath, requireOpenPath} = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath, owner as never)).not.toBeNull();
        triggerRenderProcessGone(owner);

        expect(() => requireOpenPath(filePath, owner as never)).toThrow('Path not allowed');
    });

    it('clears grants when the owning renderer reloads', async () => {
        const filePath = join(tempRoot, 'reloaded.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(44);
        const {allowOpenPath, requireOpenPath} = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath, owner as never)).not.toBeNull();
        triggerMainFrameNavigation(owner);

        expect(() => requireOpenPath(filePath, owner as never)).toThrow('Path not allowed');
    });

    it('keeps reveal-only grants separate from full open grants', async () => {
        const filePath = join(tempRoot, 'revealed-only.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(45);
        const {allowRevealPath, requireOpenPath, requireRevealPath} = await import('@electron/file-access/openPathCapabilities');

        expect(allowRevealPath(filePath, owner as never)).not.toBeNull();

        expect(() => requireRevealPath(filePath, owner as never)).not.toThrow();
        expect(() => requireOpenPath(filePath, owner as never)).toThrow('Path not allowed');

        triggerDestroyed(owner);

        expect(() => requireRevealPath(filePath, owner as never)).toThrow('Path not allowed');
    });

    it('allows full open grants to satisfy reveal checks', async () => {
        const filePath = join(tempRoot, 'opened-can-reveal.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(46);
        const {allowOpenPath, requireRevealPath} = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath, owner as never)).not.toBeNull();

        expect(() => requireRevealPath(filePath, owner as never)).not.toThrow();
    });

    it('registers one cleanup listener per owner', async () => {
        const firstPath = join(tempRoot, 'first.pdf');
        const secondPath = join(tempRoot, 'second.pdf');
        writeFileSync(firstPath, new Uint8Array([1]));
        writeFileSync(secondPath, new Uint8Array([2]));

        const owner = createOwner(7);
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');

        allowOpenPath(firstPath, owner as never);
        allowOpenPath(secondPath, owner as never);

        expect(owner.listenerCount('destroyed')).toBe(1);
        expect(owner.listenerCount('render-process-gone')).toBe(1);
        expect(owner.listenerCount('did-start-navigation')).toBe(1);
    });

    it('refuses open and reveal grants for reserved pinned-revisions files across case spellings and symlinks', async () => {
        process.env.EVB_APP_STATE_DIR = join(tempRoot, 'app-state');
        const {resetPathValidatorCachesForTests} = await import('@electron/utils/pathValidator');
        resetPathValidatorCachesForTests();
        const {getAppTempDirPath} = await import('@electron/utils/appTempDir');
        const pinnedDir = join(getAppTempDirPath(), 'pinned-revisions');
        mkdirSync(pinnedDir, {recursive: true});
        const pinnedFile = join(pinnedDir, 'pin.pdf');
        writeFileSync(pinnedFile, '%PDF-1.4\n');
        const normalFile = join(tempRoot, 'normal.pdf');
        writeFileSync(normalFile, '%PDF-1.4\n');

        const candidates = [pinnedFile];
        const upperFile = join(getAppTempDirPath(), 'PINNED-REVISIONS', 'pin.pdf');
        if (existsSync(upperFile)) {
            candidates.push(upperFile);
        }
        if (process.platform !== 'win32') {
            const outsideLink = join(tempRoot, 'opened-pin-link.pdf');
            symlinkSync(pinnedFile, outsideLink);
            candidates.push(outsideLink);
        }

        const {allowOpenPath, allowOpenPaths, allowRevealPath, allowRevealPaths, isOpenPathAccessible, requireOpenPath, requireRevealPath} =
            await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(normalFile, 9)).not.toBeNull();
        for (const candidate of candidates) {
            expect(allowOpenPath(candidate, 9)).toBeNull();
            expect(allowOpenPaths([normalFile, candidate], 9)).toEqual([expect.any(String), null]);
            expect(allowRevealPath(candidate, 9)).toBeNull();
            expect(allowRevealPaths([normalFile, candidate], 9)).toEqual([expect.any(String), null]);
            expect(isOpenPathAccessible(candidate)).toBe(false);
            expect(() => requireOpenPath(candidate, 9)).toThrow('Path not allowed');
            expect(() => requireRevealPath(candidate, 9)).toThrow('Path not allowed');
        }
    });

    it('refuses reading a reserved pin path even if an open grant is forged or already issued', async () => {
        process.env.EVB_APP_STATE_DIR = join(tempRoot, 'app-state');
        const {resetPathValidatorCachesForTests} = await import('@electron/utils/pathValidator');
        resetPathValidatorCachesForTests();
        const {getAppTempDirPath} = await import('@electron/utils/appTempDir');
        const pinnedDir = join(getAppTempDirPath(), 'pinned-revisions');
        mkdirSync(pinnedDir, {recursive: true});
        const pinnedFile = join(pinnedDir, 'forged-grant.pdf');
        writeFileSync(pinnedFile, '%PDF-1.4\n');

        const ordinaryFile = join(tempRoot, 'ordinary.pdf');
        writeFileSync(ordinaryFile, '%PDF-1.4\n');
        const requireOpenPathMock = vi.fn((_path: string) => pinnedFile);

        vi.doMock('@electron/file-access/openPathCapabilities', () => ({
            allowOpenPath: vi.fn(),
            allowOpenPaths: vi.fn(),
            isOpenPathAccessible: vi.fn(() => true),
            logRejectedOpenPath: vi.fn(),
            removeAllowedOpenPath: vi.fn(),
            requireOpenPath: requireOpenPathMock,
        }));
        try {
            const {resolveExistingReadableDocumentOrImagePath, resolveExistingReadablePdfPath} =
                await import('@electron/features/documents/main/documentFilePathResolution');

            await expect(resolveExistingReadablePdfPath(pinnedFile, 8)).rejects.toThrow('reads only allowed');
            await expect(resolveExistingReadableDocumentOrImagePath(pinnedFile, 8)).rejects.toThrow('reads only allowed');
            expect(requireOpenPathMock).not.toHaveBeenCalled();

            await expect(resolveExistingReadablePdfPath(ordinaryFile, 8)).rejects.toThrow('reads only allowed');
            await expect(resolveExistingReadableDocumentOrImagePath(ordinaryFile, 8)).rejects.toThrow('reads only allowed');
            expect(requireOpenPathMock).toHaveBeenCalledTimes(2);

            if (process.platform !== 'win32') {
                const outsideLink = join(tempRoot, 'forged-pin-link.pdf');
                symlinkSync(pinnedFile, outsideLink);
                await expect(resolveExistingReadablePdfPath(outsideLink, 8)).rejects.toThrow('reads only allowed');
                await expect(resolveExistingReadableDocumentOrImagePath(outsideLink, 8)).rejects.toThrow('reads only allowed');
                expect(requireOpenPathMock).toHaveBeenCalledTimes(2);
            }
        } finally {
            vi.doUnmock('@electron/file-access/openPathCapabilities');
        }
    });

    it('refuses page extraction and image export into reserved pinned-revisions destinations', async () => {
        process.env.EVB_APP_STATE_DIR = join(tempRoot, 'app-state');
        const showSaveDialog = vi.fn();
        const extractPagesMock = vi.fn();
        const extractPageRangesMock = vi.fn();

        vi.doMock('electron', () => ({
            app: {getPath: () => tempRoot},
            BrowserWindow: {fromWebContents: () => null},
            dialog: {showSaveDialog},
            webContents: {fromId: () => undefined},
        }));
        vi.doMock('@electron/features/page-ops/main/qpdf', () => ({
            getPdfPageCount: async () => 2,
            verifyPdfStructureStrict: vi.fn(),
        }));
        vi.doMock('@electron/features/page-ops/main/pageStructure', () => ({
            deletePageRanges: vi.fn(),
            extractPageRanges: extractPageRangesMock,
            extractPages: extractPagesMock,
            movePageRanges: vi.fn(),
            reorderPages: vi.fn(),
            insertPagesFromSourcePaths: vi.fn(),
        }));

        const {
            isAllowedReadPath,
            isAllowedWritePath,
            isReservedTempPath,
            resetPathValidatorCachesForTests,
            resolveAllowedReadPath,
            resolveAllowedWritePath,
        } = await import('@electron/utils/pathValidator');
        resetPathValidatorCachesForTests();
        const {getAppTempDirPath} = await import('@electron/utils/appTempDir');
        const appTempRoot = getAppTempDirPath();
        const {documentRevisionToken, openDocumentFromFile, pinOpenDocumentRevision, setDocumentStoreRootForTests} =
            await import('@electron/file-access/documentStore');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {pageOpsMainBindings} = await import('@electron/features/page-ops/main/pageOpsMainBindings');
        const {validateImageExportPath} = await import('@electron/features/image-export/main/export');

        await setDocumentStoreRootForTests(join(appTempRoot, 'document-store'));
        try {
            const sourcePdf = join(tempRoot, 'source.pdf');
            writeFileSync(sourcePdf, '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
            const entry = await openDocumentFromFile(sourcePdf, {ownerWebContentsId: 7});

            const pinnedDir = join(appTempRoot, 'pinned-revisions');
            mkdirSync(pinnedDir, {recursive: true});
            const pinnedFile = join(pinnedDir, 'pin.pdf');
            writeFileSync(pinnedFile, 'original-pin-bytes');

            const context = {
                parentWindow: null,
                sender: Object.assign(new EventEmitter(), {
                    id: 7,
                    isDestroyed: () => false,
                }) as never,
                senderId: 7,
            };

            showSaveDialog.mockResolvedValueOnce({
                canceled: false,
                filePath: pinnedFile,
            });
            await expect(pageOpsMainBindings.extract(context, entry.ref, [1])).rejects.toThrow('reserved application directory');

            // Also cover suffix addition (`pin` -> `pin.pdf`) before extract starts.
            showSaveDialog.mockResolvedValueOnce({
                canceled: false,
                filePath: join(pinnedDir, 'pin'),
            });
            await expect(pageOpsMainBindings.extract(context, entry.ref, [1])).rejects.toThrow('reserved application directory');

            if (process.platform !== 'win32') {
                const outsideLink = join(tempRoot, 'extract-pin-link.pdf');
                symlinkSync(pinnedFile, outsideLink);
                showSaveDialog.mockResolvedValueOnce({
                    canceled: false,
                    filePath: outsideLink,
                });
                await expect(pageOpsMainBindings.extract(context, entry.ref, [1])).rejects.toThrow('reserved application directory');

                const pinnedSubDir = join(pinnedDir, 'sub');
                mkdirSync(pinnedSubDir, {recursive: true});
                const subLink = join(tempRoot, 'sub-link');
                symlinkSync(pinnedSubDir, subLink);
                const appSubLink = join(appTempRoot, 'app-sub-link');
                symlinkSync(pinnedSubDir, appSubLink);
                const collapsedInRootPin = join(appTempRoot, 'pin.pdf');
                writeFileSync(collapsedInRootPin, 'decoy-root-file');
                for (const parentTraversalCandidate of [
                    `${subLink}${sep}..${sep}pin.pdf`,
                    `${subLink}${sep}..${sep}new.pdf`,
                    `${appSubLink}${sep}..${sep}pin.pdf`,
                    `${appSubLink}${sep}..${sep}new.pdf`,
                ]) {
                    expect(isReservedTempPath(parentTraversalCandidate)).toBe(true);
                    expect(isAllowedWritePath(parentTraversalCandidate)).toBe(false);
                    await expect(resolveAllowedWritePath(parentTraversalCandidate)).resolves.toBeNull();
                    expect(allowOpenPath(parentTraversalCandidate, 8)).toBeNull();
                }
                expect(isAllowedReadPath(`${appSubLink}${sep}..${sep}pin.pdf`)).toBe(false);
                await expect(resolveAllowedReadPath(`${appSubLink}${sep}..${sep}pin.pdf`)).resolves.toBeNull();
                for (const extractTraversalCandidate of [
                    `${subLink}${sep}..${sep}pin.pdf`,
                    `${subLink}${sep}..${sep}pin`,
                    `${subLink}${sep}..${sep}new.pdf`,
                ]) {
                    showSaveDialog.mockResolvedValueOnce({
                        canceled: false,
                        filePath: extractTraversalCandidate,
                    });
                    await expect(pageOpsMainBindings.extract(context, entry.ref, [1])).rejects.toThrow('reserved application directory');
                }
            }

            expect(extractPagesMock).not.toHaveBeenCalled();
            expect(extractPageRangesMock).not.toHaveBeenCalled();
            expect(readFileSync(pinnedFile, 'utf8')).toBe('original-pin-bytes');

            expect(() => validateImageExportPath(join(pinnedDir, 'export.png'), 'png')).toThrow('reserved application directory');
            expect(() => validateImageExportPath(join(pinnedDir, 'export.tiff'), 'tiff')).toThrow('reserved application directory');

            const otherContext = {
                parentWindow: null,
                sender: Object.assign(new EventEmitter(), {
                    id: 8,
                    isDestroyed: () => false,
                }) as never,
                senderId: 8,
            };
            const unmaterializedPin = await pinOpenDocumentRevision(entry.ref, documentRevisionToken(entry), 7);
            await expect(pageOpsMainBindings.readOutline(context, unmaterializedPin)).rejects.toThrow('Path is not a managed working copy');
            await expect(pageOpsMainBindings.readOutline(otherContext, unmaterializedPin)).rejects.toThrow(
                'Path is not a managed working copy',
            );
            expect(existsSync(unmaterializedPin)).toBe(false);
        } finally {
            await setDocumentStoreRootForTests(null);
            vi.doUnmock('electron');
            vi.doUnmock('@electron/features/page-ops/main/qpdf');
            vi.doUnmock('@electron/features/page-ops/main/pageStructure');
        }
    });

    it('keeps TOpenPath nominally branded via TBrand', async () => {
        const filePath = join(tempRoot, 'branded.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const {allowOpenPath, requireOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {requireDocumentRevisionToken} = await import('@contracts/documentRevision');

        expect(allowOpenPath(filePath)).not.toBeNull();
        const openPath = requireOpenPath(filePath);
        const asBrand: import('@contracts/brand').TBrand<string, 'OpenPath'> = openPath;
        const fromBrand: import('@electron/file-access/openPathCapabilities').TOpenPath = asBrand;
        const token = requireDocumentRevisionToken('rev-1');

        const _checkBrand = (value: typeof openPath) => value;
        expect(_checkBrand(fromBrand)).toBe(filePath);

        // @ts-expect-error raw strings must not satisfy TOpenPath
        const _fromRaw: typeof openPath = filePath;
        // @ts-expect-error distinct TBrand strings must not satisfy TOpenPath
        const _fromToken: typeof openPath = token;

        expect([_fromRaw, _fromToken]).toEqual([filePath, 'rev-1']);
    });
});
