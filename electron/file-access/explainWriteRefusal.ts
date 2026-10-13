import {
    access,
    constants,
} from 'node:fs/promises';
import {dirname} from 'node:path';
import {isErrnoException} from '@contracts/runtimeGuards';

const writable = (path: string) => access(path, constants.W_OK).then(() => true, () => false);

/**
 * Names why a save of `pdfPath` was refused with EACCES or EPERM, once the save has rolled back: the PDF itself is
 * read-only or locked (the Windows Read-only attribute, the macOS Locked flag) while its folder takes writes, or else
 * its folder cannot be written. The cause leads the message the failure surface maps; other errors pass unchanged.
 */
export async function explainWriteRefusal(error: unknown, pdfPath: string) {
    if (!(error instanceof Error) || !isErrnoException(error) || (error.code !== 'EACCES' && error.code !== 'EPERM')) return error;
    const fileReadOnly = !await writable(pdfPath) && await writable(dirname(pdfPath));
    error.message = `${fileReadOnly ? 'The PDF is read-only or locked' : 'The folder of the PDF cannot be written'}: ${error.message}`;
    return error;
}
