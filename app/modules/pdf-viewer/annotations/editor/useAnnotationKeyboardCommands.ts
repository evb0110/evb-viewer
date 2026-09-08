import type { IAnnotationEditorSurface } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import {BrowserLogger} from '@app/utils/browserLogger';

interface IAnnotationKeyboardEvent {
    readonly key: string;
    readonly isComposing?: boolean;
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
    handleEscape?: IAnnotationEditorSurface['handleEscape'];
    selectAll?: IAnnotationEditorSurface['selectAll'];
}

interface IUseAnnotationKeyboardCommandsOptions {
    surface: IAnnotationKeyboardSurface;
    pageView?: () => number[] | null;
    pageRotation?: () => TPageRotation;
}

function isEditableTarget(target: EventTarget | null) {
    return typeof HTMLElement !== 'undefined'
        && target instanceof HTMLElement
        && (target.isContentEditable || Boolean(target.closest('[contenteditable="true"], [contenteditable=""]')) || [
            'INPUT',
            'TEXTAREA',
            'SELECT',
        ].includes(target.tagName));
}

export const useAnnotationKeyboardCommands = (
    options: IUseAnnotationKeyboardCommandsOptions,
): IAnnotationKeyboardCommands => ({handleKeydown(event) {
    if (event.isComposing || isEditableTarget(event.target)) {
        return false;
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape' && options.surface.handleEscape?.()) {
        event.preventDefault();
        event.stopPropagation();
        return true;
    }
    if (modifier && !event.altKey && event.key.toLowerCase() === 'a' && options.surface.selectAll?.()) {
        event.preventDefault();
        event.stopPropagation();
        return true;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'y') {
        const handled = options.surface.redo();
        event.preventDefault();
        event.stopPropagation();
        if (handled instanceof Promise) void handled.catch(error => BrowserLogger.warn('annotations', 'Keyboard history action failed', error));
        return true;
    }
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
