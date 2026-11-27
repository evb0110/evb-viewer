import {getCliErrorMessage} from '../lib/cli-error.mjs';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashFile} from './release-hash.mjs';
import {DRILL_TAG_PATTERN, RELEASE_TAG_PATTERN} from './releaseTag.mjs';

/** @typedef {(args: string[]) => string} TGitHubCliRunner */
/** @typedef {{assets?: Array<{name?: unknown}>}} IReleasePayload */

/** @param {string[]} args @returns {string} */
function runGh(args) {
    return String(
        execFileSync('gh', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'inherit'],
        }),
    );
}

/** @param {string} localPath @param {string} remotePath @returns {Promise<string>} */
export async function assertImmutableAsset(localPath, remotePath) {
    const [localHash, remoteHash] = await Promise.all([hashFile(localPath), hashFile(remotePath)]);
    if (localHash !== remoteHash) {
        throw new Error(`Immutable release asset mismatch for ${path.basename(localPath)}: local=${localHash} remote=${remoteHash}`);
    }
    return localHash;
}

/** @param {string} repo @param {string} tag @param {TGitHubCliRunner} [run] @returns {Set<string>} */
export function getReleaseAssetNames(repo, tag, run = runGh) {
    /** @type {IReleasePayload} */
    const release = JSON.parse(run(['release', 'view', tag, '--repo', repo, '--json', 'assets']));
    return new Set((release.assets ?? []).flatMap((asset) => (typeof asset.name === 'string' ? [asset.name] : [])));
}

/** @param {string} repo @param {string} tag @param {string} assetName @param {string} temporaryRoot @returns {string} */
function downloadReleaseAsset(repo, tag, assetName, temporaryRoot) {
    const remotePath = path.join(temporaryRoot, assetName);
    if (existsSync(remotePath)) {
        rmSync(remotePath, {force: true});
    }
    runGh(['release', 'download', tag, '--repo', repo, '--pattern', assetName, '--dir', temporaryRoot]);
    if (!existsSync(remotePath)) {
        throw new Error(`GitHub release asset ${assetName} was listed but could not be downloaded for comparison.`);
    }
    return remotePath;
}

/**
 * @param {{assetPaths?: string[], drill?: boolean, repo?: string, tag?: string | undefined}} options
 */
export async function ensureGithubReleaseAssets({assetPaths, drill = false, repo = process.env.GH_REPO, tag} = {}) {
    if (!repo) {
        throw new Error('GH_REPO is required when checking immutable release assets.');
    }
    const tagPattern = drill ? DRILL_TAG_PATTERN : RELEASE_TAG_PATTERN;
    if (!tag || !tagPattern.test(tag) || !Array.isArray(assetPaths) || assetPaths.length === 0) {
        throw new Error('Usage: ensure-github-release-assets.mjs <tag> <asset> [asset...]');
    }

    const assetNames = getReleaseAssetNames(repo, tag);
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-asset-'));
    try {
        for (const assetPath of assetPaths) {
            if (!existsSync(assetPath)) {
                throw new Error(`Release asset is missing locally: ${assetPath}`);
            }

            const assetName = path.basename(assetPath);
            if (assetNames.has(assetName)) {
                const remotePath = downloadReleaseAsset(repo, tag, assetName, temporaryRoot);
                await assertImmutableAsset(assetPath, remotePath);
                console.log(`Immutable release asset already matches: ${assetName}`);
                continue;
            }

            runGh(['release', 'upload', tag, assetPath, '--repo', repo]);
            const remotePath = downloadReleaseAsset(repo, tag, assetName, temporaryRoot);
            await assertImmutableAsset(assetPath, remotePath);
            console.log(`Uploaded and verified immutable release asset: ${assetName}`);
            assetNames.add(assetName);
        }
    } finally {
        rmSync(temporaryRoot, {
            force: true,
            recursive: true,
        });
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    try {
        const [tag, ...assetPaths] = process.argv.slice(2);
        const drill = assetPaths.at(-1) === '--drill';
        if (drill) {
            assetPaths.pop();
        }
        await ensureGithubReleaseAssets({
            assetPaths,
            drill,
            tag,
        });
    } catch (error) {
        console.error(getCliErrorMessage(error));
        process.exitCode = 1;
    }
}
