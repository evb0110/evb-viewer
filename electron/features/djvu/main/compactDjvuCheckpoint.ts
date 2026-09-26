import { getErrorMessage } from '@electron/utils/error';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import type { TDjvuCompactFidelityPreset } from '@contracts/djvuConversionPolicy';
import {
    isAbsolute,
    relative,
    resolve,
} from 'node:path';
import {
    type IDjvuSourceIdentity,
    openDjvuArtifactJob,
    type IDjvuArtifactJob,
} from '@electron/features/djvu/main/djvuArtifactManifest';
import * as v from 'valibot';

const compactPageSpecSchema = v.pipe(v.object({
    pageNumber: v.pipe(v.number(), v.check(value => Number.isSafeInteger(value)), v.minValue(1)),
    manifestLine: v.pipe(v.string(), v.minLength(1)),
    kind: v.picklist([
        'bitonal',
        'layered',
        'layered-color',
        'photo',
    ]),
    reason: v.string(),
    effectivePpi: v.pipe(v.number(), v.finite(), v.minValue(Number.MIN_VALUE)),
    jpegQuality: v.optional(v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(100))),
}), v.transform(value => ({
    pageNumber: value.pageNumber,
    manifestLine: value.manifestLine,
    kind: value.kind,
    reason: value.reason,
    effectivePpi: value.effectivePpi,
    ...(value.jpegQuality === undefined ? {} : {jpegQuality: value.jpegQuality}),
})));
export type ICheckpointedCompactPageSpec = v.InferOutput<typeof compactPageSpecSchema>;
const compactArtifactSchema = v.object({
    path: v.string(),
    size: v.pipe(v.number(), v.check(value => Number.isSafeInteger(value)), v.minValue(1)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
});
const compactCheckpointSchema = v.object({
    version: v.literal(2),
    spec: compactPageSpecSchema,
    artifacts: v.pipe(v.array(compactArtifactSchema), v.minLength(1)),
});
type ICheckpointedCompactPageEnvelope = v.InferOutput<typeof compactCheckpointSchema>;

export function openCompactDjvuCheckpointJob(
    sourcePath: string,
    pages: number[],
    preset?: TDjvuCompactFidelityPreset,
    signal?: AbortSignal,
    sourceIdentity?: IDjvuSourceIdentity,
) {
    return openDjvuArtifactJob(sourcePath, pages.map(page => ({
        startPage: page,
        endPage: page,
    })), {
        artifactKind: 'compact-page',
        qualityPreset: preset ?? 'balanced',
        outputExtension: '.json',
        ...(signal ? {signal} : {}),
        ...(sourceIdentity ? {sourceIdentity} : {}),
    });
}

function getManifestArtifactPaths(manifestLine: string) {
    const fields = manifestLine.split('\t');
    switch (fields[0]) {
        case 'image':
        case 'mask':
            return fields.length === 4 && fields[3] ? [fields[3]] : null;
        case 'image-jpeg':
            return fields.length === 5 && fields[4] ? [fields[4]] : null;
        case 'photo-jpeg':
            return fields.length === 6 && fields[5] ? [fields[5]] : null;
        case 'layered':
            return fields.length === 5 && fields[3] && fields[4] ? [
                fields[3],
                fields[4],
            ] : null;
        case 'layered-jpeg':
            return fields.length === 6 && fields[4] && fields[5] ? [
                fields[4],
                fields[5],
            ] : null;
        case 'layered-color-jpeg':
            return fields.length === 9 && fields[4] && fields[5] ? [
                fields[4],
                fields[5],
            ] : null;
        case undefined:
            return null;
        default:
            return null;
    }
}

function isPathInside(path: string, parent: string) {
    const pathRelativeToParent = relative(resolve(parent), resolve(path));
    return pathRelativeToParent.length > 0
        && !pathRelativeToParent.startsWith('..')
        && !isAbsolute(pathRelativeToParent);
}

async function sha256File(path: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

async function describeArtifacts(spec: ICheckpointedCompactPageSpec, artifactDirectory: string) {
    const paths = getManifestArtifactPaths(spec.manifestLine);
    if (!paths) throw new Error(`Compact DjVu page ${spec.pageNumber} has an invalid artifact manifest`);
    return Promise.all(paths.map(async path => {
        if (!isPathInside(path, artifactDirectory)) {
            throw new Error(`Compact DjVu artifact escapes its job directory: ${path}`);
        }
        const artifact = await stat(path);
        if (!artifact.isFile() || artifact.size <= 0) {
            throw new Error(`Compact DjVu artifact is empty or not a regular file: ${path}`);
        }
        return {
            path,
            size: artifact.size,
            sha256: await sha256File(path),
        };
    }));
}

async function validateEnvelope(
    envelope: ICheckpointedCompactPageEnvelope,
    expectedPageNumber: number,
    artifactDirectory: string,
) {
    if (envelope.spec.pageNumber !== expectedPageNumber) {
        return false;
    }
    const expectedPaths = getManifestArtifactPaths(envelope.spec.manifestLine);
    if (!expectedPaths || expectedPaths.length !== envelope.artifacts.length) {
        return false;
    }
    for (const [
        index,
        artifact,
    ] of envelope.artifacts.entries()) {
        if (artifact.path !== expectedPaths[index]) {
            return false;
        }
        if (!isPathInside(artifact.path, artifactDirectory)) {
            return false;
        }
        const file = await stat(artifact.path).catch(() => null);
        if (!file?.isFile() || file.size !== artifact.size || file.size <= 0) {
            return false;
        }
        if (await sha256File(artifact.path).catch(() => null) !== artifact.sha256) {
            return false;
        }
    }
    return true;
}

export async function loadOrBuildCompactDjvuPage(
    job: IDjvuArtifactJob,
    index: number,
    build: () => Promise<ICheckpointedCompactPageSpec>,
) {
    const checkpoint = job.manifest.ranges[index];
    if (!checkpoint) throw new Error(`Missing compact DjVu checkpoint ${index}`);
    const artifactDirectory = resolve(job.directory, 'compact-pages');
    if (checkpoint.status === 'verified') {
        const saved = await readFile(checkpoint.outputPath, 'utf8')
            .then(value => {
                const parsed = v.safeParse(compactCheckpointSchema, JSON.parse(value), {abortEarly: true});
                return parsed.success ? parsed.output : null;
            })
            .catch(() => null);
        if (saved && await validateEnvelope(saved, checkpoint.startPage, artifactDirectory)) {
            await job.updateRange(index, {status: 'verified'}, {additionalArtifacts: saved.artifacts});
            return saved.spec;
        }
    }
    await job.updateRange(index, {
        status: 'running',
        error: undefined,
    });
    try {
        const spec = await build();
        if (spec.pageNumber !== checkpoint.startPage || checkpoint.startPage !== checkpoint.endPage) {
            throw new Error(`Compact DjVu checkpoint ${index} returned the wrong page`);
        }
        const envelope: ICheckpointedCompactPageEnvelope = {
            version: 2,
            spec,
            artifacts: await describeArtifacts(spec, artifactDirectory),
        };
        await writeFile(checkpoint.outputPath, JSON.stringify(envelope), 'utf8');
        await job.updateRange(index, {
            status: 'verified',
            error: undefined,
        }, {additionalArtifacts: envelope.artifacts});
        return spec;
    } catch (error) {
        await job.updateRange(index, {
            status: 'failed',
            error: getErrorMessage(error),
        });
        throw error;
    }
}
