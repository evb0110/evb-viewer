import type {IPdfValidationResult} from '@contracts/pdfConformance';

export interface IPdfValidationSourceRevision {
    /** Exact admitted document instance identity (authority + working copy ref + revision token). */
    readonly documentInstance: string;
    /** Backing file identity (path + size + mtime) for the bytes being validated. */
    readonly backingIdentity: string;
    /** Exact byte revision of the admitted document bytes. */
    readonly byteRevision: string | number;
}

export type TPdfValidationCacheResult = 'hit' | 'miss' | 'coalesced';
export type TPdfValidationPurpose = 'full' | 'opening' | 'save';

const MAX_VALIDATED_REVISIONS = 32;
const successfulValidations = new Map<string, IPdfValidationResult>();
const pendingValidations = new Map<string, Promise<IPdfValidationResult>>();

function normalizeKeyComponent(value: string | number | null | undefined): string | null {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    }
    if (typeof value !== 'string') {
        return null;
    }
    return value.trim().length > 0 && !value.includes('\u0000') ? value : null;
}

function buildValidationCacheKey(
    revision: IPdfValidationSourceRevision | null | undefined,
    purpose: TPdfValidationPurpose | null | undefined,
): string | null {
    if (!revision || (purpose !== 'full' && purpose !== 'opening' && purpose !== 'save')) {
        return null;
    }
    const documentInstance = normalizeKeyComponent(revision.documentInstance);
    const backingIdentity = normalizeKeyComponent(revision.backingIdentity);
    const byteRevision = normalizeKeyComponent(revision.byteRevision);
    if (documentInstance === null || backingIdentity === null || byteRevision === null) {
        return null;
    }
    return `${purpose}\u0000${documentInstance}\u0000${backingIdentity}\u0000${byteRevision}`;
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
    const key = buildValidationCacheKey(revision, purpose);
    if (key === null) {
        return {
            validation: await validate(),
            cacheResult: 'miss',
        };
    }
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
