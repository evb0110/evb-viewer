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
import { isRecord } from '@contracts/runtimeGuards';

export interface ICheckpointedCompactPageSpec {
    pageNumber: number;
    manifestLine: string;
    kind: 'bitonal' | 'layered' | 'layered-color' | 'photo';
    reason: string;
    effectivePpi: number;
    jpegQuality?: number;
}

interface ICheckpointedCompactArtifact {
    path: string;
    size: number;
    sha256: string;
}

interface ICheckpointedCompactPageEnvelope {
    version: 2;
    spec: ICheckpointedCompactPageSpec;
    artifacts: ICheckpointedCompactArtifact[];
}

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

function decodeSpec(value: unknown): ICheckpointedCompactPageSpec | null {
    if (!isRecord(value)
        || typeof value.pageNumber !== 'number'
        || !Number.isSafeInteger(value.pageNumber)
        || value.pageNumber < 1
        || typeof value.manifestLine !== 'string'
        || value.manifestLine.length === 0
        || !isCompactPageKind(value.kind)
        || typeof value.reason !== 'string'
        || typeof value.effectivePpi !== 'number'
        || !Number.isFinite(value.effectivePpi)
        || value.effectivePpi <= 0
        || value.jpegQuality !== undefined && (
            typeof value.jpegQuality !== 'number'
            || !Number.isFinite(value.jpegQuality)
            || value.jpegQuality < 1
            || value.jpegQuality > 100
        )) {
        return null;
    }
    return {
        pageNumber: value.pageNumber,
        manifestLine: value.manifestLine,
        kind: value.kind,
        reason: value.reason,
        effectivePpi: value.effectivePpi,
        ...(value.jpegQuality === undefined ? {} : {jpegQuality: value.jpegQuality}),
    };
}

function isCompactPageKind(value: unknown): value is ICheckpointedCompactPageSpec['kind'] {
    return value === 'bitonal'
        || value === 'layered'
        || value === 'layered-color'
        || value === 'photo';
}

function decodeArtifact(value: unknown): ICheckpointedCompactArtifact | null {
    if (!isRecord(value)
        || typeof value.path !== 'string'
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size <= 0
        || typeof value.sha256 !== 'string'
        || !/^[a-f\d]{64}$/u.test(value.sha256)) {
        return null;
    }
    return {
        path: value.path,
        size: value.size,
        sha256: value.sha256,
    };
}

function decodeEnvelope(value: unknown): ICheckpointedCompactPageEnvelope | null {
    if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.artifacts)) {
        return null;
    }
    const spec = decodeSpec(value.spec);
    const artifacts = value.artifacts.map(decodeArtifact);
    if (!spec || artifacts.length === 0 || artifacts.some(artifact => artifact === null)) {
        return null;
    }
    return {
        version: 2,
        spec,
        artifacts: artifacts.filter((artifact): artifact is ICheckpointedCompactArtifact => artifact !== null),
    };
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
            .then(value => decodeEnvelope(JSON.parse(value)))
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
