import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {app} from 'electron';
import {isRecord} from '@contracts/runtimeGuards';
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

async function readNotices() {
    const value = safeJsonParse(await readFile(getNoticesPath(), 'utf8').catch(() => '{}'));
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
 * Remembers that recovery after an interrupted save kept `keptPath` beside `originalPath`, so the next open of that
 * PDF tells the person once. A notice that cannot be stored is only logged: it never fails the recovery.
 */
export async function rememberKeptOriginal(originalPath: string, keptPath: string) {
    await updateNotices(notices => notices.set(normalizePathForLookup(originalPath), keptPath)).catch((error: unknown) => {
        log.warn('Could not remember a file recovery kept beside a PDF', {error: getErrorMessage(error)});
    });
}

/** Takes, once, the file recovery kept beside `originalPath`, while it is still there to open. */
export async function takeKeptOriginal(originalPath: string) {
    const key = normalizePathForLookup(originalPath);
    if (!(await readNotices().catch(() => new Map<string, string>())).has(key)) {
        return undefined;
    }
    return updateNotices((notices) => {
        const keptPath = notices.get(key);
        notices.delete(key);
        return keptPath !== undefined && existsSync(keptPath) ? keptPath : undefined;
    }).catch(() => undefined);
}
