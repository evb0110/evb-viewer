import {afterEach, describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {assertImmutableAsset, ensureGithubReleaseAssets, getReleaseAssetNames} from '@scripts/release/ensure-github-release-assets.mjs';

const directories: string[] = [];

afterEach(async () =>
    Promise.all(
        directories.splice(0).map((directory) =>
            rm(directory, {
                force: true,
                recursive: true,
            }),
        ),
    ),
);

describe('immutable GitHub release assets', () => {
    it('looks up draft releases through gh release view', () => {
        const calls: string[][] = [];
        const assetNames = getReleaseAssetNames('evb0110/evb-viewer', 'v0.1.444', (args) => {
            calls.push(args);
            return JSON.stringify({assets: [{name: 'EVB-Viewer-0.1.444-arm64.dmg'}, {name: 'SHA256SUMS'}]});
        });

        expect(calls).toEqual([['release', 'view', 'v0.1.444', '--repo', 'evb0110/evb-viewer', '--json', 'assets']]);
        expect([...assetNames]).toEqual(['EVB-Viewer-0.1.444-arm64.dmg', 'SHA256SUMS']);
    });

    it('accepts byte-identical retries', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-immutable-assets-'));
        directories.push(directory);
        const localPath = join(directory, 'local.zip');
        const remotePath = join(directory, 'remote.zip');
        await writeFile(localPath, 'release bytes\n');
        await writeFile(remotePath, 'release bytes\n');

        await expect(assertImmutableAsset(localPath, remotePath)).resolves.toMatch(/^[a-f\d]{64}$/u);
    });

    it('rejects a same-name replacement with different bytes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-immutable-assets-'));
        directories.push(directory);
        const localPath = join(directory, 'local.zip');
        const remotePath = join(directory, 'remote.zip');
        await writeFile(localPath, 'new release bytes\n');
        await writeFile(remotePath, 'old release bytes\n');

        await expect(assertImmutableAsset(localPath, remotePath)).rejects.toThrow('Immutable release asset mismatch');
    });

    it('rejects release tags outside the shared release-tag grammar', async () => {
        await expect(
            ensureGithubReleaseAssets({
                assetPaths: ['missing.dmg'],
                repo: 'evb0110/evb-viewer',
                tag: '../latest',
            }),
        ).rejects.toThrow('Usage: ensure-github-release-assets.mjs');
    });

    it('keeps drill tags opt-in and separate from production tags', async () => {
        await expect(
            ensureGithubReleaseAssets({
                assetPaths: ['missing.dmg'],
                drill: true,
                repo: 'evb0110/evb-viewer',
                tag: 'v1.2.3',
            }),
        ).rejects.toThrow('Usage: ensure-github-release-assets.mjs');
        await expect(
            ensureGithubReleaseAssets({
                assetPaths: ['missing.dmg'],
                repo: 'evb0110/evb-viewer',
                tag: 'v0.0.0-drill.42',
            }),
        ).rejects.toThrow('Usage: ensure-github-release-assets.mjs');
    });

    it('loads without the optional S3 mirror dependency in a clean checkout', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-release-asset-import-'));
        directories.push(directory);
        const scriptsDirectory = join(process.cwd(), 'scripts');
        const copiedScripts = [
            'release/ensure-github-release-assets.mjs',
            'release/policy.mjs',
            'release/publish-release-mirror.mjs',
            'release/release-hash.mjs',
            'release/releaseTag.mjs',
            'lib/cli-error.mjs',
        ];
        await Promise.all([mkdir(join(directory, 'release')), mkdir(join(directory, 'lib'))]);
        await Promise.all(copiedScripts.map((name) => copyFile(join(scriptsDirectory, name), join(directory, name))));

        const output = execFileSync(
            process.execPath,
            [
                '--input-type=module',
                '--eval',
                'await import(process.argv[1]); process.stdout.write("loaded")',
                pathToFileURL(join(directory, 'release', 'ensure-github-release-assets.mjs')).href,
            ],
            {encoding: 'utf8'},
        );

        expect(output).toBe('loaded');
    });
});
