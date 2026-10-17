import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {app} from 'electron';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
import {safeJsonParse} from '@contracts/safeJsonParse';
import {normalizePathForLookup} from '@electron/file-access/workingCopyStore';
import {writeJsonAtomic} from '@electron/utils/atomicReplace';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';

const log = createLogger('kept-original-notices');
let pendingUpdate: Promise<unknown> = Promise.resolve();

function getNoticesPath() {
    return join(app.getPath('userData'), 'kept-original-notices.json');
}

// Only a missing file holds no notices. Any other failure rejects, so an update never writes over notices it could not read.
async function readNotices() {
    const value = safeJsonParse(await readFile(getNoticesPath(), 'utf8').catch((error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') return '{}';
        throw error;
    }));
    return new Map(isRecord(value)
        ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        : []);
}

// One change at a time, so a later write never drops an earlier notice.
function updateNotices<T>(update: (notices: Map<string, string>) => T) {
    const next = pendingUpdate.then(async () => {
        const notices = await readNotices();
        const result = update(notices);
        await writeJsonAtomic(getNoticesPath(), Object.fromEntries(notices), {markMutationCommitStarted: false});
        return result;
    });
    pendingUpdate = next.catch(() => undefined);
    return next;
}

/**
 * Remembers that an interrupted or refused save kept `keptPath` beside `originalPath`, so every open of that PDF tells
 * the person until they dismiss it. A notice that cannot be stored is only logged: it never fails the save or recovery.
 */
export async function rememberKeptOriginal(originalPath: string, keptPath: string) {
    await updateNotices(notices => notices.set(normalizePathForLookup(originalPath), keptPath)).catch((error: unknown) => {
        log.warn('Could not remember a file recovery kept beside a PDF', {error: getErrorMessage(error)});
    });
}

/** The file kept beside `originalPath`, while it is there to open. A notice recorded before its move stays for when it lands. */
export async function findKeptOriginal(originalPath: string) {
    const notices = await readNotices().catch(() => new Map<string, string>());
    const keptPath = notices.get(normalizePathForLookup(originalPath));
    return keptPath !== undefined && existsSync(keptPath) ? keptPath : undefined;
}

/** Forgets the notice for `originalPath` once the person has dismissed it. */
export async function forgetKeptOriginal(originalPath: string) {
    await updateNotices(notices => notices.delete(normalizePathForLookup(originalPath))).catch(() => undefined);
}
