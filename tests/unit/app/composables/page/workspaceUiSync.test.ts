import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
    type Ref,
} from 'vue';
import {
    resolveWorkspaceTabUpdate,
    resolveWorkspaceWindowTitle,
    setupWorkspaceUiSyncWatchers,
} from '@app/composables/page/workspace-ui-sync';

type TWorkspaceUiSyncDeps = Parameters<typeof setupWorkspaceUiSyncWatchers>[0];

describe('resolveWorkspaceWindowTitle', () => {
    it('prefers DjVu source filename when in DjVu mode', () => {
        const title = resolveWorkspaceWindowTitle({
            isDjvuMode: true,
            djvuSourcePath: '/docs/archive/my-scan.djvu',
            fileName: 'working-copy.pdf',
            pendingOpenDisplayName: null,
            fallbackTitle: 'EVB Viewer',
        });

        expect(title).toBe('my-scan.djvu');
    });

    it('falls back to app title when no file name is available', () => {
        const title = resolveWorkspaceWindowTitle({
            isDjvuMode: false,
            djvuSourcePath: null,
            fileName: null,
            pendingOpenDisplayName: null,
            fallbackTitle: 'EVB Viewer',
        });

        expect(title).toBe('EVB Viewer');
    });
});

describe('resolveWorkspaceTabUpdate', () => {
    it('emits DjVu source path as tab originalPath when DjVu mode is active', () => {
        const update = resolveWorkspaceTabUpdate({
            fileName: 'temp.pdf',
            pendingOpenDisplayName: null,
            originalPath: '/tmp/temp.pdf',
            isDirty: true,
            isDjvuMode: true,
            djvuSourcePath: '/docs/source/book.djvu',
        });

        expect(update).toEqual({
            fileName: 'book.djvu',
            originalPath: '/docs/source/book.djvu',
            isDirty: true,
            isDjvu: true,
        });
    });

    it('keeps PDF metadata when DjVu mode is inactive', () => {
        const update = resolveWorkspaceTabUpdate({
            fileName: 'paper.pdf',
            pendingOpenDisplayName: null,
            originalPath: '/docs/paper.pdf',
            isDirty: false,
            isDjvuMode: false,
            djvuSourcePath: '/docs/source/book.djvu',
        });

        expect(update).toEqual({
            fileName: 'paper.pdf',
            originalPath: '/docs/paper.pdf',
            isDirty: false,
            isDjvu: false,
        });
    });
});

interface IWorkspaceUiSyncTestDeps {
    pendingDjvu: Ref<string | null>;
    openDjvuFile: TWorkspaceUiSyncDeps['openDjvuFile'];
    loadPdfFromPath: TWorkspaceUiSyncDeps['loadPdfFromPath'];
    currentPage: Ref<number>;
    pdfViewerRef: Ref<{ scrollToPage: (page: number) => void } | null>;
    originalPath: Ref<string | null>;
    openBatchProgress: Ref<{
        processed: number;
        total: number 
    } | null>;
    isActive: Ref<boolean>;
    fileName: Ref<string | null>;
    isDirty: Ref<boolean>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<string | null>;
    showSettings: Ref<boolean>;
    t: TWorkspaceUiSyncDeps['t'];
    emitUpdateTab: TWorkspaceUiSyncDeps['emitUpdateTab'];
    emitOpenSettings: TWorkspaceUiSyncDeps['emitOpenSettings'];
    onOpenDjvuError: NonNullable<TWorkspaceUiSyncDeps['onOpenDjvuError']>;
}

function createWatcherDeps(overrides: Partial<IWorkspaceUiSyncTestDeps> = {}): IWorkspaceUiSyncTestDeps {
    return {
        pendingDjvu: ref<string | null>(null),
        openDjvuFile: vi.fn(async () => {}) as TWorkspaceUiSyncDeps['openDjvuFile'],
        loadPdfFromPath: vi.fn(async () => {}) as TWorkspaceUiSyncDeps['loadPdfFromPath'],
        currentPage: ref(1),
        pdfViewerRef: ref(null),
        originalPath: ref<string | null>(null),
        openBatchProgress: ref(null),
        isActive: ref(false),
        fileName: ref<string | null>(null),
        isDirty: ref(false),
        isDjvuMode: ref(false),
        djvuSourcePath: ref<string | null>(null),
        showSettings: ref(false),
        t: (vi.fn((key: string) => key) as TWorkspaceUiSyncDeps['t']),
        emitUpdateTab: (vi.fn() as TWorkspaceUiSyncDeps['emitUpdateTab']),
        emitOpenSettings: (vi.fn() as TWorkspaceUiSyncDeps['emitOpenSettings']),
        onOpenDjvuError: vi.fn() as NonNullable<TWorkspaceUiSyncDeps['onOpenDjvuError']>,
        ...overrides,
    };
}

describe('setupWorkspaceUiSyncWatchers', () => {
    it('opens pending DjVu paths and clears pending state', async () => {
        const deps = createWatcherDeps();
        setupWorkspaceUiSyncWatchers(deps);

        deps.pendingDjvu.value = '/docs/test.djvu';
        await nextTick();
        await Promise.resolve();

        expect(deps.pendingDjvu.value).toBeNull();
        expect(deps.openDjvuFile).toHaveBeenCalledTimes(1);
        expect(deps.openDjvuFile).toHaveBeenCalledWith(
            '/docs/test.djvu',
            deps.loadPdfFromPath,
            expect.any(Function),
            expect.any(Function),
            expect.any(Function),
        );
    });

    it('forwards DjVu open errors to callback', async () => {
        const openError = new Error('DjVu opening failed');
        const deps = createWatcherDeps({openDjvuFile: vi.fn(async () => {
            throw openError;
        })});
        setupWorkspaceUiSyncWatchers(deps);

        deps.pendingDjvu.value = '/docs/broken.djvu';
        await nextTick();
        await Promise.resolve();

        expect(deps.onOpenDjvuError).toHaveBeenCalledTimes(1);
        expect(deps.onOpenDjvuError).toHaveBeenCalledWith(openError);
    });
});
