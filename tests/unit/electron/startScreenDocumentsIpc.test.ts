import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IpcMainInvokeEvent} from 'electron';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import {createEpochMs} from '@contracts/timestamps';
import {parseDocumentRef} from '@contracts/documentRef';
import type {IRecentFile} from '@contracts/shared';

type TRegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
    documentsMainBindingsLoaded: vi.fn(),
    fromWebContents: vi.fn(),
    getRecentFiles: vi.fn<() => Promise<IRecentFile[]>>(async () => []),
    openDocumentDirect: vi.fn(async () => null),
    refreshMenu: vi.fn(),
    removeRecentFile: vi.fn<(path: string) => Promise<void>>(async () => undefined),
    setMenuDocumentState: vi.fn(),
    setMenuTabCount: vi.fn(),
    showItemInFolder: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
}));

vi.mock('electron', () => ({
    app: {
        getPath: vi.fn(() => tmpdir()),
        isPackaged: false,
    },
    BrowserWindow: {
        fromWebContents: (...args: unknown[]) => mocks.fromWebContents(...args),
        getAllWindows: vi.fn(() => []),
        getFocusedWindow: vi.fn(() => null),
    },
    shell: {showItemInFolder: (...args: unknown[]) => mocks.showItemInFolder(...args)},
}));

vi.mock('@electron/platform-ipc/trustedIpcSender', () => ({
    isTrustedIpcEventSender: () => true,
    isTrustedIpcInvokeSender: () => true,
    isTrustedWebContentsSender: () => true,
}));

vi.mock('@electron/menu', () => ({
    refreshMenu: mocks.refreshMenu,
    setMenuDocumentState: mocks.setMenuDocumentState,
    setMenuTabCount: mocks.setMenuTabCount,
    updateRecentFilesMenu: mocks.updateRecentFilesMenu,
}));

vi.mock('@electron/recentFiles', () => ({
    clearRecentFiles: vi.fn(async () => undefined),
    getRecentFiles: () => mocks.getRecentFiles(),
    removeRecentFile: (path: string) => mocks.removeRecentFile(path),
    removeRecentFileIfMissing: vi.fn(async () => false),
}));

vi.mock('@electron/features/documents/documentsMainBindings', () => {
    mocks.documentsMainBindingsLoaded();
    return {
        DOCUMENTS_DIRECT_ARG_DECODERS: {},
        documentsMainBindings: {
            openDocumentDirect: mocks.openDocumentDirect,
        },
        registerDocumentsDirectIpc: vi.fn(),
    };
});

describe('Start-screen document IPC split and prewarm', () => {
    let tempRoot = '';

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-start-screen-ipc-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    function createHarness() {
        const handlers = new Map<string, TRegisteredHandler>();
        const ipcMain = {
            handle: vi.fn((channel: string, handler: TRegisteredHandler) => {
                handlers.set(channel, handler);
            }),
            on: vi.fn(),
        } as unknown as Electron.IpcMain;
        const onSubsystemLoaded = vi.fn();
        return {
            handlers,
            ipcMain,
            onSubsystemLoaded,
        };
    }

    function createEvent(senderId = 11) {
        const sender = {
            id: senderId,
            isDestroyed: () => false,
            once: vi.fn(),
            removeListener: vi.fn(),
        };
        return {
            sender,
            senderFrame: {url: 'evb-viewer://app/electron'},
        } as unknown as IpcMainInvokeEvent;
    }

    it('handles menu sync, window title, recent files, and Show in Folder without loading documentsMainBindings', async () => {
        const recentPath = join(tempRoot, 'recent-sample.pdf');
        writeFileSync(recentPath, new Uint8Array([1, 2, 3]));
        const recentRef = parseDocumentRef(recentPath)!;
        const setTitle = vi.fn();
        mocks.fromWebContents.mockReturnValue({
            id: 7,
            setTitle,
        });
        mocks.getRecentFiles.mockResolvedValue([
            {
                originalPath: recentRef,
                fileName: 'recent-sample.pdf',
                timestamp: createEpochMs(Date.now()),
                fileSize: 3,
            },
        ]);

        const {registerFeatureIpcAdapters} = await import('@electron/platform-ipc/registerFeatureIpcAdapters');
        const {handlers, ipcMain, onSubsystemLoaded} = createHarness();
        const runtime = registerFeatureIpcAdapters(ipcMain, {onSubsystemLoaded});

        try {
            const event = createEvent(11);

            await handlers.get(DOCUMENT_WINDOW_PLATFORM_FEATURE.methods.setWindowTitle.channel)!(event, 'Start');
            await handlers.get(DOCUMENT_MENU_PLATFORM_FEATURE.methods.setMenuTabCount.channel)!(event, 1);
            await handlers.get(DOCUMENT_MENU_PLATFORM_FEATURE.methods.setMenuDocumentState.channel)!(event, false);

            const recentFiles = await handlers.get(DOCUMENT_RECENT_FILES_PLATFORM_FEATURE.methods.get.channel)!(event);
            expect(recentFiles).toHaveLength(1);

            // Show in Folder preserves Recent reveal rights without loading documentsMainBindings.
            await expect(handlers.get(DOCUMENT_WINDOW_PLATFORM_FEATURE.methods.showItemInFolder.channel)!(event, recentRef)).resolves.toBe(
                true,
            );
            expect(mocks.showItemInFolder).toHaveBeenCalledWith(realpathSync.native(recentPath));

            // Removing the Recent entry revokes reveal rights.
            await handlers.get(DOCUMENT_RECENT_FILES_PLATFORM_FEATURE.methods.remove.channel)!(event, recentRef);
            mocks.showItemInFolder.mockClear();
            await expect(handlers.get(DOCUMENT_WINDOW_PLATFORM_FEATURE.methods.showItemInFolder.channel)!(event, recentRef)).resolves.toBe(
                false,
            );
            expect(mocks.showItemInFolder).not.toHaveBeenCalled();

            expect(setTitle).toHaveBeenCalledWith('Start');
            expect(mocks.setMenuTabCount).toHaveBeenCalledWith(7, 1);
            expect(mocks.setMenuDocumentState).toHaveBeenCalledWith(7, false);
            expect(mocks.documentsMainBindingsLoaded).not.toHaveBeenCalled();
            expect(onSubsystemLoaded).not.toHaveBeenCalledWith('documents');
        } finally {
            await runtime.disposeAll();
        }
    });

    it('prewarms documentsMainBindings once after shell-interactive and shares that load with document open', async () => {
        const {prewarmDocumentsRuntime} = await import('@electron/platform-ipc/featureRegistrationDescriptors');
        const {registerFeatureIpcAdapters} = await import('@electron/platform-ipc/registerFeatureIpcAdapters');
        const {handlers, ipcMain, onSubsystemLoaded} = createHarness();
        const runtime = registerFeatureIpcAdapters(ipcMain, {onSubsystemLoaded});

        try {
            await prewarmDocumentsRuntime(onSubsystemLoaded);
            expect(mocks.documentsMainBindingsLoaded).toHaveBeenCalledOnce();
            expect(onSubsystemLoaded).toHaveBeenCalledWith('documents');

            const sampleRef = parseDocumentRef(join(tempRoot, 'sample.pdf'))!;
            await handlers.get(DOCUMENT_OPEN_PLATFORM_FEATURE.methods.openDocumentDirect.channel)!(createEvent(12), sampleRef);
            expect(mocks.openDocumentDirect).toHaveBeenCalledOnce();
            expect(mocks.documentsMainBindingsLoaded).toHaveBeenCalledOnce();
        } finally {
            await runtime.disposeAll();
        }
    });
});
