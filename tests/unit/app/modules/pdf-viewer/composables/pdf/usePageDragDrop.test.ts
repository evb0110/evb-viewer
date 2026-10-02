import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { usePageDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageDragDrop';
import { requireDocumentRef } from '@contracts/documentRef';
import {
    createAllPageSelection,
    createExplicitPageSelection,
    createRangePageSelection,
    type TPageMoveOperation,
} from '@contracts/pageNumbers';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { toastDescriptionContaining } from '@tests/helpers/toastDescription';

vi.mock('vue', async () => ({
    ...await vi.importActual('vue'),
    onUnmounted: vi.fn(),
}));

const toastAddMock = vi.fn();

function createDropEvent(paths: string[]) {
    const files = paths.map((path, index) => {
        const file = new File([], `file-${index}`);
        Object.defineProperty(file, 'path', {value: path});
        return file;
    });
    const event = new Event('drop');
    Object.defineProperty(event, 'dataTransfer', {value: {files}});
    Object.defineProperty(event, 'preventDefault', {value: vi.fn()});
    return event as DragEvent;
}

function createDragEventTarget() {
    const windowTarget = new EventTarget();
    const body = {style: {
        cursor: '',
        userSelect: '',
    }};
    class MockHTMLElement {
        public scrollHeight = 0;
        public clientHeight = 0;
        public scrollTop = 0;

        public closest() {
            return null;
        }
    }
    const container = new MockHTMLElement();
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('document', {
        body,
        createElement: () => container,
    });
    vi.stubGlobal('HTMLElement', MockHTMLElement);
    vi.stubGlobal('MouseEvent', class extends Event {
        public readonly button: number;
        public readonly buttons: number;
        public readonly clientX: number;
        public readonly clientY: number;
        public readonly shiftKey: boolean;
        public readonly metaKey: boolean;
        public readonly ctrlKey: boolean;

        public constructor(type: string, init: MouseEventInit = {}) {
            super(type);
            this.button = init.button ?? 0;
            this.buttons = init.buttons ?? 0;
            this.clientX = init.clientX ?? 0;
            this.clientY = init.clientY ?? 0;
            this.shiftKey = init.shiftKey ?? false;
            this.metaKey = init.metaKey ?? false;
            this.ctrlKey = init.ctrlKey ?? false;
        }
    });

    return {
        body,
        container: document.createElement('div'),
        windowTarget,
    };
}

describe('usePageDragDrop', () => {
    beforeEach(() => {
        toastAddMock.mockClear();
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        vi.stubGlobal('useToast', () => ({ add: toastAddMock }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('registers external dropped paths through the split picker capability', async () => {
        const pickerRegisterFilesForOpen = vi.fn(async () => [
            requireDocumentRef('/docs/a.pdf'),
            requireDocumentRef('/docs/b.png'),
            requireDocumentRef('/docs/a.pdf'),
            requireDocumentRef('/docs/readme.txt'),
        ]);
        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({documentPicker: { registerFilesForOpen: pickerRegisterFilesForOpen }}),
        });

        const onExternalFileDrop = vi.fn();
        const dragDrop = usePageDragDrop({
            containerRef: ref(null),
            totalPages: ref(7),
            selectedPages: ref([]),
            onReorder: vi.fn(),
            onExternalFileDrop,
        });
        dragDrop.dropInsertIndex.value = 3;

        await dragDrop.handleExternalDrop(createDropEvent([
            '/ignored/a.pdf',
            '/ignored/b.png',
        ]));

        expect(onExternalFileDrop).toHaveBeenCalledWith(3, [
            '/docs/a.pdf',
            '/docs/b.png',
        ]);
        expect(pickerRegisterFilesForOpen).toHaveBeenCalledTimes(2);
    });

    it('reports failed page-insert registration and inserts remaining valid files', async () => {
        const registerFilesForOpen = vi.fn(async (files: Array<{ name: string }>) => {
            if (files[0]?.name === 'file-0') {
                throw new Error('page ingestion failed');
            }
            return [requireDocumentRef('/docs/b.png')];
        });
        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({ documentPicker: { registerFilesForOpen } }),
        });

        const onExternalFileDrop = vi.fn();
        const dragDrop = usePageDragDrop({
            containerRef: ref(null),
            totalPages: ref(7),
            selectedPages: ref([]),
            onReorder: vi.fn(),
            onExternalFileDrop,
        });
        dragDrop.dropInsertIndex.value = 3;

        await dragDrop.handleExternalDrop(createDropEvent([
            '/ignored/a.pdf',
            '/ignored/b.png',
        ]));

        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.open',
            description: toastDescriptionContaining('page ingestion failed'),
        }));
        expect(onExternalFileDrop).toHaveBeenCalledWith(3, ['/docs/b.png']);
    });

    it('clears active thumbnail drag state when the window loses the drag', async () => {
        const {
            body,
            container,
            windowTarget,
        } = createDragEventTarget();
        const onReorder = vi.fn();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(3),
            selectedPages: ref([]),
            resolveDropIndex: () => 1,
            onReorder,
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 1);
        await nextTick();
        window.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 0,
        }));

        expect(dragDrop.isDragging.value).toBe(true);
        expect(body.style.cursor).toBe('grabbing');

        windowTarget.dispatchEvent(new Event('blur'));

        expect(dragDrop.isDragging.value).toBe(false);
        expect(dragDrop.draggedPages.value).toEqual([]);
        expect(dragDrop.dropInsertIndex.value).toBeNull();
        expect(body.style.cursor).toBe('');
        expect(body.style.userSelect).toBe('');
        expect(dragDrop.consumeClickSkip()).toBe(true);
        expect(onReorder).not.toHaveBeenCalled();
    });

    it('cancels active thumbnail drag when mousemove reports no pressed button', async () => {
        const {
            container,
            windowTarget,
        } = createDragEventTarget();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(3),
            selectedPages: ref([]),
            resolveDropIndex: () => 1,
            onReorder: vi.fn(),
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 1);
        await nextTick();
        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 0,
        }));
        expect(dragDrop.isDragging.value).toBe(true);

        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 0,
            clientX: 20,
            clientY: 0,
        }));

        expect(dragDrop.isDragging.value).toBe(false);
        expect(dragDrop.draggedPages.value).toEqual([]);
        expect(dragDrop.dropInsertIndex.value).toBeNull();
    });

    it('flushes the mouseup position before committing a page reorder', async () => {
        const {
            container,
            windowTarget,
        } = createDragEventTarget();
        const onReorder = vi.fn();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(3),
            selectedPages: ref([]),
            resolveDropIndex: clientY => clientY >= 100 ? 3 : 1,
            onReorder,
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 1);
        await nextTick();
        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 10,
        }));
        windowTarget.dispatchEvent(new MouseEvent('mouseup', {
            buttons: 0,
            clientX: 20,
            clientY: 100,
        }));

        expect(onReorder).toHaveBeenCalledExactlyOnceWith([
            2,
            3,
            1,
        ]);
    });

    it('emits a compact native move for a selected page in a million-page document', async () => {
        const {
            container,
            windowTarget,
        } = createDragEventTarget();
        const onReorder = vi.fn();
        const onMove = vi.fn<(move: TPageMoveOperation) => void>();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(1_000_000),
            selectedPages: ref([]),
            selectedPageSelection: ref(createAllPageSelection(1_000_000)),
            resolveDropIndex: () => 0,
            onReorder,
            onMove,
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 900_000);
        await nextTick();
        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 0,
        }));
        windowTarget.dispatchEvent(new MouseEvent('mouseup', {
            buttons: 0,
            clientX: 20,
            clientY: 0,
        }));

        expect(onMove).toHaveBeenCalledExactlyOnceWith({
            pageCount: 1_000_000,
            startPage: 900_000,
            endPage: 900_000,
            insertAt: 0,
        });
        expect(onReorder).not.toHaveBeenCalled();
    });

    it('emits compact multi-range moves for explicit xlarge selections', async () => {
        const {
            container,
            windowTarget,
        } = createDragEventTarget();
        const onReorder = vi.fn();
        const onMove = vi.fn<(move: TPageMoveOperation) => void>();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(1_000_000),
            selectedPages: ref([]),
            selectedPageSelection: ref(createExplicitPageSelection(1_000_000, [
                900_000,
                900_002,
            ])),
            resolveDropIndex: () => 0,
            onReorder,
            onMove,
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 900_000);
        await nextTick();
        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 0,
        }));
        windowTarget.dispatchEvent(new MouseEvent('mouseup', {
            buttons: 0,
            clientX: 20,
            clientY: 0,
        }));

        expect(onMove).toHaveBeenCalledExactlyOnceWith({
            pageCount: 1_000_000,
            ranges: [
                {
                    startPage: 900_000,
                    endPage: 900_000,
                },
                {
                    startPage: 900_002,
                    endPage: 900_002,
                },
            ],
            insertAt: 0,
        });
        expect(onReorder).not.toHaveBeenCalled();
    });

    it('routes contiguous explicit selections through the compact move callback', async () => {
        const {
            container,
            windowTarget,
        } = createDragEventTarget();
        const onReorder = vi.fn();
        const onMove = vi.fn<(move: TPageMoveOperation) => void>();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(1_000_000),
            selectedPages: ref([]),
            selectedPageSelection: ref(createExplicitPageSelection(1_000_000, [
                900_000,
                900_001,
            ])),
            resolveDropIndex: () => 0,
            onReorder,
            onMove,
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 900_000);
        await nextTick();
        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 0,
        }));
        windowTarget.dispatchEvent(new MouseEvent('mouseup', {
            buttons: 0,
            clientX: 20,
            clientY: 0,
        }));

        expect(onMove).toHaveBeenCalledExactlyOnceWith({
            pageCount: 1_000_000,
            startPage: 900_000,
            endPage: 900_001,
            insertAt: 0,
        });
        expect(onReorder).not.toHaveBeenCalled();
    });

    it('keeps a million-page contiguous range drag bounded', async () => {
        const {
            container,
            windowTarget,
        } = createDragEventTarget();
        const onReorder = vi.fn();
        const onMove = vi.fn<(move: TPageMoveOperation) => void>();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(1_000_000),
            selectedPages: ref([]),
            selectedPageSelection: ref(createRangePageSelection(1_000_000, 900_000, 999_999)),
            resolveDropIndex: () => 0,
            onReorder,
            onMove,
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 900_000);
        await nextTick();
        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 0,
        }));
        expect(dragDrop.draggedPages.value).toEqual([900_000]);
        windowTarget.dispatchEvent(new MouseEvent('mouseup', {
            buttons: 0,
            clientX: 20,
            clientY: 0,
        }));

        expect(onMove).toHaveBeenCalledExactlyOnceWith({
            pageCount: 1_000_000,
            startPage: 900_000,
            endPage: 999_999,
            insertAt: 0,
        });
        expect(onReorder).not.toHaveBeenCalled();
    });
});
