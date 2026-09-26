#!/usr/bin/env node

import {getCliErrorMessage} from '../lib/cli-error.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {listWorkflowRuns} from './github-workflow-run.mjs';
import {run} from './shared.mjs';

const MIRROR_CHANNEL_KEY = 'evb-viewer/channels/stable.json';
/** @param {string} version */
const REQUIRED_ASSETS = version => [
    `EVB-Viewer-${version}-arm64.dmg`,
    `EVB-Viewer-${version}-arm64.zip`,
    'latest-mac.yml',
    `EVB-Viewer-${version}-x64-setup.exe`,
    `EVB-Viewer-${version}-arm64-setup.exe`,
    'latest-win-x64.yml',
    'latest-win-arm64.yml',
    `EVB-Viewer-${version}-x64.deb`,
    `EVB-Viewer-${version}-arm64.deb`,
    `EVB-Viewer-${version}-win-x64-provenance.json`,
    `EVB-Viewer-${version}-win-arm64-provenance.json`,
    'SHA256SUMS',
];

/** @typedef {(command: string, args: string[], options?: object) => string} TCommandRunner */
/** @param {string} tag @param {{runCommand?: TCommandRunner, listWorkflowRunsFn?: typeof listWorkflowRuns, env?: NodeJS.ProcessEnv}} [deps] */
export function summarizeReleaseStatus(tag, {
    runCommand = run, listWorkflowRunsFn = listWorkflowRuns, env = process.env,
} = {}) {
    if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error(`Expected a release tag such as v1.2.3, received "${tag}"`);
    const version = tag.slice(1);
    const release = JSON.parse(runCommand('gh', [
        'release',
        'view',
        tag,
        '--json',
        'isDraft,publishedAt,assets,tagName',
    ]));
    /** @type {{name?: unknown}[]} */
    const releaseAssets = release.assets ?? [];
    const assetNames = releaseAssets.map(asset => asset.name);
    const assets = assetNames.filter(name => typeof name === 'string').sort();
    const missing = REQUIRED_ASSETS(version).filter(name => !assets.includes(name));
    const runs = listWorkflowRunsFn('release.yml', {runCommand});
    const workflow = runs.find(item => item.displayTitle?.includes(tag)) ?? null;
    let mirror = 'not checked';
    if (env.MIRROR_S3_ENDPOINT && env.MIRROR_S3_BUCKET && env.MIRROR_S3_ACCESS_KEY_ID && env.MIRROR_S3_SECRET_KEY) {
        try {
            const channel = JSON.parse(runCommand('aws', [
                's3',
                'cp',
                `s3://${env.MIRROR_S3_BUCKET}/${MIRROR_CHANNEL_KEY}`,
                '-',
                '--endpoint-url',
                env.MIRROR_S3_ENDPOINT,
                '--region',
                env.MIRROR_S3_REGION || 'ru-central1',
            ], {env: {
                ...env,
                AWS_ACCESS_KEY_ID: env.MIRROR_S3_ACCESS_KEY_ID,
                AWS_SECRET_ACCESS_KEY: env.MIRROR_S3_SECRET_KEY,
            }}));
            mirror = (channel.release?.tag ?? channel.tag) === tag ? `matches ${tag}` : `points at ${channel.release?.tag ?? channel.tag ?? 'no tag'}`;
        } catch (error) { mirror = `error: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const isPublic = release.isDraft !== true;
    const mirrorOk = mirror === 'not checked' || mirror === `matches ${tag}`;
    const complete = isPublic && missing.length === 0 && mirrorOk;
    const state = complete ? 'complete' : release.isDraft ? 'in-progress' : missing.length ? 'blocked' : 'in-progress';
    return {
        assets,
        complete,
        isDraft: release.isDraft === true,
        missing,
        mirror,
        publishedAt: release.publishedAt ?? null,
        state,
        tag,
        workflow,
    };
}

/** @param {ReturnType<typeof summarizeReleaseStatus>} status */
export function formatReleaseStatus(status) {
    return [
        `Release status: ${status.tag}`,
        `state: ${status.state}`,
        `release: ${status.isDraft ? 'draft' : 'public'}${status.publishedAt ? `, published_at=${status.publishedAt}` : ''}`,
        `assets present: ${status.assets.length ? status.assets.join(', ') : '(none)'}`,
        `required assets: ${status.missing.length ? `missing ${status.missing.join(', ')}` : 'complete'}`,
        `release workflow: ${status.workflow ? `${status.workflow.status}, ${status.workflow.conclusion ?? 'pending'}, ${status.workflow.url ?? ''}` : 'not found'}`,
        `mirror: ${status.mirror}`,
    ].join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const tag = process.argv[2]?.trim();
    if (!tag) throw new Error('Usage: release-status.mjs <release tag>');
    try {
        const status = summarizeReleaseStatus(tag);
        process.stdout.write(formatReleaseStatus(status));
        if (!status.complete) process.exitCode = 1;
    } catch (error) { process.stderr.write(`${getCliErrorMessage(error)}\n`); process.exitCode = 1; }
}
