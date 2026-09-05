import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { computed } from 'vue';
import { usePdfViewerMouseInteractions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerMouseInteractions';

function createMouseEvent(target: EventTarget | null = null) {
    const event = new Event('contextmenu') as MouseEvent;
    Object.defineProperty(event, 'target', {
        value: target,
        configurable: true,
    });
    Object.defineProperty(event, 'preventDefault', {
        value: vi.fn(),
        configurable: true,
    });
    return event;
}

describe('usePdfViewerMouseInteractions', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('always suppresses the browser context menu inside the viewer', () => {
        vi.stubGlobal('HTMLElement', class HTMLElementStub {
            closest() {
                return null;
            }
        });
        const handleViewerContextMenuAnnotation = vi.fn();
        const interactions = usePdfViewerMouseInteractions({
            isSnipActive: () => false,
            isViewerPanDragModeActive: computed(() => false),
            cancelPendingSearchScroll: vi.fn(),
            handleDragStart: vi.fn(),
            handleDragMove: vi.fn(),
            stopDrag: vi.fn(),
            handleViewerClickAnnotation: vi.fn(),
            handleViewerDblClickAnnotation: vi.fn(),
            handleViewerContextMenuAnnotation,
        });

        const event = createMouseEvent();
        interactions.handleViewerContextMenu(event);

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(handleViewerContextMenuAnnotation).toHaveBeenCalledWith(event);
    });

    it('still suppresses the browser context menu during snipping without delegating', () => {
        vi.stubGlobal('HTMLElement', class HTMLElementStub {
            closest() {
                return null;
            }
        });
        const handleViewerContextMenuAnnotation = vi.fn();
        const interactions = usePdfViewerMouseInteractions({
            isSnipActive: () => true,
            isViewerPanDragModeActive: computed(() => false),
            cancelPendingSearchScroll: vi.fn(),
            handleDragStart: vi.fn(),
            handleDragMove: vi.fn(),
            stopDrag: vi.fn(),
            handleViewerClickAnnotation: vi.fn(),
            handleViewerDblClickAnnotation: vi.fn(),
            handleViewerContextMenuAnnotation,
        });

        const event = createMouseEvent();
        interactions.handleViewerContextMenu(event);

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(handleViewerContextMenuAnnotation).not.toHaveBeenCalled();
    });

    it('stops pan drag on mouseup inside the viewer', () => {
        vi.stubGlobal('HTMLElement', class HTMLElementStub {
            closest() {
                return null;
            }
        });
        const stopDrag = vi.fn();
        const interactions = usePdfViewerMouseInteractions({
            isSnipActive: () => false,
            isViewerPanDragModeActive: computed(() => true),
            cancelPendingSearchScroll: vi.fn(),
            handleDragStart: vi.fn(),
            handleDragMove: vi.fn(),
            stopDrag,
            handleViewerClickAnnotation: vi.fn(),
            handleViewerDblClickAnnotation: vi.fn(),
            handleViewerContextMenuAnnotation: vi.fn(),
        });

        const event = createMouseEvent();
        interactions.handleViewerMouseUp(event);

        expect(stopDrag).toHaveBeenCalledOnce();
    });

    it('does not start viewer drag from a canonical annotation layer target', () => {
        class ElementStub {
            addEventListener() {}
            dispatchEvent() { return true; }
            removeEventListener() {}
            closest(selector: string) {
                return selector.includes('.pdf-annotation-editor-layer') ? {} : null;
            }
        }
        class HTMLElementStub extends ElementStub {}
        vi.stubGlobal('Element', ElementStub);
        vi.stubGlobal('HTMLElement', HTMLElementStub);
        const handleDragStart = vi.fn();
        const interactions = usePdfViewerMouseInteractions({
            isSnipActive: () => false,
            isViewerPanDragModeActive: computed(() => true),
            cancelPendingSearchScroll: vi.fn(),
            handleDragStart,
            handleDragMove: vi.fn(),
            stopDrag: vi.fn(),
            handleViewerClickAnnotation: vi.fn(),
            handleViewerDblClickAnnotation: vi.fn(),
            handleViewerContextMenuAnnotation: vi.fn(),
        });

        const event = createMouseEvent(new ElementStub());
        interactions.handleViewerMouseDown(event);

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(handleDragStart).not.toHaveBeenCalled();
    });
});
