import type { IAnnotationEditorSurface } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import {BrowserLogger} from '@app/utils/browserLogger';

interface IAnnotationKeyboardEvent {
    readonly key: string;
    readonly target: EventTarget | null;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    preventDefault(): void;
    stopPropagation(): void;
}

export interface IAnnotationKeyboardCommands {handleKeydown(event: IAnnotationKeyboardEvent): boolean;}

interface IAnnotationKeyboardSurface {
    readonly selectedIds: IAnnotationEditorSurface['selectedIds'];
    deleteSelection: IAnnotationEditorSurface['deleteSelection'];
    nudgeSelection: IAnnotationEditorSurface['nudgeSelection'];
    nudgeSelectionByPdfPoints: IAnnotationEditorSurface['nudgeSelectionByPdfPoints'];
    undo: IAnnotationEditorSurface['undo'];
    redo: IAnnotationEditorSurface['redo'];
}

interface IUseAnnotationKeyboardCommandsOptions {
    surface: IAnnotationKeyboardSurface;
    pageView?: () => number[] | null;
    pageRotation?: () => TPageRotation;
}

function isEditableTarget(target: EventTarget | null) {
    return typeof HTMLElement !== 'undefined'
        && target instanceof HTMLElement
        && (target.isContentEditable || [
            'INPUT',
            'TEXTAREA',
            'SELECT',
        ].includes(target.tagName));
}

export const useAnnotationKeyboardCommands = (
    options: IUseAnnotationKeyboardCommandsOptions,
): IAnnotationKeyboardCommands => ({handleKeydown(event) {
    if (isEditableTarget(event.target)) {
        return false;
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && !event.altKey && event.key.toLowerCase() === 'z') {
        const handled = event.shiftKey ? options.surface.redo() : options.surface.undo();
        if (handled instanceof Promise) {
            event.preventDefault();
            event.stopPropagation();
            void handled.catch((error: unknown) => {
                BrowserLogger.warn('annotations', 'Keyboard history action failed', error);
            });
            return true;
        }
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
        return handled;
    }
    if (options.surface.selectedIds.value.size === 0) {
        return false;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !modifier && !event.altKey) {
        options.surface.deleteSelection();
        event.preventDefault();
        event.stopPropagation();
        return true;
    }
    const directions: Record<string, [number, number]> = {
        ArrowLeft: [
            -1,
            0,
        ],
        ArrowRight: [
            1,
            0,
        ],
        ArrowUp: [
            0,
            -1,
        ],
        ArrowDown: [
            0,
            1,
        ],
    };
    const direction = directions[event.key];
    if (!direction || modifier || event.altKey) {
        return false;
    }
    const amount = event.shiftKey ? 10 : 1;
    const pageView = options.pageView?.() ?? null;
    if (!pageView) {
        return false;
    }
    options.surface.nudgeSelectionByPdfPoints(
        direction[0] * amount,
        direction[1] * amount,
        pageView,
        options.pageRotation?.() ?? 0,
    );
    event.preventDefault();
    event.stopPropagation();
    return true;
}});
