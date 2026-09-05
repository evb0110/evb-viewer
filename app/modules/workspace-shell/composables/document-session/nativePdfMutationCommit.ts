import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {
    IDocumentMutationRevisionOptions,
    IPdfNativeAnnotationIdentityBinding,
    IPdfNativeMutationSet,
    IPdfNativeStagedCommitOptions,
} from '@contracts/electronApiDocuments';
import {normalizePdfNativeAnnotationIdentityBindings} from '@contracts/nativePdfMutations';

export {collectExpectedNativeIdentityIds} from '@contracts/nativePdfMutations';

const MAX_TARGETED_PDF_OBJECT_REFS = 128;
const CANONICAL_PDF_OBJECT_REF_PATTERN = /(?:^|\D)(\d+)\s+(\d+)\s+R(?:$|\D)/i;
const COMPACT_PDF_OBJECT_REF_PATTERN = /(?:^|\D)(\d+)R(\d+)?(?:$|\D)/i;

export function createDocumentMutationRevisionOptions(
    expectedDocumentRevisionToken: TDocumentRevisionToken | null | undefined,
): IDocumentMutationRevisionOptions | undefined {
    if (expectedDocumentRevisionToken === null || expectedDocumentRevisionToken === undefined) {
        return undefined;
    }
    return { expectedDocumentRevisionToken };
}

function collectChangedPdfObjectRefs(mutations: IPdfNativeMutationSet): string[] {
    const refs = new Set<string>();
    const add = (objectNumber: unknown, generationNumber: unknown) => {
        if (
            refs.size >= MAX_TARGETED_PDF_OBJECT_REFS
            || typeof objectNumber !== 'number'
            || typeof generationNumber !== 'number'
            || !Number.isSafeInteger(objectNumber)
            || !Number.isSafeInteger(generationNumber)
            || objectNumber < 1
            || generationNumber < 0
        ) {
            return;
        }
        refs.add(`${objectNumber} ${generationNumber} R`);
    };
    const addStableKey = (value: unknown) => {
        if (typeof value !== 'string' || refs.size >= MAX_TARGETED_PDF_OBJECT_REFS) {
            return;
        }
        const normalizedValue = value.trim();
        const canonicalMatch = CANONICAL_PDF_OBJECT_REF_PATTERN.exec(normalizedValue);
        if (canonicalMatch) {
            add(Number(canonicalMatch[1]), Number(canonicalMatch[2]));
            return;
        }
        const compactMatch = COMPACT_PDF_OBJECT_REF_PATTERN.exec(normalizedValue);
        if (compactMatch) {
            add(Number(compactMatch[1]), Number(compactMatch[2] ?? 0));
        }
    };
    for (const update of mutations.updates ?? []) add(update.objectNumber, update.generationNumber);
    // Deleted refs are expected to resolve to qpdf's `null`; the presence gate
    // applies only to objects that must survive in the new xref.
    for (const [key] of mutations.markup?.overrides ?? []) addStableKey(key);
    return [...refs];
}

export function createNativeStagedCommitOptions(
    expectedDocumentRevisionToken: TDocumentRevisionToken | null | undefined,
    mutations: IPdfNativeMutationSet,
    identityBindings: readonly IPdfNativeAnnotationIdentityBinding[] = [],
): IPdfNativeStagedCommitOptions | undefined {
    const revision = createDocumentMutationRevisionOptions(expectedDocumentRevisionToken);
    if (!revision) {
        return undefined;
    }
    const changedObjectRefs = collectChangedPdfObjectRefs(mutations);
    return {
        ...revision,
        ...(changedObjectRefs.length ? {changedObjectRefs} : {}),
        ...(identityBindings.length ? {identityBindings: [...identityBindings]} : {}),
    };
}

export function validateNativeIdentityBindings(
    value: unknown,
    expectedAnnotationIds: readonly string[],
    label: string,
): IPdfNativeAnnotationIdentityBinding[] {
    const bindings = normalizePdfNativeAnnotationIdentityBindings(value, label, {errorKind: 'error'});
    const expected = new Set(expectedAnnotationIds);
    if (bindings.length !== expected.size) {
        throw new Error(`${label} did not bind exactly the newly authored annotation identities`);
    }
    for (const binding of bindings) {
        if (!expected.has(binding.annotationId)) {
            throw new Error(`${label} contains an unexpected annotation identity ${binding.annotationId}`);
        }
    }
    return bindings;
}

export function haveSameNativeIdentityBindings(
    left: readonly IPdfNativeAnnotationIdentityBinding[],
    right: readonly IPdfNativeAnnotationIdentityBinding[],
) {
    if (left.length !== right.length) {
        return false;
    }
    const rightById = new Map(right.map(binding => [
        binding.annotationId,
        binding.pdfRef,
    ]));
    return left.every(binding => rightById.get(binding.annotationId) === binding.pdfRef);
}
