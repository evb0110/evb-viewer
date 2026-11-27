import type {IPdfValidationResult} from '@contracts/pdfConformance';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TEpochMs} from '@contracts/timestamps';

export interface IPdfValidationSourceRevision {
    readonly documentId: TDocumentRef;
    readonly size: number;
    readonly modifiedAt: TEpochMs;
}

export type TPdfValidationCacheResult = 'hit' | 'miss' | 'coalesced';
export type TPdfValidationPurpose = 'full' | 'opening';

const MAX_VALIDATED_REVISIONS = 32;
const successfulValidations = new Map<string, IPdfValidationResult>();
const pendingValidations = new Map<string, Promise<IPdfValidationResult>>();

function revisionKey(revision: IPdfValidationSourceRevision, purpose: TPdfValidationPurpose) {
    return `${purpose}\u0000${revision.documentId}\u0000${revision.size}:${revision.modifiedAt}`;
}

function cacheSuccessfulValidation(key: string, validation: IPdfValidationResult) {
    if (!validation.isValid) {
        return;
    }
    successfulValidations.delete(key);
    successfulValidations.set(key, validation);
    while (successfulValidations.size > MAX_VALIDATED_REVISIONS) {
        const oldestKey = successfulValidations.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }
        successfulValidations.delete(oldestKey);
    }
}

export async function validatePdfRevision(
    revision: IPdfValidationSourceRevision | null,
    validate: () => Promise<IPdfValidationResult>,
    purpose: TPdfValidationPurpose = 'full',
): Promise<{
    validation: IPdfValidationResult;
    cacheResult: TPdfValidationCacheResult;
}> {
    if (revision === null) {
        return {
            validation: await validate(),
            cacheResult: 'miss',
        };
    }
    const key = revisionKey(revision, purpose);
    const cached = successfulValidations.get(key);
    if (cached) {
        successfulValidations.delete(key);
        successfulValidations.set(key, cached);
        return {
            validation: cached,
            cacheResult: 'hit',
        };
    }
    const pending = pendingValidations.get(key);
    if (pending) {
        return {
            validation: await pending,
            cacheResult: 'coalesced',
        };
    }
    const task = validate();
    pendingValidations.set(key, task);
    try {
        const validation = await task;
        cacheSuccessfulValidation(key, validation);
        return {
            validation,
            cacheResult: 'miss',
        };
    } finally {
        if (pendingValidations.get(key) === task) {
            pendingValidations.delete(key);
        }
    }
}

export function clearPdfValidationRevisionCacheForTests() {
    successfulValidations.clear();
    pendingValidations.clear();
}
