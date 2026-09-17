import type {IScanCleanupMarginsMm} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_MARGIN_MAX_MM} from '@contracts/scan-cleanup/electronApiScanCleanup';

export type TScanCleanupMarginSide = keyof IScanCleanupMarginsMm;
export type TScanCleanupMarginTarget = TScanCleanupMarginSide | 'all';

export interface IScanCleanupMarginSideField {
    key: TScanCleanupMarginSide;
    labelKey: 'scanCleanup.margins.left' | 'scanCleanup.margins.top' | 'scanCleanup.margins.right' | 'scanCleanup.margins.bottom';
}

/** Axis-paired editor order: vertical row (top, bottom), then horizontal row (left, right). */
export const SCAN_CLEANUP_MARGIN_SIDES: IScanCleanupMarginSideField[] = [
    {
        key: 'topMm',
        labelKey: 'scanCleanup.margins.top',
    },
    {
        key: 'bottomMm',
        labelKey: 'scanCleanup.margins.bottom',
    },
    {
        key: 'leftMm',
        labelKey: 'scanCleanup.margins.left',
    },
    {
        key: 'rightMm',
        labelKey: 'scanCleanup.margins.right',
    },
];

function clampScanCleanupMarginMm(value: number) {
    return Math.min(SCAN_CLEANUP_MARGIN_MAX_MM, Math.max(0, value));
}

/**
 * Resolves the per-key patch for one margin edit. Only the edited keys appear in
 * the patch so callers can mutate their reactive margins object in place —
 * untouched sides keep their reactive identity and never re-render.
 */
export function resolveScanCleanupMarginPatch(
    target: TScanCleanupMarginTarget,
    value: number,
): Partial<IScanCleanupMarginsMm> {
    if (!Number.isFinite(value)) {
        return {};
    }
    const clamped = clampScanCleanupMarginMm(value);
    if (target === 'all') {
        return {
            leftMm: clamped,
            topMm: clamped,
            rightMm: clamped,
            bottomMm: clamped,
        };
    }
    return {[target]: clamped};
}

export function scanCleanupMarginsUniform(margins: IScanCleanupMarginsMm) {
    return margins.leftMm === margins.topMm
        && margins.topMm === margins.rightMm
        && margins.rightMm === margins.bottomMm;
}
