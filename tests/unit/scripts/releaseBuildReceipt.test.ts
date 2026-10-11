import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computeReleaseBuildState,
    validateReleaseBuildReceipt,
    writeReleaseBuildReceipt,
} from '@scripts/release/build-receipt.mjs';
import {getRequestedNativeRustTarget} from '@scripts/native-rust-targets.mjs';

function fakeToolchain(command: string, args: string[]) {
    return `${command} ${args.join(' ')} test-version`;
}

describe('release strict-build receipts', () => {
    it('accepts exact input/output reuse and rejects source, output, and toolchain changes', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-'));
        const inputPath = path.join(projectRoot, 'source.ts');
        const outputPath = path.join(projectRoot, 'dist', 'main.js');
        const receiptPath = path.join(projectRoot, '.devkit', 'receipt.json');
        mkdirSync(path.dirname(outputPath), {recursive: true});
        writeFileSync(inputPath, 'export const value = 1;\n');
        writeFileSync(outputPath, 'built-output\n');

        try {
            const options = {
                env: {NODE_ENV: 'production'},
                inputFiles: ['source.ts'],
                outputPaths: ['dist'],
                projectRoot,
                runCommand: fakeToolchain,
            };
            const original = writeReleaseBuildReceipt(receiptPath, options);
            expect(validateReleaseBuildReceipt(receiptPath, options)).toMatchObject({
                receipt: original,
                valid: true,
            });

            writeFileSync(inputPath, 'export const value = 2;\n');
            expect(validateReleaseBuildReceipt(receiptPath, options)).toEqual({
                reason: 'inputs-changed',
                valid: false,
            });
            writeFileSync(inputPath, 'export const value = 1;\n');
            writeFileSync(outputPath, 'tampered-output\n');
            expect(validateReleaseBuildReceipt(receiptPath, options)).toEqual({
                reason: 'outputs-changed',
                valid: false,
            });
            expect(validateReleaseBuildReceipt(receiptPath, {
                ...options,
                runCommand: (command: string, args: string[]) => (
                    `${command} ${args.join(' ')} different-version`
                ),
            })).toEqual({
                reason: 'inputs-changed',
                valid: false,
            });
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fails closed when a required output is absent', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-missing-'));
        writeFileSync(path.join(projectRoot, 'source.ts'), 'source\n');
        try {
            expect(() => computeReleaseBuildState({
                inputFiles: ['source.ts'],
                outputPaths: ['missing-output'],
                projectRoot,
                runCommand: fakeToolchain,
            })).toThrow();
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rebuilds when compiled configuration or a required output changes under unchanged source', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-config-'));
        const receiptPath = path.join(projectRoot, '.devkit', 'receipt.json');
        const outputPath = path.join(projectRoot, 'dist-electron', 'main.js');
        writeFileSync(path.join(projectRoot, 'source.ts'), 'export const value = 1;\n');
        mkdirSync(path.dirname(outputPath), {recursive: true});
        writeFileSync(outputPath, 'built-output\n');
        const baseEnv = {
            EVB_APP_VERSION: '1.2.3',
            NODE_ENV: 'production',
            SENTRY_AUTH_TOKEN: 'auth-token-a',
            SENTRY_BROWSER_DSN: 'browser-dsn-a',
            SENTRY_DESKTOP_DSN: 'desktop-dsn-a',
        };
        const optionsFor = (env: Record<string, string>) => ({
            env,
            inputFiles: ['source.ts'],
            outputPaths: ['dist-electron'],
            projectRoot,
            runCommand: fakeToolchain,
        });
        try {
            writeReleaseBuildReceipt(receiptPath, optionsFor(baseEnv));
            expect(validateReleaseBuildReceipt(receiptPath, optionsFor(baseEnv))).toMatchObject({valid: true});

            for (const {
                name, value,
            } of [
                    {
                        name: 'EVB_APP_VERSION',
                        value: '1.2.4',
                    },
                    {
                        name: 'SENTRY_BROWSER_DSN',
                        value: 'browser-dsn-b',
                    },
                    {
                        name: 'SENTRY_DESKTOP_DSN',
                        value: 'desktop-dsn-b',
                    },
                ]) {
                expect(validateReleaseBuildReceipt(receiptPath, optionsFor({
                    ...baseEnv,
                    [name]: value,
                }))).toEqual({
                    reason: 'inputs-changed',
                    valid: false,
                });
            }

            rmSync(outputPath);
            expect(validateReleaseBuildReceipt(receiptPath, optionsFor(baseEnv))).toMatchObject({valid: false});
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rebuilds when a root .env or the auth token presence changes, and never on the token value', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-dotenv-'));
        const receiptPath = path.join(projectRoot, '.devkit', 'receipt.json');
        writeFileSync(path.join(projectRoot, 'source.ts'), 'export const value = 1;\n');
        mkdirSync(path.join(projectRoot, 'dist-electron'));
        writeFileSync(path.join(projectRoot, 'dist-electron', 'main.js'), 'built-output\n');
        const optionsFor = (env: Record<string, string>) => ({
            env,
            inputFiles: ['source.ts'],
            outputPaths: ['dist-electron'],
            projectRoot,
            runCommand: fakeToolchain,
        });
        try {
            writeReleaseBuildReceipt(receiptPath, optionsFor({SENTRY_AUTH_TOKEN: ''}));
            expect(validateReleaseBuildReceipt(receiptPath, optionsFor({SENTRY_AUTH_TOKEN: ''}))).toMatchObject({valid: true});
            // Nuxt reads a whitespace token as set, so it changes source-map emission.
            expect(validateReleaseBuildReceipt(receiptPath, optionsFor({SENTRY_AUTH_TOKEN: ' '}))).toEqual({
                reason: 'inputs-changed',
                valid: false,
            });
            expect(validateReleaseBuildReceipt(receiptPath, optionsFor({SENTRY_AUTH_TOKEN: 'auth-token-b'}))).toEqual({
                reason: 'inputs-changed',
                valid: false,
            });

            writeReleaseBuildReceipt(receiptPath, optionsFor({SENTRY_AUTH_TOKEN: 'auth-token-a'}));
            expect(validateReleaseBuildReceipt(receiptPath, optionsFor({SENTRY_AUTH_TOKEN: 'auth-token-b'}))).toMatchObject({valid: true});

            writeFileSync(path.join(projectRoot, '.env'), 'NUXT_PUBLIC_LANDING_URL=https://before.invalid\n');
            writeReleaseBuildReceipt(receiptPath, optionsFor({}));
            expect(validateReleaseBuildReceipt(receiptPath, optionsFor({}))).toMatchObject({valid: true});
            writeFileSync(path.join(projectRoot, '.env'), 'NUXT_PUBLIC_LANDING_URL=https://after.invalid\n');
            expect(validateReleaseBuildReceipt(receiptPath, optionsFor({}))).toEqual({
                reason: 'inputs-changed',
                valid: false,
            });
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it.each([
        [
            'CC',
            'changed-compiler',
        ],
        [
            'SDKROOT',
            '/changed-sdk',
        ],
        [
            'MACOSX_DEPLOYMENT_TARGET',
            '14.0',
        ],
        [
            'CARGO_ENCODED_RUSTFLAGS',
            '--cfg\u001freview',
        ],
        [
            'CARGO_PROFILE_RELEASE_OPT_LEVEL',
            '1',
        ],
        [
            'RUSTC_WRAPPER',
            '/changed-wrapper',
        ],
    ])('rejects changed native compiler configuration: %s', (key, value) => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-native-env-'));
        const options = {
            env: {},
            projectRoot,
            inputFiles: [],
            outputPaths: [],
            runCommand: fakeToolchain,
        };
        const receiptPath = path.join(projectRoot, 'receipt.json');
        try {
            writeReleaseBuildReceipt(receiptPath, options);
            expect(validateReleaseBuildReceipt(receiptPath, {
                ...options,
                env: {[key]: value},
            }))
                .toEqual({
                    valid: false,
                    reason: 'inputs-changed',
                });
        } finally { rmSync(projectRoot, {
            recursive: true,
            force: true,
        }); }
    });

    it('rejects edited configuration in the same external Cargo home', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-cargo-config-'));
        const cargoHome = mkdtempSync(path.join(tmpdir(), 'evb-external-cargo-'));
        const options = {
            env: {CARGO_HOME: cargoHome},
            projectRoot,
            inputFiles: [],
            outputPaths: [],
            runCommand: fakeToolchain,
        };
        const receiptPath = path.join(projectRoot, 'receipt.json');
        try {
            writeFileSync(path.join(cargoHome, 'config.toml'), '[build]\n rustflags = ["--cfg", "before"]\n');
            writeReleaseBuildReceipt(receiptPath, options);
            writeFileSync(path.join(cargoHome, 'config.toml'), '[build]\n rustflags = ["--cfg", "after"]\n');
            expect(validateReleaseBuildReceipt(receiptPath, options)).toEqual({
                valid: false,
                reason: 'inputs-changed',
            });
        } finally {
            rmSync(projectRoot, {
                recursive: true,
                force: true,
            });
            rmSync(cargoHome, {
                recursive: true,
                force: true,
            });
        }
    });

    it.each([
        'NUXT_PUBLIC_SENTRY_DSN',
        'NUXT_ANALYTICS_DATABASE_URL',
        'VITE_SECRET_KEY',
    ])('digests sensitive overrides without dropping their identity: %s', key => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-sensitive-'));
        const options = {
            env: {[key]: 'dummy-secret-before'},
            projectRoot,
            inputFiles: [],
            outputPaths: [],
            runCommand: fakeToolchain,
        };
        const receiptPath = path.join(projectRoot, 'receipt.json');
        try {
            const receipt = writeReleaseBuildReceipt(receiptPath, options);
            expect(JSON.stringify(receipt)).not.toContain('dummy-secret-before');
            expect(validateReleaseBuildReceipt(receiptPath, {
                ...options,
                env: {[key]: 'dummy-secret-after'},
            }))
                .toEqual({
                    valid: false,
                    reason: 'inputs-changed',
                });
        } finally { rmSync(projectRoot, {
            recursive: true,
            force: true,
        }); }
    });

    it.each([
        'SENTRY_DESKTOP_DSN',
        'SENTRY_AUTH_TOKEN',
    ])('keeps Electron parent inputs distinct from Nuxt dotenv fallback: %s', key => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-parent-env-'));
        const options = {
            env: {},
            projectRoot,
            inputFiles: [],
            outputPaths: [],
            runCommand: fakeToolchain,
        };
        const receiptPath = path.join(projectRoot, 'receipt.json');
        try {
            writeFileSync(path.join(projectRoot, '.env'), `${key}=same-dummy-value\n`);
            writeReleaseBuildReceipt(receiptPath, options);
            expect(validateReleaseBuildReceipt(receiptPath, {
                ...options,
                env: {[key]: 'same-dummy-value'},
            }))
                .toEqual({
                    valid: false,
                    reason: 'inputs-changed',
                });
        } finally { rmSync(projectRoot, {
            recursive: true,
            force: true,
        }); }
    });

    it('keeps DSNs and database URLs out of the recorded build environment', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-secrets-'));
        writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({version: '1.2.3'}));
        writeFileSync(path.join(projectRoot, 'source.ts'), 'export const value = 1;\n');
        mkdirSync(path.join(projectRoot, 'dist-electron'));
        const secrets = [
            'desktop-dsn-secret',
            'browser-dsn-secret',
            'database-url-secret',
        ];
        try {
            const state = computeReleaseBuildState({
                env: {
                    NODE_ENV: 'production',
                    EVB_ELECTRON_SOURCEMAP: '1',
                    SENTRY_DESKTOP_DSN: secrets[0],
                    NUXT_PUBLIC_SENTRY_DSN: secrets[1],
                    NUXT_ANALYTICS_DATABASE_URL: secrets[2],
                },
                inputFiles: ['source.ts'],
                outputPaths: ['dist-electron'],
                projectRoot,
                runCommand: fakeToolchain,
            });
            expect(state.contract.environment).toHaveProperty('EVB_ELECTRON_SOURCEMAP', '1');
            for (const secret of secrets) {
                expect(JSON.stringify(state.contract)).not.toContain(secret);
            }
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rebuilds when a value that the Nuxt or Electron build reads changes under unchanged source', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-reads-'));
        const receiptPath = path.join(projectRoot, '.devkit', 'receipt.json');
        writeFileSync(path.join(projectRoot, 'source.ts'), 'export const value = 1;\n');
        mkdirSync(path.join(projectRoot, 'dist-electron'));
        writeFileSync(path.join(projectRoot, 'dist-electron', 'main.js'), 'built-output\n');
        const optionsFor = (env: Record<string, string>) => ({
            env,
            inputFiles: ['source.ts'],
            outputPaths: ['dist-electron'],
            projectRoot,
            runCommand: fakeToolchain,
        });
        try {
            writeReleaseBuildReceipt(receiptPath, optionsFor({NODE_ENV: 'production'}));
            for (const [
                name,
                value,
            ] of [
                    [
                        'VERCEL',
                        '1',
                    ],
                    [
                        'NOW_BUILDER',
                        '1',
                    ],
                    [
                        'VERCEL_ENV',
                        'production',
                    ],
                    [
                        'EVB_NUXT_BUILD_DIR',
                        'nuxt-build',
                    ],
                    [
                        'EVB_NUXT_VITE_CACHE_DIR',
                        'vite-cache',
                    ],
                    [
                        'EVB_NUXT_OUTPUT_DIR',
                        'isolated-output',
                    ],
                    [
                        'EVB_ELECTRON_SOURCEMAP',
                        '1',
                    ],
                    [
                        'GITHUB_SHA',
                        'a'.repeat(40),
                    ],
                    [
                        'CARGO_HOME',
                        '/opt/cargo',
                    ],
                ] as const) {
                expect(validateReleaseBuildReceipt(receiptPath, optionsFor({
                    NODE_ENV: 'production',
                    [name]: value,
                })), name).toEqual({
                    reason: 'inputs-changed',
                    valid: false,
                });
            }
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it.each([
        'process',
        'dotenv',
        'dotenv-expanded',
        'process-override',
    ])('checks the emitted Nuxt output selected by %s', mode => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-output-dir-'));
        const receiptPath = path.join(projectRoot, '.devkit', 'receipt.json');
        const {platformArch} = getRequestedNativeRustTarget({});
        writeFileSync(path.join(projectRoot, 'source.ts'), 'export const value = 1;\n');
        for (const directory of [
            'dist-electron',
            'nuxt-output',
            'isolated-output',
            '.tmp/native-stage',
        ]) {
            mkdirSync(path.join(projectRoot, directory), {recursive: true});
            writeFileSync(path.join(projectRoot, directory, 'built.js'), 'built-output\n');
        }
        writeFileSync(path.join(projectRoot, '.tmp', 'generated-electron-builder-resources.yml'), 'resources: []\n');
        mkdirSync(path.join(projectRoot, '.tmp', 'native-build-manifest'), {recursive: true});
        writeFileSync(
            path.join(projectRoot, '.tmp', 'native-build-manifest', `${platformArch}.json`),
            `${JSON.stringify({
                platformArch,
                schemaVersion: 1,
                stagingRoots: ['.tmp/native-stage'],
            })}\n`,
        );
        if (mode !== 'process') {
            writeFileSync(path.join(projectRoot, '.env'), mode === 'dotenv-expanded'
                ? 'OUTPUT_ROOT=isolated\nEVB_NUXT_OUTPUT_DIR=${OUTPUT_ROOT}-output\n'
                : `EVB_NUXT_OUTPUT_DIR=${mode === 'process-override' ? 'nuxt-output' : 'isolated-output'}\n`);
        }
        const options = {
            env: mode === 'process' || mode === 'process-override' ? {EVB_NUXT_OUTPUT_DIR: 'isolated-output'} : {},
            inputFiles: ['source.ts'],
            projectRoot,
            runCommand: fakeToolchain,
        };
        try {
            writeReleaseBuildReceipt(receiptPath, options);
            expect(validateReleaseBuildReceipt(receiptPath, options)).toMatchObject({valid: true});

            // The stable nuxt-output directory is untouched; the directory this build writes is gone.
            rmSync(path.join(projectRoot, 'isolated-output'), {
                force: true,
                recursive: true,
            });
            expect(validateReleaseBuildReceipt(receiptPath, options)).toMatchObject({valid: false});
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
