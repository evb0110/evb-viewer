import {readFile} from 'node:fs/promises';
import * as v from 'valibot';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseEpochMs} from '@contracts/timestamps';
import {isErrnoException} from '@contracts/runtimeGuards';
import {quarantineCorruptFile} from '@electron/utils/quarantineCorruptFile';
import {createLogger} from '@electron/utils/createLogger';
import {getWorkingCopyManifestPath} from '@electron/file-access/workingCopyDirectory';

const log = createLogger('working-copy-manifest');

/** A save wrote its target but could not refresh the working copy from it. */
const documentRefSchema = v.pipe(v.string(), v.check(value => parseDocumentRef(value) !== null), v.transform(value => parseDocumentRef(value)!));
const revisionSchema = v.object({
    version: v.literal(1),
    documentRef: documentRefSchema,
    authority: v.literal('electron-working-copy'),
    token: v.pipe(v.string(), v.check(value => parseDocumentRevisionToken(value) !== null), v.transform(value => parseDocumentRevisionToken(value)!)),
    contentRevision: v.pipe(v.number(), v.check(value => Number.isSafeInteger(value)), v.minValue(1)),
    mintedAt: v.pipe(v.number(), v.check(value => parseEpochMs(value) !== null), v.minValue(1), v.transform(value => parseEpochMs(value)!)),
});
export type TWorkingCopyRevision = v.InferOutput<typeof revisionSchema>;
// Invalid optional sync metadata has historically been ignored while the required reason remains recoverable.
export const syncRequiredSchema = v.pipe(v.object({
    reason: v.pipe(v.string(), v.check(value => value.trim() !== '')),
    originalPath: v.optional(v.unknown()),
    ownerWebContentsId: v.optional(v.unknown()),
}), v.transform(({
    reason, originalPath, ownerWebContentsId,
}) => ({
    reason,
    ...(typeof originalPath === 'string' && originalPath.trim() !== '' ? {originalPath} : {}),
    ...(typeof ownerWebContentsId === 'number' && Number.isSafeInteger(ownerWebContentsId) && ownerWebContentsId >= 0
        ? {ownerWebContentsId}
        : {}),
})));
export const originalSaveSnapshotSchema = v.object({
    contentFingerprint: v.exactOptional(v.pipe(v.string(), v.regex(/^sha256-full-v1:[0-9a-f]{64}$/u))),
    ctimeNs: v.string(),
    deviceId: v.string(),
    inode: v.string(),
    linkCount: v.string(),
    mtimeNs: v.string(),
    sampleSha256: v.string(),
    size: v.string(),
});
export const originalSaveBaseSchema = v.object({
    path: v.string(),
    snapshot: originalSaveSnapshotSchema,
});

const workingCopyManifestSchema = v.object({
    version: v.literal(1),
    revision: revisionSchema,
    syncRequired: v.optional(syncRequiredSchema),
    originalSaveBase: v.optional(originalSaveBaseSchema),
});

export type IWorkingCopySyncRequired = v.InferOutput<typeof syncRequiredSchema>;
export type IWorkingCopyManifest = v.InferOutput<typeof workingCopyManifestSchema>;

export function parseRevision(value: unknown): TWorkingCopyRevision | null {
    const result = v.safeParse(revisionSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function parseManifest(value: unknown): IWorkingCopyManifest | null {
    const result = v.safeParse(workingCopyManifestSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export async function readPersistedWorkingCopyManifest(workingCopyPath: string): Promise<IWorkingCopyManifest | null> {
    const manifestPath = getWorkingCopyManifestPath(workingCopyPath);
    let text: string;
    try {
        text = await readFile(manifestPath, 'utf8');
    } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) {
            log.warn(`Failed to read working-copy manifest ${manifestPath}`);
        }
        throw error;
    }
    try {
        const manifest = parseManifest(JSON.parse(text));
        if (manifest) {
            return manifest;
        }
    } catch {
        // Invalid JSON follows the same quarantine path as an invalid schema.
    }
    const quarantinePath = await quarantineCorruptFile(manifestPath).catch(() => null);
    log.warn(`Quarantined corrupt working-copy manifest at ${quarantinePath ?? manifestPath}`);
    return null;
}

export function deserializeSnapshot(value: unknown) {
    const parsed = v.safeParse(originalSaveSnapshotSchema, value);
    if (!parsed.success) {
        return null;
    }
    const candidate = parsed.output;
    try {
        return {
            ...(candidate.contentFingerprint ? {contentFingerprint: candidate.contentFingerprint} : {}),
            ctimeNs: BigInt(candidate.ctimeNs),
            deviceId: BigInt(candidate.deviceId),
            inode: BigInt(candidate.inode),
            linkCount: BigInt(candidate.linkCount),
            mtimeNs: BigInt(candidate.mtimeNs),
            sampleSha256: candidate.sampleSha256,
            size: BigInt(candidate.size),
        };
    } catch {
        return null;
    }
}

