import type { IClientPoint } from '@app/modules/document-viewer/public';

export function hasActiveSelectionDrag(
    state: string,
    startPoint: IClientPoint | null,
): startPoint is IClientPoint {
    return state === 'selecting' && startPoint !== null;
}
