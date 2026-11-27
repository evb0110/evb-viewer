import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

interface IWorkspaceTypecheckModule {
    TYPECHECK_EXEMPT_WORKSPACE_PACKAGES: Record<string, string>;
    getWorkspacePackageTypecheckPlan: (options?: {projectRoot?: string}) => {
        command: {
            args: string[];
            command: string;
        };
        skipped: Array<{
            packageRoot: string;
            reason: string;
        }>;
    };
    runWorkspacePackageTypecheck: (options?: {
        projectRoot?: string;
        runCommand?: (
            command: string,
            args: string[],
            options: {
                cwd: string;
                stdio: 'inherit';
            },
        ) => void;
        stdout?: {write: (message: string) => void};
    }) => void;
}

const {TYPECHECK_EXEMPT_WORKSPACE_PACKAGES, getWorkspacePackageTypecheckPlan, runWorkspacePackageTypecheck} = (await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/run-workspace-package-typecheck.mjs')).href
)) as IWorkspaceTypecheckModule;

async function createTempProject() {
    return mkdtemp(join(tmpdir(), 'evb-workspace-typecheck-'));
}

async function writeProjectFile(projectRoot: string, filePath: string, text = '') {
    const absolutePath = join(projectRoot, filePath);
    await mkdir(join(absolutePath, '..'), {recursive: true});
    await writeFile(absolutePath, text, 'utf8');
}

describe('workspace package typecheck helper', () => {
    it('typechecks repo workspace packages and skips the checked-in JS-only exemption', () => {
        const plan = getWorkspacePackageTypecheckPlan();
        const tsconfigTargets = plan.command.args.flatMap((argument, index, args) =>
            argument === '-p' && args[index + 1] ? [args[index + 1]] : [],
        );

        expect(tsconfigTargets).toEqual(
            expect.arrayContaining([
                'packages/contracts/tsconfig.json',
                'packages/i18n-app/tsconfig.json',
                'packages/i18n-core/tsconfig.json',
                'packages/pdf-core/tsconfig.json',
                'packages/release-selection/tsconfig.json',
            ]),
        );
        expect(plan.skipped).toContainEqual({
            packageRoot: 'packages/electron-worker-bundles',
            reason: TYPECHECK_EXEMPT_WORKSPACE_PACKAGES['packages/electron-worker-bundles'],
        });
    });

    it('fails when a workspace package has no tsconfig and no exemption', async () => {
        const projectRoot = await createTempProject();
        try {
            await writeProjectFile(projectRoot, 'pnpm-workspace.yaml', ['packages:', "  - 'packages/*'"].join('\n'));
            await writeProjectFile(projectRoot, 'packages/new-package/package.json', '{"name":"new-package"}\n');

            expect(() => {
                getWorkspacePackageTypecheckPlan({projectRoot});
            }).toThrow('packages/new-package is missing tsconfig.json');
        } finally {
            await rm(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('runs each typecheck command from the workspace root and reports skips', async () => {
        const projectRoot = await createTempProject();
        const writes: string[] = [];
        const calls: Array<{
            args: string[];
            command: string;
            cwd: string;
            stdio: 'inherit';
        }> = [];

        try {
            await writeProjectFile(projectRoot, 'pnpm-workspace.yaml', ['packages:', "  - 'packages/*'"].join('\n'));
            await writeProjectFile(projectRoot, 'packages/contracts/package.json', '{"name":"contracts"}\n');
            await writeProjectFile(projectRoot, 'packages/contracts/tsconfig.json', '{"extends":"../../tsconfig.json"}\n');
            await writeProjectFile(projectRoot, 'packages/electron-worker-bundles/package.json', '{"name":"worker-bundles"}\n');

            runWorkspacePackageTypecheck({
                projectRoot,
                runCommand: (command, args, options) => {
                    calls.push({
                        args,
                        command,
                        cwd: options.cwd,
                        stdio: options.stdio,
                    });
                },
                stdout: {
                    write: (message) => {
                        writes.push(message);
                    },
                },
            });

            expect(calls).toEqual([
                {
                    args: ['scripts/run-ts7-typecheck.mjs', '-p', 'packages/contracts/tsconfig.json'],
                    command: 'node',
                    cwd: projectRoot,
                    stdio: 'inherit',
                },
            ]);
            expect(writes.join('')).toContain('Skipping workspace package typecheck for packages/electron-worker-bundles');
        } finally {
            await rm(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
