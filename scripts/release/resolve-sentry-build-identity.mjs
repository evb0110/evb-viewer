import {
    appendFileSync,
    readFileSync,
} from 'node:fs';
import path from 'node:path';
import {
    resolveSentryBuildIdentity,
    resolveSentryBuildTarget,
} from '../../packages/contracts/diagnostics/releaseIdentity.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');

/** @param {string[]} args @returns {'desktop' | 'web' | undefined} */
function parseTarget(args) {
    const targetArgs = args.filter(arg => arg.startsWith('--target='));
    if (targetArgs.length > 1) {
        throw new Error(`Expected at most one Sentry build target, received: ${targetArgs.join(', ')}`);
    }
    const target = targetArgs[0]?.slice('--target='.length);
    if (target !== undefined && target !== 'desktop' && target !== 'web') {
        throw new Error(`Unsupported Sentry build target: ${target}`);
    }
    return target;
}

/** @returns {string} */
function readPackageVersion() {
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (typeof packageJson.version !== 'string') {
        throw new Error('package.json must contain a string version for Sentry release identity');
    }
    return packageJson.version;
}

/** @param {string | undefined} filePath @param {string[]} lines */
function appendLines(filePath, lines) {
    if (!filePath) {
        return;
    }
    appendFileSync(filePath, `${lines.join('\n')}\n`);
}

/** @param {{args?: string[], environment?: NodeJS.ProcessEnv, version?: string}} [options] */
export function resolveReleaseIdentityForEnvironment({
    args = process.argv.slice(2),
    environment = process.env,
    version = readPackageVersion(),
} = {}) {
    const target = parseTarget(args) ?? resolveSentryBuildTarget(environment);
    return resolveSentryBuildIdentity({
        target,
        version,
        environment,
        platform: process.platform,
        architecture: process.arch,
    });
}

/**
 * @param {{
 *   identity?: import('../../packages/contracts/diagnostics/releaseIdentity.js').SentryBuildIdentity,
 *   environment?: NodeJS.ProcessEnv,
 * }} options
 */
export function publishReleaseIdentityToGithub({
    identity,
    environment = process.env,
} = {}) {
    if (!identity) {
        throw new TypeError('A resolved Sentry build identity is required');
    }
    const lines = [
        'EVB_SENTRY_DIAGNOSTICS_BUILD=1',
        'EVB_ELECTRON_SOURCEMAP=1',
        `EVB_SENTRY_TARGET=${identity.target}`,
        `EVB_SENTRY_RELEASE=${identity.release}`,
        `EVB_SENTRY_DIST=${identity.dist}`,
        `EVB_SENTRY_ENVIRONMENT=${identity.environment}`,
    ];
    appendLines(environment.GITHUB_ENV, lines);
    appendLines(environment.GITHUB_OUTPUT, [
        `target=${identity.target}`,
        `release=${identity.release}`,
        `dist=${identity.dist}`,
        `environment=${identity.environment}`,
    ]);
    return identity;
}

function isDirectCliInvocation() {
    return process.argv[1]
        && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
}

if (isDirectCliInvocation()) {
    const identity = resolveReleaseIdentityForEnvironment();
    publishReleaseIdentityToGithub({identity});
    process.stdout.write(
        `Sentry build identity: ${identity.target}, ${identity.release}, `
        + `${identity.dist}, ${identity.environment}.\n`,
    );
}
