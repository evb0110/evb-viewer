import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
    mkdtemp,
    rm,
    mkdir,
    readFile,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    generateReleaseChecksums,
    parseChecksumManifest,
    validateReleaseAssetNames,
    verifyReleaseChecksums,
} from '@scripts/release/release-checksums.mjs';

const sha256 = (contents: string) => createHash('sha256').update(contents).digest('hex');

describe('release checksum manifest', () => {
    it('generates deterministic checksums for the exact release asset set and verifies them', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-'));
        await writeFile(join(directory, 'z archive.zip'), 'zip');
        await writeFile(join(directory, 'EVB Viewer.exe'), 'exe');

        const generated = await generateReleaseChecksums(directory);

        expect(generated.assetNames).toEqual([
            'EVB Viewer.exe',
            'z archive.zip',
        ]);
        expect(await readFile(join(directory, 'SHA256SUMS'), 'utf8')).toBe([
            `${sha256('exe')}  EVB Viewer.exe`,
            `${sha256('zip')}  z archive.zip`,
            '',
        ].join('\n'));
        await expect(verifyReleaseChecksums(directory)).resolves.toEqual({assetNames: [
            'EVB Viewer.exe',
            'z archive.zip',
        ]});
    });

    it('rejects changed bytes and both missing and unlisted release assets', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-tamper-'));
        await writeFile(join(directory, 'asset.zip'), 'original');
        await generateReleaseChecksums(directory);
        await writeFile(join(directory, 'asset.zip'), 'tampered');
        await expect(verifyReleaseChecksums(directory)).rejects.toThrow(
            'Checksum mismatch for release asset: asset.zip',
        );

        await writeFile(join(directory, 'asset.zip'), 'original');
        await writeFile(join(directory, 'extra.dmg'), 'extra');
        await expect(verifyReleaseChecksums(directory)).rejects.toThrow(
            'missing: extra.dmg; unexpected: (none)',
        );

        await writeFile(join(directory, 'SHA256SUMS'), [
            `${sha256('original')}  asset.zip`,
            `${sha256('ghost')}  ghost.AppImage`,
            '',
        ].join('\n'));
        await expect(verifyReleaseChecksums(directory)).rejects.toThrow(
            'missing: extra.dmg; unexpected: ghost.AppImage',
        );
    });

    it('tolerates unlisted supplemental assets attached after finalization but verifies listed ones', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-supplemental-'));
        await writeFile(join(directory, 'asset.zip'), 'core');
        await generateReleaseChecksums(directory);

        // Supplemental macOS Intel and Windows ARM assets attach after
        // promotion, outside SHA256SUMS.
        await writeFile(join(directory, 'EVB-Viewer-0.1.427-x64.zip'), 'intel');
        await writeFile(join(directory, 'EVB-Viewer-0.1.427-arm64-setup.exe'), 'windows-arm');
        await writeFile(
            join(directory, 'EVB-Viewer-0.1.427-win-arm64-provenance.json'),
            'windows-arm-provenance',
        );
        await expect(verifyReleaseChecksums(directory)).resolves.toEqual({assetNames: [
            'EVB-Viewer-0.1.427-arm64-setup.exe',
            'EVB-Viewer-0.1.427-win-arm64-provenance.json',
            'EVB-Viewer-0.1.427-x64.zip',
            'asset.zip',
        ]});

        // With the release version pinned, only that release's exact asset
        // name is exempt from the manifest.
        await expect(verifyReleaseChecksums(directory, {releaseVersion: '0.1.427'}))
            .resolves.toEqual({assetNames: [
                'EVB-Viewer-0.1.427-arm64-setup.exe',
                'EVB-Viewer-0.1.427-win-arm64-provenance.json',
                'EVB-Viewer-0.1.427-x64.zip',
                'asset.zip',
            ]});
        await expect(verifyReleaseChecksums(directory, {releaseVersion: '0.1.428'}))
            .rejects.toThrow(
                'missing: EVB-Viewer-0.1.427-arm64-setup.exe, '
                + 'EVB-Viewer-0.1.427-win-arm64-provenance.json, '
                + 'EVB-Viewer-0.1.427-x64.zip; unexpected: (none)',
            );

        // A supplemental asset that made it into the manifest is still
        // hash-verified like any other listed asset.
        await writeFile(join(directory, 'SHA256SUMS'), [
            `${sha256('core')}  asset.zip`,
            `${sha256('not-intel')}  EVB-Viewer-0.1.427-x64.zip`,
            '',
        ].join('\n'));
        await expect(verifyReleaseChecksums(directory)).rejects.toThrow(
            'Checksum mismatch for release asset: EVB-Viewer-0.1.427-x64.zip',
        );
    });

    it('rejects duplicate, traversing, ambiguous, and malformed manifest basenames', () => {
        expect(() => parseChecksumManifest([
            `${sha256('a')}  Asset.zip`,
            `${sha256('b')}  asset.zip`,
            '',
        ].join('\n'))).toThrow('Duplicate release asset basename');
        expect(() => parseChecksumManifest(`${sha256('a')}  ../asset.zip\n`)).toThrow(
            'Unsafe release asset basename',
        );
        expect(() => parseChecksumManifest(`${sha256('a')}  SHA256sums\n`)).toThrow(
            'Unsafe release asset basename',
        );
        expect(() => parseChecksumManifest(`${sha256('a')} *asset.zip\n`)).toThrow(
            'Invalid SHA256SUMS line',
        );
        expect(() => parseChecksumManifest(`${sha256('a')}  asset.zip`)).toThrow(
            'end with a newline',
        );
    });

    it('rejects non-portable duplicate asset filenames without relying on filesystem case sensitivity', () => {
        expect(() => validateReleaseAssetNames([
            'Asset.zip',
            'asset.zip',
        ])).toThrow(
            'Release asset basenames are not portable and unique',
        );
    });

    it('rejects an empty asset-name list without assuming a filesystem caller', () => {
        expect(() => validateReleaseAssetNames([])).toThrow(
            'Release asset names must not be empty',
        );
    });

    it('propagates regular-file basename policy through checksum generation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-unsafe-name-'));
        await writeFile(join(directory, 'asset.zip '), 'asset');

        await expect(generateReleaseChecksums(directory)).rejects.toThrow(
            'Unsafe release asset basename: "asset.zip "',
        );
    });

    it('rejects non-regular entries in real artifact directories', async () => {
        const nestedDirectory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-nested-'));
        await writeFile(join(nestedDirectory, 'asset.zip'), 'asset');
        await mkdir(join(nestedDirectory, 'nested '));
        await expect(generateReleaseChecksums(nestedDirectory)).rejects.toThrow(
            'Release artifact must be a regular file: "nested "',
        );

        const linkedDirectory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-link-'));
        await writeFile(join(linkedDirectory, 'asset.zip'), 'asset');
        await symlink(join(linkedDirectory, 'asset.zip'), join(linkedDirectory, 'linked.zip '));
        await expect(generateReleaseChecksums(linkedDirectory)).rejects.toThrow(
            'Release artifact must be a regular file: "linked.zip "',
        );
    });

    it.skipIf(process.platform === 'win32')('rejects unsafe Unix socket entries as non-regular files', async () => {
        // A Unix socket path is capped near 104 bytes; a long TMPDIR cannot
        // hold one, so the socket fixture falls back to the system /tmp.
        const socketRoot = Buffer.byteLength(join(tmpdir(), 'evb-release-checksums-socket-XXXXXX', 'release.sock ')) <= 100
            ? tmpdir()
            : '/tmp';
        const socketDirectory = await mkdtemp(join(socketRoot, 'evb-release-checksums-socket-'));
        await writeFile(join(socketDirectory, 'asset.zip'), 'asset');
        const socketPath = join(socketDirectory, 'release.sock ');
        const server = createServer();
        server.listen(socketPath);
        await once(server, 'listening');
        try {
            await expect(generateReleaseChecksums(socketDirectory)).rejects.toThrow(
                'Release artifact must be a regular file: "release.sock "',
            );
        } finally {
            const closePromise = once(server, 'close');
            server.close();
            await closePromise;
            await rm(socketDirectory, {
                recursive: true,
                force: true,
            });
        }
    });
});
