import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';

const policy = await import(pathToFileURL(resolve('scripts/release/policy.mjs')).href);
const integrity = await import(pathToFileURL(resolve('scripts/release/assert-updater-artifact-integrity.mjs')).href);

describe('updater artifact transition policy', () => {
    it('hashes updater artifacts incrementally across chunk boundaries', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-updater-integrity-'));
        const artifactPath = join(directory, 'artifact.bin');
        const artifact = Buffer.alloc(1024 * 1024 + 17, 0x5a);
        try {
            await writeFile(artifactPath, artifact);
            expect(integrity.calculateArtifactSha512(artifactPath)).toBe(createHash('sha512').update(artifact).digest('base64'));
        } finally {
            await rm(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('requires updater metadata to advertise the release version', () => {
        const artifacts = ['latest.yml', 'EVB Viewer Setup 0.1.388.exe'];
        const readMetadata = () => ['version: 0.1.387', 'path: EVB Viewer Setup 0.1.388.exe'].join('\n');

        expect(() => policy.assertUpdaterMetadataVersion(artifacts, readMetadata, '0.1.388')).toThrow('expected 0.1.388, got 0.1.387');
    });

    it('validates every updater entry size and SHA-512 against the exact artifact bytes', () => {
        const artifact = Buffer.from('signed-installer-bytes');
        const sha512 = createHash('sha512').update(artifact).digest('base64');
        const metadata = [
            'version: 0.1.388',
            'files:',
            '  - url: EVB-Viewer-0.1.388.zip',
            `    sha512: ${sha512}`,
            `    size: ${artifact.byteLength}`,
            'path: EVB-Viewer-0.1.388.zip',
            `sha512: ${sha512}`,
        ].join('\n');
        const baseOptions = {
            artifactNames: ['latest-mac.yml', 'EVB-Viewer-0.1.388.zip'],
            artifactsDir: '/unused',
            readMetadataText: () => metadata,
        };

        expect(() =>
            integrity.assertUpdaterArtifactIntegrity({
                ...baseOptions,
                readArtifactInfo: () => ({
                    sha512,
                    size: artifact.byteLength,
                }),
            }),
        ).not.toThrow();
        expect(() =>
            integrity.assertUpdaterArtifactIntegrity({
                ...baseOptions,
                readArtifactInfo: () => ({
                    sha512: 'stale',
                    size: artifact.byteLength,
                }),
            }),
        ).toThrow('Updater SHA-512 mismatch');
        expect(() =>
            integrity.assertUpdaterArtifactIntegrity({
                ...baseOptions,
                readArtifactInfo: () => ({
                    sha512,
                    size: artifact.byteLength + 1,
                }),
            }),
        ).toThrow('Updater size mismatch');
    });

    it('rejects top-level updater metadata that disagrees with files entries', () => {
        const artifact = Buffer.from('signed-installer-bytes');
        const sha512 = createHash('sha512').update(artifact).digest('base64');
        const createMetadata = (path: string, topLevelSha512: string) =>
            [
                'version: 0.1.388',
                'files:',
                '  - url: EVB-Viewer-0.1.388.zip',
                `    sha512: ${sha512}`,
                `    size: ${artifact.byteLength}`,
                `path: ${path}`,
                `sha512: ${topLevelSha512}`,
            ].join('\n');
        const assertMetadata = (metadata: string) =>
            integrity.assertUpdaterArtifactIntegrity({
                artifactNames: ['latest-mac.yml', 'EVB-Viewer-0.1.388.zip'],
                artifactsDir: '/unused',
                readArtifactInfo: () => ({
                    sha512,
                    size: artifact.byteLength,
                }),
                readMetadataText: () => metadata,
            });

        expect(() => assertMetadata(createMetadata('stale.zip', sha512))).toThrow('top-level artifact metadata is inconsistent');
        expect(() => assertMetadata(createMetadata('EVB-Viewer-0.1.388.zip', 'stale'))).toThrow(
            'top-level artifact metadata is inconsistent',
        );
    });
});
