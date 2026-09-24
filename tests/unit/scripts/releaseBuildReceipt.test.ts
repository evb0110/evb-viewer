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
});
