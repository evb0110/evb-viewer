import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {shallowRef} from 'vue';
import {useAnnotationKeyboardCommands} from '@app/modules/pdf-viewer/annotations/editor/useAnnotationKeyboardCommands';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

function harness() {
    return {
        selectedIds: shallowRef(new Set([asAnnotationId('one')])),
        deleteSelection: vi.fn(),
        nudgeSelection: vi.fn(),
        nudgeSelectionByPdfPoints: vi.fn(),
        undo: vi.fn(() => true),
        redo: vi.fn(() => true),
    };
}

describe('useAnnotationKeyboardCommands', () => {
    it('handles deletion, point nudges, and atomic undo and redo routing', () => {
        const surface = harness();
        const commands = useAnnotationKeyboardCommands({
            surface,
            pageView: () => [
                0,
                0,
                612,
                792,
            ],
        });
        const key = (value: string, init: Partial<KeyboardEvent> = {}) => {
            let prevented = false;
            const event = {
                key: value,
                altKey: false,
                ctrlKey: false,
                metaKey: false,
                shiftKey: false,
                target: null,
                preventDefault: () => { prevented = true; },
                stopPropagation: vi.fn(),
                ...init,
                get defaultPrevented() { return prevented; },
            } as KeyboardEvent;
            commands.handleKeydown(event);
            return event;
        };

        expect(key('Delete').defaultPrevented).toBe(true);
        expect(key('ArrowRight').defaultPrevented).toBe(true);
        expect(key('ArrowRight', {shiftKey: true}).defaultPrevented).toBe(true);
        expect(key('z', {ctrlKey: true}).defaultPrevented).toBe(true);
        expect(key('z', {
            metaKey: true,
            shiftKey: true,
        }).defaultPrevented).toBe(true);
        expect(surface.deleteSelection).toHaveBeenCalledTimes(1);
        expect(surface.nudgeSelectionByPdfPoints).toHaveBeenNthCalledWith(1, 1, 0, [
            0,
            0,
            612,
            792,
        ], 0);
        expect(surface.nudgeSelectionByPdfPoints).toHaveBeenNthCalledWith(2, 10, 0, [
            0,
            0,
            612,
            792,
        ], 0);
        expect(surface.undo).toHaveBeenCalledOnce();
        expect(surface.redo).toHaveBeenCalledOnce();
    });

    it('leaves modified shortcuts alone', () => {
        const surface = harness();
        const commands = useAnnotationKeyboardCommands({surface});
        const event = {
            key: 'Delete',
            target: null,
            altKey: false,
            ctrlKey: true,
            metaKey: false,
            shiftKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        expect(commands.handleKeydown(event)).toBe(false);
        expect(surface.deleteSelection).not.toHaveBeenCalled();
    });

    it('allows undo with no selection', () => {
        const surface = harness();
        surface.selectedIds.value = new Set();
        const commands = useAnnotationKeyboardCommands({surface});
        const event = {
            key: 'z',
            target: null,
            altKey: false,
            ctrlKey: true,
            metaKey: false,
            shiftKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        expect(commands.handleKeydown(event)).toBe(true);
        expect(surface.undo).toHaveBeenCalledOnce();
    });

    it('does not nudge when page geometry is unavailable', () => {
        const surface = harness();
        const commands = useAnnotationKeyboardCommands({surface});
        const event = {
            key: 'ArrowRight',
            target: null,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };

        expect(commands.handleKeydown(event)).toBe(false);
        expect(surface.nudgeSelection).not.toHaveBeenCalled();
        expect(surface.nudgeSelectionByPdfPoints).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });
});
