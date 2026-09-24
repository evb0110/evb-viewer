import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { createMissingRevisionError } from '@contracts/documentMutationErrors';
import {
    assertWorkingCopyMutationAllowed,
    assertWorkingCopyRevisionCurrent,
} from '@electron/file-access/documentRevisionStore';

function requireDocumentRef(value: string): TDocumentRef {
    const parsed = parseDocumentRef(value);
    if (parsed === null) {
        throw new TypeError('Working copy path must be an absolute document ref');
    }
    return parsed;
}

export function normalizeExpectedDocumentRevisionToken(
    options?: {expectedDocumentRevisionToken?: TDocumentRevisionToken | null} | null,
): TDocumentRevisionToken | null {
    const token = options?.expectedDocumentRevisionToken;
    if (token === undefined || token === null) {
        return null;
    }
    const parsedToken = parseDocumentRevisionToken(token);
    if (parsedToken === null) {
        throw new TypeError('expectedDocumentRevisionToken must be a non-empty string');
    }
    return parsedToken;
}

export async function assertQueuedWorkingCopyMutationPreconditions(
    workingCopyPath: string,
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null,
) {
    assertWorkingCopyMutationAllowed(workingCopyPath);
    if (expectedDocumentRevisionToken === undefined || expectedDocumentRevisionToken === null) {
        throw createMissingRevisionError({documentRef: requireDocumentRef(workingCopyPath)});
    }
    await assertWorkingCopyRevisionCurrent(workingCopyPath, expectedDocumentRevisionToken);
}

export function assertQueuedWorkingCopyMutationPreconditionsForBootstrap(
    workingCopyPath: string,
    reason: string,
) {
    if (reason.trim().length === 0) {
        throw new TypeError('bootstrap mutation precondition reason must be a non-empty string');
    }
    assertWorkingCopyMutationAllowed(workingCopyPath);
}

