import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {resolvePackageScript} from '@tests/helpers/packageScriptCommands';
import type {
    PackageJson,
    SetRequired,
    Simplify,
} from 'type-fest';

interface IVitestProjectTestConfig {
    env?: Record<string, string>;
    exclude?: string[];
    fileParallelism?: boolean;
    globalSetup?: string[];
    hookTimeout?: number;
    include?: string[];
    maxWorkers?: number;
    name?: string;
    retry?: number | {
        condition?: RegExp;
        count?: number;
    };
    sequence?: {concurrent?: boolean};
    setupFiles?: string[];
    testTimeout?: number;
}

interface IVitestProjectConfig {
    plugins?: unknown[];
    test?: IVitestProjectTestConfig;
}

interface IVitestSharedConfigModule {vitestProjects: IVitestProjectConfig[];}

type TPackageJsonWithScripts = Simplify<SetRequired<PackageJson, 'scripts'>>;

let importNonce = 0;

async function loadVitestSharedConfig(ci: string | undefined) {
    const previousCi = process.env.CI;

    try {
        if (ci === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = ci;
        }

        vi.resetModules();
        importNonce += 1;
        const configUrl = pathToFileURL(resolve('vitest.shared.config.ts'));
        configUrl.searchParams.set('retry-policy', importNonce.toString());
        return await import(/* @vite-ignore */ configUrl.href) as IVitestSharedConfigModule;
    } finally {
        if (previousCi === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = previousCi;
        }
    }
}

function projectByName(
    config: IVitestSharedConfigModule,
    projectName: string,
) {
    const project = config.vitestProjects.find(candidate => candidate.test?.name === projectName);

    if (!project) {
        throw new Error(`Missing Vitest project: ${projectName}`);
    }

    return project;
}

function projectNames(config: IVitestSharedConfigModule) {
    return config.vitestProjects
        .map(project => project.test?.name)
        .filter((name): name is string => name !== undefined);
}

function e2eProjectNames(config: IVitestSharedConfigModule) {
    return projectNames(config).filter(name => name.startsWith('e2e-'));
}

async function readPackageJsonWithScripts(): Promise<TPackageJsonWithScripts> {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as PackageJson;
    if (!packageJson.scripts) {
        throw new Error('Missing package scripts');
    }

    return packageJson as TPackageJsonWithScripts;
}

function includesFor(config: IVitestSharedConfigModule, projectName: string) {
    return projectByName(config, projectName).test?.include ?? [];
}

describe('electron e2e Vitest project topology', () => {
    it('gives ordinary Electron E2E projects a canonical headless package route', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const packageJson = await readPackageJsonWithScripts();
        const packageScripts = packageJson.scripts;
        const electronProjects = e2eProjectNames(config);
        const ordinaryProjects = electronProjects.filter(name => name !== 'e2e-visible-window');

        for (const projectName of ordinaryProjects) {
            const includes = includesFor(config, projectName);
            expect(includes, `${projectName} must own a test include`).not.toEqual([]);

            if (projectName === 'e2e-quarantine') {
                expect(resolvePackageScript(packageScripts, 'test:e2e:electron:quarantine'))
                    .toContain('pnpm exec tsx scripts/ci/runElectronQuarantine.ts');
                continue;
            }

            const routes = Object.keys(packageScripts)
                .map(scriptName => resolvePackageScript(packageScripts, scriptName))
                .filter(command => command.includes(`--no-build ${projectName}`));

            expect(routes, `missing shared headless runner route for ${projectName}`).not.toEqual([]);
            expect(routes.every(command => (
                command.includes('bash scripts/test-electron-e2e-headless.sh')
            ))).toBe(true);
        }

        const visibleIncludes = includesFor(config, 'e2e-visible-window');
        expect(visibleIncludes).not.toEqual([]);
        for (const projectName of ordinaryProjects) {
            expect(includesFor(config, projectName)).not.toEqual(
                expect.arrayContaining(visibleIncludes),
            );
        }
        expect(packageScripts['test:e2e:electron:visible-window'])
            .not.toContain('scripts/test-electron-e2e-headless.sh');
    });

    it('keeps local iteration retry-free and retries only marked infrastructure failures in CI', async () => {
        const localConfig = await loadVitestSharedConfig(undefined);
        const ciConfig = await loadVitestSharedConfig('true');
        const ciRetry = {
            condition: /\[INFRA\]/u,
            count: 2,
        };

        for (const projectName of e2eProjectNames(localConfig)) {
            expect(projectByName(localConfig, projectName).test?.retry, projectName).toBe(0);
            expect(projectByName(ciConfig, projectName).test?.retry, projectName).toEqual(ciRetry);
        }
    });

    it('keeps the regression project serialized with bounded timeouts', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const regressionProject = projectByName(config, 'e2e-regression');

        expect(regressionProject.test?.include).not.toEqual([]);
        expect(regressionProject.test?.globalSetup).toEqual(['tests/e2e/electron/globalSetup.ts']);
        expect(regressionProject.test?.fileParallelism).toBe(false);
        expect(regressionProject.test?.maxWorkers).toBe(1);
        expect(regressionProject.test?.sequence).toEqual({concurrent: false});
        expect(regressionProject.test?.testTimeout).toBe(90_000);
        expect(regressionProject.test?.hookTimeout).toBe(150_000);
    });

    it('keeps the blocking smoke project separate from broad regression', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const blockingSmokeProject = projectByName(config, 'e2e-blocking-smoke');
        const regressionProject = projectByName(config, 'e2e-regression');

        expect(blockingSmokeProject.test?.include).not.toEqual([]);
        expect(blockingSmokeProject.test?.env).toMatchObject({EVB_PR_SMOKE_SCOPE: 'blocking'});
        expect(regressionProject.test?.env).toMatchObject({EVB_PR_SMOKE_SCOPE: 'pressure'});
        expect(blockingSmokeProject.test?.include).not.toContain(
            'tests/e2e/electron/viewerSmoke.e2e.test.ts',
        );
    });
});

describe('electron e2e quarantine Vitest project', () => {
    it('uses the quarantine project and leaves empty-lane handling to its script', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const packageJson = await readPackageJsonWithScripts();
        const packageScripts = packageJson.scripts;
        const quarantineProject = projectByName(config, 'e2e-quarantine');

        expect(quarantineProject.test?.include).not.toEqual([]);
        expect(quarantineProject.test?.exclude).toBeDefined();
        for (const scriptName of [
            'test:e2e:electron:quarantine',
            'test:e2e:electron:quarantine:headless',
        ]) {
            const command = resolvePackageScript(packageScripts, scriptName);
            expect(command).toContain('pnpm exec tsx scripts/ci/runElectronQuarantine.ts');
            expect(command).not.toContain('--passWithNoTests');
        }
    });
});
