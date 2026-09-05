import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IWebDeploySourceStats {
    byteLength: number;
    fileCount: number;
    symlinkPaths: string[];
}

interface IWebDeploySourceModule {
    REQUIRED_VERCELIGNORE_ENTRIES: string[];
    collectWebDeploySourceStats: (options?: {
        projectRoot?: string;
        trackedOnly?: boolean;
    }) => Promise<IWebDeploySourceStats>;
    isExcludedWebDeploySourcePath: (fileName: string, relativeDirectory?: string) => boolean;
    validateVercelIgnoreEntries: (content: string, requiredEntries?: string[]) => unknown;
    parseWebDeploySourceCliOptions: (argv: string[]) => {requireCleanTrackedSource: boolean};
    validateWebDeploySource: (options?: {
        maxBytes?: number;
        maxFiles?: number;
        projectRoot?: string;
        requireCleanTrackedSource?: boolean;
        trackedOnly?: boolean;
    }) => Promise<IWebDeploySourceStats>;
}

const {
    REQUIRED_VERCELIGNORE_ENTRIES,
    collectWebDeploySourceStats,
    isExcludedWebDeploySourcePath,
    validateVercelIgnoreEntries,
    parseWebDeploySourceCliOptions,
    validateWebDeploySource,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-web-deploy-source.mjs')).href
) as IWebDeploySourceModule;

async function createTempProject() {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-web-source-'));

    await writeFile(
        path.join(tempRoot, '.vercelignore'),
        `${REQUIRED_VERCELIGNORE_ENTRIES.join('\n')}\n`,
        'utf8',
    );
    await mkdir(path.join(tempRoot, 'app'), {recursive: true});
    await writeFile(path.join(tempRoot, 'app', 'index.ts'), 'export const app = true;\n', 'utf8');

    return tempRoot;
}

describe('web deploy source policy', () => {
    it('requires local artifact exclusions in .vercelignore', () => {
        expect(() => validateVercelIgnoreEntries('native/\nresources/\n', [
            'native/',
            'resources/',
            'coverage/',
        ])).toThrow('.vercelignore is missing web deploy exclusions: coverage/');
    });

    // localArtifactPolicy.test.ts owns the canonical list; this proves the walker
    // actually skips those names at any depth and in any ASCII case, and that the
    // repository's own .vercelignore still declares them.
    it('keeps local-only artifacts out of the deploy source in any case', async () => {
        const vercelIgnoreContent = await readFile(
            path.join(process.cwd(), '.vercelignore'),
            'utf8',
        );
        expect(() => validateVercelIgnoreEntries(vercelIgnoreContent)).not.toThrow();

        const tempRoot = await createTempProject();
        try {
            await mkdir(path.join(tempRoot, '.agents', 'rules'), {recursive: true});
            await mkdir(path.join(tempRoot, '.devkit', 'plans'), {recursive: true});
            await mkdir(path.join(tempRoot, 'docs-site'), {recursive: true});
            for (const relativePath of [
                path.join('.agents', 'rules', 'review.md'),
                path.join('.devkit', 'plans', 'ledger.md'),
                'AGENTS.MD',
                path.join('app', 'Claude.Md'),
                // Local scratch, excluded at any depth by exact basename even
                // though it is committable.
                path.join('app', 'MEMORIES.md'),
                // Near misses: ordinary documents that only resemble the policy
                // names and must still ship.
                'AGENTS.mdx',
                'MEMORIES.mdx',
                path.join('docs-site', 'memories-overview.md'),
            ]) {
                await writeFile(path.join(tempRoot, relativePath), '# notes\n', 'utf8');
            }

            const stats = await collectWebDeploySourceStats({
                projectRoot: tempRoot,
                trackedOnly: false,
            });

            // .vercelignore, app/index.ts, AGENTS.mdx, MEMORIES.mdx,
            // docs-site/memories-overview.md.
            expect(stats.fileCount).toBe(5);
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('excludes working documents outside docs while retaining nested evidence paths', () => {
        expect(isExcludedWebDeploySourcePath('HANDOFF.md')).toBe(true);
        expect(isExcludedWebDeploySourcePath('handoff.MD')).toBe(true);
        expect(isExcludedWebDeploySourcePath('NOTES.md')).toBe(true);
        expect(isExcludedWebDeploySourcePath('todo.MD')).toBe(true);
        expect(isExcludedWebDeploySourcePath('HANDOFF.md', 'scratch')).toBe(true);
        expect(isExcludedWebDeploySourcePath('NOTES.md', 'reports/2026')).toBe(true);
        expect(isExcludedWebDeploySourcePath('TODO.md', 'docs/../scratch')).toBe(true);
        expect(isExcludedWebDeploySourcePath('HANDOFF.md', '../docs')).toBe(true);
        expect(isExcludedWebDeploySourcePath('TODO.md', 'docs/../../docs')).toBe(true);
        expect(isExcludedWebDeploySourcePath('HANDOFF.md', 'docs/scan-cleanup')).toBe(false);
        expect(isExcludedWebDeploySourcePath('NOTES.md', 'docs/scan-cleanup')).toBe(false);
        expect(isExcludedWebDeploySourcePath('TODO.md', 'docs/scan-cleanup')).toBe(false);
        expect(isExcludedWebDeploySourcePath('HANDOFF.md', 'reports/../docs/scan-cleanup')).toBe(false);
    });

    it('excludes PDF.js archives and the vendor tree from web source', () => {
        expect(isExcludedWebDeploySourcePath('pdfjs-dist.tgz')).toBe(true);
        expect(isExcludedWebDeploySourcePath('pdfjs-dist.tar.gz')).toBe(true);
        expect(isExcludedWebDeploySourcePath('pdfjs-dist.tgz', 'vendor/pdfjs-dist')).toBe(true);
    });

    it('does not count excluded local artifacts in the deploy source budget', async () => {
        const tempRoot = await createTempProject();
        try {
            await mkdir(path.join(tempRoot, 'native', 'pdf-image-combine', 'target'), {recursive: true});
            await mkdir(path.join(tempRoot, 'resources'), {recursive: true});
            await mkdir(path.join(tempRoot, 'tmp', 'pdfs'), {recursive: true});
            await writeFile(
                path.join(tempRoot, 'native', 'pdf-image-combine', 'target', 'debug.bin'),
                Buffer.alloc(1024 * 1024),
            );
            await writeFile(path.join(tempRoot, 'resources', 'large.fixture'), Buffer.alloc(1024 * 1024));
            await writeFile(path.join(tempRoot, 'tmp', 'pdfs', 'local-proof.pdf'), Buffer.alloc(1024 * 1024));
            await writeFile(path.join(tempRoot, 'electron-builder.yml'), 'appId: test\n', 'utf8');

            const stats = await collectWebDeploySourceStats({
                projectRoot: tempRoot,
                trackedOnly: false,
            });

            expect(stats.fileCount).toBe(2);
            expect(stats.byteLength).toBeLessThan(16 * 1024);
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('requires a clean snapshot unless the local gate passes --allow-dirty', () => {
        expect(parseWebDeploySourceCliOptions([])).toEqual({requireCleanTrackedSource: true});
        expect(parseWebDeploySourceCliOptions(['--allow-dirty'])).toEqual({requireCleanTrackedSource: false});
    });

    it('fails before Vercel upload when the deploy source exceeds the file cap', async () => {
        const tempRoot = await createTempProject();
        try {
            await expect(validateWebDeploySource({
                maxFiles: 1,
                projectRoot: tempRoot,
                requireCleanTrackedSource: false,
                trackedOnly: false,
            })).rejects.toThrow('Web deploy source has too many files: 2 > 1');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
