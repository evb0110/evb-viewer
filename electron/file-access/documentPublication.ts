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
 * A file version's metadata fact: its size, its modification time at the precision the platform records, and its
 * identity (device and inode; on Windows the volume serial and file id). A file another program put in its place
 * differs even with the same size and time; a rename keeps all four, so a published copy's fact survives its
 * install. An edit in place that restores the modification time goes unseen: telling it apart takes reading the
 * content. Facts of the earlier `file-v1` form, size and time only, never equal these.
 */
const metadataFact = (stats: BigIntStats) => `file-v2:${stats.size}:${stats.mtimeNs}:${stats.dev}:${stats.ino}`;

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

/**
 * Ends what a save left of the PDF it displaced: put back when the save never installed its bytes, removed when the
 * PDF still holds what the save `installed` and the displaced bytes were the `baseline` EVB last read or wrote (or the
 * very file the save's check read, `checked`), and otherwise kept beside the PDF under a visible "(original)" name with
 * a notice, since another program wrote one of the two. Returns that name.
 */
async function settleDisplacedOriginal(destination: string, baseline: string | null, installed = true, checked?: string) {
    const displaced = displacedPath(destination);
    const found = statOrNull(displaced);
    if (!found) return undefined;
    if (!statOrNull(destination)) {
        await rename(displaced, destination);
        await fsyncParentDirectory(destination);
        return undefined;
    }
    if (installed && (sameWitness(metadataFact(found), checked) || sameWitness(metadataFact(found), baseline))) {
        await rm(displaced, {force: true});
        return undefined;
    }
    return keepOriginalBeside(displaced, destination, keptPath => rememberKeptOriginal(destination, keptPath));
}

/**
 * Settles a save a crash or a failure interrupted: the save finished only if the PDF is the file it was publishing,
 * whose metadata it staged as `published`. Returns the PDF's witness afterwards; throws while the PDF cannot be read,
 * so the document keeps the save to settle later.
 */
function settleInterruptedPublish(destination: string, published: string, baseline: string | null) {
    return withOriginalPathMutationLock(destination, async () => {
        await settleDisplacedOriginal(destination, baseline, sameWitness(await fileWitness(destination), published));
        return fileWitness(destination);
    });
}

class DestinationChanged extends Error {}

async function copyRevision(source: IPublishSource, absolutePath: string, target: string) {
    await copyFile(absolutePath, target, constants.COPYFILE_FICLONE);
    if (statSync(target).size !== source.length) await truncate(target, source.length);
}

/**
 * Publication to files on this computer. A destination's witness is its metadata, so opening, checking or saving
 * a file never reads it. The bytes are copied beside the destination, and that copy's metadata is the witness staged
 * before the replace: a rename keeps it. A Save checks the destination against the baseline inside `atomicReplace`,
 * after which the replaced PDF is moved aside rather than deleted; bytes another program wrote between that check and
 * the move stay beside the PDF as "(original)". Save As replaces without a check. A PDF that no longer has the staged
 * witness after the replace was changed by another program: the save is refused with the displaced original kept.
 */
export function createDesktopPublication(absolute: (storePath: string) => string): IPublicationPort {
    return {
        witness: fileWitness,
        settle: settleInterruptedPublish,
        source: async destination => destination,
        publish: (destination, source, expected, stage) => withOriginalPathMutationLock(destination, async () => {
            await settleDisplacedOriginal(destination, expected);
            const temp = makeSiblingTempPath(destination);
            try {
                await copyRevision(source, absolute(source.path), temp);
                const staged = metadataFact(statSync(temp, {bigint: true}));
                await stage(staged);
                let checked: string | undefined;
                try {
                    await atomicReplace(temp, destination, expected === null ? {} : {
                        destinationBackupPath: displacedPath(destination),
                        assertDestinationCurrent: () => {
                            const before = statOrNull(destination);
                            checked = before ? metadataFact(before) : undefined;
                            if (!sameWitness(checked, expected)) throw new DestinationChanged();
                            return Promise.resolve();
                        },
                    });
                } catch (error) {
                    if (error instanceof DestinationChanged) return {status: 'conflict'};
                    throw error;
                }
                const installed = await fileWitness(destination) === staged;
                const keptOriginal = await settleDisplacedOriginal(destination, expected, installed, checked);
                const kept = keptOriginal === undefined ? {} : {keptOriginal};
                return installed ? {status: 'published', witness: staged, ...kept} : {status: 'conflict', ...kept};
            } finally {
                await rm(temp, {force: true});
            }
        }),
    };
}
