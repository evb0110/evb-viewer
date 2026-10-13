import {isErrnoException} from '@contracts/runtimeGuards';

// What link() reports on a volume without hard links (FAT32, exFAT, some network shares) or across volumes. Windows
// reports exFAT's refusal as EISDIR.
const NO_HARD_LINK_CODES = new Set([
    'EXDEV',
    'ENOTSUP',
    'EOPNOTSUPP',
    'EPERM',
    'EMLINK',
    'EISDIR',
]);

/** Whether a failed link() means the file must be copied or renamed instead. */
export function isNoHardLinkError(error: unknown) {
    return isErrnoException(error) && typeof error.code === 'string' && NO_HARD_LINK_CODES.has(error.code);
}
