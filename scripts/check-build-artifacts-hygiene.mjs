import {
    readFile,
    readdir,
    stat,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoots = [
    'dist-electron',
    'nuxt-output',
    '.vercel/output',
    '.output',
];

const ignoredMissingRoots = new Set(artifactRoots);
const allowedLicensePattern = /(?:^|[/\\])(?:LICENSE|LICENSE_[^/\\]+|LICENSE-[^/\\]+)(?:\.[^/\\]+)?$/iu;
const contentFilePattern = /\.(?:c?js|mjs|json|html?|css|txt|xml|svg)$/iu;

export const forbiddenPublicArtifactPathPatterns = [
    /(?:^|[/\\])(?:__tests__|tests?|coverage|\.vitest|\.playwright)(?:[/\\]|$)/u,
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
    /\.map$/iu,
    /(?:^|[/\\])(?:\.tmp|private-sourcemaps|sentry-sources|sources)(?:[/\\]|$)/iu,
    /(?:^|[/\\])(?:README|CHANGELOG)(?:\.[^/\\]+)?$/iu,
    /(?:^|[/\\])favicon-dev[.-][^/\\]*$/u,
];

const remoteCredentialPattern = /\bsntry[su]_[A-Za-z0-9_-]{16,}\b/u;
const sentryEndpointPattern = /https:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]*sentry\.io\/\d+/giu;

/** @typedef {{absolutePath: string, relativePath: string}} IArtifactFile */

/** @param {string} relativePath @returns {boolean} */
export function isForbiddenPublicArtifactPath(relativePath) {
    if (allowedLicensePattern.test(relativePath)) {
        return false;
    }
    return forbiddenPublicArtifactPathPatterns.some(pattern => pattern.test(relativePath));
}

/** @param {string} relativePath @returns {boolean} */
export function shouldScanPublicArtifactContent(relativePath) {
    return contentFilePattern.test(relativePath);
}

/** @param {string | Buffer} content @param {{target: string}} options @returns {string[]} */
export function collectPublicArtifactContentViolations(
    content,
    {target},
) {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
    const violations = [];

    if (remoteCredentialPattern.test(text)) {
        violations.push('remote auth credential');
    }
    const endpoints = new Set(text.match(sentryEndpointPattern) ?? []);
    // The desktop renderer reports through Electron main and carries no DSN.
    // The SDK's own connectivity-check URL has no key and does not match.
    if (target === 'desktop-renderer' && endpoints.size > 0) {
        violations.push('web Sentry ingest endpoint in desktop renderer');
    }
    if (endpoints.size > 1) {
        violations.push('multiple runtime Sentry endpoints');
    }

    return [...new Set(violations)];
}

/** @param {string} dirPath @param {string} relativeRoot @returns {Promise<IArtifactFile[]>} */
async function collectFiles(dirPath, relativeRoot) {
    const entries = await readdir(dirPath, {withFileTypes: true});
    const files = [];

    for (const entry of entries) {
        const absolutePath = path.join(dirPath, entry.name);
        const relativePath = path.join(relativeRoot, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') {
                continue;
            }
            files.push(...await collectFiles(absolutePath, relativePath));
            continue;
        }
        if (entry.isFile()) {
            files.push({
                absolutePath,
                relativePath,
            });
        }
    }
    return files;
}

/** @param {{rootPath: string, target: string}} options @returns {Promise<string[]>} */
export async function scanPublicArtifactDirectory({
    rootPath,
    target,
}) {
    const files = await collectFiles(rootPath, '');
    const violations = [];

    for (const file of files) {
        if (isForbiddenPublicArtifactPath(file.relativePath)) {
            violations.push(`${file.relativePath}: forbidden path`);
            continue;
        }
        if (!shouldScanPublicArtifactContent(file.relativePath)) {
            continue;
        }
        const content = await readFile(file.absolutePath);
        for (const problem of collectPublicArtifactContentViolations(content, {target})) {
            violations.push(`${file.relativePath}: ${problem}`);
        }
    }
    return violations;
}

/** @param {string} relativeRoot @param {string} root @returns {Promise<IArtifactFile[]>} */
async function collectArtifactFiles(relativeRoot, root) {
    const rootPath = path.join(root, relativeRoot);
    try {
        const rootStat = await stat(rootPath);
        if (!rootStat.isDirectory()) {
            return [];
        }
    } catch (error) {
        if (
            error
            && typeof error === 'object'
            && 'code' in error
            && error.code === 'ENOENT'
            && ignoredMissingRoots.has(relativeRoot)
        ) {
            return [];
        }
        throw error;
    }
    return collectFiles(rootPath, relativeRoot);
}

/** @param {string} relativeRoot @param {string} relativePath @returns {string} */
function targetForArtifact(relativeRoot, relativePath) {
    if (relativeRoot === 'dist-electron') {
        return 'desktop';
    }
    if (relativeRoot === 'nuxt-output' && relativePath.includes(`${path.sep}public${path.sep}`)) {
        return 'desktop-renderer';
    }
    if (relativeRoot === '.vercel/output' && relativePath.includes(`${path.sep}static${path.sep}`)) {
        return 'web-static';
    }
    return 'web-server';
}

/** @param {{root?: string}} options @returns {Promise<string[]>} */
export async function runBuildArtifactHygiene({root = projectRoot} = {}) {
    const violations = [];
    for (const artifactRoot of artifactRoots) {
        const files = await collectArtifactFiles(artifactRoot, root);
        for (const file of files) {
            if (isForbiddenPublicArtifactPath(file.relativePath)) {
                violations.push(`${file.relativePath}: forbidden path`);
                continue;
            }
            if (!shouldScanPublicArtifactContent(file.relativePath)) {
                continue;
            }
            const content = await readFile(file.absolutePath);
            const target = targetForArtifact(artifactRoot, file.relativePath);
            for (const problem of collectPublicArtifactContentViolations(content, {target})) {
                violations.push(`${file.relativePath}: ${problem}`);
            }
        }
    }
    return violations;
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const violations = await runBuildArtifactHygiene();
    if (violations.length > 0) {
        console.error('Build artifacts contain files that should not ship:');
        for (const violation of violations.slice(0, 100)) {
            console.error(`  - ${violation}`);
        }
        if (violations.length > 100) {
            console.error(`  ... and ${violations.length - 100} more`);
        }
        process.exit(1);
    }
    console.log('Build artifact hygiene check passed.');
}
