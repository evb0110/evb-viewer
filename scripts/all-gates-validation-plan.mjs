/** @param {string} id @param {string} scriptName @param {Record<string, unknown>} options */
function pnpmStage(id, scriptName, options = {}) {
    return {
        args: [
            'run',
            scriptName,
        ],
        command: 'pnpm',
        dependsOn: [],
        heavyWeight: 0,
        weight: 1,
        ...options,
        id,
    };
}

export function createAllGatesValidationStages({cold = false} = {}) {
    return [
        pnpmStage('build.prepare', 'generate:build-artifacts', {priority: 100}),
        pnpmStage('lint.full', cold ? 'lint:clean' : 'lint', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            heavyWeight: 2,
            inputScope: 'lint',
            priority: 70,
            weight: 2,
        }),
        pnpmStage('typecheck.full', cold ? 'typecheck:clean' : 'typecheck', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            heavyWeight: 1,
            inputScope: 'typecheck',
            priority: 60,
            weight: 1,
        }),
        pnpmStage('test.unit.full', 'test:unit', {
            dependsOn: ['build.prepare'],
            heavyWeight: 4,
            priority: 90,
            weight: 4,
        }),
        pnpmStage('static.web-deploy-source', 'check:static:assets', {
            args: [
                'run',
                'check:static:assets',
                '--allow-dirty',
            ],
            cacheable: true,
            dependsOn: ['build.prepare'],
            inputScope: 'web-deploy',
            priority: 30,
        }),
        pnpmStage('native.lint', 'lint:rust', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            env: {CARGO_BUILD_JOBS: '2'},
            heavyWeight: 2,
            inputScope: 'native',
            priority: 65,
            weight: 2,
        }),
        pnpmStage('native.test', 'test:rust', {
            dependsOn: ['build.prepare'],
            env: {
                CARGO_BUILD_JOBS: '4',
                RUST_TEST_THREADS: '4',
            },
            heavyWeight: 4,
            inputScope: 'native',
            priority: 95,
            weight: 4,
        }),
        // build.strict, native.resource-matrix, electron.bundle-integrity and
        // electron.blocking-smoke are deliberately absent. They are the strict
        // build and its dependents, and hosted CI proves the same contracts on
        // the platform releases ship from. Locally they dominated the run,
        // never once predicted a Linux verdict, and their Electron launches
        // competed with the developer's own session for the desktop.
    ];
}

export const allGatesValidationStages = createAllGatesValidationStages();
