import type {
    INativeScanCleanupManifestV3,
    IScanCleanupNormalizedRect,
    IScanCleanupPlacementAnchor,
} from '@contracts/electronApiScanCleanup';

function describeRect(rect: IScanCleanupNormalizedRect) {
    return `x=${String(rect.xNormalized)}, y=${String(rect.yNormalized)}, `
        + `width=${String(rect.widthNormalized)}, height=${String(rect.heightNormalized)}, `
        + `rotation=${String(rect.rotationDegrees)}°`;
}

function assertRect(
    pageNumber: number,
    label: string,
    rect: IScanCleanupNormalizedRect | undefined,
    pageRotation: IScanCleanupNormalizedRect['rotationDegrees'],
) {
    if (rect === undefined) {
        return;
    }
    const values = [
        rect.xNormalized,
        rect.yNormalized,
        rect.widthNormalized,
        rect.heightNormalized,
    ];
    // Complements computed as `1 - x` in a different rounding order overshoot
    // 1.0 by ~1e-16; mirror the native validator's BOUNDS_EPSILON so a box
    // the sidecar itself authored cannot abort the run at the preflight.
    const boundsEpsilon = 1e-9;
    if (
        !values.every(Number.isFinite)
        || rect.xNormalized < 0
        || rect.yNormalized < 0
        || rect.widthNormalized <= 0
        || rect.heightNormalized <= 0
        || rect.xNormalized + rect.widthNormalized > 1 + boundsEpsilon
        || rect.yNormalized + rect.heightNormalized > 1 + boundsEpsilon
        || rect.rotationDegrees !== pageRotation
    ) {
        throw new Error(
            `Scan cleanup page ${String(pageNumber)} has invalid ${label} geometry `
            + `(${describeRect(rect)}; page rotation=${String(pageRotation)}°)`,
        );
    }
}

function assertAnchor(
    pageNumber: number,
    half: string,
    anchor: IScanCleanupPlacementAnchor | undefined,
) {
    if (anchor === undefined) {
        return;
    }
    const value = anchor.yNormalized;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(
            `Scan cleanup page ${String(pageNumber)} has invalid ${half} placement anchor `
            + `(y=${String(value)})`,
        );
    }
}

/**
 * Mirrors the native rectangle preconditions at the point where effective
 * per-page options first exist. This is deliberately cheap and runs before
 * reusable MRC layers or final rasters are extracted.
 */
export function assertNativeScanCleanupManifestGeometry(
    manifest: INativeScanCleanupManifestV3,
) {
    for (const page of manifest.pages) {
        const pageNumber = page.sourcePageIndex + 1;
        const options = page.options;
        const rotation = options.rotationDegrees;
        assertRect(pageNumber, 'render crop', options.renderCrop, rotation);
        assertRect(pageNumber, 'manual full content box', options.manualContentBoxes.full, rotation);
        assertRect(pageNumber, 'manual left content box', options.manualContentBoxes.left, rotation);
        assertRect(pageNumber, 'manual right content box', options.manualContentBoxes.right, rotation);
        assertRect(pageNumber, 'automatic full content box', options.automaticContentBoxes?.full, rotation);
        assertRect(pageNumber, 'automatic left content box', options.automaticContentBoxes?.left, rotation);
        assertRect(pageNumber, 'automatic right content box', options.automaticContentBoxes?.right, rotation);
        assertAnchor(pageNumber, 'full', options.placementAnchors?.full);
        assertAnchor(pageNumber, 'left', options.placementAnchors?.left);
        assertAnchor(pageNumber, 'right', options.placementAnchors?.right);
    }
}
