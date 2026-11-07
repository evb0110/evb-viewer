import type {INativeScanCleanupManifestV3} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';
import {
    assertScanCleanupPathWithinCanonicalRoot,
    canonicalizeScanCleanupAllowedRoot,
    createScanCleanupPathResolutionCache,
    type IScanCleanupAllowedRoot,
    type IScanCleanupPathResolutionCache,
} from '@evb/scan-cleanup/core/assertScanCleanupPathWithinRoot';
import {
    assembleNativeScanCleanupManifest,
    MANIFEST_DETAIL_RENDER_PLAN_PATH_FIELDS,
    MANIFEST_OUTPUT_PATH_FIELDS,
    MANIFEST_PAGE_PATH_FIELDS,
    type IBuildRunnableNativeScanCleanupManifestInput,
    type IScanCleanupManifestPageInput,
} from '@evb/scan-cleanup/core/policy/assembleNativeScanCleanupManifest';

export * from '@evb/scan-cleanup/core/policy/assembleNativeScanCleanupManifest';

function assertManifestPagePaths(
    page: IScanCleanupManifestPageInput,
    pageIndex: number,
    allowedRoot: IScanCleanupAllowedRoot,
    checkedPathTrails: Map<string, string>,
    pathResolutionCache: IScanCleanupPathResolutionCache,
) {
    const pageLabel = `page ${String(pageIndex + 1)}`;
    const pageTrail = `pages.${String(pageIndex)}`;
    const check = (path: string | undefined, trail: string, label: string) => {
        if (path === undefined) {
            return;
        }
        assertScanCleanupPathWithinCanonicalRoot(path, allowedRoot, label, pathResolutionCache);
        // Keyed by the field trail the manifest emits, not by the path value: a
        // slot this list never judged cannot borrow the verdict of a checked
        // slot that happens to carry the same string.
        checkedPathTrails.set(trail, path);
    };
    for (const {
        field,
        label,
    } of MANIFEST_PAGE_PATH_FIELDS) check(page[field], `${pageTrail}.${field}`, `${pageLabel} ${label}`);
    for (const [
        outputIndex,
        output,
    ] of (page.outputs ?? []).entries()) {
        for (const {
            field,
            label,
        } of MANIFEST_OUTPUT_PATH_FIELDS) {
            check(
                output[field] ?? undefined,
                `${pageTrail}.outputs.${String(outputIndex)}.${field}`,
                `${pageLabel} output ${String(outputIndex)} ${label}`,
            );
        }
    }
    const detailRenderPlan = page.detailRenderPlan;
    if (detailRenderPlan == null) {
        return;
    }
    for (const {
        field,
        label,
    } of MANIFEST_DETAIL_RENDER_PLAN_PATH_FIELDS) {
        check(
            detailRenderPlan[field] ?? undefined,
            `${pageTrail}.detailRenderPlan.${field}`,
            `${pageLabel} ${label}`,
        );
    }
}

/**
 * Last word on coverage: a runnable manifest may not carry a path string that
 * containment never judged. Descriptor lists say what is checked; this says
 * that nothing else reached the wire, including a slot copied verbatim from
 * caller input.
 *
 * Coverage is matched per emitted field trail, so an unlabelled path slot fails
 * even when it repeats a string some other slot was cleared for.
 */
function assertNoUncheckedManifestPaths(
    manifest: INativeScanCleanupManifestV3,
    checkedPathTrails: ReadonlyMap<string, string>,
) {
    const visit = (value: unknown, trail: string) => {
        if (Array.isArray(value)) {
            for (const [
                index,
                entry,
            ] of value.entries()) visit(entry, `${trail}.${String(index)}`);
            return;
        }
        if (value === null || typeof value !== 'object') {
            return;
        }
        for (const [
            key,
            entry,
        ] of Object.entries(value)) {
            const fieldTrail = trail === '' ? key : `${trail}.${key}`;
            if (key.endsWith('Path') && typeof entry === 'string' && checkedPathTrails.get(fieldTrail) !== entry) {
                throw new ScanCleanupContractError(
                    `manifest field ${fieldTrail} was not checked against the allowed root`,
                );
            }
            visit(entry, fieldTrail);
        }
    };
    visit(manifest, '');
}

/**
 * Build a manifest that will be handed to the native binary. Every path is
 * checked against the caller's process-owned root before the manifest exists.
 */
export function buildRunnableNativeScanCleanupManifest(
    input: IBuildRunnableNativeScanCleanupManifestInput,
): INativeScanCleanupManifestV3 {
    // One canonical root per manifest: every field is judged against the same
    // resolved directory instead of re-resolving the root for each path.
    const allowedRoot = canonicalizeScanCleanupAllowedRoot(input.allowedPathRoot);
    const pathResolutionCache = createScanCleanupPathResolutionCache(allowedRoot);
    const checkedPathTrails = new Map<string, string>();
    return assembleNativeScanCleanupManifest(input, {
        page: (page, pageIndex) => assertManifestPagePaths(page, pageIndex, allowedRoot, checkedPathTrails, pathResolutionCache),
        manifest: manifest => assertNoUncheckedManifestPaths(manifest, checkedPathTrails),
    });
}

