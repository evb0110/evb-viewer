import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {effectScope, ref} from 'vue';
import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import type {IRecentFile} from '@contracts/shared';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';
import {createElectronPlatformApiFixture} from '@tests/helpers/createElectronPlatformApiFixture';
import {createPlatformApiFixture} from '@tests/helpers/createPlatformApiFixture';
import {installNuxtStateTestStubs} from '@tests/unit/app/composables/installNuxtStateTestStubs';
import {BROWSER_RECENT_FILES_STORAGE_KEY} from '@app/utils/browserRuntimePersistence';

const cookieStore = new Map<string, ReturnType<typeof ref>>();
const stateStore = new Map<string, ReturnType<typeof ref>>();
const routePath = ref('/electron');
const electronRecentFilesGet = vi.fn<() => Promise<IRecentFile[]>>();
const electronRecentFilesRemove = vi.fn<(path: string) => Promise<void>>();
const electronRecentFilesClear = vi.fn<() => Promise<void>>();
const electronRecentFilesRemoveIfMissing = vi.fn<(path: string) => Promise<boolean>>();
const electronOpenDocumentDirect = vi.fn<(path: string) => Promise<TOpenFileResult | null>>();
const browserRecentFilesGet = vi.fn<() => Promise<IRecentFile[]>>();
const toastAdd = vi.fn();
const browserStorage = new Map<string, string>();
const electronRecentFiles = {
    get: electronRecentFilesGet,
    remove: electronRecentFilesRemove,
    removeIfMissing: electronRecentFilesRemoveIfMissing,
    clear: electronRecentFilesClear,
};
const electronPlatformApi = createElectronPlatformApiFixture({
    documentOpen: {openDocumentDirect: electronOpenDocumentDirect},
    documentRecentFiles: {recentFiles: electronRecentFiles},
});
const browserPlatformApi = createPlatformApiFixture({
    backend: 'browser',
    overrides: {documentRecentFiles: {recentFiles: {get: browserRecentFilesGet}}},
});

function recentFile(path: string, timestamp = 1): IRecentFile {
    const fileName = path.split('/').at(-1) ?? path;

    return {
        originalPath: requireDocumentRef(path),
        fileName,
        timestamp: requireEpochMs(timestamp),
        fileSize: timestamp * 42,
    };
}

function installRecentFilesStubs() {
    installNuxtStateTestStubs(cookieStore, stateStore);
    vi.stubGlobal('useRoute', () => ({path: routePath.value}));
    vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
    vi.stubGlobal('useToast', () => ({add: toastAdd}));
    vi.stubGlobal('onMounted', (_callback: () => void) => undefined);
}

describe('useRecentFiles', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useRealTimers();
        cookieStore.clear();
        stateStore.clear();
        browserStorage.clear();
        vi.stubGlobal('window', {
            electronAPI: electronPlatformApi,
            localStorage: {
                getItem: (key: string) => browserStorage.get(key) ?? null,
                clear: () => browserStorage.clear(),
                removeItem: (key: string) => browserStorage.delete(key),
                setItem: (key: string, value: string) => browserStorage.set(key, value),
            },
        });
        vi.stubGlobal('document', {
            get cookie() {
                return '';
            },
            set cookie(_value: string) {},
        });
        routePath.value = '/electron';
        electronRecentFilesGet.mockResolvedValue([]);
        electronRecentFilesRemove.mockResolvedValue();
        electronRecentFilesClear.mockResolvedValue();
        electronRecentFilesRemoveIfMissing.mockResolvedValue(false);
        electronOpenDocumentDirect.mockResolvedValue(null);
        browserRecentFilesGet.mockResolvedValue([]);
        installRecentFilesStubs();
        const {setBrowserPlatformApi} = await import('@app/utils/platform');
        setBrowserPlatformApi(browserPlatformApi);
    });

    it('keeps desktop recent files unresolved until Electron results load', async () => {
        electronRecentFilesGet.mockResolvedValue([recentFile('/tmp/example.pdf')]);

        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {recentFiles, isResolved, loadRecentFiles} = useRecentFiles();

        expect(isResolved.value).toBe(false);
        expect(recentFiles.value).toEqual([]);

        await loadRecentFiles();

        expect(isResolved.value).toBe(true);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/example.pdf'})]);
        expect(electronRecentFilesGet).toHaveBeenCalledOnce();
    });

    it('reports a missing Electron API on the electron route', async () => {
        vi.useFakeTimers();
        delete window.electronAPI;
        browserRecentFilesGet.mockResolvedValue([recentFile('browser://documents/local')]);

        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {error, isResolved, loadRecentFiles, recentFiles} = useRecentFiles();

        await loadRecentFiles();

        expect(error.value).toBe('Electron API unavailable');
        expect(isResolved.value).toBe(false);
        expect(recentFiles.value).toEqual([]);
    });

    it('loads Electron recent files on the electron route with an unhydrated bridge state', async () => {
        stateStore.set('runtime:has-desktop-bridge', ref(false));
        electronRecentFilesGet.mockResolvedValue([recentFile('/tmp/route-electron.pdf', 3)]);
        browserRecentFilesGet.mockResolvedValue([recentFile('browser://documents/local')]);

        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {loadRecentFiles, recentFiles} = useRecentFiles();

        await loadRecentFiles();

        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/route-electron.pdf'})]);
    });

    it('removes recent files through the split recent-files capability', async () => {
        const file = recentFile('/tmp/remove-me.pdf');
        electronRecentFilesGet.mockResolvedValue([recentFile('/tmp/remaining.pdf', 2)]);

        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {recentFiles, removeRecentFile} = useRecentFiles();

        await removeRecentFile(file);

        expect(electronRecentFilesRemove).toHaveBeenCalledWith('/tmp/remove-me.pdf');
        expect(electronRecentFilesGet).toHaveBeenCalledOnce();
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/remaining.pdf'})]);
    });

    it('clears recent files through the split recent-files capability', async () => {
        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {clearRecentFiles, isResolved, recentFiles} = useRecentFiles();

        await clearRecentFiles();

        expect(electronRecentFilesClear).toHaveBeenCalledOnce();
        expect(recentFiles.value).toEqual([]);
        expect(isResolved.value).toBe(true);
    });

    it('drops a Recent file that is gone and tells the user, before any open starts', async () => {
        electronRecentFilesGet.mockResolvedValue([recentFile('/docs/gone.pdf', 2), recentFile('/docs/kept.pdf', 1)]);
        electronRecentFilesRemoveIfMissing.mockImplementation(async (path) => path === '/docs/gone.pdf');
        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {recentFiles, loadRecentFiles, forgetRecentFileIfMissing} = useRecentFiles();
        await loadRecentFiles();

        await expect(forgetRecentFileIfMissing(requireDocumentRef('/docs/kept.pdf'))).resolves.toBe(false);
        expect(toastAdd).not.toHaveBeenCalled();
        await expect(forgetRecentFileIfMissing(requireDocumentRef('/docs/gone.pdf'))).resolves.toBe(true);

        expect(recentFiles.value.map((file) => file.originalPath)).toEqual(['/docs/kept.pdf']);
        expect(toastAdd).toHaveBeenCalledWith({
            color: 'warning',
            icon: 'i-ph-warning',
            title: 'errors.recent.notFoundTitle',
            description: 'errors.recent.notFoundDescription:{"name":"gone.pdf"}',
        });
    });

    it('lets the open go on when it cannot tell whether a Recent file is gone', async () => {
        electronRecentFilesRemoveIfMissing.mockRejectedValue(new Error('IPC sender is not trusted'));
        const {useRecentFiles} = await import('@app/composables/useRecentFiles');

        await expect(useRecentFiles().forgetRecentFileIfMissing(requireDocumentRef('/docs/any.pdf'))).resolves.toBe(false);
        expect(toastAdd).not.toHaveBeenCalled();
    });

    it('keeps Electron recent files unresolved and retries after a startup failure', async () => {
        vi.useFakeTimers();
        electronRecentFilesGet
            .mockRejectedValueOnce(new Error('temporary startup failure'))
            .mockResolvedValueOnce([recentFile('/tmp/retried.pdf', 4)]);

        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {isResolved, recentFiles, loadRecentFiles} = useRecentFiles();

        await loadRecentFiles();

        expect(isResolved.value).toBe(false);
        expect(recentFiles.value).toEqual([]);
        expect(electronRecentFilesGet).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(750);

        expect(isResolved.value).toBe(true);
        expect(electronRecentFilesGet).toHaveBeenCalledTimes(2);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/retried.pdf'})]);
    });

    it('cancels scheduled Electron recent file retries when the composable scope is disposed', async () => {
        vi.useFakeTimers();
        electronRecentFilesGet
            .mockRejectedValueOnce(new Error('temporary startup failure'))
            .mockResolvedValueOnce([recentFile('/tmp/should-not-load.pdf', 5)]);

        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const scope = effectScope();
        const recentFilesState = scope.run(() => useRecentFiles());
        if (!recentFilesState) {
            throw new Error('Failed to create recent files composable');
        }

        await recentFilesState.loadRecentFiles();
        scope.stop();

        await vi.advanceTimersByTimeAsync(750);

        expect(electronRecentFilesGet).toHaveBeenCalledOnce();
        expect(recentFilesState.isResolved.value).toBe(false);
        expect(recentFilesState.recentFiles.value).toEqual([]);
    });

    it('keeps browser recent files unresolved when local storage has no snapshot', async () => {
        delete window.electronAPI;
        routePath.value = '/';
        browserRecentFilesGet.mockResolvedValue([recentFile('/tmp/full.pdf', 10)]);

        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {isResolved, loadRecentFiles, recentFiles} = useRecentFiles();

        expect(isResolved.value).toBe(false);
        expect(recentFiles.value).toEqual([]);

        await loadRecentFiles();

        expect(browserRecentFilesGet).toHaveBeenCalledOnce();
        expect(isResolved.value).toBe(true);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/full.pdf'})]);
    });

    it('marks a local browser snapshot as usable for startup paint', async () => {
        delete window.electronAPI;
        routePath.value = '/';
        browserStorage.set(BROWSER_RECENT_FILES_STORAGE_KEY, JSON.stringify([recentFile('browser://documents/local', 11)]));

        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {hasUsableInitialSnapshot, isResolved, recentFiles} = useRecentFiles();

        expect(hasUsableInitialSnapshot.value).toBe(true);
        expect(isResolved.value).toBe(true);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: 'browser://documents/local'})]);
    });

    it('does not treat browser local snapshots as startup-usable for Electron runtime', async () => {
        browserStorage.set(BROWSER_RECENT_FILES_STORAGE_KEY, JSON.stringify([recentFile('browser://documents/local', 13)]));

        const {useRecentFiles} = await import('@app/composables/useRecentFiles');
        const {hasUsableInitialSnapshot, isResolved, recentFiles} = useRecentFiles();

        expect(hasUsableInitialSnapshot.value).toBe(false);
        expect(isResolved.value).toBe(false);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: 'browser://documents/local'})]);
    });
});
