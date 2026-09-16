#!/usr/bin/env node

import { getCliErrorMessage } from '../lib/cli-error.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
    getRequiredArtifactPatterns,
    getLocalReleaseTargets,
    getSupplementalReleaseAssetNames,
} from './policy.mjs';
import {listWorkflowRuns} from './github-workflow-run.mjs';
import {RELEASE_TAG_PATTERN} from './releaseTag.mjs';
import {
    errorMessage,
    getExitStatus,
    run,
} from './shared.mjs';

const MIRROR_CHANNEL_KEY = 'evb-viewer/channels/stable.json';
/** @typedef {'blocked' | 'complete' | 'core-published-supplemental-pending' | 'in-progress' | 'ready'} TReleaseStatusState */
/** @type {ReadonlyArray<{arch: string, label: string, platform: NodeJS.Platform}>} */
const CORE_TARGETS = [
    {
        arch: 'arm64',
        label: 'mac-arm64',
        platform: 'darwin',
    },
    {
        arch: 'x64',
        label: 'linux-x64',
        platform: 'linux',
    },
    {
        arch: 'arm64',
        label: 'linux-arm64',
        platform: 'linux',
    },
    {
        arch: 'x64',
        label: 'win-x64',
        platform: 'win32',
    },
];

/** @typedef {(command: string, args: string[], options?: object) => string} TCommandRunner */
/** @typedef {{exists: boolean, error: string | null}} ITagState */
/** @typedef {{assets: string[], error: string | null, exists: boolean, isDraft: boolean, publishedAt: string | null, tagName: string}} IReleaseState */
/** @typedef {{label: string, pattern: RegExp}} IAssetRequirement */
/** @typedef {{complete: boolean, expected: string[], missing: string[], present: string[]}} IAssetSummary */
/** @typedef {{conclusion: string | null, createdAt: string | null, error: string | null, found: boolean, status: string, url: string}} IWorkflowSummary */
/** @typedef {{checked: boolean, error: string | null, matchesTag: boolean | null, tag: string | null}} IMirrorSummary */
/** @typedef {{databaseId?: number, displayTitle?: unknown, eventPayload?: {inputs?: {tag?: unknown}}, inputs?: {tag?: unknown}, name?: unknown, workflowName?: unknown, createdAt?: string, conclusion?: string | null, status?: string, url?: string}} IWorkflowStatusRun */
/** @typedef {{tag: string, runCommand: TCommandRunner}} ITagCommandOptions */
/** @typedef {{env?: NodeJS.ProcessEnv, getLocalReleaseTargetsFn?: typeof getLocalReleaseTargets, getRequiredArtifactPatternsFn?: typeof getRequiredArtifactPatterns, getSupplementalReleaseAssetNamesFn?: typeof getSupplementalReleaseAssetNames, listWorkflowRunsFn?: typeof listWorkflowRuns, readMirrorChannelFn?: (options: {env: NodeJS.ProcessEnv, runCommand: TCommandRunner}) => {checked: boolean, error: string | null, tag: string | null}, readReleaseStateFn?: (tag: string, runCommand: TCommandRunner) => IReleaseState, readTagStateFn?: (tag: string, runCommand: TCommandRunner) => ITagState, runCommand?: TCommandRunner}} IReleaseStatusDependencies */
/** @typedef {{assets: string[], blocker: string | null, checksumManifestPresent: boolean, core: IAssetSummary, coreComplete: boolean, isDraft: boolean | null, isPublic: boolean, mirror: IMirrorSummary, publishedAt: string | null, releaseExists: boolean, releaseError: string | null, releaseTag: string, state: TReleaseStatusState, supplemental: IAssetSummary, supplementalComplete: boolean, tag: string, tagError: string | null, tagExists: boolean, workflows: {release: IWorkflowSummary, supplemental: IWorkflowSummary}}} IReleaseStatus */

/** @param {unknown} error @returns {boolean} */

function isNotFoundError(error) {
    const status = getExitStatus(error);
    const message = errorMessage(error);

    return status === 1 && (
        message.length === 0
        || /not found|does not exist|could not find|HTTP 404/iu.test(message)
    );
}

/** @param {string} tag @param {TCommandRunner} runCommand @returns {ITagState} */
function readTagState(tag, runCommand) {
    try {
        runCommand('gh', [
            'api',
            '-H',
            'Accept: application/vnd.github+json',
            `repos/{owner}/{repo}/git/ref/tags/${tag}`,
        ]);
        return {
            exists: true,
            error: null,
        };
    } catch (error) {
        if (isNotFoundError(error)) {
            return {
                exists: false,
                error: null,
            };
        }

        return {
            exists: false,
            error: errorMessage(error),
        };
    }
}

/** @param {string} tag @param {TCommandRunner} runCommand @returns {IReleaseState} */
function readReleaseState(tag, runCommand) {
    try {
        const payload = runCommand('gh', [
            'release',
            'view',
            tag,
            '--json',
            'isDraft,publishedAt,assets,tagName',
        ]);
        /** @type {{assets?: Array<{name?: unknown}>, isDraft?: unknown, publishedAt?: unknown, tagName?: unknown}} */
        const release = JSON.parse(payload);
        const assets = Array.isArray(release.assets)
            ? release.assets.flatMap(asset => typeof asset.name === 'string' ? [asset.name] : [])
            : [];

        return {
            assets,
            error: null,
            exists: true,
            isDraft: release.isDraft === true,
            publishedAt: typeof release.publishedAt === 'string' ? release.publishedAt : null,
            tagName: typeof release.tagName === 'string' ? release.tagName : tag,
        };
    } catch (error) {
        if (isNotFoundError(error)) {
            return {
                assets: [],
                error: null,
                exists: false,
                isDraft: false,
                publishedAt: null,
                tagName: tag,
            };
        }

        return {
            assets: [],
            error: errorMessage(error),
            exists: false,
            isDraft: false,
            publishedAt: null,
            tagName: tag,
        };
    }
}

/** @param {RegExp | string} pattern @returns {string} */
function patternText(pattern) {
    return pattern instanceof RegExp ? pattern.toString() : String(pattern);
}

/** @param {{env: NodeJS.ProcessEnv, getLocalReleaseTargetsFn: typeof getLocalReleaseTargets, getRequiredArtifactPatternsFn: typeof getRequiredArtifactPatterns}} options @returns {IAssetRequirement[]} */
function getCoreAssetRequirements({
    env,
    getLocalReleaseTargetsFn,
    getRequiredArtifactPatternsFn,
}) {
    const policyEnv = {
        ...env,
        // The status command checks the public release matrix. Local signing
        // credentials must not make the macOS ZIP optional in that report.
        EVB_RELEASE_HAS_MAC_SIGNING: env.EVB_RELEASE_HAS_MAC_SIGNING ?? 'true',
        EVB_RELEASE_HAS_WINDOWS_SIGNING: env.EVB_RELEASE_HAS_WINDOWS_SIGNING ?? 'true',
    };

    return CORE_TARGETS.flatMap(({
        arch,
        label,
        platform,
    }) => (
        getLocalReleaseTargetsFn({
            arch,
            platform,
        })
            .flatMap(target => getRequiredArtifactPatternsFn(target, policyEnv)
                .map(pattern => ({
                    label: `${label} ${patternText(pattern)}`,
                    pattern,
                })))
    ));
}

/** @param {string[]} assetNames @param {IAssetRequirement[]} requirements @param {string[]} supplementalNames @returns {IAssetSummary} */
function summarizeCoreAssets(assetNames, requirements, supplementalNames) {
    const coreAssetNames = assetNames.filter(name => !supplementalNames.includes(name));
    const present = requirements
        .filter(requirement => coreAssetNames.some(name => requirement.pattern.test(name)))
        .map(requirement => requirement.label);
    const missing = requirements
        .filter(requirement => !coreAssetNames.some(name => requirement.pattern.test(name)))
        .map(requirement => requirement.label);

    return {
        complete: missing.length === 0,
        expected: requirements.map(requirement => requirement.label),
        missing,
        present,
    };
}

/** @param {string[]} assetNames @param {string[]} expectedNames @returns {IAssetSummary} */
function summarizeSupplementalAssets(assetNames, expectedNames) {
    const present = expectedNames.filter(name => assetNames.includes(name));

    return {
        complete: present.length === expectedNames.length,
        expected: [...expectedNames],
        missing: expectedNames.filter(name => !assetNames.includes(name)),
        present,
    };
}

/** @param {IWorkflowStatusRun | null | undefined} runInfo @param {string} tag @returns {boolean} */
function runMatchesTag(runInfo, tag) {
    const values = [
        runInfo?.displayTitle,
        runInfo?.name,
        runInfo?.workflowName,
        runInfo?.inputs?.tag,
        runInfo?.eventPayload?.inputs?.tag,
    ];

    return values.some(value => {
        if (typeof value !== 'string') {
            return false;
        }

        return value === tag
            || value === `Release ${tag}`
            || value === `Release (${tag})`
            || value.includes(tag);
    });
}

/** @param {string} tag @param {string} workflow @param {typeof listWorkflowRuns} listWorkflowRunsFn @param {TCommandRunner} runCommand @returns {IWorkflowSummary} */
function latestWorkflowRun(tag, workflow, listWorkflowRunsFn, runCommand) {
    let runs;
    try {
        runs = listWorkflowRunsFn(workflow, {runCommand});
    } catch (error) {
        return {
            conclusion: null,
            createdAt: null,
            error: errorMessage(error),
            found: false,
            status: 'unavailable',
            url: '',
        };
    }

    /** @type {IWorkflowStatusRun[]} */
    const matchingRuns = (Array.isArray(runs) ? runs : [])
        .filter(runInfo => runMatchesTag(runInfo, tag));
    let latest = null;
    for (const candidate of matchingRuns) {
        if (!latest) {
            latest = candidate;
            continue;
        }

        const currentTime = Date.parse(String(latest.createdAt ?? ''));
        const candidateTime = Date.parse(String(candidate.createdAt ?? ''));
        if (candidateTime !== currentTime) {
            if (candidateTime > currentTime) {
                latest = candidate;
            }
            continue;
        }

        if (Number(candidate.databaseId ?? 0) > Number(latest.databaseId ?? 0)) {
            latest = candidate;
        }
    }

    if (!latest) {
        return {
            conclusion: null,
            createdAt: null,
            error: null,
            found: false,
            status: 'not found',
            url: '',
        };
    }

    return {
        conclusion: latest.conclusion ?? null,
        createdAt: latest.createdAt ?? null,
        error: null,
        found: true,
        status: latest.status ?? 'unknown',
        url: latest.url ?? '',
    };
}

/** @param {NodeJS.ProcessEnv} env @returns {boolean} */
function mirrorIsConfigured(env) {
    return [
        'MIRROR_S3_ENDPOINT',
        'MIRROR_S3_BUCKET',
        'MIRROR_S3_ACCESS_KEY_ID',
        'MIRROR_S3_SECRET_KEY',
    ].every(name => typeof env[name] === 'string' && env[name].trim() !== '');
}

/** @param {{env: NodeJS.ProcessEnv, runCommand: TCommandRunner}} options @returns {{checked: true, error: null, tag: string | null}} */
function readMirrorChannel({
    env,
    runCommand,
}) {
    const payload = runCommand('aws', [
        's3',
        'cp',
        `s3://${env.MIRROR_S3_BUCKET}/${MIRROR_CHANNEL_KEY}`,
        '-',
        '--endpoint-url',
        env.MIRROR_S3_ENDPOINT ?? '',
        '--region',
        env.MIRROR_S3_REGION || 'ru-central1',
    ], {env: {
        ...env,
        AWS_ACCESS_KEY_ID: env.MIRROR_S3_ACCESS_KEY_ID ?? '',
        AWS_SECRET_ACCESS_KEY: env.MIRROR_S3_SECRET_KEY ?? '',
    }});
    const channel = JSON.parse(payload);
    const tag = channel.release?.tag ?? channel.tag ?? null;

    return {
        checked: true,
        error: null,
        tag: typeof tag === 'string' ? tag : null,
    };
}

/** @param {string} tag @param {NodeJS.ProcessEnv} env @param {TCommandRunner} runCommand @param {(options: {env: NodeJS.ProcessEnv, runCommand: TCommandRunner}) => {checked: boolean, error: string | null, tag: string | null}} readMirrorChannelFn @returns {IMirrorSummary} */
function summarizeMirror(tag, env, runCommand, readMirrorChannelFn) {
    if (!mirrorIsConfigured(env)) {
        return {
            checked: false,
            error: null,
            matchesTag: null,
            tag: null,
        };
    }

    try {
        const mirror = readMirrorChannelFn({
            env,
            runCommand,
        });
        return {
            checked: true,
            error: mirror.error ?? null,
            matchesTag: mirror.tag === tag,
            tag: mirror.tag ?? null,
        };
    } catch (error) {
        return {
            checked: true,
            error: errorMessage(error),
            matchesTag: false,
            tag: null,
        };
    }
}

/** @param {string} label @param {IWorkflowSummary} workflow @returns {string | null} */
function getWorkflowBlocker(label, workflow) {
    if (workflow.error) {
        return `${label} lookup failed: ${workflow.error}`;
    }
    if (!workflow.found) {
        return null;
    }
    if (workflow.status === 'completed' && workflow.conclusion !== 'success') {
        return `${label} concluded '${workflow.conclusion ?? 'missing'}' (${workflow.url || 'no URL'})`;
    }
    return null;
}

/** @param {IReleaseStatus} status @returns {{blocker: string | null, state: TReleaseStatusState}} */
export function getReleaseStatusState(status) {
    const tagBlocker = status.tagError
        ? `tag lookup failed: ${status.tagError}`
        : null;
    const releaseBlocker = status.releaseError
        ? `release lookup failed: ${status.releaseError}`
        : null;
    const releaseWorkflowBlocker = getWorkflowBlocker('release workflow', status.workflows.release);
    const supplementalWorkflowBlocker = getWorkflowBlocker(
        'supplemental workflow',
        status.workflows.supplemental,
    );
    const mirrorBlocker = status.mirror.checked && (
        status.mirror.error
        || status.mirror.matchesTag !== true
    )
        ? status.mirror.error
            ? `mirror lookup failed: ${status.mirror.error}`
            : `mirror points at ${status.mirror.tag ?? 'no release tag'}, not ${status.tag}`
        : null;

    const blocker = tagBlocker
        ?? releaseBlocker
        ?? releaseWorkflowBlocker
        ?? supplementalWorkflowBlocker
        ?? mirrorBlocker;
    if (blocker) {
        return {
            blocker,
            state: 'blocked',
        };
    }

    const hasReleaseActivity = status.tagExists
        || status.releaseExists
        || status.workflows.release.found
        || status.workflows.supplemental.found;
    if (!hasReleaseActivity) {
        return {
            blocker: null,
            state: 'ready',
        };
    }

    if (status.coreComplete) {
        if (status.supplementalComplete) {
            return {
                blocker: null,
                state: 'complete',
            };
        }

        return {
            blocker: null,
            state: 'core-published-supplemental-pending',
        };
    }

    if (status.releaseExists && status.isDraft) {
        return {
            blocker: null,
            state: 'in-progress',
        };
    }

    if (status.workflows.release.found && status.workflows.release.conclusion === 'success') {
        return {
            blocker: `core publication is incomplete: ${status.core.missing.join('; ') || 'required assets are missing'}`,
            state: 'blocked',
        };
    }

    return {
        blocker: null,
        state: 'in-progress',
    };
}

/** @param {string} tag @param {IReleaseStatusDependencies} [deps] @returns {IReleaseStatus} */
export function summarizeReleaseStatus(tag, deps = {}) {
    if (!RELEASE_TAG_PATTERN.test(tag)) {
        throw new Error(`Expected a release tag such as v1.2.3, received "${tag}"`);
    }

    const runCommand = deps.runCommand ?? run;
    const env = deps.env ?? process.env;
    const getLocalReleaseTargetsFn = deps.getLocalReleaseTargetsFn ?? getLocalReleaseTargets;
    const getRequiredArtifactPatternsFn = deps.getRequiredArtifactPatternsFn ?? getRequiredArtifactPatterns;
    const getSupplementalReleaseAssetNamesFn = deps.getSupplementalReleaseAssetNamesFn
        ?? getSupplementalReleaseAssetNames;
    const listWorkflowRunsFn = deps.listWorkflowRunsFn ?? listWorkflowRuns;
    const readMirrorChannelFn = deps.readMirrorChannelFn ?? readMirrorChannel;
    const version = tag.slice(1);
    const tagState = deps.readTagStateFn
        ? deps.readTagStateFn(tag, runCommand)
        : readTagState(tag, runCommand);
    const release = deps.readReleaseStateFn
        ? deps.readReleaseStateFn(tag, runCommand)
        : readReleaseState(tag, runCommand);
    const supplementalNames = getSupplementalReleaseAssetNamesFn(version);
    const core = summarizeCoreAssets(
        release.assets,
        getCoreAssetRequirements({
            env,
            getLocalReleaseTargetsFn,
            getRequiredArtifactPatternsFn,
        }),
        supplementalNames,
    );
    const supplemental = summarizeSupplementalAssets(release.assets, supplementalNames);
    const checksumManifestPresent = release.assets.includes('SHA256SUMS');
    const mirror = summarizeMirror(tag, env, runCommand, readMirrorChannelFn);
    const isPublic = release.exists && !release.isDraft;
    const coreComplete = tagState.exists
        && isPublic
        && core.complete
        && checksumManifestPresent
        && (!mirror.checked || mirror.matchesTag === true);
    const workflows = {
        release: latestWorkflowRun(tag, 'release.yml', listWorkflowRunsFn, runCommand),
        supplemental: latestWorkflowRun(
            tag,
            'release-supplemental.yml',
            listWorkflowRunsFn,
            runCommand,
        ),
    };
    /** @type {IReleaseStatus} */
    const status = {
        assets: [...release.assets].sort(),
        blocker: null,
        checksumManifestPresent,
        core,
        coreComplete,
        isDraft: release.exists ? release.isDraft : null,
        isPublic,
        mirror,
        publishedAt: release.publishedAt,
        releaseExists: release.exists,
        releaseError: release.error,
        releaseTag: release.tagName,
        supplemental,
        supplementalComplete: supplemental.complete,
        state: 'in-progress',
        tag,
        tagError: tagState.error,
        tagExists: tagState.exists,
        workflows,
    };
    const releaseState = getReleaseStatusState(status);
    return {
        ...status,
        ...releaseState,
    };
}

/** @param {string} label @param {IWorkflowSummary} workflow @returns {string} */
function formatWorkflow(label, workflow) {
    if (!workflow.found) {
        const detail = workflow.error ? `, ${workflow.error}` : '';
        return `${label}: ${workflow.status}${detail}`;
    }

    const conclusion = workflow.conclusion ? `, conclusion=${workflow.conclusion}` : '';
    return `${label}: ${workflow.status}${conclusion}, ${workflow.url || 'no URL'}`;
}

/** @param {IReleaseStatus} status @returns {string} */
export function formatReleaseStatus(status) {
    const releaseState = !status.releaseExists
        ? status.releaseError ? `unavailable (${status.releaseError})` : 'missing'
        : status.isDraft ? 'draft' : 'public';
    const publishedAt = status.publishedAt ? `, published_at=${status.publishedAt}` : '';
    const presentAssets = status.assets.length > 0 ? status.assets.join(', ') : '(none)';
    const coreCounts = `${status.core.present.length}/${status.core.expected.length}`;
    const coreMissing = status.core.missing.length > 0
        ? `, missing=${status.core.missing.join('; ')}`
        : '';
    const supplementalCounts = `${status.supplemental.present.length}/${status.supplemental.expected.length}`;
    const supplementalMissing = status.supplemental.missing.length > 0
        ? `, missing=${status.supplemental.missing.join(', ')}`
        : '';
    const mirror = status.mirror.checked
        ? status.mirror.error
            ? `mirror: error (${status.mirror.error})`
            : `mirror: ${status.mirror.tag ?? 'no tag'}${status.mirror.matchesTag ? ' (matches)' : ' (does not match)'}`
        : 'mirror: not checked';

    return [
        `Release status: ${status.tag}`,
        `state: ${status.state}${status.blocker ? ` (${status.blocker})` : ''}`,
        `tag: ${status.tagExists ? 'present' : 'missing'}${status.tagError ? ` (${status.tagError})` : ''}`,
        `release: ${releaseState}${publishedAt}`,
        `assets present: ${presentAssets}`,
        `core assets: ${status.core.complete ? 'complete' : 'incomplete'} (${coreCounts})${coreMissing}`,
        `supplemental assets: ${status.supplemental.complete ? 'complete' : 'incomplete'} (${supplementalCounts})${supplementalMissing}`,
        `checksum manifest: ${status.checksumManifestPresent ? 'present' : 'missing'}`,
        formatWorkflow('release workflow', status.workflows.release),
        formatWorkflow('supplemental workflow', status.workflows.supplemental),
        mirror,
        `core complete and public: ${status.coreComplete ? 'yes' : 'no'}`,
    ].join('\n') + '\n';
}

function readTag() {
    const tag = process.argv[2]?.trim();
    if (!tag) {
        throw new Error('Usage: release-status.mjs <release tag>');
    }

    return tag;
}

async function main() {
    const status = summarizeReleaseStatus(readTag());
    process.stdout.write(formatReleaseStatus(status));
    if (!status.coreComplete) {
        process.exitCode = 1;
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    main().catch((error) => {
        process.stderr.write(`${getCliErrorMessage(error)}\n`);
        process.exit(1);
    });
}
