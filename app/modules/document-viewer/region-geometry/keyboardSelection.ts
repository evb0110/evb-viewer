import type {IClientRect} from '@app/modules/document-viewer/region-geometry/regionGeometryTypes';
import {getRectHeight} from '@app/modules/document-viewer/region-geometry/getRectHeight';
import {getRectWidth} from '@app/modules/document-viewer/region-geometry/getRectWidth';

const KEYBOARD_SELECTION_WIDTH_RATIO = 0.25;
const KEYBOARD_SELECTION_HEIGHT_RATIO = 0.25;
const KEYBOARD_SELECTION_STEP = 8;

export function clampKeyboardSelection(
    selection: IClientRect,
    bounds: IClientRect,
): IClientRect {
    const width = Math.min(getRectWidth(selection), getRectWidth(bounds));
    const height = Math.min(getRectHeight(selection), getRectHeight(bounds));
    const left = Math.min(
        Math.max(selection.left, bounds.left),
        bounds.right - width,
    );
    const top = Math.min(
        Math.max(selection.top, bounds.top),
        bounds.bottom - height,
    );
    return {
        left,
        top,
        right: left + width,
        bottom: top + height,
    };
}

export function createKeyboardSelection(
    bounds: IClientRect,
    minimumSize: number,
): IClientRect {
    const width = Math.max(minimumSize, getRectWidth(bounds) * KEYBOARD_SELECTION_WIDTH_RATIO);
    const height = Math.max(minimumSize, getRectHeight(bounds) * KEYBOARD_SELECTION_HEIGHT_RATIO);
    return clampKeyboardSelection({
        left: bounds.left + (getRectWidth(bounds) - width) / 2,
        top: bounds.top + (getRectHeight(bounds) - height) / 2,
        right: bounds.left + (getRectWidth(bounds) + width) / 2,
        bottom: bounds.top + (getRectHeight(bounds) + height) / 2,
    }, bounds);
}

export function updateKeyboardSelection(
    selection: IClientRect,
    bounds: IClientRect,
    event: KeyboardEvent,
    minimumSize: number,
): IClientRect {
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    if (event.shiftKey) {
        const width = Math.max(
            minimumSize,
            getRectWidth(selection) + (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                ? direction * KEYBOARD_SELECTION_STEP
                : 0),
        );
        const height = Math.max(
            minimumSize,
            getRectHeight(selection) + (event.key === 'ArrowUp' || event.key === 'ArrowDown'
                ? direction * KEYBOARD_SELECTION_STEP
                : 0),
        );
        return clampKeyboardSelection({
            left: selection.left,
            top: selection.top,
            right: selection.left + width,
            bottom: selection.top + height,
        }, bounds);
    }

    const deltaX = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        ? direction * KEYBOARD_SELECTION_STEP
        : 0;
    const deltaY = event.key === 'ArrowUp' || event.key === 'ArrowDown'
        ? direction * KEYBOARD_SELECTION_STEP
        : 0;
    return clampKeyboardSelection({
        left: selection.left + deltaX,
        top: selection.top + deltaY,
        right: selection.right + deltaX,
        bottom: selection.bottom + deltaY,
    }, bounds);
}
