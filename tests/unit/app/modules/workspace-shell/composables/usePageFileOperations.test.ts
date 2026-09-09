import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { requireDocumentRef } from '@contracts/documentRef';
import type { IRecentFile } from '@contracts/shared';
import { requireEpochMs } from '@contracts/timestamps';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { TPdfSource } from '@app/types/pdfUi';

const {
    mockHasElectronAPI,
    mockOpenCombineDialog,
    mockOpenFolderDialog,
    mockLegacyOpenCombineDialog,
    mockLegacyOpenFolderDialog,
} = vi.hoisted(() => ({
    mockHasElectronAPI: vi.fn(() => true),
    mockOpenCombineDialog: vi.fn<() => Promise<TOpenFileResult | null>>(async () => null),
    mockOpenFolderDialog: vi.fn<() => Promise<TOpenFileResult | null>>(async () => null),
    mockLegacyOpenCombineDialog: vi.fn(() => {
        throw new Error('legacy combine picker should not be used');
    }),
    mockLegacyOpenFolderDialog: vi.fn(() => {
        throw new Error('legacy folder picker should not be used');
    }),
}));

vi.mock('@app/utils/platform', () => ({hasElectronAPI: () => mockHasElectronAPI()}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentPickerCapability: () => ({
    openCombineDialog: mockOpenCombineDialog,
    openFolderDialog: mockOpenFolderDialog,
})}));

function openedOutcome(path = '/tmp/working.pdf'): TDocumentOpenOutcome {
    return {
        status: 'opened',
        result: {
            kind: 'pdf',
            originalPath: requireDocumentRef(path),
            workingPath: requireDocumentRef(path),
        },
    };
}

function createDeps(overrides: Partial<Parameters<typeof usePageFileOperations>[0]> = {}) {
    const annotationDirty = overrides.annotationDirty ?? ref(false);
    const isDirty = overrides.isDirty ?? ref(false);
    const pageLabelsDirty = overrides.pageLabelsDirty ?? ref(false);
    const bookmarksDirty = overrides.bookmarksDirty ?? ref(false);

    return {
        pdfSrc: ref<TPdfSource | null>(new Blob([], {type: 'application/pdf'})),
        hasDocument: ref(true),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        isExportingDocx: ref(false),
        isAnyAnnotationNoteSaving: ref(false),
        annotationNoteWindows: ref([]),
        hasPendingUnsavedChanges: computed(() => (
            annotationDirty.value
            || isDirty.value
            || pageLabelsDirty.value
            || bookmarksDirty.value
        )),
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        persistAllAnnotationNotes: vi.fn(async () => true),
        handleSave: vi.fn(async () => {}),
        pickFileToOpen: vi.fn(async () => null),
        openFile: vi.fn(async () => openedOutcome()),
        openFileDirect: vi.fn(async (path: string) => openedOutcome(path)),
        openFileDirectBatch: vi.fn(async (_paths: string[]) => openedOutcome()),
        closeFile: vi.fn(async () => {}),
        closeAllDropdowns: vi.fn(),
        emitOpenInNewTab: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof usePageFileOperations>[0];
}

describe('usePageFileOperations', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockHasElectronAPI.mockReturnValue(true);
        mockOpenCombineDialog.mockReset();
        mockOpenCombineDialog.mockResolvedValue(null);
        mockOpenFolderDialog.mockReset();
        mockOpenFolderDialog.mockResolvedValue(null);
        mockLegacyOpenCombineDialog.mockClear();
        mockLegacyOpenFolderDialog.mockClear();
    });

    it('persists unsaved changes before closing by default', async () => {
        const isDirty = ref(true);
        const deps = createDeps({
            isDirty,
            handleSave: vi.fn(async () => {
                isDirty.value = false;
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi();

        expect(deps.handleSave).toHaveBeenCalledOnce();
        expect(deps.closeFile).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('commits close after persistence succeeds and immediately before closing', async () => {
        const events: string[] = [];
        const isDirty = ref(true);
        const deps = createDeps({
            isDirty,
            handleSave: vi.fn(async () => {
                events.push('save');
                isDirty.value = false;
            }),
            closeFile: vi.fn(async () => {
                events.push('close');
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi({onCloseCommit: () => events.push('commit')});

        expect(events).toEqual([
            'save',
            'commit',
            'close',
        ]);
    });

    it('uses the supplied pending change predicate for persistence gating', async () => {
        const hasPendingUnsavedChanges = ref(true);
        const deps = createDeps({
            hasPendingUnsavedChanges: computed(() => hasPendingUnsavedChanges.value),
            handleSave: vi.fn(async () => {
                hasPendingUnsavedChanges.value = false;
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi();

        expect(deps.handleSave).toHaveBeenCalledOnce();
        expect(deps.closeFile).toHaveBeenCalledOnce();
    });

    it('can close without persisting when persist is false', async () => {
        const deps = createDeps({ isDirty: ref(true) });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi({ persist: false });

        expect(deps.handleSave).not.toHaveBeenCalled();
        expect(deps.closeFile).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('handles save rejection deterministically before opening another file', async () => {
        const errorSpy = vi.spyOn(BrowserLogger, 'error').mockImplementation(
            () => ({}) as ReturnType<typeof BrowserLogger.error>,
        );
        const deps = createDeps({
            isDirty: ref(true),
            handleSave: vi.fn(async () => {
                throw new Error('disk full');
            }),
        });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await expect(handleOpenFileFromUi()).resolves.toBe(false);

        expect(deps.pickFileToOpen).not.toHaveBeenCalled();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            'recent-open',
            'Switch blocked: save before switch threw',
            { error: 'disk full' },
            {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            },
        );
    });

    it('preserves a detailed blocked outcome when persistence prevents opening', async () => {
        const deps = createDeps({
            isDirty: ref(true),
            handleSave: vi.fn(async () => {
                throw new Error('disk full');
            }),
        });
        const {
            handleOpenFileFromUiDetailed,
            lastOpenOutcome,
        } = usePageFileOperations(deps);

        await expect(handleOpenFileFromUiDetailed()).resolves.toEqual({
            status: 'blocked',
            reason: 'persistence-gate',
        });

        expect(lastOpenOutcome.value).toEqual({
            status: 'blocked',
            reason: 'persistence-gate',
        });
        expect(deps.pickFileToOpen).not.toHaveBeenCalled();
    });

    it('opens through openFile directly in browser mode', async () => {
        mockHasElectronAPI.mockReturnValue(false);
        const openResult = {
            kind: 'pdf' as const,
            originalPath: requireDocumentRef('browser://documents/source/browser-open.pdf'),
            workingPath: requireDocumentRef('browser://documents/working/browser-open.pdf'),
        };
        const deps = createDeps({pickFileToOpen: vi.fn(async () => openResult)});
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await expect(handleOpenFileFromUi()).resolves.toBe(true);

        expect(deps.pickFileToOpen).toHaveBeenCalledOnce();
        expect(deps.openFile).toHaveBeenCalledWith(openResult);
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('returns failed direct opens immediately without retrying or closing dropdowns', async () => {
        const warnSpy = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        const deps = createDeps({
            pdfSrc: ref(null),
            openFileDirect: vi.fn(async () => ({
                status: 'failed' as const,
                error: 'not allowed',
            })),
        });
        const { handleOpenFileDirectWithPersist } = usePageFileOperations(deps);

        await expect(handleOpenFileDirectWithPersist(requireDocumentRef('/tmp/blocked.pdf'))).resolves.toBe(false);

        expect(deps.openFileDirect).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
            'recent-open',
            'Open path finished without an active document',
            {
                path: '/tmp/blocked.pdf',
                status: 'failed',
                error: 'not allowed',
            },
        );
    });

    it('preserves failed direct-open details for UI diagnostics', async () => {
        const deps = createDeps({
            pdfSrc: ref(null),
            openFileDirect: vi.fn(async () => ({
                status: 'failed' as const,
                error: 'not allowed',
            })),
        });
        const {
            handleOpenFileDirectWithPersistDetailed,
            lastOpenOutcome,
        } = usePageFileOperations(deps);

        const outcome = await handleOpenFileDirectWithPersistDetailed(requireDocumentRef('/tmp/blocked.pdf'));

        expect(outcome).toEqual({
            status: 'failed',
            error: 'not allowed',
        });
        expect(lastOpenOutcome.value).toEqual(outcome);
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('retries one stale direct open when no document reached renderer state', async () => {
        const infoSpy = vi.spyOn(BrowserLogger, 'info').mockImplementation(() => {});
        const pdfSrc = ref<TPdfSource | null>(null);
        let openAttempt = 0;
        const openFileDirect = vi.fn(async (path: TDocumentRef) => {
            openAttempt += 1;
            if (openAttempt === 1) {
                return {
                    status: 'stale' as const,
                    result: {
                        kind: 'pdf' as const,
                        originalPath: path,
                        workingPath: requireDocumentRef('/tmp/stale-working.pdf'),
                    },
                };
            }

            pdfSrc.value = {
                kind: 'path',
                path,
                size: 1,
            };
            return openedOutcome(path);
        });
        const deps = createDeps({
            pdfSrc,
            openFileDirect,
        });
        const { handleOpenFileDirectWithPersist } = usePageFileOperations(deps);

        await expect(handleOpenFileDirectWithPersist(requireDocumentRef('/tmp/startup.pdf'))).resolves.toBe(true);

        expect(openFileDirect).toHaveBeenCalledTimes(2);
        expect(openFileDirect).toHaveBeenNthCalledWith(1, '/tmp/startup.pdf');
        expect(openFileDirect).toHaveBeenNthCalledWith(2, '/tmp/startup.pdf');
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
        expect(infoSpy).toHaveBeenCalledWith(
            'recent-open',
            'Retrying stale direct open once before returning to empty state',
            { path: '/tmp/startup.pdf' },
        );
    });

    it('awaits the persistence gate before invoking the open picker', async () => {
        const callOrder: string[] = [];
        const isDirty = ref(true);
        const handleSave = vi.fn(async () => {
            callOrder.push('save');
            isDirty.value = false;
        });
        const pickFileToOpen = vi.fn(async () => {
            callOrder.push('pick');
            return null;
        });
        const deps = createDeps({
            isDirty,
            handleSave,
            pickFileToOpen,
        });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await handleOpenFileFromUi();

        expect(callOrder).toEqual([
            'save',
            'pick',
        ]);
    });

    it('returns early without closing dropdowns when the open picker is cancelled', async () => {
        const deps = createDeps({ pickFileToOpen: vi.fn(async () => null) });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await handleOpenFileFromUi();

        expect(deps.pickFileToOpen).toHaveBeenCalledOnce();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('runs the full open flow and closes dropdowns after handling the result', async () => {
        const openResult = {
            kind: 'pdf' as const,
            originalPath: requireDocumentRef('/tmp/source.pdf'),
            workingPath: requireDocumentRef('/tmp/working.pdf'),
        };
        const deps = createDeps({ pickFileToOpen: vi.fn(async () => openResult) });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await handleOpenFileFromUi();

        expect(deps.openFile).toHaveBeenCalledWith(openResult);
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('returns early without closing dropdowns when combine picker is cancelled', async () => {
        mockOpenCombineDialog.mockResolvedValue(null);
        const deps = createDeps();
        const { handleCombineImages } = usePageFileOperations(deps);

        await handleCombineImages();

        expect(mockOpenCombineDialog).toHaveBeenCalledOnce();
        expect(mockLegacyOpenCombineDialog).not.toHaveBeenCalled();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('returns early without closing dropdowns when folder picker is cancelled', async () => {
        mockOpenFolderDialog.mockResolvedValue(null);
        const deps = createDeps();
        const { handleOpenFolderFromUi } = usePageFileOperations(deps);

        await handleOpenFolderFromUi();

        expect(mockOpenFolderDialog).toHaveBeenCalledOnce();
        expect(mockLegacyOpenFolderDialog).not.toHaveBeenCalled();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('opens combined generated PDF in a new tab only when a document is already open', async () => {
        const generated = {
            kind: 'pdf' as const,
            originalPath: requireDocumentRef('/tmp/generated.pdf'),
            workingPath: requireDocumentRef('/tmp/working.pdf'),
            isGenerated: true,
        };
        mockOpenCombineDialog.mockResolvedValue(generated);

        const depsWithDoc = createDeps({ hasDocument: ref(true) });
        const opsWithDoc = usePageFileOperations(depsWithDoc);
        await opsWithDoc.handleCombineImages();

        expect(depsWithDoc.emitOpenInNewTab).toHaveBeenCalledWith(generated);
        expect(depsWithDoc.openFile).not.toHaveBeenCalled();
        expect(depsWithDoc.closeAllDropdowns).toHaveBeenCalledOnce();

        mockOpenCombineDialog.mockResolvedValue(generated);
        const depsNoDoc = createDeps({ hasDocument: ref(false) });
        const opsNoDoc = usePageFileOperations(depsNoDoc);
        await opsNoDoc.handleCombineImages();

        expect(depsNoDoc.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(depsNoDoc.openFile).toHaveBeenCalledWith(generated);
        expect(depsNoDoc.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('opens combined generated PDF in a new tab while a DjVu document is open', async () => {
        const generated = {
            kind: 'pdf' as const,
            originalPath: requireDocumentRef('/tmp/generated-from-djvu.pdf'),
            workingPath: requireDocumentRef('/tmp/working-from-djvu.pdf'),
            isGenerated: true,
        };
        mockOpenCombineDialog.mockResolvedValue(generated);
        const deps = createDeps({
            pdfSrc: ref(null),
            hasDocument: ref(true),
        });
        const { handleCombineImages } = usePageFileOperations(deps);

        await handleCombineImages();

        expect(deps.emitOpenInNewTab).toHaveBeenCalledWith(generated);
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('opens a missing recent file through the normal direct-open failure path', async () => {
        const deps = createDeps({openFileDirect: vi.fn(async () => ({
            status: 'failed' as const,
            error: 'File is unavailable',
        }))});
        const { openRecentFile } = usePageFileOperations(deps);
        const file: IRecentFile = {
            originalPath: requireDocumentRef('/tmp/missing.pdf'),
            fileName: 'missing.pdf',
            timestamp: requireEpochMs(0),
            fileSize: 0,
        };

        await expect(openRecentFile(file)).resolves.toBe(false);
        expect(deps.openFileDirect).toHaveBeenCalledWith('/tmp/missing.pdf');
    });

    it('opens an available recent file directly without a history preflight', async () => {
        const deps = createDeps();
        const { openRecentFile } = usePageFileOperations(deps);
        const file: IRecentFile = {
            originalPath: requireDocumentRef('/tmp/present.pdf'),
            fileName: 'present.pdf',
            timestamp: requireEpochMs(0),
            fileSize: 4096,
        };

        await openRecentFile(file);

        expect(deps.openFileDirect).toHaveBeenCalledWith('/tmp/present.pdf');
    });

    it('blocks close when save throws instead of bubbling an uncaught rejection', async () => {
        const errorSpy = vi.spyOn(BrowserLogger, 'error').mockImplementation(
            () => ({}) as ReturnType<typeof BrowserLogger.error>,
        );
        const onCloseCommit = vi.fn();
        const deps = createDeps({
            isDirty: ref(true),
            handleSave: vi.fn(async () => {
                throw new Error('cannot save');
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await expect(handleCloseFileFromUi({onCloseCommit})).resolves.toBe(false);

        expect(onCloseCommit).not.toHaveBeenCalled();
        expect(deps.closeFile).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            'recent-open',
            'Switch blocked: save before switch threw',
            { error: 'cannot save' },
            {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            },
        );
    });

});
