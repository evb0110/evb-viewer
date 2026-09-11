import { createHash } from 'node:crypto';
import {
    mkdtemp,
    mkdir,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
} from '@aws-sdk/client-s3';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    compareReleaseTags,
    contentTypeFor,
    cleanupMirrorPrefix,
    createMirrorClient,
    hashFile,
    MIRROR_TRANSFER_TIMEOUTS,
    publishReleaseMirror,
    publishSupplementalMirrorAssets,
    requireEnvironment,
    resolveMirrorPaths,
    versionParts,
} from '@scripts/release/publish-release-mirror.mjs';

function hasConfigProvider(value: unknown): value is {configProvider: Promise<Record<string, unknown>>} {
    return typeof value === 'object' && value !== null && 'configProvider' in value;
}

const environment = {
    MIRROR_S3_ENDPOINT: 'https://mirror.example.test',
    MIRROR_S3_BUCKET: 'releases',
    MIRROR_S3_ACCESS_KEY_ID: 'access',
    MIRROR_S3_SECRET_KEY: 'secret',
};

async function commandBodyBytes(body: unknown): Promise<Buffer> {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
        return Buffer.from(body);
    }
    if (ArrayBuffer.isView(body)) {
        return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function objectBody(bytes: Buffer) {
    return {
        transformToByteArray: async () => bytes,
        transformToString: async () => bytes.toString('utf8'),
    };
}

describe('release mirror publisher', () => {
    it('keeps production and drill mirror paths and tags separate', async () => {
        expect(resolveMirrorPaths(environment)).toEqual({
            channelKey: 'evb-viewer/channels/stable.json',
            releasePrefix: 'evb-viewer/releases/',
        });
        expect(() => resolveMirrorPaths({
            ...environment,
            MIRROR_RELEASE_PREFIX: 'evb-viewer/drill/123/releases/',
            MIRROR_CHANNEL_KEY: 'evb-viewer/drill/123/channels/stable.json',
        })).toThrow('Production mirror publication requires');
        expect(resolveMirrorPaths({
            ...environment,
            MIRROR_RELEASE_PREFIX: 'evb-viewer/drill/123/releases/',
            MIRROR_CHANNEL_KEY: 'evb-viewer/drill/123/channels/stable.json',
        }, {drill: true})).toEqual({
            channelKey: 'evb-viewer/drill/123/channels/stable.json',
            releasePrefix: 'evb-viewer/drill/123/releases/',
        });
        expect(() => resolveMirrorPaths({
            ...environment,
            MIRROR_RELEASE_PREFIX: 'evb-viewer/releases/',
            MIRROR_CHANNEL_KEY: 'evb-viewer/channels/stable.json',
        }, {drill: true})).toThrow('evb-viewer/drill/');
    });

    it('publishes a drill tag only into its configured isolated channel', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-drill-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'drill');
        const drillEnvironment = {
            ...environment,
            MIRROR_CHANNEL_KEY: 'evb-viewer/drill/123/channels/stable.json',
            MIRROR_RELEASE_PREFIX: 'evb-viewer/drill/123/releases/',
        };
        const stored = new Map<string, Buffer>();
        const puts: PutObjectCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            const key = command instanceof HeadObjectCommand
                || command instanceof GetObjectCommand
                || command instanceof PutObjectCommand
                ? command.input.Key!
                : '';
            if (command instanceof HeadObjectCommand) {
                const bytes = stored.get(key);
                return bytes
                    ? {ContentLength: bytes.byteLength}
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof GetObjectCommand) {
                const bytes = stored.get(key);
                if (!bytes) {
                    const missing = new Error('missing');
                    Object.assign(missing, {$metadata: {httpStatusCode: 404}});
                    throw missing;
                }
                return {Body: objectBody(bytes)};
            }
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                const bytes = await commandBodyBytes(command.input.Body);
                stored.set(key, bytes);
                return {};
            }
            if (command instanceof ListObjectsV2Command) {
                return {Contents: []};
            }
            throw new Error(`Unexpected drill command: ${String(command)}`);
        })};

        await expect(publishReleaseMirror({
            artifactDirectory,
            drill: true,
            environment: drillEnvironment,
            releaseTag: 'v0.0.0-drill.123',
            client,
        })).resolves.toMatchObject({assets: [{name: 'asset.zip'}]});

        expect(puts.map(command => command.input.Key)).toEqual([
            'evb-viewer/drill/123/releases/v0.0.0-drill.123/asset.zip',
            'evb-viewer/drill/123/releases/v0.0.0-drill.123/manifest.json',
            'evb-viewer/drill/123/channels/stable.json',
        ]);
    });

    it('bounds every mirror transfer instead of waiting on a stalled socket', async () => {
        const {client} = createMirrorClient(environment);
        if (!(client instanceof S3Client)) {
            throw new Error('createMirrorClient must build a real S3 client when none is injected');
        }
        const handler: unknown = client.config.requestHandler;
        if (!hasConfigProvider(handler)) {
            throw new Error('request handler must expose its resolved config');
        }

        await expect(handler.configProvider).resolves.toMatchObject({
            ...MIRROR_TRANSFER_TIMEOUTS,
            throwOnRequestTimeout: true,
        });
        expect(MIRROR_TRANSFER_TIMEOUTS.socketTimeout).toBeLessThan(MIRROR_TRANSFER_TIMEOUTS.requestTimeout);
    });

    function createRetryFixture(failure: (attempt: number) => Error | undefined) {
        const stored = new Map<string, Buffer>();
        const putBodies: Buffer[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                const bytes = stored.get(command.input.Key!);
                return bytes
                    ? {ContentLength: bytes.byteLength}
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof GetObjectCommand) {
                const bytes = stored.get(command.input.Key!);
                if (!bytes) {
                    throw Object.assign(new Error('missing'), {$metadata: {httpStatusCode: 404}});
                }
                return {Body: objectBody(bytes)};
            }
            if (command instanceof PutObjectCommand) {
                const bytes = await commandBodyBytes(command.input.Body);
                if (command.input.Key!.endsWith('/asset.zip')) {
                    putBodies.push(bytes);
                    const error = failure(putBodies.length);
                    if (error) {
                        throw error;
                    }
                }
                stored.set(command.input.Key!, bytes);
                return {};
            }
            if (command instanceof ListObjectsV2Command) {
                return {Contents: []};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        return {
            client,
            putBodies,
            publish: async () => {
                const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-retry-'));
                await writeFile(join(artifactDirectory, 'asset.zip'), 'drill');
                return await publishReleaseMirror({
                    artifactDirectory,
                    client,
                    drill: true,
                    environment: {
                        ...environment,
                        MIRROR_CHANNEL_KEY: 'evb-viewer/drill/123/channels/stable.json',
                        MIRROR_RELEASE_PREFIX: 'evb-viewer/drill/123/releases/',
                    },
                    releaseTag: 'v0.0.0-drill.123',
                    uploadRetryDelayMs: 0,
                });
            },
        };
    }

    it('retries a timed-out artifact upload with the whole body', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const {
            publish,
            putBodies,
        } = createRetryFixture(attempt => (attempt === 1
            ? Object.assign(new Error('socket timed out after 60000 ms of inactivity'), {name: 'TimeoutError'})
            : undefined));

        await expect(publish()).resolves.toMatchObject({assets: [{name: 'asset.zip'}]});

        expect(putBodies.map(bytes => bytes.toString('utf8'))).toEqual([
            'drill',
            'drill',
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying (2/3)'));
        warn.mockRestore();
    });

    it('does not retry an upload the mirror rejected', async () => {
        const {
            publish,
            putBodies,
        } = createRetryFixture(() => Object.assign(new Error('AccessDenied'), {$metadata: {httpStatusCode: 403}}));

        await expect(publish()).rejects.toThrow('AccessDenied');

        expect(putBodies).toHaveLength(1);
    });

    it('gives up after three transient upload failures', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const {
            publish,
            putBodies,
        } = createRetryFixture(() => Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET'}));

        await expect(publish()).rejects.toThrow('ECONNRESET');

        expect(putBodies).toHaveLength(3);
        warn.mockRestore();
    });

    function createMultipartFixture({
        failCompletion = () => undefined,
        failPart = () => undefined,
        failRead = () => undefined,
        partDelayMs = 0,
    }: {
        failCompletion?: (uploadId: string, attempt: number) => Error | undefined;
        failPart?: (partNumber: number, uploadId: string) => Error | undefined;
        failRead?: (key: string, attempt: number) => Error | undefined;
        partDelayMs?: number;
    } = {}) {
        const stored = new Map<string, Buffer>();
        const openUploads = new Map<string, {
            key: string;
            parts: Map<number, Buffer>
        }>();
        const commands: unknown[] = [];
        let createdUploads = 0;
        let completions = 0;
        let reads = 0;
        let inFlight = 0;
        let maxInFlight = 0;
        const client = {send: vi.fn(async (command: unknown) => {
            commands.push(command);
            if (command instanceof HeadObjectCommand) {
                const bytes = stored.get(command.input.Key!);
                return bytes
                    ? {ContentLength: bytes.byteLength}
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof GetObjectCommand) {
                const bytes = stored.get(command.input.Key!);
                if (!bytes) {
                    throw Object.assign(new Error('missing'), {$metadata: {httpStatusCode: 404}});
                }
                reads += 1;
                const error = failRead(command.input.Key!, reads);
                if (error) {
                    throw error;
                }
                return {Body: objectBody(bytes)};
            }
            if (command instanceof PutObjectCommand) {
                stored.set(command.input.Key!, await commandBodyBytes(command.input.Body));
                return {};
            }
            if (command instanceof CreateMultipartUploadCommand) {
                createdUploads += 1;
                const uploadId = `upload-${createdUploads}`;
                openUploads.set(uploadId, {
                    key: command.input.Key!,
                    parts: new Map(),
                });
                return {UploadId: uploadId};
            }
            if (command instanceof UploadPartCommand) {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                try {
                    await new Promise(resolve => setTimeout(resolve, partDelayMs));
                    const upload = openUploads.get(command.input.UploadId!);
                    if (!upload) {
                        throw new Error(`Part for unknown upload ${command.input.UploadId}`);
                    }
                    const error = failPart(command.input.PartNumber!, command.input.UploadId!);
                    if (error) {
                        throw error;
                    }
                    const bytes = await commandBodyBytes(command.input.Body);
                    if (bytes.byteLength !== command.input.ContentLength) {
                        throw new Error(`Part ${command.input.PartNumber} declared ${command.input.ContentLength} bytes but carried ${bytes.byteLength}`);
                    }
                    upload.parts.set(command.input.PartNumber!, bytes);
                    return {ETag: `"${command.input.UploadId}-${command.input.PartNumber}"`};
                } finally {
                    inFlight -= 1;
                }
            }
            if (command instanceof CompleteMultipartUploadCommand) {
                const upload = openUploads.get(command.input.UploadId!);
                if (!upload) {
                    throw new Error(`Completion for unknown upload ${command.input.UploadId}`);
                }
                completions += 1;
                const error = failCompletion(command.input.UploadId!, completions);
                if (error) {
                    throw error;
                }
                const listed = command.input.MultipartUpload?.Parts ?? [];
                if (listed.length !== upload.parts.size) {
                    throw new Error(`Completion listed ${listed.length} of ${upload.parts.size} parts`);
                }
                const assembled = listed.map((part, index) => {
                    if (part.PartNumber !== index + 1 || part.ETag !== `"${command.input.UploadId}-${index + 1}"`) {
                        throw new Error(`Completion part ${index + 1} is out of order or mislabelled`);
                    }
                    return upload.parts.get(index + 1) ?? Buffer.alloc(0);
                });
                stored.set(upload.key, Buffer.concat(assembled));
                openUploads.delete(command.input.UploadId!);
                return {};
            }
            if (command instanceof AbortMultipartUploadCommand) {
                openUploads.delete(command.input.UploadId!);
                return {};
            }
            if (command instanceof ListObjectsV2Command) {
                return {Contents: []};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        return {
            client,
            commands,
            maxInFlight: () => maxInFlight,
            openUploads,
            stored,
            publish: async (artifact: Buffer, partBytes: number) => {
                const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-multipart-'));
                await writeFile(join(artifactDirectory, 'asset.zip'), artifact);
                return await publishReleaseMirror({
                    artifactDirectory,
                    client,
                    drill: true,
                    environment: {
                        ...environment,
                        MIRROR_CHANNEL_KEY: 'evb-viewer/drill/123/channels/stable.json',
                        MIRROR_RELEASE_PREFIX: 'evb-viewer/drill/123/releases/',
                    },
                    partBytes,
                    releaseTag: 'v0.0.0-drill.123',
                    uploadRetryDelayMs: 0,
                });
            },
        };
    }

    const multipartAssetKey = 'evb-viewer/drill/123/releases/v0.0.0-drill.123/asset.zip';

    it('uploads a large artifact as ordered parts and completes it immutably', async () => {
        const artifact = Buffer.from('multipart drill payload');
        const fixture = createMultipartFixture();

        await expect(fixture.publish(artifact, 8)).resolves.toMatchObject({assets: [{
            name: 'asset.zip',
            size: artifact.byteLength,
        }]});

        const creates = fixture.commands.filter(command => command instanceof CreateMultipartUploadCommand);
        expect(creates).toHaveLength(1);
        expect(creates[0]?.input).toMatchObject({
            Bucket: 'releases',
            CacheControl: 'public, max-age=31536000, immutable',
            ContentType: 'application/zip',
            Key: multipartAssetKey,
            Metadata: {sha256: createHash('sha256').update(artifact).digest('hex')},
        });
        const parts = fixture.commands
            .filter(command => command instanceof UploadPartCommand)
            .map(command => [
                command.input.PartNumber,
                command.input.ContentLength,
            ])
            .sort((left, right) => (left[0] ?? 0) - (right[0] ?? 0));
        expect(parts).toEqual([
            [
                1,
                8,
            ],
            [
                2,
                8,
            ],
            [
                3,
                7,
            ],
        ]);
        const completes = fixture.commands.filter(command => command instanceof CompleteMultipartUploadCommand);
        expect(completes).toHaveLength(1);
        expect(completes[0]?.input.IfNoneMatch).toBe('*');
        expect(fixture.commands.some(command => command instanceof PutObjectCommand
            && command.input.Key === multipartAssetKey)).toBe(false);
        expect(fixture.stored.get(multipartAssetKey)?.equals(artifact)).toBe(true);
        expect(fixture.openUploads.size).toBe(0);
    });

    it('keeps at most four parts in flight', async () => {
        const fixture = createMultipartFixture({partDelayMs: 20});

        await expect(fixture.publish(Buffer.from('0123456789'), 1)).resolves.toMatchObject({assets: [{name: 'asset.zip'}]});

        expect(fixture.commands.filter(command => command instanceof UploadPartCommand)).toHaveLength(10);
        expect(fixture.maxInFlight()).toBeLessThanOrEqual(4);
        expect(fixture.maxInFlight()).toBeGreaterThan(1);
    });

    it('resends a stalled part on the same multipart upload', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const artifact = Buffer.from('multipart drill payload');
        let stalls = 0;
        const fixture = createMultipartFixture({failPart: (partNumber, uploadId) => {
            if (uploadId === 'upload-1' && partNumber === 2 && stalls === 0) {
                stalls += 1;
                return Object.assign(new Error('a request has exceeded the configured 120000 ms requestTimeout'), {name: 'TimeoutError'});
            }
            return undefined;
        }});

        await expect(fixture.publish(artifact, 8)).resolves.toMatchObject({assets: [{name: 'asset.zip'}]});

        expect(fixture.commands.filter(command => command instanceof AbortMultipartUploadCommand)).toHaveLength(0);
        expect(fixture.commands.filter(command => command instanceof CreateMultipartUploadCommand)).toHaveLength(1);
        expect(fixture.commands.filter(command => command instanceof UploadPartCommand
            && command.input.PartNumber === 2)).toHaveLength(2);
        expect(fixture.stored.get(multipartAssetKey)?.equals(artifact)).toBe(true);
        expect(fixture.openUploads.size).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Part 2 of asset.zip'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('resending it (2/3)'));
        warn.mockRestore();
    });

    it('aborts the multipart upload and restarts the artifact once a part keeps stalling', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const artifact = Buffer.from('multipart drill payload');
        const fixture = createMultipartFixture({failPart: (partNumber, uploadId) => (uploadId === 'upload-1' && partNumber === 2
            ? Object.assign(new Error('a request has exceeded the configured 120000 ms requestTimeout'), {name: 'TimeoutError'})
            : undefined)});

        await expect(fixture.publish(artifact, 8)).resolves.toMatchObject({assets: [{name: 'asset.zip'}]});

        const aborts = fixture.commands.filter(command => command instanceof AbortMultipartUploadCommand);
        expect(aborts.map(command => command.input.UploadId)).toEqual(['upload-1']);
        expect(fixture.commands.filter(command => command instanceof CreateMultipartUploadCommand)).toHaveLength(2);
        expect(fixture.commands.filter(command => command instanceof UploadPartCommand
            && command.input.UploadId === 'upload-1' && command.input.PartNumber === 2)).toHaveLength(3);
        expect(fixture.stored.get(multipartAssetKey)?.equals(artifact)).toBe(true);
        expect(fixture.openUploads.size).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying (2/3)'));
        warn.mockRestore();
    });

    it('repeats a stalled completion on the same multipart upload', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const artifact = Buffer.from('multipart drill payload');
        const fixture = createMultipartFixture({failCompletion: (uploadId, attempt) => (uploadId === 'upload-1' && attempt === 1
            ? Object.assign(new Error('@smithy/node-http-handler - the request socket timed out after 60000 ms of inactivity'), {name: 'TimeoutError'})
            : undefined)});

        await expect(fixture.publish(artifact, 8)).resolves.toMatchObject({assets: [{name: 'asset.zip'}]});

        expect(fixture.commands.filter(command => command instanceof AbortMultipartUploadCommand)).toHaveLength(0);
        expect(fixture.commands.filter(command => command instanceof CreateMultipartUploadCommand)).toHaveLength(1);
        expect(fixture.commands.filter(command => command instanceof UploadPartCommand)).toHaveLength(3);
        expect(fixture.commands.filter(command => command instanceof CompleteMultipartUploadCommand)).toHaveLength(2);
        expect(fixture.stored.get(multipartAssetKey)?.equals(artifact)).toBe(true);
        expect(fixture.openUploads.size).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Completion of asset.zip'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('repeating it (2/3)'));
        warn.mockRestore();
    });

    it('re-reads a stalled verification instead of uploading the artifact again', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const artifact = Buffer.from('multipart drill payload');
        const fixture = createMultipartFixture({failRead: (key, attempt) => (key === multipartAssetKey && attempt === 1
            ? Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET'})
            : undefined)});

        await expect(fixture.publish(artifact, 8)).resolves.toMatchObject({assets: [{name: 'asset.zip'}]});

        expect(fixture.commands.filter(command => command instanceof CreateMultipartUploadCommand)).toHaveLength(1);
        expect(fixture.commands.filter(command => command instanceof UploadPartCommand)).toHaveLength(3);
        expect(fixture.commands.filter(command => command instanceof CompleteMultipartUploadCommand)).toHaveLength(1);
        expect(fixture.commands.filter(command => command instanceof GetObjectCommand
            && command.input.Key === multipartAssetKey)).toHaveLength(2);
        expect(fixture.stored.get(multipartAssetKey)?.equals(artifact)).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Verification read of ${multipartAssetKey}`));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-reading it (2/3)'));
        warn.mockRestore();
    });

    it('does not retry a multipart upload the mirror rejected', async () => {
        const fixture = createMultipartFixture({failPart: () => Object.assign(new Error('AccessDenied'), {$metadata: {httpStatusCode: 403}})});

        await expect(fixture.publish(Buffer.from('multipart drill payload'), 8)).rejects.toThrow('AccessDenied');

        expect(fixture.commands.filter(command => command instanceof CreateMultipartUploadCommand)).toHaveLength(1);
        expect(fixture.commands.filter(command => command instanceof AbortMultipartUploadCommand)).toHaveLength(1);
        expect(fixture.stored.has(multipartAssetKey)).toBe(false);
        expect(fixture.openUploads.size).toBe(0);
    });

    it('deletes only drill mirror prefixes', async () => {
        const deletions: DeleteObjectsCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof ListObjectsV2Command) {
                expect(command.input.Prefix).toBe('evb-viewer/drill/123/');
                return {Contents: [
                    {Key: 'evb-viewer/drill/123/releases/asset'},
                    {Key: 'evb-viewer/drill/123/channels/stable.json'},
                ]};
            }
            if (command instanceof DeleteObjectsCommand) {
                deletions.push(command);
                return {};
            }
            throw new Error(`Unexpected cleanup command: ${String(command)}`);
        })};

        await expect(cleanupMirrorPrefix({
            environment,
            prefix: 'evb-viewer/drill/123/',
            client,
        })).resolves.toMatchObject({deletedKeys: [
            'evb-viewer/drill/123/releases/asset',
            'evb-viewer/drill/123/channels/stable.json',
        ]});
        expect(deletions[0]?.input.Delete?.Objects).toEqual([
            {Key: 'evb-viewer/drill/123/releases/asset'},
            {Key: 'evb-viewer/drill/123/channels/stable.json'},
        ]);
        await expect(cleanupMirrorPrefix({
            environment,
            prefix: 'evb-viewer/releases/',
            client,
        })).rejects.toThrow('non-drill mirror prefix');
    });

    it('uploads verified artifacts and JSON pointers before pruning stale releases', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-'));
        await writeFile(join(artifactDirectory, 'EVB Viewer.exe'), 'windows');
        await writeFile(join(artifactDirectory, 'latest.yml'), 'version: 1');
        await writeFile(join(artifactDirectory, '.ignored'), 'hidden');
        await mkdir(join(artifactDirectory, 'nested'));

        const puts: PutObjectCommand[] = [];
        const deletions: DeleteObjectsCommand[] = [];
        const stored = new Map<string, {
            bytes: Buffer;
            sha256: string
        }>();
        let listPage = 0;
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                stored.set(command.input.Key!, {
                    bytes: await commandBodyBytes(command.input.Body),
                    sha256: command.input.Metadata!.sha256!,
                });
                return {};
            }
            if (command instanceof HeadObjectCommand) {
                const object = stored.get(command.input.Key!);
                return {
                    ContentLength: object?.bytes.byteLength,
                    Metadata: {sha256: object?.sha256},
                };
            }
            if (command instanceof ListObjectsV2Command) {
                listPage += 1;
                return listPage === 1
                    ? {
                        Contents: [
                            'v1.0.0',
                            'v1.1.0',
                            'v1.2.0',
                        ].map(tag => ({Key: `evb-viewer/releases/${tag}/asset`})),
                        NextContinuationToken: 'page-2',
                    }
                    : {Contents: [
                        {Key: 'evb-viewer/releases/v1.3.0/asset'},
                        {Key: 'evb-viewer/releases/v2.0.0/asset'},
                        {Key: 'evb-viewer/releases/not-a-version/asset'},
                    ]};
            }
            if (command instanceof GetObjectCommand) {
                const object = stored.get(command.input.Key!);
                if (object) {
                    return {Body: objectBody(object.bytes)};
                }
                const missing = new Error('missing');
                Object.assign(missing, {$metadata: {httpStatusCode: 404}});
                throw missing;
            }
            if (command instanceof DeleteObjectsCommand) {
                deletions.push(command);
                return {};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        const result = await publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.0.0',
            environment,
            client,
        });

        expect(result.assets.map(asset => asset.name)).toEqual([
            'EVB Viewer.exe',
            'latest.yml',
        ]);
        expect(result.prunedTags).toEqual(['v1.0.0']);
        expect(puts.map(command => command.input.Key)).toEqual([
            'evb-viewer/releases/v2.0.0/EVB Viewer.exe',
            'evb-viewer/releases/v2.0.0/latest.yml',
            'evb-viewer/releases/v2.0.0/manifest.json',
            'evb-viewer/channels/stable.json',
        ]);
        expect(puts[0]?.input).toMatchObject({
            Bucket: 'releases',
            ContentLength: 7,
            ContentType: 'application/vnd.microsoft.portable-executable',
            CacheControl: 'public, max-age=31536000, immutable',
            IfNoneMatch: '*',
        });
        expect(puts[2]?.input.IfNoneMatch).toBe('*');
        expect(puts.at(-1)?.input.IfNoneMatch).toBe('*');
        expect(puts.at(-1)?.input.IfMatch).toBeUndefined();
        expect(puts.at(-1)?.input.CacheControl).toBe('no-cache, no-store, must-revalidate');
        expect(deletions[0]?.input.Delete?.Objects).toEqual([{Key: 'evb-viewer/releases/v1.0.0/asset'}]);
        expect(client.send).toHaveBeenCalledTimes(16);
    });

    it('stages immutable release objects without publishing the stable channel', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-stage-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'staged');
        const puts: PutObjectCommand[] = [];
        const stored = new Map<string, {
            bytes: Buffer;
            sha256: string
        }>();
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                stored.set(command.input.Key!, {
                    bytes: await commandBodyBytes(command.input.Body),
                    sha256: command.input.Metadata!.sha256!,
                });
                return {};
            }
            if (command instanceof HeadObjectCommand) {
                const object = stored.get(command.input.Key!);
                if (!object) {
                    return {$metadata: {httpStatusCode: 404}};
                }
                return {
                    ContentLength: object.bytes.byteLength,
                    Metadata: {sha256: object.sha256},
                };
            }
            if (command instanceof GetObjectCommand) {
                const object = stored.get(command.input.Key!);
                if (!object) {
                    throw new Error('Unexpected missing staged object');
                }
                return {Body: objectBody(object.bytes)};
            }
            throw new Error(`Unexpected staging command: ${String(command)}`);
        })};

        const result = await publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.1.0',
            publishChannel: false,
            environment,
            client,
        });

        expect(puts.map(command => command.input.Key)).toEqual([
            'evb-viewer/releases/v2.1.0/asset.zip',
            'evb-viewer/releases/v2.1.0/manifest.json',
        ]);
        expect(result.prunedTags).toEqual([]);
        expect(client.send).not.toHaveBeenCalledWith(expect.any(ListObjectsV2Command));
        expect(client.send).not.toHaveBeenCalledWith(expect.any(DeleteObjectsCommand));
    });

    it('keeps same-tag mirror repair byte-identical after supplemental assets attach', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-repair-'));
        await writeFile(join(artifactDirectory, 'core.zip'), 'core');
        const stored = new Map<string, {
            bytes: Buffer;
            sha256: string
        }>();
        const puts: PutObjectCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                stored.set(command.input.Key!, {
                    bytes: await commandBodyBytes(command.input.Body),
                    sha256: command.input.Metadata!.sha256!,
                });
                return {};
            }
            if (command instanceof HeadObjectCommand) {
                const object = stored.get(command.input.Key!);
                return object
                    ? {
                        ContentLength: object.bytes.byteLength,
                        Metadata: {sha256: object.sha256},
                    }
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof GetObjectCommand) {
                const object = stored.get(command.input.Key!);
                if (!object) {
                    throw new Error('Unexpected missing repair object');
                }
                return {Body: objectBody(object.bytes)};
            }
            throw new Error(`Unexpected repair command: ${String(command)}`);
        })};

        const first = await publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.1.0',
            publishChannel: false,
            environment,
            client,
        });
        await writeFile(join(artifactDirectory, 'EVB-Viewer-2.1.0-x64.zip'), 'intel');
        await writeFile(join(artifactDirectory, 'EVB-Viewer-2.1.0-arm64-setup.exe'), 'arm installer');
        await writeFile(
            join(artifactDirectory, 'EVB-Viewer-2.1.0-win-arm64-provenance.json'),
            '{}',
        );
        const repaired = await publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.1.0',
            publishChannel: false,
            environment,
            client,
        });

        expect(first.assets.map(asset => asset.name)).toEqual(['core.zip']);
        expect(repaired.assets).toEqual(first.assets);
        expect(puts.map(command => command.input.Key)).toEqual([
            'evb-viewer/releases/v2.1.0/core.zip',
            'evb-viewer/releases/v2.1.0/manifest.json',
        ]);
    });

    function createSupplementalFixture() {
        const stored = new Map<string, {
            bytes: Buffer;
            sha256: string
        }>();
        const puts: PutObjectCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                stored.set(command.input.Key!, {
                    bytes: await commandBodyBytes(command.input.Body),
                    sha256: command.input.Metadata!.sha256!,
                });
                return {};
            }
            if (command instanceof HeadObjectCommand) {
                const object = stored.get(command.input.Key!);
                return object
                    ? {
                        ContentLength: object.bytes.byteLength,
                        Metadata: {sha256: object.sha256},
                    }
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof GetObjectCommand) {
                const object = stored.get(command.input.Key!);
                if (!object) {
                    throw new Error('Unexpected missing supplemental object');
                }
                return {Body: objectBody(object.bytes)};
            }
            throw new Error(`Unexpected supplemental command: ${String(command)}`);
        })};

        return {
            client,
            puts,
            async writeSupplementalAssets() {
                const directory = await mkdtemp(join(tmpdir(), 'evb-mirror-supplemental-'));
                const intelZip = join(directory, 'EVB-Viewer-2.1.0-x64.zip');
                const windowsInstaller = join(directory, 'EVB-Viewer-2.1.0-arm64-setup.exe');
                const windowsProvenance = join(directory, 'EVB-Viewer-2.1.0-win-arm64-provenance.json');
                await writeFile(intelZip, 'intel');
                await writeFile(windowsInstaller, 'arm installer');
                await writeFile(windowsProvenance, '{}');
                return {
                    files: [
                        intelZip,
                        windowsInstaller,
                        windowsProvenance,
                    ],
                    intelZip,
                };
            },
        };
    }

    it('mirrors supplemental assets beside the core objects and repeats without rewriting them', async () => {
        const {
            client,
            puts,
            writeSupplementalAssets,
        } = createSupplementalFixture();
        const coreDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-core-'));
        await writeFile(join(coreDirectory, 'core.zip'), 'core');
        await publishReleaseMirror({
            artifactDirectory: coreDirectory,
            releaseTag: 'v2.1.0',
            publishChannel: false,
            environment,
            client,
        });
        const {files} = await writeSupplementalAssets();
        puts.length = 0;

        const published = await publishSupplementalMirrorAssets({
            files,
            releaseTag: 'v2.1.0',
            environment,
            client,
        });
        const repeated = await publishSupplementalMirrorAssets({
            files,
            releaseTag: 'v2.1.0',
            environment,
            client,
        });

        expect(published).toMatchObject({
            assets: [
                {name: 'EVB-Viewer-2.1.0-x64.zip'},
                {name: 'EVB-Viewer-2.1.0-arm64-setup.exe'},
                {name: 'EVB-Viewer-2.1.0-win-arm64-provenance.json'},
            ],
            skipped: false,
        });
        expect(repeated.assets).toEqual(published.assets);
        // The manifest and the stable channel stay exactly as the promoted
        // release left them; only the new objects are written, once.
        expect(puts.map(command => command.input.Key)).toEqual([
            'evb-viewer/releases/v2.1.0/EVB-Viewer-2.1.0-x64.zip',
            'evb-viewer/releases/v2.1.0/EVB-Viewer-2.1.0-arm64-setup.exe',
            'evb-viewer/releases/v2.1.0/EVB-Viewer-2.1.0-win-arm64-provenance.json',
        ]);
        expect(puts.every(command => command.input.CacheControl === 'public, max-age=31536000, immutable')).toBe(true);
    });

    it('leaves supplemental assets unmirrored when the tag has no core manifest', async () => {
        const {
            client,
            puts,
            writeSupplementalAssets,
        } = createSupplementalFixture();

        const {files} = await writeSupplementalAssets();

        await expect(publishSupplementalMirrorAssets({
            files,
            releaseTag: 'v2.1.0',
            environment,
            client,
        })).resolves.toEqual({
            assets: [],
            skipped: true,
        });

        expect(puts).toEqual([]);
    });

    it('refuses supplemental publication of core assets, foreign tags, and empty input', async () => {
        const {
            client,
            writeSupplementalAssets,
        } = createSupplementalFixture();
        const {intelZip} = await writeSupplementalAssets();

        await expect(publishSupplementalMirrorAssets({
            files: [intelZip.replace('EVB-Viewer-2.1.0-x64.zip', 'EVB-Viewer-2.1.0-x64-setup.exe')],
            releaseTag: 'v2.1.0',
            environment,
            client,
        })).rejects.toThrow('Refusing to mirror EVB-Viewer-2.1.0-x64-setup.exe');
        // A supplemental name from another version is a caller mistake, not a
        // second mirror layout.
        await expect(publishSupplementalMirrorAssets({
            files: [intelZip],
            releaseTag: 'v2.2.0',
            environment,
            client,
        })).rejects.toThrow('Refusing to mirror EVB-Viewer-2.1.0-x64.zip');
        await expect(publishSupplementalMirrorAssets({
            files: [],
            releaseTag: 'v2.1.0',
            environment,
            client,
        })).rejects.toThrow('Usage: publish-release-mirror.mjs supplemental');
        // A drill tag never reaches the production prefix, and a public tag
        // never reaches a drill prefix.
        await expect(publishSupplementalMirrorAssets({
            files: [intelZip],
            releaseTag: 'v0.0.0-drill.123',
            environment,
            client,
        })).rejects.toThrow('Invalid release tag: v0.0.0-drill.123');
        await expect(publishSupplementalMirrorAssets({
            drill: true,
            files: [intelZip],
            releaseTag: 'v2.1.0',
            environment: {
                ...environment,
                MIRROR_CHANNEL_KEY: 'evb-viewer/drill/123/channels/stable.json',
                MIRROR_RELEASE_PREFIX: 'evb-viewer/drill/123/releases/',
            },
            client,
        })).rejects.toThrow('Invalid release tag: v2.1.0');
        expect(client.send).not.toHaveBeenCalled();
    });

    it('rejects invalid input, missing credentials, empty folders, and verification mismatches', async () => {
        await expect(publishReleaseMirror({
            artifactDirectory: '',
            releaseTag: '',
            environment,
            client: {send: vi.fn()},
        }))
            .rejects.toThrow('Usage:');
        await expect(publishReleaseMirror({
            artifactDirectory: '/tmp',
            releaseTag: 'latest',
            environment,
            client: {send: vi.fn()},
        }))
            .rejects.toThrow('Invalid release tag');
        expect(() => requireEnvironment({}, 'MIRROR_S3_BUCKET')).toThrow('Missing required environment variable');

        const emptyDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-empty-'));
        await writeFile(join(emptyDirectory, '.ignored'), 'hidden');
        await expect(publishReleaseMirror({
            artifactDirectory: emptyDirectory,
            releaseTag: 'v1.0.0',
            environment,
            client: {send: vi.fn()},
        }))
            .rejects.toThrow('No release artifacts');

        const directoryOnly = await mkdtemp(join(tmpdir(), 'evb-mirror-directory-'));
        await mkdir(join(directoryOnly, 'nested'));
        await expect(publishReleaseMirror({
            artifactDirectory: directoryOnly,
            releaseTag: 'v1.0.0',
            environment,
            client: {send: vi.fn()},
        }))
            .rejects.toThrow('No regular release artifact files');

        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-invalid-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'zip');
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                return {
                    ContentLength: 999,
                    Metadata: {sha256: 'wrong'},
                };
            }
            if (command instanceof GetObjectCommand) {
                return {Body: objectBody(Buffer.from('wrong'))};
            }
            return {};
        })};
        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v1.0.0',
            environment,
            client,
        }))
            .rejects.toThrow('Immutable mirror object mismatch');
    });

    it('refuses to overwrite an immutable tagged asset or manifest', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-immutable-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'new bytes');
        const puts: PutObjectCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                return {
                    ContentLength: 7,
                    Metadata: {sha256: 'different'},
                };
            }
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                return {};
            }
            if (command instanceof GetObjectCommand) {
                return {Body: objectBody(Buffer.from('old body'))};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v3.0.0',
            publishChannel: false,
            environment,
            client,
        })).rejects.toThrow('Immutable mirror object mismatch');
        expect(puts).toEqual([]);
    });

    it('rejects an existing object whose trusted-looking metadata hides different bytes', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-forged-metadata-'));
        const artifact = Buffer.from('intended bytes');
        await writeFile(join(artifactDirectory, 'asset.zip'), artifact);
        const sha256 = createHash('sha256').update(artifact).digest('hex');
        const puts: PutObjectCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                return {
                    ContentLength: artifact.byteLength,
                    Metadata: {sha256},
                };
            }
            if (command instanceof GetObjectCommand) {
                return {Body: objectBody(Buffer.from('tampered bytes'))};
            }
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                return {};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v3.0.1',
            publishChannel: false,
            environment,
            client,
        })).rejects.toThrow('Immutable mirror object mismatch');
        expect(puts).toEqual([]);
    });

    it.each([
        [
            'accepts',
            Buffer.from('release bytes'),
            true,
        ],
        [
            'rejects',
            Buffer.from('racing attacker'),
            false,
        ],
    ] as const)('%s a concurrent conditional creator according to its downloaded bytes', async (
        _label,
        racingBytes,
        shouldAccept,
    ) => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-race-'));
        const intendedBytes = Buffer.from('release bytes');
        await writeFile(join(artifactDirectory, 'asset.zip'), intendedBytes);
        const stored = new Map<string, Buffer>();
        const puts: PutObjectCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            const key = command instanceof HeadObjectCommand
                || command instanceof GetObjectCommand
                || command instanceof PutObjectCommand
                ? command.input.Key!
                : '';
            if (command instanceof HeadObjectCommand) {
                const bytes = stored.get(key);
                return bytes
                    ? {ContentLength: bytes.byteLength}
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                expect(command.input.IfNoneMatch).toBe('*');
                if (key.endsWith('/asset.zip')) {
                    stored.set(key, racingBytes);
                    const conflict = new Error('conditional conflict');
                    Object.assign(conflict, {$metadata: {httpStatusCode: 412}});
                    throw conflict;
                }
                stored.set(key, await commandBodyBytes(command.input.Body));
                return {};
            }
            if (command instanceof GetObjectCommand) {
                const bytes = stored.get(key);
                if (!bytes) {
                    throw new Error(`Missing object: ${key}`);
                }
                return {Body: objectBody(bytes)};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        const result = publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v3.0.2',
            publishChannel: false,
            environment,
            client,
        });
        if (shouldAccept) {
            await expect(result).resolves.toMatchObject({assets: [{name: 'asset.zip'}]});
        } else {
            await expect(result).rejects.toThrow('Immutable mirror object mismatch');
        }
        expect(puts[0]?.input.IfNoneMatch).toBe('*');
        expect(stored.get('evb-viewer/releases/v3.0.2/asset.zip')).toEqual(racingBytes);
    });

    it('refuses to move the stable channel backward', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-downgrade-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'release');
        const puts: PutObjectCommand[] = [];
        const stored = new Map<string, {
            bytes: Buffer;
            sha256: string
        }>();
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                const object = stored.get(command.input.Key!);
                return object
                    ? {
                        ContentLength: object.bytes.byteLength,
                        Metadata: {sha256: object.sha256},
                    }
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                stored.set(command.input.Key!, {
                    bytes: await commandBodyBytes(command.input.Body),
                    sha256: command.input.Metadata!.sha256!,
                });
                return {};
            }
            if (command instanceof GetObjectCommand) {
                const storedObject = stored.get(command.input.Key!);
                if (storedObject) {
                    return {Body: objectBody(storedObject.bytes)};
                }
                return {Body: {transformToString: async () => JSON.stringify({release: {tag: 'v3.0.0'}})}};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.9.0',
            environment,
            client,
        })).rejects.toThrow('Refusing to move stable mirror backward');
        expect(puts.map(command => command.input.Key)).not.toContain('evb-viewer/channels/stable.json');
    });

    it('uses the stable channel ETag and rejects a concurrent downgrade race', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-channel-race-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'release');
        const stored = new Map<string, Buffer>();
        let stableReadCount = 0;
        const client = {send: vi.fn(async (command: unknown) => {
            const key = command instanceof HeadObjectCommand
                || command instanceof GetObjectCommand
                || command instanceof PutObjectCommand
                ? command.input.Key!
                : '';
            if (command instanceof HeadObjectCommand) {
                const bytes = stored.get(key);
                return bytes
                    ? {ContentLength: bytes.byteLength}
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof GetObjectCommand) {
                if (key === 'evb-viewer/channels/stable.json') {
                    stableReadCount += 1;
                    const tag = stableReadCount === 1 ? 'v1.9.0' : 'v2.1.0';
                    return {
                        Body: objectBody(Buffer.from(JSON.stringify({release: {tag}}))),
                        ETag: stableReadCount === 1 ? '"old"' : '"new"',
                    };
                }
                const bytes = stored.get(key);
                if (!bytes) {
                    throw new Error(`Missing object: ${key}`);
                }
                return {Body: objectBody(bytes)};
            }
            if (command instanceof PutObjectCommand) {
                if (key === 'evb-viewer/channels/stable.json') {
                    expect(command.input.IfMatch).toBe('"old"');
                    const conflict = new Error('conditional conflict');
                    Object.assign(conflict, {$metadata: {httpStatusCode: 412}});
                    throw conflict;
                }
                stored.set(key, await commandBodyBytes(command.input.Body));
                return {};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.0.0',
            environment,
            client,
        })).rejects.toThrow('Refusing to move stable mirror backward from v2.1.0 to v2.0.0');
        expect(stableReadCount).toBe(2);
    });

    it('maps content types, compares release tags, and hashes files deterministically', async () => {
        expect(contentTypeFor('app.dmg')).toBe('application/x-apple-diskimage');
        expect(contentTypeFor('app.AppImage')).toBe('application/octet-stream');
        expect(contentTypeFor('app.deb')).toBe('application/vnd.debian.binary-package');
        expect(contentTypeFor('app.zip')).toBe('application/zip');
        expect(contentTypeFor('manifest.json')).toBe('application/json');
        expect(contentTypeFor('notes.txt')).toBe('application/octet-stream');
        expect(versionParts('v12.3.4-beta.1')).toEqual([
            12,
            3,
            4,
        ]);
        expect(compareReleaseTags('v2.0.0', 'v1.9.9')).toBeGreaterThan(0);
        expect(compareReleaseTags('v1.0.0-beta', 'v1.0.0-alpha')).toBeGreaterThan(0);
        expect(compareReleaseTags('v1.0.0', 'v1.0.0-beta.9')).toBeGreaterThan(0);
        expect(compareReleaseTags('v1.0.0-rc.2', 'v1.0.0-rc.10')).toBeLessThan(0);

        const directory = await mkdtemp(join(tmpdir(), 'evb-mirror-hash-'));
        const filePath = join(directory, 'asset');
        await writeFile(filePath, 'content');
        expect(await hashFile(filePath)).toBe(createHash('sha256').update('content').digest('hex'));
    });
});
