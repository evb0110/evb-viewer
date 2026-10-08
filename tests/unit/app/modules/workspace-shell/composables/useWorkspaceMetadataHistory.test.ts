import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
    toRaw,
} from 'vue';
import { useWorkspaceMetadataHistory } from '@app/modules/workspace-shell/composables/useWorkspaceMetadataHistory';
import { useWorkspaceCommandLedger } from '@app/modules/workspace-shell/composables/useWorkspaceCommandLedger';
import type {IWorkspaceCommandRegistration} from '@app/types/workspaceCommand';
import { createPageLabelModel } from '@app/modules/document-viewer/pageLabels';
import { requirePageIndex } from '@contracts/pageNumbers';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';

function createHistory() {
    const ledger = useWorkspaceCommandLedger();
    const registrations: IWorkspaceCommandRegistration[] = [];
    const commandSink = {
        register: (command: IWorkspaceCommandRegistration) => {
            registrations.push(command);
            ledger.registerCommand(command);
        },
        reset: ledger.resetSource,
        forget: ledger.forgetSourceEntries,
    };
    const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
    const bookmarksDirty = ref(false);
    const pageLabels = ref<string[] | null>(null);
    const pageLabelRanges = ref<IPdfPageLabelRange[]>([{
        startPage: 1,
        style: 'D',
        prefix: '',
        startNumber: 1,
    }]);
    const pageLabelModel = shallowRef(createPageLabelModel(1, pageLabelRanges.value));
    const pageLabelsDirty = ref(false);
    const totalPages = ref(1);

    return {
        bookmarkItems,
        bookmarksDirty,
        pageLabels,
        pageLabelModel,
        pageLabelRanges,
        pageLabelsDirty,
        totalPages,
        ledger,
        registrations,
        history: {
            ...useWorkspaceMetadataHistory({
                bookmarkItems,
                bookmarksDirty,
                pageLabels,
                pageLabelModel,
                pageLabelRanges,
                pageLabelsDirty,
                totalPages,
                commandSink,
            }),
            canUndoMetadata: ledger.canUndoTimeline,
            undoMetadata: ledger.undoTimeline,
            redoMetadata: ledger.redoTimeline,
        },
    };
}

describe('useWorkspaceMetadataHistory', () => {
    it('publishes each metadata edit directly to the workspace command sink', () => {
        const registrations: IWorkspaceCommandRegistration[] = [];
        const reset = vi.fn();
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
        const history = useWorkspaceMetadataHistory({
            bookmarkItems,
            bookmarksDirty: ref(false),
            pageLabels: ref<string[] | null>(null),
            pageLabelRanges: ref<IPdfPageLabelRange[]>([]),
            pageLabelsDirty: ref(false),
            totalPages: ref(1),
            commandSink: {
                register: command => registrations.push(command),
                reset,
                forget: vi.fn(),
            },
        });
        history.resetToCurrentState();
        bookmarkItems.value = [{
            title: 'Direct command',
            pageIndex: requirePageIndex(0),
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }];
        history.recordCurrentState();

        expect(reset).toHaveBeenCalledWith('metadata');
        expect(registrations).toHaveLength(1);
        expect(registrations[0]?.source).toBe('metadata');
        expect(registrations[0]?.undo()).toBe(true);
        expect(bookmarkItems.value).toEqual([]);
        expect(registrations[0]?.cmd()).toBe(true);
        expect(bookmarkItems.value[0]?.title).toBe('Direct command');
    });

    it('releases discarded inverse payloads without letting an old command undo a new edit', async () => {
        const {
            bookmarkItems, history, registrations,
        } = createHistory();
        history.resetToCurrentState();
        const bookmark = (title: string): IPdfBookmarkEntry => ({
            title,
            pageIndex: requirePageIndex(0),
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        });
        bookmarkItems.value = [bookmark('Old edit')];
        history.recordCurrentState();
        const discarded = registrations[0]!;
        history.resetToCurrentState();
        bookmarkItems.value = [bookmark('New edit')];
        history.recordCurrentState();

        expect(await discarded.undo()).toBe(false);
        expect(await discarded.cmd()).toBe(false);
        expect(bookmarkItems.value[0]?.title).toBe('New edit');
        expect(await history.undoMetadata()).toBe(true);
        expect(bookmarkItems.value[0]?.title).toBe('Old edit');
    });

    it('limits large inverse payloads to the shared byte budget and preserves retained undo/redo', async () => {
        const {
            bookmarkItems, history, registrations,
        } = createHistory();
        bookmarkItems.value = Array.from({length: 1000}, (_, index) => ({
            title: 'x'.repeat(1000),
            pageIndex: requirePageIndex(index),
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }));
        history.resetToCurrentState();
        for (let index = 0; index < 55; index += 1) {
            bookmarkItems.value[0] = {
                ...toRaw(bookmarkItems.value[0]!),
                title: `edit-${index}`,
            };
            history.recordCurrentState();
        }

        expect(await registrations[0]!.undo()).toBe(false);
        expect(bookmarkItems.value[0]?.title).toBe('edit-54');
        let undoCount = 0;
        while (await history.undoMetadata()) undoCount += 1;
        expect(undoCount).toBe(14);
        expect(bookmarkItems.value[0]?.title).toBe('edit-40');
        let redoCount = 0;
        while (await history.redoMetadata()) redoCount += 1;
        expect(redoCount).toBe(14);
        expect(bookmarkItems.value[0]?.title).toBe('edit-54');
    });

    it('tracks bookmark and page label snapshots with undo/redo', async () => {
        const {
            bookmarkItems,
            pageLabels,
            pageLabelRanges,
            bookmarksDirty,
            pageLabelsDirty,
            history,
        } = createHistory();

        history.resetToCurrentState();

        bookmarkItems.value = [{
            title: 'Chapter 1',
            pageIndex: requirePageIndex(0),
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }];
        history.recordCurrentState();

        pageLabels.value = ['i'];
        pageLabelRanges.value = [{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }];
        history.recordCurrentState();

        expect(history.canUndoMetadata.value).toBe(true);
        expect(bookmarksDirty.value).toBe(true);
        expect(pageLabelsDirty.value).toBe(true);

        expect(await history.undoMetadata()).toBe(true);
        expect(pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
        expect(pageLabels.value).toBeNull();
        expect(bookmarkItems.value).toEqual([{
            title: 'Chapter 1',
            pageIndex: 0,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }]);
        expect(bookmarksDirty.value).toBe(true);
        expect(pageLabelsDirty.value).toBe(false);

        expect(await history.undoMetadata()).toBe(true);
        expect(bookmarkItems.value).toEqual([]);
        expect(bookmarksDirty.value).toBe(false);

        expect(await history.redoMetadata()).toBe(true);
        expect(bookmarkItems.value).toEqual([{
            title: 'Chapter 1',
            pageIndex: 0,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }]);
    });

    it('restores small page-label compatibility arrays while preserving range semantics', async () => {
        const {
            pageLabels,
            pageLabelModel,
            pageLabelRanges,
            history,
        } = createHistory();

        history.resetToCurrentState();
        pageLabelRanges.value = [{
            startPage: 1,
            style: 'r',
            prefix: 'Front ',
            startNumber: 1,
        }];
        pageLabelModel.value = createPageLabelModel(1, pageLabelRanges.value);
        history.recordCurrentState();

        expect(await history.undoMetadata()).toBe(true);
        expect(pageLabels.value).toBeNull();
        expect(pageLabelModel.value.labelAt(1)).toBe('1');

        expect(await history.redoMetadata()).toBe(true);
        expect(pageLabels.value).toEqual(['Front i']);
        expect(pageLabelModel.value.labelAt(1)).toBe('Front i');
    });

    it('restores million-page history through ranges without materializing labels', async () => {
        const ledger = useWorkspaceCommandLedger();
        const totalPages = 1_000_000;
        const initialRanges: IPdfPageLabelRange[] = [{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }];
        const changedRanges: IPdfPageLabelRange[] = [
            ...initialRanges,
            {
                startPage: 500_001,
                style: 'D',
                prefix: 'Appendix ',
                startNumber: 1,
            },
        ];
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
        const bookmarksDirty = ref(false);
        const pageLabels = ref<string[] | null>(null);
        const pageLabelRanges = ref<IPdfPageLabelRange[]>(initialRanges);
        const pageLabelModel = shallowRef(createPageLabelModel(totalPages, initialRanges));
        const pageLabelsDirty = ref(false);
        const totalPageCount = ref(totalPages);
        const history = useWorkspaceMetadataHistory({
            bookmarkItems,
            bookmarksDirty,
            pageLabels,
            pageLabelModel,
            pageLabelRanges,
            pageLabelsDirty,
            totalPages: totalPageCount,
            commandSink: {
                register: ledger.registerCommand,
                reset: ledger.resetSource,
                forget: ledger.forgetSourceEntries,
            },
        });

        history.resetToCurrentState();
        pageLabelRanges.value = changedRanges;
        pageLabelModel.value = createPageLabelModel(totalPages, changedRanges);
        history.recordCurrentState();

        expect(await ledger.undoTimeline()).toBe(true);
        expect(pageLabels.value).toBeNull();
        expect(pageLabelRanges.value).toEqual(initialRanges);
        expect(pageLabelModel.value.segments).toEqual([expect.objectContaining({
            startPage: 1,
            endPage: totalPages,
        })]);
        expect(pageLabelModel.value.labelAt(totalPages)).toBe(String(totalPages));

        expect(await ledger.redoTimeline()).toBe(true);
        expect(pageLabels.value).toBeNull();
        expect(pageLabelRanges.value).toEqual(changedRanges);
        expect(pageLabelModel.value.segments).toEqual([
            expect.objectContaining({
                startPage: 1,
                endPage: 500_000,
            }),
            expect.objectContaining({
                startPage: 500_001,
                endPage: totalPages,
            }),
        ]);
        expect(pageLabelModel.value.labelAt(500_001)).toBe('Appendix 1');
        expect(pageLabelModel.value.labelAt(totalPages)).toBe('Appendix 500000');
    });

    it('keeps small metadata edits within the shared history budget without a second cap', async () => {
        const {
            bookmarkItems,
            bookmarksDirty,
            history,
        } = createHistory();

        history.resetToCurrentState();

        for (let index = 0; index < 60; index += 1) {
            bookmarkItems.value = [{
                title: `Bookmark ${index + 1}`,
                pageIndex: requirePageIndex(index),
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }];
            history.recordCurrentState();
        }

        let undoCount = 0;
        while (await history.undoMetadata()) {
            undoCount += 1;
        }

        expect(undoCount).toBe(60);
        expect(bookmarkItems.value).toEqual([]);
        expect(bookmarksDirty.value).toBe(false);
        expect(history.canUndoMetadata.value).toBe(false);
    });

    it('preserves undo history when the current metadata state is marked clean after save', async () => {
        const {
            bookmarkItems,
            bookmarksDirty,
            history,
        } = createHistory();

        history.resetToCurrentState();

        bookmarkItems.value = [{
            title: 'Saved bookmark',
            pageIndex: requirePageIndex(0),
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }];
        history.recordCurrentState();
        expect(bookmarksDirty.value).toBe(true);

        history.markCurrentStateClean();

        expect(bookmarksDirty.value).toBe(false);
        expect(history.canUndoMetadata.value).toBe(true);

        expect(await history.undoMetadata()).toBe(true);
        expect(bookmarkItems.value).toEqual([]);
        expect(bookmarksDirty.value).toBe(true);

        expect(await history.redoMetadata()).toBe(true);
        expect(bookmarkItems.value).toEqual([{
            title: 'Saved bookmark',
            pageIndex: 0,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }]);
        expect(bookmarksDirty.value).toBe(false);
    });

    it('records edits that return metadata to the clean snapshot as undoable', async () => {
        const {
            bookmarkItems,
            bookmarksDirty,
            history,
        } = createHistory();

        history.resetToCurrentState();

        bookmarkItems.value = [{
            title: 'Transient bookmark',
            pageIndex: requirePageIndex(0),
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }];
        history.recordCurrentState();

        bookmarkItems.value = [];
        history.recordCurrentState();

        expect(bookmarksDirty.value).toBe(false);
        expect(history.canUndoMetadata.value).toBe(true);

        expect(await history.undoMetadata()).toBe(true);
        expect(bookmarkItems.value).toEqual([{
            title: 'Transient bookmark',
            pageIndex: 0,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }]);
        expect(bookmarksDirty.value).toBe(true);
    });
});
