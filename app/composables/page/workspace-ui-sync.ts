import {
    watch,
    type Ref,
} from 'vue';
import type { TTranslationKey } from '@app/i18n/locales';
import type { TTabUpdate } from '@app/types/tabs';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';

interface IWorkspaceWindowTitleState {
    isDjvuMode: boolean;
    djvuSourcePath: string | null;
    fileName: string | null;
    pendingOpenDisplayName: string | null;
    fallbackTitle: string;
}

interface IWorkspaceTabState {
    fileName: string | null;
    pendingOpenDisplayName: string | null;
    originalPath: string | null;
    isDirty: boolean;
    isDjvuMode: boolean;
    djvuSourcePath: string | null;
}

interface IOpenBatchProgressState {
    processed: number;
    total: number;
}

interface IWorkspaceUiSyncDeps {
    pendingDjvu: Ref<string | null>;
    openDjvuFile: (
        djvuPath: string,
        loadPdfFromPath: (path: string) => Promise<void>,
        getCurrentPage?: () => number,
        setPage?: (page: number) => void,
        setOriginalPath?: (path: string | null) => void,
    ) => Promise<void>;
    loadPdfFromPath: (path: string) => Promise<void>;
    currentPage: Ref<number>;
    pdfViewerRef: Ref<{ scrollToPage: (page: number) => void } | null>;
    originalPath: Ref<string | null>;
    openBatchProgress: Ref<IOpenBatchProgressState | null>;
    isActive: Ref<boolean>;
    fileName: Ref<string | null>;
    isDirty: Ref<boolean>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<string | null>;
    showSettings: Ref<boolean>;
    t: (key: TTranslationKey, params?: Record<string, string | number>) => string;
    emitUpdateTab: (updates: TTabUpdate) => void;
    emitOpenSettings: () => void;
    onOpenDjvuError?: (error: unknown) => void;
}

function getBaseName(path: string | null) {
    if (!path) {
        return null;
    }
    return path.split(/[\\/]/).pop() ?? null;
}

export function resolveWorkspaceWindowTitle(state: IWorkspaceWindowTitleState) {
    if (state.pendingOpenDisplayName) {
        return state.pendingOpenDisplayName;
    }

    if (state.isDjvuMode && state.djvuSourcePath) {
        return getBaseName(state.djvuSourcePath) ?? state.fallbackTitle;
    }

    return state.fileName ?? state.fallbackTitle;
}

export function resolveWorkspaceTabUpdate(state: IWorkspaceTabState): TTabUpdate {
    const displayName = state.pendingOpenDisplayName
        ?? (state.isDjvuMode && state.djvuSourcePath
            ? (getBaseName(state.djvuSourcePath) ?? state.fileName)
            : state.fileName);

    return {
        fileName: displayName,
        originalPath: state.isDjvuMode && state.djvuSourcePath ? state.djvuSourcePath : state.originalPath,
        isDirty: state.isDirty,
        isDjvu: state.isDjvuMode,
    };
}

function resolvePendingOpenDisplayName(
    progress: IOpenBatchProgressState | null,
    t: (key: TTranslationKey, params?: Record<string, string | number>) => string,
) {
    if (!progress || progress.total <= 0) {
        return null;
    }

    return t('tabs.preparingBatch', {
        processed: Math.min(Math.max(0, progress.processed), progress.total),
        total: progress.total,
    });
}

export function setupWorkspaceUiSyncWatchers(deps: IWorkspaceUiSyncDeps) {
    watch(deps.pendingDjvu, async (djvuPath) => {
        if (!djvuPath) {
            return;
        }
        deps.pendingDjvu.value = null;
        try {
            await deps.openDjvuFile(
                djvuPath,
                deps.loadPdfFromPath,
                () => deps.currentPage.value,
                (page) => {
                    deps.pdfViewerRef.value?.scrollToPage(page);
                },
                (path) => {
                    deps.originalPath.value = path;
                },
            );
        } catch (error) {
            deps.onOpenDjvuError?.(error);
        }
    });

    watch(
        [
            deps.isActive,
            deps.fileName,
            deps.isDjvuMode,
            deps.djvuSourcePath,
            deps.openBatchProgress,
        ],
        ([active]) => {
            if (!active || !hasElectronAPI()) {
                return;
            }

            const title = resolveWorkspaceWindowTitle({
                isDjvuMode: deps.isDjvuMode.value,
                djvuSourcePath: deps.djvuSourcePath.value,
                fileName: deps.fileName.value,
                pendingOpenDisplayName: resolvePendingOpenDisplayName(deps.openBatchProgress.value, deps.t),
                fallbackTitle: deps.t('app.title'),
            });

            void getElectronAPI().setWindowTitle(title);
        },
        { immediate: true },
    );

    watch(
        [
            deps.fileName,
            deps.originalPath,
            deps.isDirty,
            deps.isDjvuMode,
            deps.djvuSourcePath,
            deps.openBatchProgress,
        ],
        () => {
            deps.emitUpdateTab(resolveWorkspaceTabUpdate({
                fileName: deps.fileName.value,
                pendingOpenDisplayName: resolvePendingOpenDisplayName(deps.openBatchProgress.value, deps.t),
                originalPath: deps.originalPath.value,
                isDirty: deps.isDirty.value,
                isDjvuMode: deps.isDjvuMode.value,
                djvuSourcePath: deps.djvuSourcePath.value,
            }));
        },
    );

    watch(deps.showSettings, (value) => {
        if (!value) {
            return;
        }

        deps.emitOpenSettings();
        deps.showSettings.value = false;
    });
}
