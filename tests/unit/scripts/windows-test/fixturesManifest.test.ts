import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import type { IWindowsFixtureManifest } from '@scripts/windows-test/fixtures/fixtureManifest';
import {
    WINDOWS_FIXTURE_PACK_ID_PATTERN,
    collectFixturePackIds,
    computeFixtureManifestSha256,
    findFixturePack,
    isWindowsFixtureManifest,
    loadFixtureManifest,
    verifyFixturePack,
} from '@scripts/windows-test/fixtures/fixtureManifest';
import { runWindowsFixtureGeneration } from '@scripts/windows-test/fixtures/generateWindowsFixturesCli';

const repositoryRoot = process.cwd();

const fixtureDirectory = path.join(repositoryRoot, 'tests', 'windows', 'fixtures');

const manifestPath = path.join(fixtureDirectory, 'manifest.json');

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), 'evb-windows-manifest-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterAll(async () => {
    for (const directory of temporaryDirectories) {
        await rm(directory, {
            recursive: true,
            force: true,
        });
    }
});

let manifest: IWindowsFixtureManifest;

beforeAll(async () => {
    manifest = await loadFixtureManifest(manifestPath);
});

describe('tests/windows/fixtures/manifest.json', () => {
    it('declares every pack from F01 to F10', () => {
        expect(collectFixturePackIds(manifest)).toEqual([
            'F01',
            'F02',
            'F03',
            'F04',
            'F05',
            'F06',
            'F07',
            'F08',
            'F10',
            'F09',
        ]);
        for (const packId of collectFixturePackIds(manifest)) {
            expect(WINDOWS_FIXTURE_PACK_ID_PATTERN.test(packId)).toBe(true);
        }
    });

    it('gives every pack a purpose, provenance, license and publishable flag', () => {
        for (const pack of manifest.packs) {
            expect(pack.name.length).toBeGreaterThan(0);
            expect(pack.purpose.length).toBeGreaterThan(0);
            expect(pack.provenance.length).toBeGreaterThan(0);
            expect(pack.variants.length).toBeGreaterThan(0);
            expect(typeof pack.publishable).toBe('boolean');
        }
    });

    it('uses unique file IDs across every pack', () => {
        const ids = manifest.packs.flatMap(pack => pack.files.map(file => file.id));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('records the sha256 and byte size the generators actually produce', async () => {
        const generation = await runWindowsFixtureGeneration({
            outputDirectory: path.join(fixtureDirectory, 'generated'),
            write: false,
            relativeTo: fixtureDirectory,
        });
        const declared = new Map(
            manifest.packs
                .flatMap(pack => pack.files)
                .filter(file => file.generated)
                .map(file => [
                    file.id,
                    file,
                ]),
        );
        expect(declared.size).toBe(generation.entries.length);
        for (const entry of generation.entries) {
            const file = declared.get(entry.fixtureId);
            expect(file, entry.fixtureId).toBeDefined();
            expect(file?.path).toBe(entry.relativePath);
            expect(file?.bytes).toBe(entry.bytes);
            expect(file?.sha256).toBe(entry.sha256);
        }
    });

    it('verifies every tracked file and skips the files that are generated on demand', async () => {
        const result = await verifyFixturePack(fixtureDirectory, manifest);
        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.verified).toEqual(expect.arrayContaining([
            'F03-generated-text',
            'F03-test-scanned',
        ]));
        expect(result.skipped).toEqual(expect.arrayContaining(['F01-numbered-12p']));
    });

    it('finds a pack by ID and reports an unknown one', () => {
        expect(findFixturePack(manifest, 'F01')?.name.length).toBeGreaterThan(0);
        expect(findFixturePack(manifest, 'F42')).toBeNull();
    });
});

describe('computeFixtureManifestSha256', () => {
    it('is stable and ignores prose', () => {
        const baseline = computeFixtureManifestSha256(manifest);
        expect(computeFixtureManifestSha256(manifest)).toBe(baseline);
        const reworded: IWindowsFixtureManifest = {
            ...manifest,
            packs: manifest.packs.map(pack => ({
                ...pack,
                purpose: `${pack.purpose} (reworded)`,
            })),
        };
        expect(computeFixtureManifestSha256(reworded)).toBe(baseline);
    });

    it('changes when a fixture hash or size changes', () => {
        const baseline = computeFixtureManifestSha256(manifest);
        const mutated: IWindowsFixtureManifest = {
            ...manifest,
            packs: manifest.packs.map(pack => ({
                ...pack,
                files: pack.files.map(file => ({
                    ...file,
                    bytes: file.bytes + 1,
                })),
            })),
        };
        expect(computeFixtureManifestSha256(mutated)).not.toBe(baseline);
    });
});

describe('isWindowsFixtureManifest', () => {
    it('rejects a wrong schema version, a bad pack ID and a malformed hash', () => {
        expect(isWindowsFixtureManifest(manifest)).toBe(true);
        expect(isWindowsFixtureManifest({
            ...manifest,
            schemaVersion: 2,
        })).toBe(false);
        expect(isWindowsFixtureManifest({
            schemaVersion: 1,
            packs: [{
                ...manifest.packs[0],
                id: 'FIXTURE-1',
            }],
        })).toBe(false);
        expect(isWindowsFixtureManifest({
            schemaVersion: 1,
            packs: [{
                ...manifest.packs[0],
                files: [{
                    id: 'bad',
                    path: 'bad.pdf',
                    bytes: 1,
                    sha256: 'not-a-hash',
                    expectedPages: null,
                    markers: [],
                    generated: true,
                }],
            }],
        })).toBe(false);
        expect(isWindowsFixtureManifest(null)).toBe(false);
    });
});

describe('loadFixtureManifest', () => {
    it('reports invalid JSON and a schema mismatch', async () => {
        const directory = await createTemporaryDirectory();
        const badJson = path.join(directory, 'bad.json');
        await writeFile(badJson, '{');
        await expect(loadFixtureManifest(badJson)).rejects.toThrow(/is not valid JSON/u);
        const wrongShape = path.join(directory, 'wrong.json');
        await writeFile(wrongShape, JSON.stringify({
            schemaVersion: 1,
            packs: [{ id: 'F01' }],
        }));
        await expect(loadFixtureManifest(wrongShape)).rejects.toThrow(/does not match the expected schema/u);
    });
});

describe('verifyFixturePack', () => {
    async function writeSample(directory: string) {
        await mkdir(path.join(directory, 'generated'), { recursive: true });
        await writeFile(path.join(directory, 'generated', 'sample.pdf'), 'hello');
    }

    function sampleManifest(overrides: Partial<IWindowsFixtureManifest['packs'][number]['files'][number]>) {
        const sample: IWindowsFixtureManifest = {
            schemaVersion: 1,
            packs: [{
                id: 'F01',
                name: 'Sample',
                purpose: 'Sample pack for verification tests.',
                license: 'synthetic',
                publishable: true,
                provenance: 'test',
                variants: ['default'],
                metadata: {},
                files: [{
                    id: 'sample',
                    path: 'generated/sample.pdf',
                    bytes: 5,
                    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
                    expectedPages: null,
                    markers: [],
                    generated: true,
                    ...overrides,
                }],
            }],
        };
        return sample;
    }

    it('accepts a file whose size and hash match', async () => {
        const directory = await createTemporaryDirectory();
        await writeSample(directory);
        const result = await verifyFixturePack(directory, sampleManifest({}));
        expect(result.ok).toBe(true);
        expect(result.verified).toEqual(['sample']);
    });

    it('reports a size mismatch and a hash mismatch', async () => {
        const directory = await createTemporaryDirectory();
        await writeSample(directory);
        const sizeResult = await verifyFixturePack(directory, sampleManifest({ bytes: 9 }));
        expect(sizeResult.ok).toBe(false);
        expect(sizeResult.problems[0]?.message).toMatch(/is 5 bytes, expected 9/u);
        const hashResult = await verifyFixturePack(directory, sampleManifest({sha256: '0'.repeat(64)}));
        expect(hashResult.ok).toBe(false);
        expect(hashResult.problems[0]?.message).toMatch(/hashes to /u);
    });

    it('skips a missing generated file but fails a missing tracked file', async () => {
        const directory = await createTemporaryDirectory();
        const skipped = await verifyFixturePack(directory, sampleManifest({}));
        expect(skipped.ok).toBe(true);
        expect(skipped.skipped).toEqual(['sample']);
        const missing = await verifyFixturePack(directory, sampleManifest({ generated: false }));
        expect(missing.ok).toBe(false);
        expect(missing.problems[0]?.message).toMatch(/is missing/u);
    });

    it('skips a file whose hash is deliberately not pinned', async () => {
        const directory = await createTemporaryDirectory();
        await writeSample(directory);
        const result = await verifyFixturePack(directory, sampleManifest({ sha256: null }));
        expect(result.skipped).toEqual(['sample']);
    });

    it('reports a requested pack that the manifest does not declare', async () => {
        const directory = await createTemporaryDirectory();
        await writeSample(directory);
        const result = await verifyFixturePack(directory, sampleManifest({}), ['F09']);
        expect(result.ok).toBe(false);
        expect(result.problems).toEqual([{
            fixtureId: 'F09',
            message: 'Fixture pack is not declared in the manifest.',
        }]);
    });

    it('rejects a path that is a directory rather than a file', async () => {
        const directory = await createTemporaryDirectory();
        await mkdir(path.join(directory, 'generated', 'sample.pdf'), { recursive: true });
        const result = await verifyFixturePack(directory, sampleManifest({}));
        expect(result.ok).toBe(false);
        expect(result.problems[0]?.message).toMatch(/is not a regular file/u);
    });
});
