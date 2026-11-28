import {BrowserWindow, type IpcMainInvokeEvent} from 'electron';
import type {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import type {TFeatureMainBindings} from '@contracts/platformFeature';
import {handleSetWindowTitle} from '@electron/features/documents/main/windowTitleHandler';
import {allowRevealPaths, removeAllowedRevealPath} from '@electron/file-access/openPathCapabilities';
import {setMenuDocumentState, setMenuTabCount, updateRecentFilesMenu} from '@electron/menu';
import {clearRecentFiles, getRecentFiles, removeRecentFile, removeRecentFileIfMissing} from '@electron/recentFiles';

/**
 * Lightweight main-process IPC bindings for Start-screen document features
 * (menu sync, window title/reveal, recent files). Keeps Start-screen calls on
 * already-eager modules so the full documents runtime stays deferred until
 * first document open or post-shell-interactive prewarm.
 */
export const documentMenuMainBindings = {
    setMenuDocumentState: (context, state) => {
        const window = BrowserWindow.fromWebContents(context.sender);
        if (window) {
            setMenuDocumentState(window.id, state);
        }
    },
    setMenuTabCount: (context, tabCount) => {
        const window = BrowserWindow.fromWebContents(context.sender);
        if (window) {
            setMenuTabCount(window.id, tabCount);
        }
    },
} satisfies TFeatureMainBindings<typeof DOCUMENT_MENU_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export const documentWindowMainBindings = {
    setWindowTitle: (context, title) => {
        handleSetWindowTitle(
            {
                senderId: context.senderId,
                window: BrowserWindow.fromWebContents(context.sender),
            },
            title,
        );
        return undefined;
    },
    showItemInFolder: async (context, filePath) => {
        const {handleShowItemInFolder} = await import('@electron/features/documents/main/documentWindowHandlers');
        return handleShowItemInFolder({owner: context.sender}, filePath);
    },
} satisfies TFeatureMainBindings<typeof DOCUMENT_WINDOW_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export const documentRecentFilesMainBindings = {
    getRecentFiles: async (context) => {
        const files = await getRecentFiles();
        allowRevealPaths(
            files.map((file) => file.originalPath),
            context.sender,
        );
        return files;
    },
    getRecentReadingView: async (context, documentPath) => {
        const {getRecentReadingView} = await import('@electron/recentReadingViews');
        return getRecentReadingView(documentPath, context.senderId);
    },
    rememberRecentReadingView: async (context, documentPath, view) => {
        const {rememberRecentReadingView} = await import('@electron/recentReadingViews');
        await rememberRecentReadingView(documentPath, view, context.senderId);
        return undefined;
    },
    removeRecentFile: async (originalPath) => {
        await removeRecentFile(originalPath);
        // Recent history owns reveal access; retained tabs keep their open grants.
        removeAllowedRevealPath(originalPath);
        updateRecentFilesMenu();
    },
    removeRecentFileIfMissing: async (originalPath) => {
        const removed = await removeRecentFileIfMissing(originalPath);
        if (removed) {
            removeAllowedRevealPath(originalPath);
            updateRecentFilesMenu();
        }
        return removed;
    },
    clearRecentFiles: async () => {
        const files = await getRecentFiles();
        await clearRecentFiles();
        for (const file of files) {
            removeAllowedRevealPath(file.originalPath);
        }
        updateRecentFilesMenu();
    },
} satisfies TFeatureMainBindings<typeof DOCUMENT_RECENT_FILES_PLATFORM_FEATURE, IpcMainInvokeEvent>;
