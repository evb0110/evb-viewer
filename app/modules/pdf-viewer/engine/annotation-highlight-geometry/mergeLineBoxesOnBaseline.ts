import type {ITextLineBox} from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/buildTextLineBoxesFromTextContent';

export const BASELINE_TOLERANCE = 0.002;
export const ADJACENT_RUN_GAP = 0.04;

function canShareLine(left: ITextLineBox, right: ITextLineBox) {
    const leftRun = left.runs.at(-1);
    const rightRun = right.runs[0];
    if (!leftRun || !rightRun || leftRun.isVertical !== rightRun.isVertical || leftRun.hasEOL) {
        return false;
    }
    const leftCrossStart = leftRun.isVertical ? left.left : left.top;
    const leftCrossEnd = leftRun.isVertical ? left.right : left.bottom;
    const rightCrossStart = leftRun.isVertical ? right.left : right.top;
    const rightCrossEnd = leftRun.isVertical ? right.right : right.bottom;
    const crossOverlap = Math.min(leftCrossEnd, rightCrossEnd) - Math.max(leftCrossStart, rightCrossStart);
    const leftInlineStart = Math.min(leftRun.inlineStart, leftRun.inlineEnd);
    const leftInlineEnd = Math.max(leftRun.inlineStart, leftRun.inlineEnd);
    const rightInlineStart = Math.min(rightRun.inlineStart, rightRun.inlineEnd);
    const rightInlineEnd = Math.max(rightRun.inlineStart, rightRun.inlineEnd);
    const gap = Math.max(0, Math.max(leftInlineStart, rightInlineStart) - Math.min(leftInlineEnd, rightInlineEnd));
    return Math.abs(left.baseline - right.baseline) <= BASELINE_TOLERANCE
        && crossOverlap >= -BASELINE_TOLERANCE
        && gap <= ADJACENT_RUN_GAP;
}

function mergePair(left: ITextLineBox, right: ITextLineBox): ITextLineBox {
    const runs = [
        ...left.runs,
        ...right.runs,
    ].sort((a, b) => a.itemIndex - b.itemIndex);
    return {
        runs,
        left: Math.min(left.left, right.left),
        top: Math.min(left.top, right.top),
        right: Math.max(left.right, right.right),
        bottom: Math.max(left.bottom, right.bottom),
        baseline: (left.baseline + right.baseline) / 2,
    };
}

/** Merges adjacent renderer runs that share a baseline into one line box. */
export function mergeLineBoxesOnBaseline(boxes: readonly ITextLineBox[]): ITextLineBox[] {
    const ordered = [...boxes].sort((left, right) => (
        left.baseline - right.baseline
        || Math.min(left.runs[0]!.inlineStart, left.runs[0]!.inlineEnd)
            - Math.min(right.runs[0]!.inlineStart, right.runs[0]!.inlineEnd)
        || left.runs[0]!.itemIndex - right.runs[0]!.itemIndex
    ));
    const merged: ITextLineBox[] = [];
    ordered.forEach((box) => {
        const previous = merged.at(-1);
        if (previous && canShareLine(previous, box)) {
            merged[merged.length - 1] = mergePair(previous, box);
            return;
        }
        merged.push(box);
    });
    return merged.sort((left, right) => (
        left.top - right.top
        || left.left - right.left
        || left.runs[0]!.itemIndex - right.runs[0]!.itemIndex
    ));
}
