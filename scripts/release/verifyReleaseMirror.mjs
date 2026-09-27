#!/usr/bin/env node

import {
    GetObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createMirrorClient} from './publish-release-mirror.mjs';
import {
    DEFAULT_UPDATES_MIRROR_METADATA_URL,
    DEFAULT_UPDATES_MIRROR_RELEASE_BASE_URL,
} from '../../packages/contracts/updateMirrorDefaults.mjs';

/** @param {string} url @param {string} runId @returns {string} */
function mirrorUrl(url, runId) {
    return url.replace('evb-viewer/channels/stable.json', `evb-viewer/drill/${runId}/channels/stable.json`)
        .replace('evb-viewer/releases', `evb-viewer/drill/${runId}/releases`);
}

/** @param {string} url @param {typeof fetch} [fetchFn] @returns {Promise<Response>} */
async function readPublic(url, fetchFn = fetch) {
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return response;
}

/** @param {{tag: string, drillRunId?: string, env?: NodeJS.ProcessEnv, fetchFn?: typeof fetch, createMirrorClientFn?: typeof createMirrorClient}} options */
async function verifyMirrorObjects({
    tag, drillRunId, env = process.env, fetchFn = fetch, createMirrorClientFn = createMirrorClient,
}) {
    const metadataUrl = drillRunId
        ? mirrorUrl(DEFAULT_UPDATES_MIRROR_METADATA_URL, drillRunId)
        : DEFAULT_UPDATES_MIRROR_METADATA_URL;
    const releaseBase = drillRunId
        ? mirrorUrl(DEFAULT_UPDATES_MIRROR_RELEASE_BASE_URL, drillRunId)
        : DEFAULT_UPDATES_MIRROR_RELEASE_BASE_URL;
    let metadata;
    let manifest;
    let assetUrl;
    let publicRoute = true;
    try {
        const channelResponse = await readPublic(metadataUrl, fetchFn);
        metadata = await channelResponse.json();
        if (metadata?.release?.tag !== tag) throw new Error(`Mirror channel points to ${metadata?.release?.tag ?? 'no tag'}, expected ${tag}`);
        const manifestResponse = await readPublic(`${releaseBase}/${encodeURIComponent(tag)}/manifest.json`, fetchFn);
        manifest = await manifestResponse.json();
        if (manifest?.release?.tag !== tag) throw new Error(`Mirror release object points to ${manifest?.release?.tag ?? 'no tag'}, expected ${tag}`);
        const asset = manifest.assets?.[0]?.name;
        if (typeof asset !== 'string') throw new Error('Mirror channel has no release asset');
        assetUrl = `${releaseBase}/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
        let assetResponse = await fetchFn(assetUrl, {method: 'HEAD'});
        if (!assetResponse.ok) assetResponse = await fetchFn(assetUrl, {headers: {Range: 'bytes=0-0'}});
        if (!assetResponse.ok) throw new Error(`Mirror release asset returned HTTP ${assetResponse.status}`);
    } catch (error) {
        if (!drillRunId) throw error;
        publicRoute = false;
        const {
            bucket, client,
        } = createMirrorClientFn(env);
        const channelKey = `evb-viewer/drill/${drillRunId}/channels/stable.json`;
        const releaseKey = `evb-viewer/drill/${drillRunId}/releases/${tag}`;
        const channelObject = await client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: channelKey,
        }));
        if (!channelObject.Body) throw new Error('Drill mirror channel object has no body');
        metadata = JSON.parse(await channelObject.Body.transformToString());
        if (metadata?.release?.tag !== tag) throw new Error(`Drill mirror channel points to ${metadata?.release?.tag ?? 'no tag'}, expected ${tag}`);
        const manifestObject = await client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: `${releaseKey}/manifest.json`,
        }));
        if (!manifestObject.Body) throw new Error('Drill mirror release object has no body');
        manifest = JSON.parse(await manifestObject.Body.transformToString());
        if (manifest?.release?.tag !== tag) throw new Error(`Drill mirror release object points to ${manifest?.release?.tag ?? 'no tag'}, expected ${tag}`);
        const asset = manifest.assets?.[0]?.name;
        if (typeof asset !== 'string') throw new Error('Drill mirror release object has no asset');
        await client.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: `${releaseKey}/${asset}`,
        }));
    }
    if (manifest?.release?.tag !== tag) throw new Error(`Mirror release object does not name ${tag}`);
    return {
        publicRoute,
        tag,
    };
}

/** @param {string} tag @param {{repository?: string, drillRunId?: string, fetchFn?: typeof fetch, env?: NodeJS.ProcessEnv, createMirrorClientFn?: typeof createMirrorClient}} [options] */
async function verify(tag, {
    repository = process.env.GITHUB_REPOSITORY, drillRunId, fetchFn = fetch, env = process.env, createMirrorClientFn,
} = {}) {
    if (!tag || !repository) throw new Error('Expected a release tag and GITHUB_REPOSITORY');
    if (!drillRunId) {
        const response = await readPublic(`https://api.github.com/repos/${repository}/releases/latest`, fetchFn);
        const release = await response.json();
        if (tag !== '--latest' && release.tag_name !== tag) throw new Error(`GitHub latest release is ${release.tag_name ?? 'missing'}, expected ${tag}`);
        if (tag === '--latest') tag = release.tag_name;
    }
    return verifyMirrorObjects({
        tag,
        ...(drillRunId ? {drillRunId} : {}),
        fetchFn,
        env,
        ...(createMirrorClientFn ? {createMirrorClientFn} : {}),
    });
}

export {
    verify, verifyMirrorObjects,
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const [
        tag,
        drillFlag,
        runId,
    ] = process.argv.slice(2);
    try {
        if (!tag) throw new Error('Usage: verifyReleaseMirror.mjs <release tag|--latest> [--drill <run id>]');
        const result = await verify(tag, drillFlag === '--drill' && runId ? {drillRunId: runId} : {});
        process.stdout.write(result.publicRoute
            ? `Public GitHub and updater mirror both serve ${tag}.\n`
            : `Drill mirror HTTP route does not serve the isolated prefix; mirror client verified channel, release manifest, and asset for ${tag}.\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
