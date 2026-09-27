import {
    existsSync,
    readdirSync,
    readFileSync,
    statSync,
} from 'node:fs';
import path from 'node:path';

const WORKSPACE_FILE_NAME = 'pnpm-workspace.yaml';
const FALLBACK_PACKAGE_PATTERN = 'packages/*';

const FOCUSED_ARCHITECTURE_STATIC_ROOTS = [
    'app',
    'electron',
    'scripts',
    'server',
];

const ALL_ARCHITECTURE_STATIC_ROOTS = [
    'app',
    'electron',
    'landing',
    'scripts',
    'server',
];

/** @param {string} relativePath @returns {string} */
function normalizeRelativePath(relativePath) {
    const normalized = relativePath.split(path.sep).join('/').replace(/\/+$/u, '');
    return normalized.length === 0 ? '.' : normalized;
}

/** @param {string} value @returns {string} */
function stripYamlQuotes(value) {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('\'') && trimmed.endsWith('\''))
        || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

/** @param {string[]} values @returns {string[]} */
function uniqueOrdered(values) {
    const seen = new Set();
    return values.filter((value) => {
        if (seen.has(value)) {
            return false;
        }
        seen.add(value);
        return true;
    });
}

/** @param {string} filePath @returns {boolean} */
function isDirectory(filePath) {
    try {
        return statSync(filePath).isDirectory();
    } catch {
        return false;
    }
}

/** @param {string} sourceText @returns {string[]} */
export function parseWorkspacePackagePatterns(sourceText) {
    const lines = sourceText.split(/\r?\n/u);
    const packagesLineIndex = lines.findIndex(line => line.trim() === 'packages:');

    if (packagesLineIndex === -1) {
        throw new Error(`${WORKSPACE_FILE_NAME} is missing the packages: section.`);
    }

    const patterns = [];
    for (const line of lines.slice(packagesLineIndex + 1)) {
        if (/^\S/u.test(line)) {
            break;
        }

        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) {
            continue;
        }

        const match = trimmed.match(/^-\s+(.+)$/u);
        if (!match?.[1]) {
            continue;
        }

        patterns.push(normalizeRelativePath(stripYamlQuotes(match[1])));
    }

    return patterns;
}

/** @param {{projectRoot?: string}} options @returns {string[]} */
export function getWorkspacePackagePatterns({projectRoot = process.cwd()} = {}) {
    const workspaceFilePath = path.join(projectRoot, WORKSPACE_FILE_NAME);
    if (!existsSync(workspaceFilePath)) {
        return isDirectory(path.join(projectRoot, 'packages'))
            ? [FALLBACK_PACKAGE_PATTERN]
            : [];
    }

    return parseWorkspacePackagePatterns(readFileSync(workspaceFilePath, 'utf8'));
}

/** @param {string} pattern @param {{projectRoot: string}} options @returns {string[]} */
function expandWorkspacePattern(pattern, {projectRoot}) {
    const normalizedPattern = normalizeRelativePath(pattern);
    if (normalizedPattern.startsWith('!')) {
        throw new Error(`Unsupported negated workspace package pattern: ${normalizedPattern}`);
    }

    if (normalizedPattern === '.') {
        return ['.'];
    }

    if (!normalizedPattern.includes('*')) {
        return isDirectory(path.join(projectRoot, normalizedPattern))
            ? [normalizedPattern]
            : [];
    }

    const segments = normalizedPattern.split('/');
    let candidates = [''];

    for (const segment of segments) {
        if (segment === '*') {
            candidates = candidates.flatMap((candidate) => {
                const parentDir = candidate.length === 0
                    ? projectRoot
                    : path.join(projectRoot, candidate);
                if (!isDirectory(parentDir)) {
                    return [];
                }

                return readdirSync(parentDir)
                    .filter((entry) => isDirectory(path.join(parentDir, entry)))
                    .map((entry) => normalizeRelativePath(path.posix.join(candidate, entry)));
            });
            continue;
        }

        if (segment.includes('*')) {
            throw new Error(`Unsupported workspace package glob segment: ${segment}`);
        }

        candidates = candidates.map((candidate) => normalizeRelativePath(path.posix.join(candidate, segment)));
    }

    return candidates
        .filter((candidate) => isDirectory(path.join(projectRoot, candidate)))
        .sort((left, right) => left.localeCompare(right));
}

/** @param {{includeWorkspaceRoot?: boolean, projectRoot?: string}} options @returns {string[]} */
export function getWorkspacePackageRoots({
    includeWorkspaceRoot = false,
    projectRoot = process.cwd(),
} = {}) {
    const patterns = getWorkspacePackagePatterns({ projectRoot });
    const roots = patterns.flatMap(pattern => expandWorkspacePattern(pattern, { projectRoot }))
        .filter(root => includeWorkspaceRoot || root !== '.');

    return uniqueOrdered(roots.sort((left, right) => left.localeCompare(right)));
}

/** @param {{projectRoot?: string}} options @returns {string[]} */
export function getFocusedArchitectureRoots({projectRoot = process.cwd()} = {}) {
    return uniqueOrdered([
        ...FOCUSED_ARCHITECTURE_STATIC_ROOTS,
        ...getWorkspacePackageRoots({ projectRoot }),
    ]);
}

/** @param {{projectRoot?: string}} options @returns {string[]} */
export function getAllArchitectureRoots({projectRoot = process.cwd()} = {}) {
    return uniqueOrdered([
        ...ALL_ARCHITECTURE_STATIC_ROOTS,
        ...getWorkspacePackageRoots({ projectRoot }),
    ]);
}
