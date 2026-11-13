import {
    constants,
    type BigIntStats,
} from 'node:fs';
import {
    copyFile,
    lstat,
    open,
    rename,
    rm,
    stat,
    truncate,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    join,
} from 'node:path';
import {contentWitness} from '@document-store/contentWitness';
import type {
    IPublicationPort,
    IPublishSource,
} from '@document-store/documentDirectory';
import {isErrnoException} from '@contracts/runtimeGuards';
import {
    atomicReplace,
    fsyncParentDirectory,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {keepOriginalBeside} from '@electron/utils/boundedPathComponent';
import {rememberKeptOriginal} from '@electron/file-access/keptOriginalNotices';
import {withOriginalPathMutationLock} from '@electron/file-access/withOriginalPathMutationLock';

const isMissing = (error: unknown) => isErrnoException(error) && error.code === 'ENOENT';

/** The content witness of the file at `path`, comparable with the store's revision witnesses. */
export async function fileWitness(path: string) {
    const handle = await open(path, 'r');
    try {
        const {size} = await handle.stat();
        return await contentWitness(size, async (offset, length) => {
            const bytes = new Uint8Array(length);
            let done = 0;
            while (done < length) {
                const {bytesRead} = await handle.read(bytes, done, length - done, offset + done);
                if (bytesRead === 0) break;
                done += bytesRead;
            }
            return bytes.subarray(0, done);
        });
    } finally {
        await handle.close();
    }
}

/** Where a save moves the PDF it replaces until it knows whose bytes those were; one name per PDF. */
function displacedPath(destination: string) {
    return join(dirname(destination), `.${basename(destination)}.evb-replaced`);
}

const sameBytesOnDisk = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;

/**
 * Ends what a save left of the PDF it displaced: put back when the save never installed its bytes, removed when they
 * were the `baseline` EVB last read or wrote (or the very file the save's check read, `checked`), and otherwise kept
 * beside the PDF under a visible "(original)" name with a notice, since another program wrote them. Returns that name.
 */
async function settleDisplacedOriginal(destination: string, baseline: string | null, checked?: BigIntStats) {
    const displaced = displacedPath(destination);
    const found = await lstat(displaced, {bigint: true}).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
    });
    if (!found) return undefined;
    if (!await lstat(destination).then(() => true, (error: unknown) => {
        if (isMissing(error)) return false;
        throw error;
    })) {
        await rename(displaced, destination);
        await fsyncParentDirectory(destination);
        return undefined;
    }
    if ((checked && sameBytesOnDisk(found, checked)) || (baseline !== null && await fileWitness(displaced) === baseline)) {
        await rm(displaced, {force: true});
        return undefined;
    }
    return keepOriginalBeside(displaced, destination, keptPath => rememberKeptOriginal(destination, keptPath));
}

/** Settles a save a crash interrupted, before the document that made it reopens. */
export function recoverInterruptedPublish(destination: string, baseline: string | null) {
    return withOriginalPathMutationLock(destination, () => settleDisplacedOriginal(destination, baseline));
}

class DestinationChanged extends Error {}

async function copyRevision(source: IPublishSource, absolutePath: string, target: string) {
    await copyFile(absolutePath, target, constants.COPYFILE_FICLONE);
    if ((await stat(target)).size !== source.length) await truncate(target, source.length);
}

/**
 * Publication to files on this computer. A Save checks the destination's content witness against the baseline
 * inside `atomicReplace`, after which the replaced PDF is moved aside rather than deleted; bytes another program
 * wrote between that check and the move stay beside the PDF as "(original)". Save As replaces without a check.
 */
export function createDesktopPublication(absolute: (storePath: string) => string): IPublicationPort {
    return {
        async witness(destination) {
            return fileWitness(destination).catch((error: unknown) => {
                if (isMissing(error)) return null;
                throw error;
            });
        },
        source: async destination => destination,
        publish: (destination, source, expected) => withOriginalPathMutationLock(destination, async () => {
            await settleDisplacedOriginal(destination, expected);
            const temp = makeSiblingTempPath(destination);
            try {
                await copyRevision(source, absolute(source.path), temp);
                if (expected === null) {
                    await atomicReplace(temp, destination);
                    return {status: 'published'};
                }
                let checked: BigIntStats | undefined;
                try {
                    await atomicReplace(temp, destination, {
                        destinationBackupPath: displacedPath(destination),
                        assertDestinationCurrent: async () => {
                            const before = await stat(destination, {bigint: true}).catch(() => null);
                            const witness = before && await fileWitness(destination).catch(() => null);
                            if (witness !== expected) throw new DestinationChanged();
                            checked = before ?? undefined;
                        },
                    });
                } catch (error) {
                    if (error instanceof DestinationChanged) return {status: 'conflict'};
                    throw error;
                }
                const keptOriginal = await settleDisplacedOriginal(destination, expected, checked);
                return keptOriginal === undefined ? {status: 'published'} : {status: 'published', keptOriginal};
            } finally {
                await rm(temp, {force: true});
            }
        }),
    };
}
