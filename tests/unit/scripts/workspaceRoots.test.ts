import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path, {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

interface IWorkspaceRootsModule {
    getAllArchitectureRoots: (options?: {projectRoot?: string}) => string[];
    getFocusedArchitectureRoots: (options?: {projectRoot?: string}) => string[];
    getWorkspacePackagePatterns: (options?: {projectRoot?: string}) => string[];
    getWorkspacePackageRoots: (options?: {includeWorkspaceRoot?: boolean; projectRoot?: string}) => string[];
    parseWorkspacePackagePatterns: (sourceText: string) => string[];
}

const {
    getAllArchitectureRoots,
    getFocusedArchitectureRoots,
    getWorkspacePackagePatterns,
    getWorkspacePackageRoots,
    parseWorkspacePackagePatterns,
} = (await import(pathToFileURL(resolve(process.cwd(), 'scripts/workspace-roots.mjs')).href)) as IWorkspaceRootsModule;

async function createTempProject() {
    return mkdtemp(join(tmpdir(), 'evb-workspace-roots-'));
}

async function writeProjectFile(projectRoot: string, filePath: string, text = '') {
    const absolutePath = join(projectRoot, filePath);
    await mkdir(path.dirname(absolutePath), {recursive: true});
    await writeFile(absolutePath, text, 'utf8');
}

describe('workspace root helpers', () => {
    it('parses quoted workspace package patterns and stops at the next top-level section', () => {
        expect(
            parseWorkspacePackagePatterns(
                ['packages:', "  - '.'", '  - "packages/*"', '  - tools/internal', '', 'ignoredSection:', '  - should-not-appear'].join(
                    '\n',
                ),
            ),
        ).toEqual(['.', 'packages/*', 'tools/internal']);
    });

    it('expands workspace package roots and keeps the workspace root opt-in', async () => {
        const projectRoot = await createTempProject();
        try {
            await writeProjectFile(
                projectRoot,
                'pnpm-workspace.yaml',
                ['packages:', "  - '.'", "  - 'packages/*'", '  - tools/internal'].join('\n'),
            );
            await mkdir(join(projectRoot, 'packages', 'beta'), {recursive: true});
            await mkdir(join(projectRoot, 'packages', 'alpha'), {recursive: true});
            await mkdir(join(projectRoot, 'tools', 'internal'), {recursive: true});

            expect(getWorkspacePackageRoots({projectRoot})).toEqual(['packages/alpha', 'packages/beta', 'tools/internal']);
            expect(
                getWorkspacePackageRoots({
                    includeWorkspaceRoot: true,
                    projectRoot,
                }),
            ).toEqual(['.', 'packages/alpha', 'packages/beta', 'tools/internal']);
            expect(getFocusedArchitectureRoots({projectRoot})).toEqual([
                'app',
                'electron',
                'scripts',
                'server',
                'packages/alpha',
                'packages/beta',
                'tools/internal',
            ]);
            expect(getAllArchitectureRoots({projectRoot})).toEqual([
                'app',
                'electron',
                'landing',
                'scripts',
                'server',
                'packages/alpha',
                'packages/beta',
                'tools/internal',
            ]);
        } finally {
            await rm(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('falls back to packages/* when pnpm-workspace.yaml is absent', async () => {
        const projectRoot = await createTempProject();
        try {
            await mkdir(join(projectRoot, 'packages', 'contracts'), {recursive: true});

            expect(getWorkspacePackagePatterns({projectRoot})).toEqual(['packages/*']);
            expect(getWorkspacePackageRoots({projectRoot})).toEqual(['packages/contracts']);
        } finally {
            await rm(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects unsupported negated workspace package patterns', async () => {
        const projectRoot = await createTempProject();
        try {
            await writeProjectFile(
                projectRoot,
                'pnpm-workspace.yaml',
                ['packages:', "  - 'packages/*'", "  - '!packages/legacy'"].join('\n'),
            );
            await mkdir(join(projectRoot, 'packages', 'alpha'), {recursive: true});

            expect(() => {
                getWorkspacePackageRoots({projectRoot});
            }).toThrow('Unsupported negated workspace package pattern');
        } finally {
            await rm(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
