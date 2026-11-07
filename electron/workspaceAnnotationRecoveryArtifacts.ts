import {app} from 'electron';
import {
    mkdir, open, readFile, rm, stat,
} from 'node:fs/promises';
import {join} from 'node:path';
import {
    createHash, randomUUID,
} from 'node:crypto';
import * as v from 'valibot';
import {
    mapWorkspaceRecoveryRasters,
    workspaceAnnotationRecoveryRefSchema,
    type IWorkspaceCheckpoint,
    type IWorkspaceCheckpointAnnotationRecovery,
    type IWorkspaceRecoveryRaster,
} from '@contracts/workspaceCheckpoint';
import {writeJsonAtomic} from '@electron/utils/atomicReplace';
import {fsyncDirectory} from '@electron/utils/fsyncPath';

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const artifactSchema = v.object({
    version: v.picklist([
        1,
        2,
    ]),
    ref: workspaceAnnotationRecoveryRefSchema,
    payload: v.unknown(),
});
type IStoredArtifact = v.InferOutput<typeof artifactSchema>;
export interface IAnnotationRecoveryArtifact extends IStoredArtifact {rasters: Array<{
    index: number;
    image: IWorkspaceRecoveryRaster
}>;}

function directory() {
    return join(app.getPath('userData'), 'workspace-annotation-recovery');
}
function artifactPath(ref: IWorkspaceCheckpointAnnotationRecovery) {
    v.parse(workspaceAnnotationRecoveryRefSchema, ref);
    return join(directory(), `${ref.artifactId}.json`);
}
function assetDirectory(ref: IWorkspaceCheckpointAnnotationRecovery) {
    return `${artifactPath(ref)}.assets`;
}
function assertRasterBytes(image: IWorkspaceRecoveryRaster, bytes: Buffer) {
    if (bytes.length !== image.byteLength || createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
        throw new Error('Annotation recovery raster integrity mismatch');
    }
}

/** The artifact identity owns both its small JSON record and its immutable raster files. */
export async function removeAnnotationRecoveryArtifact(ref: IWorkspaceCheckpointAnnotationRecovery) {
    await rm(artifactPath(ref), {force: true});
    await rm(assetDirectory(ref), {
        force: true,
        recursive: true,
    });
}

export async function writeAnnotationRecoveryArtifact(artifact: IAnnotationRecoveryArtifact) {
    await mkdir(directory(), {recursive: true});
    try {
        if (artifact.rasters.length) {
            const assets = assetDirectory(artifact.ref);
            await mkdir(assets);
            for (const {
                index, image,
            } of artifact.rasters) {
                const bytes = Buffer.from(image.dataBase64, 'base64');
                assertRasterBytes(image, bytes);
                const handle = await open(join(assets, `${index}.bin`), 'wx');
                try {
                    await handle.writeFile(bytes);
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            }
            await fsyncDirectory(assets);
            await fsyncDirectory(directory());
        }
        await writeJsonAtomic(artifactPath(artifact.ref), {
            version: artifact.version,
            ref: artifact.ref,
            payload: artifact.payload,
        });
    } catch (error) {
        await removeAnnotationRecoveryArtifact(artifact.ref);
        throw error;
    }
}

export async function readAnnotationRecoveryArtifact(ref: IWorkspaceCheckpointAnnotationRecovery) {
    const path = artifactPath(ref);
    if ((await stat(path)).size > MAX_ARTIFACT_BYTES) throw new Error('Annotation recovery artifact is too large');
    const artifact = v.parse(artifactSchema, JSON.parse(await readFile(path, 'utf8')));
    if (artifact.payload === undefined || Object.entries(v.parse(workspaceAnnotationRecoveryRefSchema, ref))
        .some(([
            key,
            value,
        ]) => artifact.ref[key as keyof typeof artifact.ref] !== value)) {
        throw new Error(`Annotation recovery artifact metadata mismatch: ${ref.artifactId}`);
    }
    if (artifact.version === 1) return artifact.payload;
    const rasters: Array<{
        index: number;
        image: IWorkspaceRecoveryRaster
    }> = [];
    mapWorkspaceRecoveryRasters(artifact.payload, (image, index) => {
        if (image.dataBase64 !== '') throw new Error('External recovery raster contains inline data');
        rasters.push({
            index,
            image,
        });
        return image;
    });
    const hydrated = new Map<number, IWorkspaceRecoveryRaster>();
    for (const {
        index, image,
    } of rasters) {
        const rasterPath = join(assetDirectory(ref), `${index}.bin`);
        if ((await stat(rasterPath)).size !== image.byteLength) throw new Error('Annotation recovery raster size mismatch');
        const bytes = await readFile(rasterPath);
        assertRasterBytes(image, bytes);
        hydrated.set(index, {
            ...image,
            dataBase64: bytes.toString('base64'),
        });
    }
    return mapWorkspaceRecoveryRasters(artifact.payload, (_image, index) => hydrated.get(index)!);
}

export function getAnnotationRecoveryRefs(checkpoint: IWorkspaceCheckpoint | null) {
    return checkpoint?.tabs.flatMap(tab => tab.annotationRecovery ? [tab.annotationRecovery] : []) ?? [];
}

export function removeAnnotationRecoveryArtifacts(checkpoint: IWorkspaceCheckpoint | null) {
    return Promise.all(getAnnotationRecoveryRefs(checkpoint).map(removeAnnotationRecoveryArtifact));
}

export function admitAnnotationRecovery(checkpoint: IWorkspaceCheckpoint) {
    const artifacts: IAnnotationRecoveryArtifact[] = [];
    const admitted: IWorkspaceCheckpoint = {
        ...checkpoint,
        tabs: checkpoint.tabs.map(tab => {
            const capture = tab.annotationRecovery;
            if (!capture || capture.payload === undefined) return tab;
            const rasters: IAnnotationRecoveryArtifact['rasters'] = [];
            const payload = mapWorkspaceRecoveryRasters(capture.payload, (image, index) => {
                rasters.push({
                    index,
                    image,
                });
                return {
                    ...image,
                    dataBase64: '',
                };
            });
            const ref: IWorkspaceCheckpointAnnotationRecovery = {
                ...v.parse(workspaceAnnotationRecoveryRefSchema, capture),
                artifactId: randomUUID().replaceAll('-', ''),
            };
            const version = rasters.length ? 2 : 1;
            if (Buffer.byteLength(JSON.stringify({
                version,
                ref,
                payload,
            })) + 1 > MAX_ARTIFACT_BYTES) {
                throw new Error('Canonical annotation recovery exceeds the checkpoint artifact budget');
            }
            artifacts.push({
                version,
                ref,
                payload,
                rasters,
            });
            return {
                ...tab,
                annotationRecovery: ref,
            };
        }),
    };
    return {
        checkpoint: admitted,
        artifacts,
    };
}
