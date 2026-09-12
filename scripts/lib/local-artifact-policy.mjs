// Canonical policy for local-only artifacts: files that exist on a developer
// machine to configure a coding assistant or to hold local working material.
// None of them is part of the product, so they must stay untracked, unpublished,
// and out of the web deploy source.
//
// The enforcing gates import this list directly: the staged, pre-push, and CI
// history checks in `check-commit-attribution.mjs`, and the web deploy source
// filter in `check-web-deploy-source.mjs`. `.gitignore` and `.vercelignore` are
// static text that cannot import anything, so they restate the list and a unit
// test asserts each one still mirrors what is declared here.
//
// The list is deliberately limited to names real tooling reads. Names that
// merely sound related (`docs/agents-overview.md`, `docs/devkit-notes.md`,
// `electron/features/agent/…`) are ordinary product paths and stay legal.

export const AGENT_INSTRUCTION_FILE_NAMES = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
];

// The two rule files at the repository root are published on purpose: the
// README points readers at them so the workflow that writes most of this code
// is auditable. The exception is anchored to the root. A nested `AGENTS.md`
// is still a local scratch file for one directory and stays forbidden, and so
// does every other name above.
export const PUBLISHED_ROOT_AGENT_INSTRUCTION_FILE_NAMES = [
    'AGENTS.md',
    'CLAUDE.md',
];

// A branch working handoff is useful while a change is in flight, but working
// documents outside the top-level `docs/` evidence tree are not product
// content. Keep the basename list separate so the path-aware exception remains
// explicit and case-insensitive.
export const ROOT_ONLY_LOCAL_ARTIFACT_FILE_NAMES = [
    'HANDOFF.md',
    'NOTES.md',
    'TODO.md',
];

// `.devkit/` holds local planning and run material. It is ignored working state,
// never product source, so a forced `git add` under it must fail exactly as a
// harness directory does.
const LOCAL_ONLY_DIRECTORIES = [
    {
        kind: 'agent harness directory',
        name: '.agents',
    },
    {
        kind: 'agent harness directory',
        name: '.claude',
    },
    {
        kind: 'agent harness directory',
        name: '.codex',
    },
    {
        kind: 'local working directory',
        name: '.devkit',
    },
];

export const LOCAL_ONLY_DIRECTORY_NAMES = LOCAL_ONLY_DIRECTORIES.map(({name}) => name);

// Harnesses read the canonical upper-case name, but contributors and editors
// write `agents.md`, `Claude.Md`, or `AGENTS.MD` just as readily, and a
// case-insensitive checkout resolves all of them to the same file. Compare the
// whole basename case-insensitively; only ASCII case folds, so a name such as
// `AGENTS.MD` matches while `AGENTS.mdx` or `MEMORIES.md` stays an ordinary
// document.
//
// Directory names are compared exactly: the tooling that creates `.claude` and
// `.devkit` always spells them in lower case.
/** @param {string} value */
function asciiLowerCase(value) {
    return value.replace(/[A-Z]/gu, character => character.toLowerCase());
}

/**
 * Normalizes a repository-relative slash-separated path for policy checks.
 * Traversal segments must not evade the top-level `docs/` exception.
 *
 * @param {string} filePath repository-relative path
 * @returns {string[]}
 */
export function normalizeRepositoryRelativePath(filePath) {
    const normalized = [];
    for (const segment of filePath.split('/')) {
        if (!segment || segment === '.') {
            continue;
        }
        if (segment === '..') {
            if (normalized.length === 0 || normalized.at(-1) === '..') {
                // Preserve traversal above the repository root so a later
                // `docs` segment cannot manufacture the docs exception.
                normalized.push('..');
            } else {
                normalized.pop();
            }
            continue;
        }
        normalized.push(segment);
    }
    return normalized;
}

/** @param {string} filePath */
export function isTopLevelDocsPath(filePath) {
    return normalizeRepositoryRelativePath(filePath)[0] === 'docs';
}

/**
 * Returns the canonical instruction file name a basename spells in any ASCII
 * case, or null for an ordinary file name.
 *
 * @param {string} fileName basename, with no directory part
 * @returns {string | null}
 */
export function findAgentInstructionFileName(fileName) {
    const normalized = asciiLowerCase(fileName);
    return AGENT_INSTRUCTION_FILE_NAMES
        .find(candidate => asciiLowerCase(candidate) === normalized) ?? null;
}

/**
 * Returns the canonical root-only local artifact name a basename spells in
 * any ASCII case, or null for an ordinary file name.
 *
 * @param {string} fileName basename, with no directory part
 * @returns {string | null}
 */
export function findRootOnlyLocalArtifactFileName(fileName) {
    const normalized = asciiLowerCase(fileName);
    return ROOT_ONLY_LOCAL_ARTIFACT_FILE_NAMES
        .find(candidate => asciiLowerCase(candidate) === normalized) ?? null;
}

/**
 * Describes why a repository-relative path is a forbidden local-only artifact,
 * or returns null when the path is ordinary product content.
 *
 * @param {string} filePath repository-relative, `/`-separated path
 * @returns {string | null}
 */
export function describeForbiddenArtifactPath(filePath) {
    const segments = normalizeRepositoryRelativePath(filePath);
    if (segments.length === 0) {
        return null;
    }

    const fileName = segments.at(-1);
    if (fileName === undefined) {
        return null;
    }
    const instructionFileName = findAgentInstructionFileName(fileName);
    if (instructionFileName) {
        const publishedAtRoot = segments.length === 1
            && PUBLISHED_ROOT_AGENT_INSTRUCTION_FILE_NAMES.includes(instructionFileName)
            && fileName === instructionFileName;
        if (!publishedAtRoot) {
            return `agent instruction file ${instructionFileName} at ${filePath}`;
        }
    }

    const directorySegments = segments.slice(0, -1);
    const directory = LOCAL_ONLY_DIRECTORIES
        .find(({name}) => directorySegments.includes(name));
    if (directory) {
        return `${directory.kind} ${directory.name}/ at ${filePath}`;
    }

    const rootOnlyArtifactName = findRootOnlyLocalArtifactFileName(fileName);
    return rootOnlyArtifactName && segments[0] !== 'docs'
        ? `local working document ${rootOnlyArtifactName} outside docs/ at ${filePath}`
        : null;
}

// A bare name ignores the artifact at any depth; a trailing slash ignores the
// directory and everything under it. Working-document entries use a glob plus
// a docs exception because tracked evidence under `docs/` remains legal.
export const REQUIRED_GITIGNORE_PATTERNS = [
    ...AGENT_INSTRUCTION_FILE_NAMES.flatMap(name => (
        PUBLISHED_ROOT_AGENT_INSTRUCTION_FILE_NAMES.includes(name)
            ? [`**/${name}`, `!/${name}`]
            : [name]
    )),
    ...LOCAL_ONLY_DIRECTORY_NAMES.map(name => `${name}/`),
];

// Unlike the basename rules above, working-document patterns need a tracked
// docs exception: nested `docs/**/HANDOFF.md` is evidence, not local state.
export const REQUIRED_ROOT_GITIGNORE_PATTERNS = ROOT_ONLY_LOCAL_ARTIFACT_FILE_NAMES
    .flatMap(name => [
        `**/${name}`,
        `!docs/**/${name}`,
    ]);

/**
 * Returns the required ignore patterns `.gitignore` does not declare. An anchored
 * form such as `/AGENTS.md` does not count: it leaves the artifact trackable in
 * every subdirectory.
 *
 * This is a literal line comparison, not a gitignore engine. The ignore file is
 * developer convenience — a missing or anchored entry is the mistake worth
 * catching. Case variants, negations, and every other way of re-including a file
 * are the job of the deterministic staged and pre-push checks, which see what is
 * actually about to be committed or pushed.
 *
 * @param {string} content `.gitignore` contents
 * @returns {string[]}
 */
export function findMissingGitIgnorePatterns(content) {
    const lines = content
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));

    return [
        ...REQUIRED_GITIGNORE_PATTERNS,
        ...REQUIRED_ROOT_GITIGNORE_PATTERNS,
    ].filter(pattern => !lines.includes(pattern));
}
