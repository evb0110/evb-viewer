import {createHash} from 'node:crypto';
import {
    access,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IRuntimeBinaryManifestEntry, IRuntimeBinaryManifest,
} from '@scripts/runtimeBinaryArchive';
import {
    computeRuntimeBinaryManifestSha256,
    fetchVerifiedRuntimeArchive,
    validateRuntimeBinaryManifest,
} from '@scripts/runtimeBinaryArchive';

const target = {
    arch: 'x64',
    exeSuffix: '.exe',
    platform: 'win32',
    platformArch: 'win32-x64',
} as const;

const otherTarget = {
    arch: 'arm64',
    exeSuffix: '',
    platform: 'darwin',
    platformArch: 'darwin-arm64',
} as const;

const archiveBytes = new TextEncoder().encode('synthetic-runtime-archive');
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');

function entry(overrides: Partial<IRuntimeBinaryManifestEntry> = {}): IRuntimeBinaryManifestEntry {
    return {
        archiveKind: 'zip',
        archiveBytes: archiveBytes.byteLength,
        archiveSha256,
        archiveUrl: 'https://example.test/runtime.zip',
        executableEntry: 'bin/runtime.exe',
        familyId: 'qpdf',
        target,
        ...overrides,
    };
}

function malformedEntry(value: Record<string, unknown>): IRuntimeBinaryManifestEntry {
    return JSON.parse(JSON.stringify(value)) as IRuntimeBinaryManifestEntry;
}

function manifest(entries: readonly IRuntimeBinaryManifestEntry[] = [entry()]): IRuntimeBinaryManifest {
    return {
        entries,
        manifestSha256: computeRuntimeBinaryManifestSha256(entries),
    };
}

async function createCacheDirectory() {
    return mkdtemp(path.join(tmpdir(), 'evb-runtime-binary-'));
}

type TFetchArchiveOptions = Omit<
    Parameters<typeof fetchVerifiedRuntimeArchive>[0],
    'familyId'
>;

function fetchArchive(options: TFetchArchiveOptions) {
    return fetchVerifiedRuntimeArchive({
        ...options,
        familyId: 'qpdf',
    });
}

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, {
        force: true,
        recursive: true,
    })));
});

describe('runtime binary manifest and verified archive cache', () => {
    it('validates target rows and a distinct manifest digest', () => {
        const value = manifest();

        expect(validateRuntimeBinaryManifest(value)).toBe(value);
        expect(value.manifestSha256).not.toBe(value.entries[0]?.archiveSha256);
        expect(() => validateRuntimeBinaryManifest({
            ...value,
            manifestSha256: value.entries[0]?.archiveSha256 ?? '',
        })).toThrow('does not match');
    });

    it('rejects unsupported targets, archive kinds, and unsafe executable entries', () => {
        const invalidTarget = malformedEntry({
            ...entry(),
            target: {
                ...target,
                platform: '../../etc',
                arch: 'x64',
                platformArch: '../../etc-x64',
                exeSuffix: '',
            },
        });
        expect(() => validateRuntimeBinaryManifest(manifest([invalidTarget]))).toThrow('supported native resource target');
        const invalidArchiveKind = malformedEntry({
            ...entry(),
            archiveKind: 'rar',
        });
        expect(() => validateRuntimeBinaryManifest(manifest([invalidArchiveKind]))).toThrow('unsupported');
        expect(() => validateRuntimeBinaryManifest(manifest([entry({executableEntry: '../runtime.exe'})]))).toThrow('safe relative path');
    });

    it('rejects unsafe URLs, duplicate or empty target rows, and target mismatches', () => {
        const value = manifest();
        const cases: Array<{
            expected: string;
            entries: readonly IRuntimeBinaryManifestEntry[];
        }> = [
            {
                entries: [entry({archiveUrl: 'http://example.test/runtime.zip'})],
                expected: 'credential-free HTTPS',
            },
            {
                entries: [entry({archiveUrl: 'https://user:password@example.test/runtime.zip'})],
                expected: 'credential-free HTTPS',
            },
            {
                entries: [
                    entry(),
                    entry(),
                ],
                expected: 'duplicate family target',
            },
            {
                entries: [],
                expected: 'at least one target',
            },
            {
                entries: [entry({target: {
                    ...target,
                    exeSuffix: '',
                }})],
                expected: 'invalid executable suffix',
            },
        ];

        for (const testCase of cases) {
            expect(() => validateRuntimeBinaryManifest({
                ...value,
                entries: testCase.entries,
                manifestSha256: computeRuntimeBinaryManifestSha256(testCase.entries),
            })).toThrow(testCase.expected);
        }
    });

    it('canonicalizes target field order for manifest identity', () => {
        const reorderedTarget = {
            platformArch: target.platformArch,
            platform: target.platform,
            exeSuffix: target.exeSuffix,
            arch: target.arch,
        } as const;
        const first = entry();
        const second = entry({target: reorderedTarget});

        expect(computeRuntimeBinaryManifestSha256([first])).toBe(
            computeRuntimeBinaryManifestSha256([second]),
        );
    });

    it('includes family and byte length in the manifest identity', () => {
        const base = entry();
        expect(computeRuntimeBinaryManifestSha256([base])).not.toBe(
            computeRuntimeBinaryManifestSha256([{
                ...base,
                familyId: 'poppler',
            }]),
        );
        expect(computeRuntimeBinaryManifestSha256([base])).not.toBe(
            computeRuntimeBinaryManifestSha256([{
                ...base,
                archiveBytes: base.archiveBytes + 1,
            }]),
        );
    });

    it('rejects a missing, zero, fractional, or oversized archive length', () => {
        const {
            archiveBytes: _omitted,
            ...withoutArchiveBytes
        } = entry();
        expect(() => validateRuntimeBinaryManifest(manifest([malformedEntry(withoutArchiveBytes)]))).toThrow(
            'invalid byte length',
        );
        for (const archiveBytesValue of [
            0,
            -1,
            1.5,
            Number.MAX_SAFE_INTEGER,
        ]) {
            const invalidEntry = malformedEntry({
                ...entry(),
                archiveBytes: archiveBytesValue,
            });
            expect(() => validateRuntimeBinaryManifest(manifest([invalidEntry]))).toThrow('invalid byte length');
        }
    });

    it('rejects a missing checksum before transport or cache work', async () => {
        const parentDirectory = await createCacheDirectory();
        directories.push(parentDirectory);
        const cacheDirectory = path.join(parentDirectory, 'cache');
        const invalidEntry = entry({archiveSha256: ''});
        const transport = async () => {
            throw new Error('transport must not run');
        };

        await expect(fetchArchive({
            cacheDirectory,
            manifest: manifest([invalidEntry]),
            target,
            transport,
        })).rejects.toThrow('lowercase SHA-256');
        await expect(access(cacheDirectory)).rejects.toThrow();
    });

    it('downloads a fresh archive, verifies it, and atomically caches it', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        let calls = 0;

        const result = await fetchArchive({
            cacheDirectory,
            manifest: manifest(),
            target,
            transport: async function* (url) {
                expect(url).toBe('https://example.test/runtime.zip');
                calls += 1;
                yield archiveBytes.slice(0, 9);
                yield archiveBytes.slice(9);
            },
        });

        expect(calls).toBe(1);
        expect(await readFile(result.archivePath)).toEqual(Buffer.from(archiveBytes));
        expect((await readdir(cacheDirectory))).toEqual([path.basename(result.archivePath)]);
    });

    it('reuses a warm verified cache without transport', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        let calls = 0;
        const options = {
            cacheDirectory,
            manifest: manifest(),
            target,
            transport: async function* () {
                calls += 1;
                yield archiveBytes;
            },
        };

        await fetchArchive(options);
        await fetchArchive(options);

        expect(calls).toBe(1);
    });

    it('removes a corrupt cache and replaces it only with verified bytes', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        const first = await fetchArchive({
            cacheDirectory,
            manifest: manifest(),
            target,
            transport: async function* () {
                yield archiveBytes;
            },
        });
        await writeFile(first.archivePath, 'corrupt');
        const result = await fetchArchive({
            cacheDirectory,
            manifest: manifest(),
            target,
            transport: async function* () {
                yield archiveBytes;
            },
        });

        expect(await readFile(result.archivePath)).toEqual(Buffer.from(archiveBytes));
    });

    it('replaces a warm cache whose byte length is wrong before trusting its digest', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        let calls = 0;
        const first = await fetchArchive({
            cacheDirectory,
            manifest: manifest(),
            target,
            transport: async function* () {
                calls += 1;
                yield archiveBytes;
            },
        });
        await writeFile(first.archivePath, Buffer.concat([
            Buffer.from(archiveBytes),
            Buffer.from('extra'),
        ]));

        const result = await fetchArchive({
            cacheDirectory,
            manifest: manifest(),
            target,
            transport: async function* () {
                calls += 1;
                yield archiveBytes;
            },
        });

        expect(calls).toBe(2);
        expect(await readFile(result.archivePath)).toEqual(Buffer.from(archiveBytes));
    });

    it('cleans an interrupted download and never leaves partial bytes staged', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);

        await expect(fetchArchive({
            cacheDirectory,
            manifest: manifest(),
            target,
            transport: async function* () {
                yield archiveBytes.slice(0, 8);
                throw new Error('connection interrupted');
            },
        })).rejects.toThrow('connection interrupted');

        expect(await readdir(cacheDirectory)).toEqual([]);
    });

    it('rejects a byte-count mismatch before promoting an otherwise digest-matching stream', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        const invalidLengthEntry = entry({archiveBytes: archiveBytes.byteLength + 1});
        await expect(fetchArchive({
            cacheDirectory,
            manifest: manifest([invalidLengthEntry]),
            target,
            transport: async function* () {
                yield archiveBytes;
            },
        })).rejects.toThrow(`has ${archiveBytes.byteLength} bytes, expected ${archiveBytes.byteLength + 1}`);
        expect(await readdir(cacheDirectory)).toEqual([]);
    });

    it('stops an oversized stream before it can fill the maximum archive bound', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        const invalidLengthEntry = entry({archiveBytes: archiveBytes.byteLength - 1});
        await expect(fetchArchive({
            cacheDirectory,
            manifest: manifest([invalidLengthEntry]),
            target,
            transport: async function* () {
                yield archiveBytes;
            },
        })).rejects.toThrow('exceeded its expected');
        expect(await readdir(cacheDirectory)).toEqual([]);
    });

    it('rejects a mismatch or unavailable download without creating a cache', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        const mismatch = entry({archiveSha256: createHash('sha256').update('different').digest('hex')});
        const mismatchManifest = manifest([mismatch]);

        await expect(fetchArchive({
            cacheDirectory,
            manifest: mismatchManifest,
            target,
            transport: async function* () {
                yield archiveBytes;
            },
        })).rejects.toThrow('does not match');
        expect(await readdir(cacheDirectory)).toEqual([]);

        await expect(fetchArchive({
            cacheDirectory,
            manifest: manifest(),
            target,
            transport: async () => {
                throw new Error('download unavailable');
            },
        })).rejects.toThrow('download unavailable');
        expect(await readdir(cacheDirectory)).toEqual([]);
    });

    it('separates target and manifest identity in cache keys', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        const secondEntry = entry({archiveUrl: 'https://example.test/runtime-v2.zip'});
        const firstManifest = manifest();
        const secondManifest = manifest([secondEntry]);
        const multiTargetManifest = manifest([
            entry(),
            entry({
                archiveUrl: 'https://example.test/runtime-darwin.tar.gz',
                archiveKind: 'tar.gz',
                executableEntry: 'bin/runtime',
                target: otherTarget,
            }),
        ]);
        const urls: string[] = [];
        const transport = async function* (url: string) {
            urls.push(url);
            yield archiveBytes;
        };

        const first = await fetchArchive({
            cacheDirectory,
            manifest: firstManifest,
            target,
            transport,
        });
        const second = await fetchArchive({
            cacheDirectory,
            manifest: secondManifest,
            target,
            transport,
        });
        const other = await fetchArchive({
            cacheDirectory,
            manifest: multiTargetManifest,
            target: otherTarget,
            transport,
        });

        expect(first.archivePath).not.toBe(second.archivePath);
        expect(first.archivePath).not.toBe(other.archivePath);
        expect(urls).toEqual([
            'https://example.test/runtime.zip',
            'https://example.test/runtime-v2.zip',
            'https://example.test/runtime-darwin.tar.gz',
        ]);
        expect(multiTargetManifest.manifestSha256).not.toBe(
            firstManifest.manifestSha256,
        );
    });

    it('separates tools that share a native target by family id', async () => {
        const qpdfEntry = entry({familyId: 'qpdf'});
        const popplerEntry = entry({
            archiveUrl: 'https://example.test/poppler.zip',
            familyId: 'poppler',
        });
        const value = manifest([
            qpdfEntry,
            popplerEntry,
        ]);

        expect(validateRuntimeBinaryManifest(value)).toBe(value);
        expect(() => validateRuntimeBinaryManifest(manifest([
            qpdfEntry,
            entry({familyId: 'qpdf'}),
        ]))).toThrow('duplicate family target');

        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        const qpdf = await fetchVerifiedRuntimeArchive({
            cacheDirectory,
            familyId: 'qpdf',
            manifest: value,
            target,
            transport: async function* (url) {
                expect(url).toBe(qpdfEntry.archiveUrl);
                yield archiveBytes;
            },
        });
        const poppler = await fetchVerifiedRuntimeArchive({
            cacheDirectory,
            familyId: 'poppler',
            manifest: value,
            target,
            transport: async function* (url) {
                expect(url).toBe(popplerEntry.archiveUrl);
                yield archiveBytes;
            },
        });

        expect(qpdf.archivePath).not.toBe(poppler.archivePath);
    });

    it('keeps concurrent downloads isolated until verified promotion', async () => {
        const cacheDirectory = await createCacheDirectory();
        directories.push(cacheDirectory);
        let releaseFirstChunk: (() => void) | undefined;
        const firstChunkReady = new Promise<void>(resolve => {
            releaseFirstChunk = resolve;
        });
        let firstGeneratorEntered: (() => void) | undefined;
        const firstGeneratorReady = new Promise<void>(resolve => {
            firstGeneratorEntered = resolve;
        });
        let calls = 0;
        const transport = (url: string) => {
            calls += 1;
            const invocation = calls;
            return (async function* () {
                if (invocation === 1) {
                    firstGeneratorEntered?.();
                }
                expect(url).toBe('https://example.test/runtime.zip');
                yield archiveBytes.slice(0, 8);
                if (invocation === 1) {
                    await firstChunkReady;
                }
                yield archiveBytes.slice(8);
            })();
        };

        const first = fetchArchive({
            cacheDirectory,
            manifest: manifest(),
            target,
            transport,
        });
        await firstGeneratorReady;
        const second = fetchArchive({
            cacheDirectory,
            manifest: manifest(),
            target,
            transport,
        });
        releaseFirstChunk?.();
        const [
            firstResult,
            secondResult,
        ] = await Promise.all([
            first,
            second,
        ]);

        expect(calls).toBe(2);
        expect(firstResult.archivePath).toBe(secondResult.archivePath);
        expect(await readFile(firstResult.archivePath)).toEqual(Buffer.from(archiveBytes));
        expect((await readdir(cacheDirectory)).filter(name => name.includes('.part-'))).toEqual([]);
    });
});
