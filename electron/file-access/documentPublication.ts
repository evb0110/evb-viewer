import {
    constants,
    statSync,
    type BigIntStats,
} from 'node:fs';
import {
    copyFile,
    open,
    rename,
    rm,
    truncate,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    join,
} from 'node:path';
import {
    contentWitness,
    sameWitness,
} from '@document-store/contentWitness';
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

/** `stat` of `path`, or `null` when nothing is there. Synchronous, as metadata reads on Windows must be (ADR 0001). */
function statOrNull(path: string) {
    try {
        return statSync(path, {bigint: true});
    } catch (error) {
        if (isMissing(error)) return null;
        throw error;
    }
}

/**
 * A file version's metadata fact: its size and modification time at the precision the platform records. Equal
 * facts mean an unchanged file, as long as nothing restores a modification time it changed.
 */
const metadataFact = (stats: BigIntStats) => `file-v1:${stats.size}:${stats.mtimeNs}`;

/** The metadata fact of the file at `path` and, with `content`, its content witness (one full read); `null` when missing. */
async function fileWitness(path: string, content = false) {
    const stats = statOrNull(path);
    if (!stats || !content) return stats && metadataFact(stats);
    const handle = await open(path, 'r');
    try {
        return `${metadataFact(stats)} ${await contentWitness(Number(stats.size), async (offset, length) => {
            const bytes = new Uint8Array(length);
            let done = 0;
            while (done < length) {
                const {bytesRead} = await handle.read(bytes, done, length - done, offset + done);
                if (bytesRead === 0) break;
                done += bytesRead;
            }
            return bytes.subarray(0, done);
        })}`;
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
    const found = statOrNull(displaced);
    if (!found) return undefined;
    if (!statOrNull(destination)) {
        await rename(displaced, destination);
        await fsyncParentDirectory(destination);
        return undefined;
    }
    if ((checked && sameBytesOnDisk(found, checked)) || sameWitness(metadataFact(found), baseline)) {
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
    if (statSync(target).size !== source.length) await truncate(target, source.length);
}

/**
 * Publication to files on this computer. A destination's witness is its metadata, so opening or checking a file
 * never reads it; recovery asks for its content too. A Save checks the destination against the baseline inside
 * `atomicReplace`, after which the replaced PDF is moved aside rather than deleted; bytes another program wrote
 * between that check and the move stay beside the PDF as "(original)". Save As replaces without a check. The
 * metadata after the replace joins the published bytes' content witness in the new baseline.
 */
export function createDesktopPublication(absolute: (storePath: string) => string): IPublicationPort {
    return {
        witness: fileWitness,
        source: async destination => destination,
        publish: (destination, source, expected) => withOriginalPathMutationLock(destination, async () => {
            await settleDisplacedOriginal(destination, expected);
            const temp = makeSiblingTempPath(destination);
            const published = (keptOriginal?: string) => ({
                status: 'published' as const,
                witness: metadataFact(statSync(destination, {bigint: true})),
                ...(keptOriginal === undefined ? {} : {keptOriginal}),
            });
            try {
                await copyRevision(source, absolute(source.path), temp);
                if (expected === null) {
                    await atomicReplace(temp, destination);
                    return published();
                }
                let checked: BigIntStats | undefined;
                try {
                    await atomicReplace(temp, destination, {
                        destinationBackupPath: displacedPath(destination),
                        assertDestinationCurrent: () => {
                            const before = statOrNull(destination);
                            if (!before || !sameWitness(metadataFact(before), expected)) throw new DestinationChanged();
                            checked = before;
                            return Promise.resolve();
                        },
                    });
                } catch (error) {
                    if (error instanceof DestinationChanged) return {status: 'conflict'};
                    throw error;
                }
                return published(await settleDisplacedOriginal(destination, expected, checked));
            } finally {
                await rm(temp, {force: true});
            }
        }),
    };
}
