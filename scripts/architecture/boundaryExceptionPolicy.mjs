const TICKET_REFERENCE_PATTERN = /^#\d+$/u;
const EXPIRY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const exception = (entry) => Object.freeze(entry);

export const BOUNDARY_EXCEPTION_POLICY = Object.freeze({
    scriptsToAppEdges: Object.freeze([
        exception({
            id: 'scripts-to-app:pdfTraceEntryGuards->logPdfNav',
            value: 'scripts/diagnostics/pdfTraceEntryGuards.ts -> app/utils/logPdfNav.ts',
            ownerTicket: '#323',
            expiresOn: '2026-12-31',
        }),
        exception({
            id: 'scripts-to-app:pdfTraceEntryGuards->pdfRenderTrace',
            value: 'scripts/diagnostics/pdfTraceEntryGuards.ts -> app/utils/pdfRenderTrace.ts',
            ownerTicket: '#323',
            expiresOn: '2026-12-31',
        }),
        exception({
            id: 'scripts-to-app:runPdfSkeletonNavigationDiagnostics->workspaceExpose',
            value: 'scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/types/workspaceExpose.ts',
            ownerTicket: '#323',
            expiresOn: '2026-12-31',
        }),
        exception({
            id: 'scripts-to-app:runPdfSkeletonNavigationDiagnostics->logPdfNav',
            value: 'scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/utils/logPdfNav.ts',
            ownerTicket: '#323',
            expiresOn: '2026-12-31',
        }),
        exception({
            id: 'scripts-to-app:runPdfSkeletonNavigationDiagnostics->pdfRenderTrace',
            value: 'scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/utils/pdfRenderTrace.ts',
            ownerTicket: '#323',
            expiresOn: '2026-12-31',
        }),
        exception({
            id: 'scripts-to-app:pdfNavigationBlinkTrace->evbTestApi',
            value: 'scripts/diagnostics/pdfNavigationBlinkTrace.ts -> app/types/evbTestApi.ts',
            ownerTicket: '#323',
            expiresOn: '2026-12-31',
        }),
    ]),
    annotationStoragePrivateAccess: Object.freeze([exception({
        id: 'annotation-storage-private-access:pdfjsAnnotationDiagnostics',
        value: 'app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics.ts',
        ownerTicket: '#323',
        expiresOn: '2026-12-31',
    })]),
    contractCompatibilityImports: Object.freeze([
        exception({
            id: 'contract-compatibility-imports:@contracts/search',
            specifier: '@contracts/search',
            names: Object.freeze([
                'assertSafePdfSearchRegex',
                'buildPdfSearchRegex',
                'collapseRepeatedPdfSearchPageText',
                'escapeSearchRegex',
                'normalizePdfSearchRequestPayload',
                'validateSearchQuery',
            ]),
            ownerTicket: '#316',
            expiresOn: '2026-12-31',
        }),
        exception({
            id: 'contract-compatibility-imports:@contracts/nativePdfMutations',
            specifier: '@contracts/nativePdfMutations',
            names: Object.freeze([
                'normalizePdfNativeModifiedAt',
                'normalizePdfNativeMutationSet',
                'normalizePdfNativeNoteChanges',
                'normalizePdfNativeNoteTextUpdates',
            ]),
            ownerTicket: '#316',
            expiresOn: '2026-12-31',
        }),
    ]),
    contractCompatibilityRoots: Object.freeze([
        exception({
            id: 'contract-compatibility-roots:tests',
            value: 'tests',
            ownerTicket: '#316',
            expiresOn: '2026-12-31',
        }),
        exception({
            id: 'contract-compatibility-roots:packages-contracts',
            value: 'packages/contracts',
            ownerTicket: '#316',
            expiresOn: '2026-12-31',
        }),
    ]),
    pdfViewerEngineBackEdges: Object.freeze([exception({
        id: 'pdf-viewer-engine-back-edge:embedded-shape',
        source: 'app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations.ts',
        targetRoots: Object.freeze([
            'app/modules/pdf-viewer/annotations/pdf-page-iteration',
            'app/modules/pdf-viewer/annotations/pdf-refs',
        ]),
        ownerTicket: '#323',
        expiresOn: '2026-12-31',
    })]),
});

/** @param {Record<string, unknown>} policy */
export function getBoundaryExceptionEntries(policy = BOUNDARY_EXCEPTION_POLICY, group) {
    const entries = policy[group];
    if (!Array.isArray(entries)) {
        throw new Error(`Unknown boundary exception group: ${group}`);
    }
    return entries;
}

/** @param {Record<string, unknown>} policy */
function flattenPolicyEntries(policy) {
    return Object.entries(policy).flatMap(([
        group,
        entries,
    ]) => {
        if (!Array.isArray(entries)) {
            throw new Error(`Boundary exception group must be an array: ${group}`);
        }
        return entries;
    });
}

export function validateBoundaryExceptionEntries(entries, now = new Date()) {
    const today = now.toISOString().slice(0, 10);
    const errors = [];
    const ids = new Set();

    for (const entry of entries) {
        const hasId = typeof entry?.id === 'string' && entry.id.length > 0;
        const id = hasId ? entry.id : '<missing id>';
        if (!hasId) {
            errors.push(`${id}: id must be a non-empty string`);
        } else if (ids.has(id)) {
            errors.push(`${id}: duplicate exception id`);
        }
        if (hasId) {
            ids.add(id);
        }
        if (typeof entry?.ownerTicket !== 'string' || !TICKET_REFERENCE_PATTERN.test(entry.ownerTicket)) {
            errors.push(`${id}: ownerTicket must reference a GitHub issue such as #323`);
        }
        if (
            typeof entry?.expiresOn !== 'string'
            || !EXPIRY_DATE_PATTERN.test(entry.expiresOn)
            || Number.isNaN(Date.parse(`${entry.expiresOn}T00:00:00.000Z`))
        ) {
            errors.push(`${id}: expiresOn must be an ISO calendar date`);
        } else if (entry.expiresOn <= today) {
            errors.push(`${id}: exception expired on ${entry.expiresOn}`);
        }

        const hasValue = typeof entry?.value === 'string' && entry.value.length > 0;
        const hasSpecifier = typeof entry?.specifier === 'string' && entry.specifier.length > 0;
        const hasNames = Array.isArray(entry?.names)
            && entry.names.length > 0
            && entry.names.every(name => typeof name === 'string' && name.length > 0);
        const hasSource = typeof entry?.source === 'string' && entry.source.length > 0;
        const hasTargetRoots = Array.isArray(entry?.targetRoots)
            && entry.targetRoots.length > 0
            && entry.targetRoots.every(root => typeof root === 'string' && root.length > 0);
        if ('value' in (entry ?? {}) && !hasValue) {
            errors.push(`${id}: value must be a non-empty string`);
        }
        if ('specifier' in (entry ?? {}) && !hasSpecifier) {
            errors.push(`${id}: specifier must be a non-empty string`);
        }
        if ('names' in (entry ?? {}) && !hasNames) {
            errors.push(`${id}: names must be a non-empty string array`);
        }
        if ('source' in (entry ?? {}) && !hasSource) {
            errors.push(`${id}: source must be a non-empty string`);
        }
        if ('targetRoots' in (entry ?? {}) && !hasTargetRoots) {
            errors.push(`${id}: targetRoots must be a non-empty string array`);
        }
        if (!hasValue && !(hasSpecifier && hasNames) && !(hasSource && hasTargetRoots)) {
            errors.push(`${id}: exception payload must define a value, specifier/names, or source/targetRoots`);
        }
    }

    return errors;
}

/** @param {Record<string, unknown>} policy */
export function validateBoundaryExceptionPolicy(policy = BOUNDARY_EXCEPTION_POLICY, now = new Date()) {
    return validateBoundaryExceptionEntries(flattenPolicyEntries(policy), now);
}

/** @param {Record<string, unknown>} policy */
export function getBoundaryExceptionValues(policy = BOUNDARY_EXCEPTION_POLICY, group) {
    return getBoundaryExceptionEntries(policy, group).map(entry => {
        if (typeof entry?.value !== 'string' || entry.value.length === 0) {
            throw new Error(`Boundary exception group ${group} entry ${entry?.id ?? '<missing id>'} has no string value`);
        }
        return entry.value;
    });
}
