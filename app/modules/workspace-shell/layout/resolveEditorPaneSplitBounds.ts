import {clamp} from 'es-toolkit/math';

const EDITOR_PANE_MIN_SIZE_PX = 320;
export const LEGACY_MIN_SPLIT_RATIO = 0.15;

export interface IEditorPaneSplitBounds {
    minRatio: number;
    maxRatio: number;
    ultraCompact: boolean;
}

export function resolveEditorPaneSplitBounds(availableSize: number, minPaneSize = EDITOR_PANE_MIN_SIZE_PX): IEditorPaneSplitBounds {
    if (!Number.isFinite(availableSize) || availableSize <= 0) {
        return {
            minRatio: LEGACY_MIN_SPLIT_RATIO,
            maxRatio: 1 - LEGACY_MIN_SPLIT_RATIO,
            ultraCompact: false,
        };
    }

    if (availableSize < minPaneSize * 2) {
        return {
            minRatio: 0.5,
            maxRatio: 0.5,
            ultraCompact: true,
        };
    }

    const minRatio = clamp(minPaneSize / availableSize, LEGACY_MIN_SPLIT_RATIO, 0.5);
    return {
        minRatio,
        maxRatio: 1 - minRatio,
        ultraCompact: false,
    };
}
