// Public because document opening must distinguish managed cleanup outputs from user files.
import type { App } from 'electron';
import * as electron from 'electron';
import {
    createHash,
    randomUUID,
} from 'crypto';
import {realpathSync} from 'fs';
import {
    mkdir,
    lstat,
    readFile,
    readdir,
    rm,
    stat,
    utimes,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'path';
import {
    parseDocumentRef, type TDocumentRef,
} from '@contracts/documentRef';
import {atomicReplace} from '@electron/utils/atomicReplace';
import { getLegacyAppTempDirPath } from '@electron/utils/appTempDir';

export const SCAN_CLEANUP_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES = 255;
const OUTPUT_NAME_HASH_HEX_LENGTH = 12;
const COMPLETED_OUTPUT_JOURNAL_VERSION = 1;
export const SCAN_CLEANUP_COMPLETED_OUTPUT_JOURNAL_NAME = '.evb-scan-cleanup-completed-outputs.json';
const COMPLETED_OUTPUT_JOURNAL_MAX_ENTRIES = 32;

interface ICompletedOutputJournalEntry {
    version: 1;
    outputPdfPath: string;
    completedAtMs: number;
}

let completedOutputJournalWrite: Promise<void> = Promise.resolve();

/**
 * Cleanup outputs are the feature's only deliverable, so they live under app
 * data: the OS may purge its temp directory on its own schedule, which would
 * destroy a document the user is still coming back to. Outputs written by
 * earlier versions stay under the app temp directory; that root remains
 * readable and keeps being swept by the same retention policy.
 */
export function getScanCleanupOutputBaseDirs() {
    // The Electron app is reachable from the main process only, which is the
    // only place outputs are created, classified or swept; elsewhere the legacy
    // root is all there is to report.
    const appDataDir = (electron as {app?: Pick<App, 'getPath'>}).app?.getPath('userData');
    // Removal condition for this compatibility root: only after every
    // supported checkpoint/recovery reader has stopped producing paths under
    // the pre-app-data location. Until then it remains a read-and-sweep root.
    const legacyTempDir = getLegacyAppTempDirPath();
    return appDataDir ? [
        appDataDir,
        legacyTempDir,
    ] : [legacyTempDir];
}

export function getScanCleanupOutputRoot(baseDir = getScanCleanupOutputBaseDirs()[0]!) {
    return join(baseDir, 'scan-cleanup', 'output');
}

export function getScanCleanupCompletedOutputJournalPath(baseDir: string) {
    return join(getScanCleanupOutputRoot(baseDir), SCAN_CLEANUP_COMPLETED_OUTPUT_JOURNAL_NAME);
}

function parseCompletedOutputJournal(value: unknown): ICompletedOutputJournalEntry[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const entries: ICompletedOutputJournalEntry[] = [];
    for (const candidate of value) {
        if (typeof candidate !== 'object' || candidate === null) {
            continue;
        }
        const entry = candidate as Record<string, unknown>;
        if (
            entry.version !== COMPLETED_OUTPUT_JOURNAL_VERSION
            || typeof entry.outputPdfPath !== 'string'
            || parseDocumentRef(entry.outputPdfPath) === null
            || typeof entry.completedAtMs !== 'number'
            || !Number.isFinite(entry.completedAtMs)
            || entry.completedAtMs < 0
        ) {
            continue;
        }
        entries.push({
            version: 1,
            outputPdfPath: entry.outputPdfPath,
            completedAtMs: entry.completedAtMs,
        });
    }
    return entries.slice(-COMPLETED_OUTPUT_JOURNAL_MAX_ENTRIES);
}

async function readCompletedOutputJournal(baseDir: string) {
    const journalPath = getScanCleanupCompletedOutputJournalPath(baseDir);
    let raw: string;
    try {
        raw = await readFile(journalPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [] as ICompletedOutputJournalEntry[];
        }
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        await unlink(journalPath).catch(() => undefined);
        return [];
    }
    const entries = parseCompletedOutputJournal(parsed);
    if (entries !== null) {
        return entries;
    }
    await unlink(journalPath).catch(() => undefined);
    return [];
}

async function writeCompletedOutputJournal(baseDir: string, entries: readonly ICompletedOutputJournalEntry[]) {
    const journalPath = getScanCleanupCompletedOutputJournalPath(baseDir);
    if (entries.length === 0) {
        await unlink(journalPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        });
        return;
    }
    await mkdir(dirname(journalPath), {
        recursive: true,
        mode: 0o700,
    });
    const temporaryPath = `${journalPath}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, `${JSON.stringify(entries)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
        });
        await atomicReplace(temporaryPath, journalPath, {markMutationCommitStarted: false});
    } finally {
        await unlink(temporaryPath).catch(() => undefined);
    }
}

function enqueueCompletedOutputJournalMutation<T>(mutation: () => Promise<T>) {
    const next = completedOutputJournalWrite.then(mutation);
    completedOutputJournalWrite = next.then(() => undefined, () => undefined);
    return next;
}

/** Records a terminal output before the renderer receives its terminal event. */
export function recordScanCleanupCompletedOutput(
    outputPdfPath: string,
    options: {
        baseDir?: string;
        completedAtMs?: number
    } = {},
) {
    const baseDir = options.baseDir ?? getScanCleanupOutputBaseDirs()[0]!;
    return enqueueCompletedOutputJournalMutation(async () => {
        const entries = await readCompletedOutputJournal(baseDir);
        const nextEntries = entries.filter(entry => entry.outputPdfPath !== outputPdfPath);
        nextEntries.push({
            version: 1,
            outputPdfPath,
            completedAtMs: options.completedAtMs ?? Date.now(),
        });
        await writeCompletedOutputJournal(baseDir, nextEntries.slice(-COMPLETED_OUTPUT_JOURNAL_MAX_ENTRIES));
    });
}

/** Returns completed outputs until the renderer confirms that it opened them. */
export async function getPendingScanCleanupCompletedOutputs(
    options: {baseDir?: string} = {},
): Promise<TDocumentRef[]> {
    await completedOutputJournalWrite;
    const baseDir = options.baseDir ?? getScanCleanupOutputBaseDirs()[0]!;
    const entries = await readCompletedOutputJournal(baseDir);
    const validEntries: ICompletedOutputJournalEntry[] = [];
    const paths: TDocumentRef[] = [];
    for (const entry of entries) {
        const outputPath = parseDocumentRef(entry.outputPdfPath);
        if (outputPath === null || !isScanCleanupGeneratedOutputPath(outputPath, [baseDir])) {
            continue;
        }
        const outputStat = await lstat(outputPath).catch(() => null);
        if (!outputStat?.isFile() || outputStat.isSymbolicLink()) {
            continue;
        }
        validEntries.push(entry);
        paths.push(outputPath);
    }
    if (validEntries.length !== entries.length) {
        await enqueueCompletedOutputJournalMutation(() => writeCompletedOutputJournal(baseDir, validEntries));
    }
    return paths;
}

export function acknowledgeScanCleanupCompletedOutputs(
    outputPaths: readonly string[],
    options: {baseDir?: string} = {},
) {
    const baseDir = options.baseDir ?? getScanCleanupOutputBaseDirs()[0]!;
    const acknowledged = new Set(outputPaths.map(path => String(path)));
    return enqueueCompletedOutputJournalMutation(async () => {
        const entries = await readCompletedOutputJournal(baseDir);
        await writeCompletedOutputJournal(baseDir, entries.filter(entry => !acknowledged.has(entry.outputPdfPath)));
    });
}

export function isScanCleanupGeneratedOutputPath(
    outputPath: string,
    baseDirs: readonly string[] = getScanCleanupOutputBaseDirs(),
) {
    return baseDirs.some(baseDir => isPathInsideOutputRoot(outputPath, baseDir));
}

function isPathInsideOutputRoot(outputPath: string, baseDir: string) {
    let relativePath: string;
    try {
        relativePath = relative(
            realpathSync(getScanCleanupOutputRoot(baseDir)),
            realpathSync(outputPath),
        );
    } catch {
        return false;
    }
    const segments = relativePath.split(sep);
    return relativePath.length > 0
        && relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
        && segments.length === 2
        && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(segments[0] ?? '')
        && extname(segments[1] ?? '').toLowerCase() === '.pdf';
}

function utf8Prefix(value: string, maxBytes: number) {
    let bytes = 0;
    let prefix = '';
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (bytes + characterBytes > maxBytes) {
            break;
        }
        prefix += character;
        bytes += characterBytes;
    }
    return prefix;
}

function humanOutputName(sourcePdfPath: string, partial: boolean) {
    const sourceName = basename(sourcePdfPath, extname(sourcePdfPath)).trim() || 'document';
    const suffix = ` — cleaned${partial ? ' selection' : ''}.pdf`;
    const fullName = `${sourceName}${suffix}`;
    if (Buffer.byteLength(fullName, 'utf8') <= SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES) {
        return fullName;
    }
    const sourceHash = createHash('sha256')
        .update(sourceName, 'utf8')
        .digest('hex')
        .slice(0, OUTPUT_NAME_HASH_HEX_LENGTH);
    const disambiguator = `…-${sourceHash}`;
    const prefixBytes = SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES
        - Buffer.byteLength(`${disambiguator}${suffix}`, 'utf8');
    const truncatedSourceName = utf8Prefix(sourceName, prefixBytes).trimEnd();
    return `${truncatedSourceName}${disambiguator}${suffix}`;
}

export async function createScanCleanupGeneratedOutputPath(
    sourcePdfPath: string,
    partial = false,
    baseDir = getScanCleanupOutputBaseDirs()[0]!,
) {
    const outputDirectory = join(getScanCleanupOutputRoot(baseDir), randomUUID());
    await mkdir(outputDirectory, {
        recursive: true,
        mode: 0o700,
    });
    return join(outputDirectory, humanOutputName(sourcePdfPath, partial));
}

/**
 * Retention is measured from last access, not from creation: a document the
 * user keeps opening must never expire underneath them. Opening an output
 * stamps its run directory, which is the same timestamp the sweep reads.
 */
export async function touchScanCleanupGeneratedOutput(
    outputPath: string,
    options: {
        baseDirs?: readonly string[];
        nowMs?: number;
    } = {},
) {
    if (!isScanCleanupGeneratedOutputPath(outputPath, options.baseDirs ?? getScanCleanupOutputBaseDirs())) {
        return false;
    }
    const accessedAtSeconds = (options.nowMs ?? Date.now()) / 1_000;
    try {
        await utimes(dirname(outputPath), accessedAtSeconds, accessedAtSeconds);
        return true;
    } catch {
        // Losing the stamp only shortens retention; it must never fail an open.
        return false;
    }
}

export async function pruneScanCleanupGeneratedOutputs(options: {
    baseDirs?: readonly string[];
    isOutputLive: (outputPath: string) => boolean;
    nowMs?: number;
}) {
    const baseDirs = options.baseDirs ?? getScanCleanupOutputBaseDirs();
    const nowMs = options.nowMs ?? Date.now();
    const pendingOutputs = new Set<string>(
        (await Promise.all(baseDirs.map(baseDir => getPendingScanCleanupCompletedOutputs({baseDir}))))
            .flat(),
    );
    const isOutputLive = (outputPath: string) => (
        pendingOutputs.has(outputPath) || options.isOutputLive(outputPath)
    );
    let removed = 0;
    for (const baseDir of baseDirs) {
        removed += await pruneOutputRoot(getScanCleanupOutputRoot(baseDir), isOutputLive, nowMs);
    }
    return removed;
}

async function pruneOutputRoot(
    outputRoot: string,
    isOutputLive: (outputPath: string) => boolean,
    nowMs: number,
) {
    const resolvedRoot = resolve(outputRoot);
    let entries;
    try {
        entries = await readdir(outputRoot, {withFileTypes: true});
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
        }
        throw error;
    }

    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directoryPath = join(outputRoot, entry.name);
        const resolvedDirectory = resolve(directoryPath);
        const relativeDirectory = relative(resolvedRoot, resolvedDirectory);
        if (
            relativeDirectory.length === 0
            || relativeDirectory === '..'
            || relativeDirectory.startsWith(`..${sep}`)
            || isAbsolute(relativeDirectory)
        ) {
            continue;
        }
        const files = await readdir(directoryPath, {withFileTypes: true}).catch(() => []);
        const outputPdfPaths = files
            .filter(file => file.isFile() && extname(file.name).toLowerCase() === '.pdf')
            .map(file => join(directoryPath, file.name));
        if (containsLiveOutput(outputPdfPaths, isOutputLive)) continue;
        const metadata = await stat(directoryPath).catch(() => null);
        if (!metadata || nowMs - metadata.mtimeMs < SCAN_CLEANUP_OUTPUT_MAX_AGE_MS) continue;
        // Liveness can change while directory metadata is being read. Check
        // the main-owned registry again at the last synchronous decision point
        // before rm is submitted, so an output opened during a prune survives.
        if (containsLiveOutput(outputPdfPaths, isOutputLive)) continue;
        await rm(directoryPath, {
            recursive: true,
            force: true,
        });
        removed += 1;
    }
    return removed;
}

function containsLiveOutput(
    outputPdfPaths: readonly string[],
    isOutputLive: (outputPath: string) => boolean,
) {
    for (const outputPdfPath of outputPdfPaths) {
        if (isOutputLive(outputPdfPath)) {
            return true;
        }
    }
    return false;
}
