import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface ILocalArtifactPolicyModule {
    AGENT_INSTRUCTION_FILE_NAMES: string[];
    PUBLISHED_ROOT_AGENT_INSTRUCTION_FILE_NAMES: string[];
    LOCAL_ONLY_DIRECTORY_NAMES: string[];
    ROOT_ONLY_LOCAL_ARTIFACT_FILE_NAMES: string[];
    REQUIRED_GITIGNORE_PATTERNS: string[];
    REQUIRED_ROOT_GITIGNORE_PATTERNS: string[];
    describeForbiddenArtifactPath: (filePath: string) => string | null;
    findMissingGitIgnorePatterns: (content: string) => string[];
}

interface IWebDeploySourceModule {
    REQUIRED_VERCELIGNORE_ENTRIES: string[];
    WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES: string[];
    WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES: string[];
}

async function importScript<T>(relativePath: string) {
    return await import(
        pathToFileURL(path.resolve(process.cwd(), relativePath)).href
    ) as T;
}

const policy = await importScript<ILocalArtifactPolicyModule>('scripts/lib/local-artifact-policy.mjs');
const webDeploy = await importScript<IWebDeploySourceModule>('scripts/check-web-deploy-source.mjs');

describe('local artifact policy', () => {
    it('covers the local-only conventions this project actually encounters', () => {
        expect(policy.AGENT_INSTRUCTION_FILE_NAMES).toEqual([
            'AGENTS.md',
            'CLAUDE.md',
            'GEMINI.md',
        ]);
        expect(policy.LOCAL_ONLY_DIRECTORY_NAMES).toEqual([
            '.agents',
            '.claude',
            '.codex',
            '.devkit',
        ]);
        expect(policy.PUBLISHED_ROOT_AGENT_INSTRUCTION_FILE_NAMES).toEqual([
            'AGENTS.md',
            'CLAUDE.md',
        ]);
        expect(policy.ROOT_ONLY_LOCAL_ARTIFACT_FILE_NAMES).toEqual([
            'HANDOFF.md',
            'NOTES.md',
            'TODO.md',
        ]);
    });

    it.each([
        [
            'GEMINI.md',
            'agent instruction file GEMINI.md',
        ],
        [
            'docs/AGENTS.md',
            'agent instruction file AGENTS.md',
        ],
        [
            'landing/CLAUDE.md',
            'agent instruction file CLAUDE.md',
        ],
        [
            'packages/contracts/agents.md',
            'agent instruction file AGENTS.md',
        ],
        [
            'AGENTS.MD',
            'agent instruction file AGENTS.md',
        ],
        [
            'Claude.Md',
            'agent instruction file CLAUDE.md',
        ],
        [
            'tools/harness/cLaUdE.MD',
            'agent instruction file CLAUDE.md',
        ],
        [
            'packages/contracts/gemini.md',
            'agent instruction file GEMINI.md',
        ],
        [
            '.agents/rules/review.md',
            'agent harness directory .agents/',
        ],
        [
            'tools/.claude/settings.json',
            'agent harness directory .claude/',
        ],
        [
            '.codex/config.toml',
            'agent harness directory .codex/',
        ],
        [
            '.devkit/plans/perf-lowend/run/ledger.md',
            'local working directory .devkit/',
        ],
        [
            'tools/.devkit/notes.md',
            'local working directory .devkit/',
        ],
        [
            'HANDOFF.md',
            'local working document HANDOFF.md outside docs/',
        ],
        [
            'handoff.MD',
            'local working document HANDOFF.md outside docs/',
        ],
        [
            'notes.md',
            'local working document NOTES.md outside docs/',
        ],
        [
            'ToDo.MD',
            'local working document TODO.md outside docs/',
        ],
        [
            'scratch/HANDOFF.md',
            'local working document HANDOFF.md outside docs/',
        ],
        [
            'reports/2026/NOTES.md',
            'local working document NOTES.md outside docs/',
        ],
        [
            'docs/../TODO.md',
            'local working document TODO.md outside docs/',
        ],
        [
            'reports/../NOTES.md',
            'local working document NOTES.md outside docs/',
        ],
        [
            '../docs/HANDOFF.md',
            'local working document HANDOFF.md outside docs/',
        ],
        [
            'docs/../../docs/TODO.md',
            'local working document TODO.md outside docs/',
        ],
        [
            'devkit/plans/notes.md',
            'local working document NOTES.md outside docs/',
        ],
    ])('rejects %s', (filePath, expectedReason) => {
        expect(policy.describeForbiddenArtifactPath(filePath)).toContain(expectedReason);
    });

    it.each([
        'AGENTS.md',
        'CLAUDE.md',
        'electron/features/agent/agentSession.ts',
        'docs/agents-overview.md',
        'docs/internal/agents/overview.md',
        'packages/contracts/claudeAgentSdk.ts',
        'AGENTS.mdx',
        'agents.markdown',
        'MEMORIES.md',
        'CODEX.md',
        'AGENTS-v2.md',
        'my-agents.md',
        'docs/AGENTS.md.bak',
        'docs/devkit-notes.md',
        'docs/HANDOFF.md',
        'docs/internal/scan-cleanup/HANDOFF.md',
        'docs/NOTES.md',
        'docs/TODO.md',
        'reports/../docs/HANDOFF.md',
        'HANDOFF.mdx',
        'scripts/devkit/report.mjs',
    ])('keeps product path %s legal', (filePath) => {
        expect(policy.describeForbiddenArtifactPath(filePath)).toBeNull();
    });

    it('ignores every forbidden artifact at any depth', async () => {
        const gitIgnore = await readFile(path.join(process.cwd(), '.gitignore'), 'utf8');

        expect(policy.findMissingGitIgnorePatterns(gitIgnore)).toEqual([]);
        // Working documents are ignored outside docs/ but explicit negations
        // keep tracked evidence under that top-level tree legal.
        expect(policy.REQUIRED_GITIGNORE_PATTERNS.some(pattern => pattern.startsWith('/'))).toBe(false);
        expect(policy.REQUIRED_ROOT_GITIGNORE_PATTERNS).toEqual([
            '**/HANDOFF.md',
            '!docs/**/HANDOFF.md',
            '**/NOTES.md',
            '!docs/**/NOTES.md',
            '**/TODO.md',
            '!docs/**/TODO.md',
        ]);
    });

    it('reports missing and anchored-only patterns as missing coverage', () => {
        expect(policy.findMissingGitIgnorePatterns([
            ...policy.REQUIRED_GITIGNORE_PATTERNS,
            ...policy.REQUIRED_ROOT_GITIGNORE_PATTERNS,
        ].join('\n') + '\n'))
            .toEqual([]);
        // Omitting either the global ignore or the docs exception leaves a
        // forbidden working document trackable (or hides legal evidence).
        expect(policy.findMissingGitIgnorePatterns('/AGENTS.md\n/CLAUDE.md\n'))
            .toEqual([
                ...policy.REQUIRED_GITIGNORE_PATTERNS,
                ...policy.REQUIRED_ROOT_GITIGNORE_PATTERNS,
            ]);
    });

    it('derives the web deploy exclusions from the same policy', () => {
        for (const directoryName of policy.LOCAL_ONLY_DIRECTORY_NAMES) {
            expect(webDeploy.WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES).toContain(directoryName);
            expect(webDeploy.REQUIRED_VERCELIGNORE_ENTRIES).toContain(`${directoryName}/`);
        }
        for (const fileName of policy.AGENT_INSTRUCTION_FILE_NAMES) {
            expect(webDeploy.WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES).toContain(fileName);
            expect(webDeploy.REQUIRED_VERCELIGNORE_ENTRIES).toContain(fileName);
        }
    });
});
