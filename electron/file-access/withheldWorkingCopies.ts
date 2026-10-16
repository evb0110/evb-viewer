import {
    getWorkingCopyBackingEntry,
    normalizePathForLookup,
} from '@electron/file-access/workingCopyStore';
import {WorkingCopyMissingError} from '@electron/file-access/workingCopyMissingError';

const withheldRegistrations = new Set<string>();

function getRegistrationKey(logicalRef: string, registrationId: number) {
    return `${normalizePathForLookup(logicalRef) || logicalRef}\0${registrationId}`;
}

/**
 * A recovered working copy whose unsaved bytes are not on this computer reads its original in their place but never
 * becomes a copy of it: nothing saves or edits that stand-in, a later start that finds the real copy still recovers
 * it, and only a discard ends it.
 */
export function withholdWorkingCopyMaterialization(logicalRef: string, registrationId: number) {
    withheldRegistrations.add(getRegistrationKey(logicalRef, registrationId));
}

export function isWorkingCopyMaterializationWithheld(logicalRef: string, ownerWebContentsId?: number) {
    const entry = getWorkingCopyBackingEntry(logicalRef, ownerWebContentsId);
    return !!entry && withheldRegistrations.has(getRegistrationKey(logicalRef, entry.registrationId));
}

export function assertWorkingCopyMaterializationAllowed(logicalRef: string, registrationId: number) {
    if (withheldRegistrations.has(getRegistrationKey(logicalRef, registrationId))) {
        throw new WorkingCopyMissingError('The unsaved changes of this document are in a working copy missing on this computer');
    }
}
