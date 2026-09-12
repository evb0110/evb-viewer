import { getCliErrorMessage } from '../lib/cli-error.mjs';
import { createHash } from 'node:crypto';
import {
    open,
    readdir,
    readFile,
    stat,
} from 'node:fs/promises';
import {
    basename,
    join,
} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectsCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
} from '@aws-sdk/client-s3';
import {isSupplementalReleaseAsset} from './policy.mjs';
import {hashFile} from './release-hash.mjs';
import {
    DRILL_TAG_PATTERN,
    RELEASE_TAG_PATTERN,
} from './releaseTag.mjs';

const RELEASE_PREFIX = 'evb-viewer/releases/';
const CHANNEL_KEY = 'evb-viewer/channels/stable.json';
const DRILL_PREFIX = 'evb-viewer/drill/';
const MIRROR_PREFIX_PATTERN = /^evb-viewer\/[a-z0-9./-]+\/$/u;
const MIRROR_CHANNEL_KEY_PATTERN = /^evb-viewer\/[a-z0-9./-]+$/u;
const RETAINED_RELEASE_COUNT = 4;

// Every upload request now carries at most one part, so a single request
// never has more than a few seconds of legitimate work; the total bound only
// has to outlast a slow part, not a whole installer.
export const MIRROR_TRANSFER_TIMEOUTS = Object.freeze({
    connectionTimeout: 10_000,
    socketTimeout: 60_000,
    requestTimeout: 2 * 60_000,
});
// Yandex Object Storage rejects multipart parts below 5 MiB except the last.
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MULTIPART_CONCURRENCY = 4;
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const UPLOAD_ATTEMPTS = 3;
const TRANSIENT_TRANSFER_ERROR_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'EHOSTUNREACH',
]);

/** @typedef {Pick<import('@aws-sdk/client-s3').S3Client, 'send'>} TMirrorClient */
/** @typedef {{name: string, size: number, sha256: string}} IMirrorAsset */
/** @typedef {{schemaVersion: number, release: {tag: string}, assets: IMirrorAsset[]}} IMirrorManifest */
/** @typedef {{channelKey: string, releasePrefix: string}} IMirrorPaths */
/** @typedef {{sha256: string, size: number}} IObjectDigest */
/** @typedef {{body: string, etag?: string | undefined, sha256: string, size: number, tag: string}} IStableChannel */
/** @typedef {{schemaVersion: 1, releaseTag: string, artifactIdentity: string, previousChannel: IStableChannel | null, activatedChannel: IStableChannel | null, promotion: 'pending' | 'public'}} IReleaseTransaction */
/** @typedef {{Key?: string | undefined}} IMirrorObject */
/** @typedef {{artifactDirectory?: string | undefined, drill?: boolean | undefined, releaseTag?: string | undefined, publishChannel?: boolean | undefined, durableTransaction?: boolean | undefined, environment?: NodeJS.ProcessEnv | undefined, client?: TMirrorClient | undefined, uploadRetryDelayMs?: number | undefined, partBytes?: number | undefined}} IPublishMirrorOptions */
/** @typedef {{drill?: boolean | undefined, files?: string[] | undefined, releaseTag?: string | undefined, environment?: NodeJS.ProcessEnv | undefined, client?: TMirrorClient | undefined, uploadRetryDelayMs?: number | undefined, partBytes?: number | undefined}} IPublishSupplementalMirrorOptions */
/** @typedef {{environment?: NodeJS.ProcessEnv | undefined, prefix?: string | undefined, client?: TMirrorClient | undefined}} ICleanupMirrorOptions */
/** @typedef {{[Symbol.asyncIterator]?: () => AsyncIterator<unknown>, transformToByteArray?: () => Promise<Uint8Array>, transformToString?: () => Promise<string>}} IMirrorBody */
/** @typedef {{[Symbol.asyncIterator]: () => AsyncIterator<unknown>}} IAsyncMirrorBody */
/** @typedef {{name?: unknown, code?: unknown, $metadata?: {httpStatusCode?: unknown}, stableChannelMutationAttempted?: unknown}} IMirrorError */

/** @param {unknown} error @returns {error is IMirrorError} */
function isMirrorError(error) {
    return typeof error === 'object' && error !== null;
}

/** @param {IPublishMirrorOptions} options @returns {Promise<{assets: IMirrorAsset[], manifest: string, prunedTags: string[]}>} */
export async function publishReleaseMirror({
    artifactDirectory,
    drill = false,
    releaseTag,
    publishChannel = true,
    durableTransaction = false,
    environment = process.env,
    client: providedClient,
    uploadRetryDelayMs = 5_000,
    partBytes = MULTIPART_PART_BYTES,
}) {
    if (!artifactDirectory || !releaseTag) {
        throw new Error('Usage: publish-release-mirror.mjs <artifact-directory> <release-tag>');
    }
    const mirrorPaths = resolveMirrorPaths(environment, {drill});
    const releaseTagPattern = drill ? DRILL_TAG_PATTERN : RELEASE_TAG_PATTERN;
    if (!releaseTagPattern.test(releaseTag)) {
        throw new Error(`Invalid release tag: ${releaseTag}`);
    }

    const {
        bucket,
        client,
    } = createMirrorClient(environment, providedClient);

    const releaseVersion = releaseTag.slice(1);
    const artifactNames = (await readdir(artifactDirectory))
        .filter(name => !name.startsWith('.'))
        // Supplemental channels attach after promotion and stay outside the
        // immutable core mirror. Filtering here keeps same-tag repair runs
        // byte-identical after those assets already exist on GitHub.
        .filter(name => !isSupplementalReleaseAsset(name, releaseVersion))
        .sort((left, right) => left.localeCompare(right));

    if (artifactNames.length === 0) {
        throw new Error(`No release artifacts found in ${artifactDirectory}`);
    }

    const assets = [];
    for (const name of artifactNames) {
        const filePath = join(artifactDirectory, name);
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
            continue;
        }

        assets.push(await mirrorImmutableAsset(client, bucket, `${mirrorPaths.releasePrefix}${releaseTag}/${name}`, {
            filePath,
            name,
            size: fileStat.size,
        }, {
            partBytes,
            retryDelayMs: uploadRetryDelayMs,
        }));
    }

    if (assets.length === 0) {
        throw new Error(`No regular release artifact files found in ${artifactDirectory}`);
    }

    const manifest = JSON.stringify({
        schemaVersion: 1,
        release: { tag: releaseTag },
        assets,
    }, null, 2);
    await putImmutableJson(
        client,
        bucket,
        `${mirrorPaths.releasePrefix}${releaseTag}/manifest.json`,
        manifest,
        IMMUTABLE_CACHE_CONTROL,
        uploadRetryDelayMs,
    );

    let prunedTags = /** @type {string[]} */ ([]);
    if (publishChannel) {
        // Publish the mutable channel pointer last, after every immutable object
        // has been uploaded and verified. Clients cannot discover a partial release.
        const previousChannel = await readStableChannel(
            client,
            bucket,
            mirrorPaths.channelKey,
            releaseTagPattern,
        );
        const transaction = durableTransaction
            ? await prepareReleaseTransaction(
                client,
                bucket,
                mirrorPaths.releasePrefix,
                releaseTag,
                manifest,
                previousChannel,
                uploadRetryDelayMs,
            )
            : null;
        let stableChannelMutationAttempted = false;
        try {
            stableChannelMutationAttempted = await publishStableChannel(
                client,
                bucket,
                manifest,
                releaseTag,
                environment,
                mirrorPaths.channelKey,
                releaseTagPattern,
                uploadRetryDelayMs,
            );
            if (transaction) {
                await updateReleaseTransaction(
                    client,
                    bucket,
                    transaction,
                    {
                        body: manifest,
                        etag: undefined,
                        sha256: createHash('sha256').update(manifest).digest('hex'),
                        size: Buffer.byteLength(manifest),
                        tag: releaseTag,
                    },
                );
            }
            prunedTags = await pruneOldReleases(
                client,
                bucket,
                releaseTag,
                mirrorPaths.releasePrefix,
                releaseTagPattern,
            );
        } catch (error) {
            if (previousChannel && (
                stableChannelMutationAttempted
                || (typeof error === 'object'
                    && error !== null
                    && 'stableChannelMutationAttempted' in error
                    && error.stableChannelMutationAttempted === true)
            )) {
                try {
                    await restoreStableChannel(
                        client,
                        bucket,
                        previousChannel,
                        mirrorPaths.channelKey,
                        releaseTagPattern,
                        uploadRetryDelayMs,
                    );
                } catch (rollbackError) {
                    throw new Error(
                        `Mirror publication failed and stable-channel rollback failed: ${getCliErrorMessage(rollbackError)}`,
                        {cause: error},
                    );
                }
                console.error(`Mirror publication failed; stable channel rolled back to ${previousChannel.tag}.`);
            }
            throw error;
        }
        console.log(`Mirror published ${releaseTag}; retained ${RETAINED_RELEASE_COUNT} releases${
            prunedTags.length ? ` and pruned ${prunedTags.join(', ')}` : ''
        }`);
    } else {
        console.log(`Mirror staged ${releaseTag}; stable channel remains unchanged.`);
    }
    return {
        assets,
        manifest,
        prunedTags,
    };
}

// Supplemental installers are built and attached after promotion, so they can
// never join the immutable manifest or the channel body a repair run has to
// reproduce byte for byte. They are mirrored as ordinary objects under the
// release prefix instead, and a client learns they are there by asking for
// them: a missing object answers 404 and costs the caller nothing.
/** @param {IPublishSupplementalMirrorOptions} options @returns {Promise<{assets: IMirrorAsset[], skipped: boolean}>} */
export async function publishSupplementalMirrorAssets({
    drill = false,
    files,
    releaseTag,
    environment = process.env,
    client: providedClient,
    uploadRetryDelayMs = 5_000,
    partBytes = MULTIPART_PART_BYTES,
}) {
    if (!releaseTag || !files || files.length === 0) {
        throw new Error('Usage: publish-release-mirror.mjs supplemental <release-tag> <file...>');
    }
    const mirrorPaths = resolveMirrorPaths(environment, {drill});
    const releaseTagPattern = drill ? DRILL_TAG_PATTERN : RELEASE_TAG_PATTERN;
    if (!releaseTagPattern.test(releaseTag)) {
        throw new Error(`Invalid release tag: ${releaseTag}`);
    }

    const releaseVersion = releaseTag.slice(1);
    for (const filePath of files) {
        const name = basename(filePath);
        if (!isSupplementalReleaseAsset(name, releaseVersion)) {
            throw new Error(`Refusing to mirror ${name} outside the immutable core manifest of ${releaseTag}`);
        }
    }

    const {
        bucket,
        client,
    } = createMirrorClient(environment, providedClient);
    const tagPrefix = `${mirrorPaths.releasePrefix}${releaseTag}/`;

    // The mirror keeps only the retained window. Without the core manifest the
    // tag was never mirrored or has already been pruned, and a lone
    // supplemental object would be unreachable weight in the bucket.
    if (!await objectExists(client, bucket, `${tagPrefix}manifest.json`)) {
        console.log(`No core mirror manifest for ${releaseTag}; leaving its supplemental assets on GitHub only.`);
        return {
            assets: [],
            skipped: true,
        };
    }

    const assets = [];
    for (const filePath of files) {
        const name = basename(filePath);
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
            throw new Error(`Supplemental mirror asset is not a file: ${filePath}`);
        }

        assets.push(await mirrorImmutableAsset(client, bucket, `${tagPrefix}${name}`, {
            filePath,
            name,
            size: fileStat.size,
        }, {
            partBytes,
            retryDelayMs: uploadRetryDelayMs,
        }));
    }

    console.log(`Mirrored ${assets.length} supplemental asset${assets.length === 1 ? '' : 's'} for ${releaseTag}`);
    return {
        assets,
        skipped: false,
    };
}

/** @param {NodeJS.ProcessEnv} environment @param {string} name @returns {string} */
export function requireEnvironment(environment, name) {
    const value = environment[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/** @param {NodeJS.ProcessEnv} [environment] @param {{drill?: boolean}} [options] @returns {IMirrorPaths} */
export function resolveMirrorPaths(environment = process.env, {drill = false} = {}) {
    const releasePrefix = environment.MIRROR_RELEASE_PREFIX?.trim() || RELEASE_PREFIX;
    const channelKey = environment.MIRROR_CHANNEL_KEY?.trim() || CHANNEL_KEY;

    if (!MIRROR_PREFIX_PATTERN.test(releasePrefix)) {
        throw new Error(`Invalid mirror release prefix: ${releasePrefix}`);
    }
    if (!MIRROR_CHANNEL_KEY_PATTERN.test(channelKey)) {
        throw new Error(`Invalid mirror channel key: ${channelKey}`);
    }
    if (channelKey.split('/')[0] !== releasePrefix.split('/')[0]) {
        throw new Error('Mirror channel key must use the same top-level folder as the release prefix');
    }

    if (drill) {
        if (!releasePrefix.startsWith(DRILL_PREFIX)) {
            throw new Error('Drill mirror publication requires an evb-viewer/drill/ release prefix');
        }
        if (!channelKey.startsWith(DRILL_PREFIX)) {
            throw new Error('Drill mirror publication requires an evb-viewer/drill/ channel key');
        }
    } else if (releasePrefix !== RELEASE_PREFIX || channelKey !== CHANNEL_KEY) {
        throw new Error('Production mirror publication requires the production release prefix and channel key');
    }

    return {
        channelKey,
        releasePrefix,
    };
}

/** @param {ICleanupMirrorOptions} options @returns {Promise<{deletedKeys: string[]}>} */
export async function cleanupMirrorPrefix({
    environment = process.env,
    prefix,
    client: providedClient,
}) {
    if (!prefix) {
        throw new Error('A mirror cleanup prefix is required');
    }
    const cleanupPrefix = validateDrillCleanupPrefix(prefix);
    const {
        bucket,
        client,
    } = createMirrorClient(environment, providedClient);
    const objects = await listAllReleaseObjects(client, bucket, cleanupPrefix);
    const keys = objects.flatMap(object => (
        typeof object.Key === 'string' && object.Key.startsWith(cleanupPrefix)
            ? [object.Key]
            : []
    ));

    await deleteMirrorObjects(client, bucket, keys, 'Mirror cleanup');

    console.log(`Deleted ${keys.length} drill mirror objects under ${cleanupPrefix}`);
    return {deletedKeys: keys};
}

export {hashFile};

/** @param {NodeJS.ProcessEnv} environment @param {TMirrorClient | undefined} [providedClient] @returns {{bucket: string, client: TMirrorClient}} */
export function createMirrorClient(environment, providedClient) {
    const endpoint = requireEnvironment(environment, 'MIRROR_S3_ENDPOINT');
    const bucket = requireEnvironment(environment, 'MIRROR_S3_BUCKET');
    return {
        bucket,
        client: providedClient ?? new S3Client({
            endpoint,
            region: environment.MIRROR_S3_REGION || 'ru-central1',
            // Yandex implements the S3 API but not every optional AWS checksum mode.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
            // A single installer upload from a GitHub runner has stalled
            // silently for the whole job. Without these limits nothing aborts
            // it before GitHub's six-hour job cap, and the global release
            // concurrency group stays blocked for that long.
            requestHandler: {
                ...MIRROR_TRANSFER_TIMEOUTS,
                throwOnRequestTimeout: true,
            },
            credentials: {
                accessKeyId: requireEnvironment(environment, 'MIRROR_S3_ACCESS_KEY_ID'),
                secretAccessKey: requireEnvironment(environment, 'MIRROR_S3_SECRET_KEY'),
            },
        }),
    };
}

/** @param {string} prefix @returns {string} */
function validateDrillCleanupPrefix(prefix) {
    if (typeof prefix !== 'string' || !prefix.startsWith(DRILL_PREFIX) || !MIRROR_PREFIX_PATTERN.test(prefix)) {
        throw new Error(`Refusing to clean a non-drill mirror prefix: ${prefix ?? ''}`);
    }
    return prefix;
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {number} expectedSize @param {string} expectedSha256 @param {number} retryDelayMs @returns {Promise<boolean>} */
async function objectMatches(client, bucket, key, expectedSize, expectedSha256, retryDelayMs) {
    const actual = await retryTransient(async () => {
        const result = await client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        return hashObjectBody(result.Body);
    }, {
        label: `Verification read of ${key}`,
        retryDelayMs,
        verb: 're-reading it',
    });
    return actual.size === expectedSize && actual.sha256 === expectedSha256;
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {number} expectedSize @param {string} expectedSha256 @param {number} retryDelayMs @returns {Promise<void>} */
async function verifyUpload(client, bucket, key, expectedSize, expectedSha256, retryDelayMs) {
    if (!await objectMatches(client, bucket, key, expectedSize, expectedSha256, retryDelayMs)) {
        throw new Error(`Mirror verification failed for ${key}`);
    }
}

/** @param {unknown} body @returns {Promise<IObjectDigest>} */
async function hashObjectBody(body) {
    if (!body) {
        throw new Error('Mirror object response has no body');
    }
    const hash = createHash('sha256');
    let size = 0;
    const objectBody = typeof body === 'object' && body !== null
        ? /** @type {IMirrorBody} */ (body)
        : null;
    if (objectBody && typeof objectBody[Symbol.asyncIterator] === 'function') {
        for await (const chunk of /** @type {IAsyncMirrorBody} */ (objectBody)) {
            const bytes = Buffer.isBuffer(chunk) || typeof chunk === 'string'
                ? Buffer.from(chunk)
                : Buffer.from(/** @type {Uint8Array} */ (chunk));
            hash.update(bytes);
            size += bytes.byteLength;
        }
    } else if (objectBody && typeof objectBody.transformToByteArray === 'function') {
        const bytes = Buffer.from(await objectBody.transformToByteArray());
        hash.update(bytes);
        size = bytes.byteLength;
    } else if (typeof body === 'string' || Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
        const bytes = typeof body === 'string' || Buffer.isBuffer(body)
            ? Buffer.from(body)
            : Buffer.from(/** @type {Uint8Array} */ (body));
        hash.update(bytes);
        size = bytes.byteLength;
    } else {
        throw new Error('Mirror object response body cannot be read');
    }
    return {
        sha256: hash.digest('hex'),
        size,
    };
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @returns {Promise<boolean>} */
async function objectExists(client, bucket, key) {
    try {
        const result = await client.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        return result.$metadata?.httpStatusCode !== 404 && result.ContentLength !== undefined;
    } catch (error) {
        if (isMirrorError(error)
            && (error.$metadata?.httpStatusCode === 404 || error.name === 'NotFound')) {
            return false;
        }
        throw error;
    }
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {number} expectedSize @param {string} expectedSha256 @param {number} retryDelayMs @returns {Promise<'match' | 'mismatch' | 'missing'>} */
async function immutableUploadState(client, bucket, key, expectedSize, expectedSha256, retryDelayMs) {
    if (!await objectExists(client, bucket, key)) {
        return 'missing';
    }
    return await objectMatches(client, bucket, key, expectedSize, expectedSha256, retryDelayMs)
        ? 'match'
        : 'mismatch';
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {{filePath: string, name: string, size: number}} file @param {{partBytes: number, retryDelayMs: number}} upload @returns {Promise<IMirrorAsset>} */
async function mirrorImmutableAsset(client, bucket, key, {
    filePath,
    name,
    size,
}, upload) {
    const sha256 = await hashFile(filePath);
    const existingState = await immutableUploadState(client, bucket, key, size, sha256, upload.retryDelayMs);
    if (existingState === 'match') {
        console.log(`Already verified ${name} (${size} bytes)`);
    } else if (existingState === 'mismatch') {
        throw new Error(`Immutable mirror object mismatch for ${key}`);
    } else {
        console.log(`Uploading ${name} (${size} bytes)`);
        await putImmutableFile(client, bucket, key, {
            filePath,
            name,
            sha256,
            size,
        }, upload);
    }
    return {
        name,
        size,
        sha256,
    };
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {() => Promise<unknown>} upload @param {number} expectedSize @param {string} expectedSha256 @param {number} retryDelayMs @returns {Promise<void>} */
async function putImmutableObject(client, bucket, key, upload, expectedSize, expectedSha256, retryDelayMs) {
    try {
        await upload();
    } catch (error) {
        if (!isConditionalWriteConflict(error)) {
            throw error;
        }
        if (await objectMatches(client, bucket, key, expectedSize, expectedSha256, retryDelayMs)) {
            return;
        }
        throw new Error(`Immutable mirror object mismatch for ${key}`, {cause: error});
    }
    await verifyUpload(client, bucket, key, expectedSize, expectedSha256, retryDelayMs);
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {{filePath: string, name: string, sha256: string, size: number}} file @param {{partBytes: number, retryDelayMs: number}} upload @returns {Promise<void>} */
async function putImmutableFile(client, bucket, key, {
    filePath,
    name,
    sha256,
    size,
}, {
    partBytes,
    retryDelayMs,
}) {
    const partCount = Math.ceil(size / partBytes);
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
        const startedAt = Date.now();
        try {
            await putImmutableObject(client, bucket, key, () => (partCount > 1
                ? uploadMultipart(client, bucket, key, {
                    filePath,
                    name,
                    partBytes,
                    partCount,
                    retryDelayMs,
                    sha256,
                    size,
                })
                : uploadWhole(client, bucket, key, {
                    filePath,
                    name,
                    sha256,
                    size,
                })), size, sha256, retryDelayMs);
            console.log(`Uploaded ${name} in ${elapsedSeconds(startedAt)}s${
                partCount > 1 ? ` (${partCount} parts)` : ''
            }`);
            return;
        } catch (error) {
            if (attempt === UPLOAD_ATTEMPTS || !isTransientTransferError(error)) {
                throw error;
            }
            const reason = getCliErrorMessage(error);
            console.warn(
                `Upload of ${name} failed after ${elapsedSeconds(startedAt)}s (${reason}); `
                + `retrying (${attempt + 1}/${UPLOAD_ATTEMPTS}).`,
            );
            await delay(retryDelayMs * attempt);
        }
    }
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {{filePath: string, name: string, sha256: string, size: number}} parameters @returns {Promise<void>} */
async function uploadWhole(client, bucket, key, {
    filePath,
    name,
    sha256,
    size,
}) {
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: await readFile(filePath),
        ContentLength: size,
        ContentType: contentTypeFor(name),
        CacheControl: IMMUTABLE_CACHE_CONTROL,
        Metadata: { sha256 },
        IfNoneMatch: '*',
    }));
}

// One HTTP request per part keeps a stalled connection from costing more
// than one part's timeout, and the conditional completion keeps the object
// immutable exactly like the single-request path.
/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {{filePath: string, name: string, partBytes: number, partCount: number, retryDelayMs: number, sha256: string, size: number}} parameters @returns {Promise<void>} */
async function uploadMultipart(client, bucket, key, {
    filePath,
    name,
    partBytes,
    partCount,
    retryDelayMs,
    sha256,
    size,
}) {
    const {UploadId: uploadId} = await client.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentTypeFor(name),
        CacheControl: IMMUTABLE_CACHE_CONTROL,
        Metadata: { sha256 },
    }));
    if (!uploadId) {
        throw new Error(`Mirror returned no multipart upload id for ${key}`);
    }
    const file = await open(filePath, 'r');
    try {
        const parts = await uploadParts(client, bucket, key, uploadId, {
            file,
            name,
            partBytes,
            partCount,
            retryDelayMs,
            size,
        });
        await retryTransient(() => client.send(new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {Parts: parts},
            IfNoneMatch: '*',
        })), {
            label: `Completion of ${name}`,
            retryDelayMs,
            verb: 'repeating it',
        });
    } catch (error) {
        await abortMultipartUpload(client, bucket, key, uploadId);
        throw error;
    } finally {
        await file.close();
    }
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {string} uploadId @param {{file: import('node:fs/promises').FileHandle, name: string, partBytes: number, partCount: number, retryDelayMs: number, size: number}} parameters @returns {Promise<{ETag: string, PartNumber: number}[]>} */
async function uploadParts(client, bucket, key, uploadId, {
    file,
    name,
    partBytes,
    partCount,
    retryDelayMs,
    size,
}) {
    /** @type {{ETag: string, PartNumber: number}[]} */
    const parts = new Array(partCount);
    let nextIndex = 0;
    let failed = false;
    const worker = async () => {
        while (!failed && nextIndex < partCount) {
            const index = nextIndex;
            nextIndex += 1;
            const offset = index * partBytes;
            const length = Math.min(partBytes, size - offset);
            const body = Buffer.alloc(length);
            const {bytesRead} = await file.read(body, 0, length, offset);
            if (bytesRead !== length) {
                throw new Error(`Short read of ${key} at byte ${offset}: expected ${length}, got ${bytesRead}`);
            }
            const {ETag} = await sendPart(client, () => new UploadPartCommand({
                Bucket: bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: index + 1,
                Body: body,
                ContentLength: length,
            }), {
                name,
                partNumber: index + 1,
                retryDelayMs,
            });
            if (!ETag) {
                throw new Error(`Mirror returned no ETag for part ${index + 1} of ${key}`);
            }
            parts[index] = {
                ETag,
                PartNumber: index + 1,
            };
        }
    };
    const outcomes = await Promise.allSettled(
        Array.from({length: Math.min(MULTIPART_CONCURRENCY, partCount)}, () => worker().catch((error) => {
            failed = true;
            throw error;
        })),
    );
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) {
        throw failure.reason;
    }
    return parts;
}

/** @param {TMirrorClient} client @param {() => UploadPartCommand} createCommand @param {{name: string, partNumber: number, retryDelayMs: number}} parameters @returns {Promise<{ETag?: string | undefined}>} */
async function sendPart(client, createCommand, {
    name,
    partNumber,
    retryDelayMs,
}) {
    return retryTransient(() => client.send(createCommand()), {
        label: `Part ${partNumber} of ${name}`,
        retryDelayMs,
        verb: 'resending it',
    });
}

// One transient failure costs one request, never the whole file: a stalled
// part is resent on the same multipart upload, a stalled completion is
// repeated for the same upload id, and a stalled verification read is read
// again. On 2026-09-11 every stall restarted the whole artifact: the core
// mirror stage ran out of its 40-minute budget on 12 assets, and after parts
// alone were covered, a 184 MB supplemental asset still restarted twice from
// its completion and verification calls.
/** @template T @param {() => Promise<T>} action @param {{label: string, retryDelayMs: number, verb: string}} parameters @returns {Promise<T>} */
async function retryTransient(action, {
    label,
    retryDelayMs,
    verb,
}) {
    for (let attempt = 1; ; attempt += 1) {
        const startedAt = Date.now();
        try {
            return await action();
        } catch (error) {
            if (attempt === UPLOAD_ATTEMPTS || !isTransientTransferError(error)) {
                throw error;
            }
            const reason = getCliErrorMessage(error);
            console.warn(
                `${label} failed after ${elapsedSeconds(startedAt)}s (${reason}); `
                + `${verb} (${attempt + 1}/${UPLOAD_ATTEMPTS}).`,
            );
            await delay(retryDelayMs * attempt);
        }
    }
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {string} uploadId @returns {Promise<void>} */
async function abortMultipartUpload(client, bucket, key, uploadId) {
    try {
        await client.send(new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
        }));
    } catch (error) {
        const reason = getCliErrorMessage(error);
        console.warn(`Could not abort multipart upload ${uploadId} for ${key} (${reason}); the bucket lifecycle rule reclaims it.`);
    }
}

/** @param {number} startedAt @returns {string} */
function elapsedSeconds(startedAt) {
    return ((Date.now() - startedAt) / 1000).toFixed(1);
}

/** @param {unknown} error @returns {boolean} */
function isTransientTransferError(error) {
    const status = isMirrorError(error) ? error.$metadata?.httpStatusCode : undefined;
    return isMirrorError(error) && (error.name === 'TimeoutError'
        || TRANSIENT_TRANSFER_ERROR_CODES.has(String(error.code))
        || (typeof status === 'number' && status >= 500));
}

/** @param {unknown} error @returns {boolean} */
function isConditionalWriteConflict(error) {
    return isMirrorError(error) && (
        error.$metadata?.httpStatusCode === 409
        || error.$metadata?.httpStatusCode === 412
        || error.name === 'ConditionalRequestConflict'
        || error.name === 'PreconditionFailed'
    );
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} key @param {string} body @param {string} cacheControl @param {number} retryDelayMs @returns {Promise<void>} */
async function putImmutableJson(client, bucket, key, body, cacheControl, retryDelayMs) {
    const size = Buffer.byteLength(body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const existingState = await immutableUploadState(client, bucket, key, size, sha256, retryDelayMs);
    if (existingState === 'match') {
        return;
    }
    if (existingState === 'mismatch') {
        throw new Error(`Immutable mirror object mismatch for ${key}`);
    }
    await putImmutableObject(client, bucket, key, () => client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: size,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: cacheControl,
        Metadata: { sha256 },
        IfNoneMatch: '*',
    })), size, sha256, retryDelayMs);
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} releasePrefix @param {string} releaseTag @param {string} manifest @param {IStableChannel | null} previousChannel @param {number} retryDelayMs @returns {Promise<{key: string, etag: string, transaction: IReleaseTransaction}>} */
async function prepareReleaseTransaction(client, bucket, releasePrefix, releaseTag, manifest, previousChannel, retryDelayMs) {
    const key = transactionKey(releasePrefix, releaseTag);
    const artifactIdentity = createHash('sha256').update(manifest).digest('hex');
    const existing = await readReleaseTransaction(client, bucket, releasePrefix, releaseTag);
    if (existing) {
        if (existing.transaction.artifactIdentity !== artifactIdentity) {
            throw new Error(`Release transaction artifact identity changed for ${releaseTag}`);
        }
        return existing;
    }
    const transaction = {
        schemaVersion: 1,
        releaseTag,
        artifactIdentity,
        previousChannel,
        activatedChannel: null,
        promotion: 'pending',
    };
    const response = await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(transaction),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-cache, no-store, must-revalidate',
        IfNoneMatch: '*',
    })).catch(async error => {
        if (!isConditionalWriteConflict(error)) {
            throw error;
        }
        const concurrent = await readReleaseTransaction(client, bucket, releasePrefix, releaseTag);
        if (!concurrent || concurrent.transaction.artifactIdentity !== artifactIdentity) {
            throw new Error(`Release transaction changed while publishing ${releaseTag}`, {cause: error});
        }
        return {ETag: concurrent.etag};
    });
    if (!response.ETag) {
        throw new Error('Release transaction object response has no ETag');
    }
    void retryDelayMs;
    return {
        key,
        etag: response.ETag,
        transaction,
    };
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} releasePrefix @param {string} releaseTag @returns {Promise<{key: string, etag: string, transaction: IReleaseTransaction} | null>} */
async function readReleaseTransaction(client, bucket, releasePrefix, releaseTag) {
    const key = transactionKey(releasePrefix, releaseTag);
    try {
        const response = await client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        const raw = await response.Body?.transformToString();
        if (typeof raw !== 'string' || !response.ETag) {
            throw new Error('Release transaction object is incomplete');
        }
        const transaction = JSON.parse(raw);
        if (transaction?.schemaVersion !== 1 || transaction.releaseTag !== releaseTag) {
            throw new Error('Release transaction object is invalid');
        }
        return {
            key,
            etag: response.ETag,
            transaction,
        };
    } catch (error) {
        if (isMirrorError(error) && (error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey')) {
            return null;
        }
        throw error;
    }
}

/** @param {TMirrorClient} client @param {string} bucket @param {{key: string, etag: string, transaction: IReleaseTransaction}} current @param {IStableChannel} activatedChannel @returns {Promise<void>} */
async function updateReleaseTransaction(client, bucket, current, activatedChannel) {
    let response;
    try {
        response = await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: current.key,
            Body: JSON.stringify({
                ...current.transaction,
                activatedChannel,
            }),
            ContentType: 'application/json; charset=utf-8',
            CacheControl: 'no-cache, no-store, must-revalidate',
            IfMatch: current.etag,
        }));
    } catch (error) {
        if (!isConditionalWriteConflict(error)) {
            throw error;
        }
        const concurrent = await readReleaseTransaction(
            client,
            bucket,
            current.key.replace(/transactions\/[^/]+\.json$/u, 'releases/'),
            current.transaction.releaseTag,
        );
        if (concurrent?.transaction.activatedChannel?.sha256 !== activatedChannel.sha256) {
            throw error;
        }
        return;
    }
    if (!response.ETag) {
        throw new Error('Release transaction activation update returned no ETag');
    }
}

/** @param {TMirrorClient} client @param {string} bucket @param {{key: string, etag: string, transaction: IReleaseTransaction}} current @returns {Promise<void>} */
async function markReleaseTransactionPublic(client, bucket, current) {
    let response;
    try {
        response = await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: current.key,
            Body: JSON.stringify({
                ...current.transaction,
                promotion: 'public',
            }),
            ContentType: 'application/json; charset=utf-8',
            CacheControl: 'no-cache, no-store, must-revalidate',
            IfMatch: current.etag,
        }));
    } catch (error) {
        if (!isConditionalWriteConflict(error)) {
            throw error;
        }
        const concurrent = await readReleaseTransaction(
            client,
            bucket,
            current.key.replace(/transactions\/[^/]+\.json$/u, 'releases/'),
            current.transaction.releaseTag,
        );
        if (concurrent?.transaction.promotion === 'public') {
            return;
        }
        throw error;
    }
    if (!response.ETag) {
        throw new Error('Release transaction promotion update returned no ETag');
    }
}

/** @param {unknown} value @param {string} releaseTag @returns {'public' | 'draft' | 'unresolved'} */
function parseGithubReleaseState(value, releaseTag) {
    if (typeof value !== 'object' || value === null) {
        return 'public';
    }
    const state = /** @type {{tagName?: unknown, isDraft?: unknown, assets?: unknown}} */ (value);
    if (state.tagName !== releaseTag || typeof state.isDraft !== 'boolean' || !Array.isArray(state.assets)) {
        return 'unresolved';
    }
    if (!state.assets.some(asset => typeof asset === 'object' && asset !== null && asset.name === 'SHA256SUMS')) {
        return 'unresolved';
    }
    return state.isDraft ? 'draft' : 'public';
}

/** @param {{releaseTag: string, githubState: unknown, drill?: boolean, environment?: NodeJS.ProcessEnv, client?: TMirrorClient, uploadRetryDelayMs?: number}} options @returns {Promise<'public' | 'draft-restored' | 'unresolved' | 'missing'>} */
export async function reconcileReleasePromotion({
    releaseTag,
    githubState,
    drill = false,
    environment = process.env,
    client: providedClient,
    uploadRetryDelayMs = 5_000,
}) {
    const mirrorPaths = resolveMirrorPaths(environment, {drill});
    const releaseTagPattern = drill ? DRILL_TAG_PATTERN : RELEASE_TAG_PATTERN;
    const {
        bucket, client,
    } = createMirrorClient(environment, providedClient);
    const current = await readReleaseTransaction(client, bucket, mirrorPaths.releasePrefix, releaseTag);
    if (!current) {
        return 'missing';
    }
    const state = parseGithubReleaseState(githubState, releaseTag);
    if (state === 'unresolved') {
        return 'unresolved';
    }
    if (state === 'public') {
        await markReleaseTransactionPublic(client, bucket, current);
        return 'public';
    }
    const channel = await readStableChannel(client, bucket, mirrorPaths.channelKey, releaseTagPattern);
    const activated = current.transaction.activatedChannel ?? channel;
    if (!channel || !activated || activated.tag !== releaseTag
        || channel.sha256 !== activated.sha256
        || channel.sha256 !== current.transaction.artifactIdentity) {
        return 'unresolved';
    }
    if (current.transaction.previousChannel) {
        await restoreStableChannel(
            client,
            bucket,
            current.transaction.previousChannel,
            mirrorPaths.channelKey,
            releaseTagPattern,
            uploadRetryDelayMs,
        );
    } else {
        await client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: mirrorPaths.channelKey,
            IfMatch: channel.etag,
        }));
    }
    return 'draft-restored';
}

/** @param {string} releasePrefix @param {string} releaseTag @returns {string} */
function transactionKey(releasePrefix, releaseTag) {
    return `${releasePrefix.replace(/releases\/$/u, 'transactions/')}${releaseTag}.json`;
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} body @param {string} releaseTag @param {NodeJS.ProcessEnv} environment @param {string} channelKey @param {RegExp} releaseTagPattern @param {number} retryDelayMs @returns {Promise<boolean>} */
async function publishStableChannel(
    client,
    bucket,
    body,
    releaseTag,
    environment,
    channelKey,
    releaseTagPattern,
    retryDelayMs,
) {
    const sha256 = createHash('sha256').update(body).digest('hex');
    const size = Buffer.byteLength(body);
    let stableChannelMutationAttempted = false;
    /** @param {unknown} error @returns {unknown} */
    const markStableChannelMutation = (error) => {
        if (!stableChannelMutationAttempted) {
            return error;
        }
        if (isMirrorError(error)) {
            error.stableChannelMutationAttempted = true;
            return error;
        }
        const wrapped = new Error(String(error), {cause: error});
        return Object.assign(wrapped, {stableChannelMutationAttempted: true});
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        const current = await readStableChannel(
            client,
            bucket,
            channelKey,
            releaseTagPattern,
        );
        if (
            current
            && compareReleaseTags(releaseTag, current.tag) < 0
            && environment.EVB_ALLOW_RELEASE_ROLLBACK !== '1'
        ) {
            throw new Error(
                `Refusing to move stable mirror backward from ${current.tag} to ${releaseTag}`,
            );
        }
        if (current?.size === size && current.sha256 === sha256) {
            return false;
        }
        if (current && !current.etag) {
            throw new Error('Stable mirror object response has no ETag; refusing an unguarded update');
        }
        try {
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: channelKey,
                Body: body,
                ContentLength: size,
                ContentType: 'application/json; charset=utf-8',
                CacheControl: 'no-cache, no-store, must-revalidate',
                Metadata: { sha256 },
                ...(current
                    ? {IfMatch: current.etag}
                    : {IfNoneMatch: '*'}),
            }));
            // The pointer may have changed even if verification fails. Keep
            // the outer transaction informed so it can restore the old value.
            stableChannelMutationAttempted = true;
            await verifyUpload(client, bucket, channelKey, size, sha256, retryDelayMs);
            return true;
        } catch (error) {
            if (!isConditionalWriteConflict(error)) {
                throw markStableChannelMutation(error);
            }
            if (attempt === 5) {
                throw markStableChannelMutation(new Error(
                    'Stable mirror channel changed repeatedly during publication',
                    {cause: error},
                ));
            }
            await delay(25 * attempt);
        }
    }
    throw new Error('Stable mirror channel publication exhausted its retry budget');
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} channelKey @param {RegExp} releaseTagPattern @returns {Promise<IStableChannel | null>} */
async function readStableChannel(client, bucket, channelKey, releaseTagPattern) {
    let response;
    try {
        response = await client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: channelKey,
        }));
    } catch (error) {
        if (isMirrorError(error)
            && (error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey')) {
            return null;
        }
        throw error;
    }
    const raw = await response.Body?.transformToString();
    if (typeof raw !== 'string') {
        throw new Error('Stable mirror object response has no readable body');
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error('Stable mirror object is not valid JSON', {cause: error});
    }
    const tag = parsed?.release?.tag;
    if (typeof tag !== 'string' || !releaseTagPattern.test(tag)) {
        throw new Error('Stable mirror object has an invalid release tag');
    }
    return {
        body: raw,
        etag: response.ETag,
        sha256: createHash('sha256').update(raw).digest('hex'),
        size: Buffer.byteLength(raw),
        tag,
    };
}

/** @param {TMirrorClient} client @param {string} bucket @param {IStableChannel} previousChannel @param {string} channelKey @param {RegExp} releaseTagPattern @param {number} retryDelayMs @returns {Promise<void>} */
async function restoreStableChannel(client, bucket, previousChannel, channelKey, releaseTagPattern, retryDelayMs) {
    const current = await readStableChannel(
        client,
        bucket,
        channelKey,
        releaseTagPattern,
    );
    if (current?.sha256 === previousChannel.sha256) {
        return;
    }
    if (!current?.etag) {
        throw new Error('Stable mirror rollback found no guarded current channel object');
    }

    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: channelKey,
        Body: previousChannel.body,
        ContentLength: previousChannel.size,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-cache, no-store, must-revalidate',
        Metadata: {sha256: previousChannel.sha256},
        IfMatch: current.etag,
    }));
    await verifyUpload(client, bucket, channelKey, previousChannel.size, previousChannel.sha256, retryDelayMs);
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} protectedTag @param {string} releasePrefix @param {RegExp} releaseTagPattern @returns {Promise<string[]>} */
async function pruneOldReleases(client, bucket, protectedTag, releasePrefix, releaseTagPattern) {
    const objects = await listAllReleaseObjects(client, bucket, releasePrefix);
    const tags = [...new Set(objects.flatMap(object => {
        const tag = object.Key?.slice(releasePrefix.length).split('/')[0];
        return tag ? [tag] : [];
    }))]
        .filter(tag => releaseTagPattern.test(tag))
        .sort(compareReleaseTags)
        .reverse();
    const retainedTags = new Set(tags.slice(0, RETAINED_RELEASE_COUNT));
    retainedTags.add(protectedTag);
    const staleTags = tags.filter(tag => !retainedTags.has(tag));
    const staleKeys = objects.flatMap(object => {
        const key = object.Key;
        return key && staleTags.some(tag => key.startsWith(`${releasePrefix}${tag}/`))
            ? [key]
            : [];
    });

    await deleteMirrorObjects(client, bucket, staleKeys, 'Mirror pruning');
    return staleTags;
}

/** @param {TMirrorClient} client @param {string} bucket @param {string[]} keys @param {string} label @returns {Promise<void>} */
async function deleteMirrorObjects(client, bucket, keys, label) {
    for (let index = 0; index < keys.length; index += 1_000) {
        const batch = keys.slice(index, index + 1_000);
        const result = await client.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
                Objects: batch.map(Key => ({Key})),
                Quiet: true,
            },
        }));
        const errors = result.Errors ?? [];
        if (errors.length > 0) {
            throw new Error(`${label} failed for ${errors.map(error => error.Key ?? 'unknown').join(', ')}`);
        }
    }
}

/** @param {TMirrorClient} client @param {string} bucket @param {string} releasePrefix @returns {Promise<IMirrorObject[]>} */
async function listAllReleaseObjects(client, bucket, releasePrefix) {
    const objects = /** @type {IMirrorObject[]} */ ([]);
    let continuationToken;
    do {
        /** @type {import('@aws-sdk/client-s3').ListObjectsV2CommandOutput} */
        const page = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: releasePrefix,
            ContinuationToken: continuationToken,
        }));
        objects.push(...(page.Contents ?? []));
        continuationToken = page.NextContinuationToken;
    } while (continuationToken);
    return objects;
}

/** @param {string} left @param {string} right @returns {number} */
export function compareReleaseTags(left, right) {
    const leftVersion = parseReleaseVersion(left);
    const rightVersion = parseReleaseVersion(right);
    for (let index = 0; index < 3; index++) {
        const comparison = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);
        if (comparison !== 0) {
            return comparison;
        }
    }
    if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
        return leftVersion.prerelease.length === rightVersion.prerelease.length
            ? 0
            : leftVersion.prerelease.length === 0 ? 1 : -1;
    }
    const identifierCount = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
    for (let index = 0; index < identifierCount; index++) {
        const leftIdentifier = leftVersion.prerelease[index];
        const rightIdentifier = rightVersion.prerelease[index];
        if (leftIdentifier === undefined || rightIdentifier === undefined) {
            return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
        }
        const leftNumeric = /^\d+$/u.test(leftIdentifier);
        const rightNumeric = /^\d+$/u.test(rightIdentifier);
        if (leftNumeric && rightNumeric) {
            const comparison = Number(leftIdentifier) - Number(rightIdentifier);
            if (comparison !== 0) {
                return comparison;
            }
        } else if (leftNumeric !== rightNumeric) {
            return leftNumeric ? -1 : 1;
        } else {
            if (leftIdentifier !== rightIdentifier) {
                return leftIdentifier < rightIdentifier ? -1 : 1;
            }
        }
    }
    return 0;
}

/** @param {string} tag @returns {number[]} */
export function versionParts(tag) {
    return parseReleaseVersion(tag).core;
}

/** @param {string} tag @returns {{core: number[], prerelease: string[]}} */
function parseReleaseVersion(tag) {
    const match = /^v(\d+)\.(\d+)\.(\d+)(?:[-.]([0-9A-Za-z][0-9A-Za-z.-]*))?$/u.exec(tag);
    if (!match) {
        throw new Error(`Invalid release tag: ${tag}`);
    }
    return {
        core: [
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
        ],
        prerelease: match[4]?.split('.') ?? [],
    };
}

/** @param {string} filename @returns {string} */
export function contentTypeFor(filename) {
    const extension = basename(filename).toLowerCase().split('.').at(-1);
    return ({
        appimage: 'application/octet-stream',
        blockmap: 'application/octet-stream',
        deb: 'application/vnd.debian.binary-package',
        dmg: 'application/x-apple-diskimage',
        exe: 'application/vnd.microsoft.portable-executable',
        json: 'application/json',
        yml: 'text/yaml; charset=utf-8',
        zip: 'application/zip',
    })[extension ?? ''] ?? 'application/octet-stream';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    if (args[0] === 'cleanup') {
        if (args.length !== 2) {
            throw new Error('Usage: publish-release-mirror.mjs cleanup <evb-viewer/drill/.../>');
        }
        await cleanupMirrorPrefix({prefix: args[1]});
    } else if (args[0] === 'reconcile') {
        const [
            , releaseTag,
            statePath,
            ...modes
        ] = args;
        if (!releaseTag || !statePath || modes.some(mode => mode !== '--drill')) {
            throw new Error('Usage: publish-release-mirror.mjs reconcile <release-tag> <github-state.json> [--drill]');
        }
        const result = await reconcileReleasePromotion({
            releaseTag,
            githubState: JSON.parse(await readFile(statePath, 'utf8')),
            drill: modes.includes('--drill'),
        });
        console.log(`Release reconciliation: ${result}`);
        if (result === 'draft-restored') {
            process.exitCode = 2;
        } else if (result === 'unresolved') {
            process.exitCode = 3;
        } else if (result === 'missing') {
            process.exitCode = 4;
        }
    } else if (args[0] === 'supplemental') {
        const [
            ,
            releaseTag,
            ...rest
        ] = args;
        const files = rest.filter(argument => argument !== '--drill');
        const unknownMode = files.find(argument => argument.startsWith('--'));
        if (unknownMode) {
            throw new Error(`Unknown supplemental mirror mode: ${unknownMode}`);
        }
        await publishSupplementalMirrorAssets({
            drill: rest.includes('--drill'),
            files,
            releaseTag,
        });
    } else {
        const [
            artifactDirectory,
            releaseTag,
            ...modes
        ] = args;
        const allowedModes = new Set([
            '--drill',
            '--stage',
            '--transaction',
        ]);
        if (modes.some(mode => !allowedModes.has(mode))) {
            throw new Error(`Unknown mirror publish mode: ${modes.find(mode => !allowedModes.has(mode))}`);
        }
        await publishReleaseMirror({
            artifactDirectory,
            drill: modes.includes('--drill'),
            releaseTag,
            publishChannel: !modes.includes('--stage'),
            durableTransaction: modes.includes('--transaction'),
        });
    }
}
