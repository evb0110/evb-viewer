import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {resolvePlatformArchTag} from '@electron/utils/platformArch';

const macOsDescribe = process.platform === 'darwin' ? describe : describe.skip;
const helperPath = resolve(
    process.cwd(),
    '.tmp',
    'pdf-print-dialog',
    process.platform === 'darwin' ? resolvePlatformArchTag() : 'darwin-arm64',
    'bin',
    'pdf-print-dialog',
);

function runHelper(args: string[]) {
    return spawnSync(helperPath, args, {
        encoding: 'utf8',
        timeout: 30_000,
    });
}

macOsDescribe('macOS PDF print dialog CLI', () => {
    beforeAll(() => {
        const build = spawnSync('bash', ['scripts/build-macos-pdf-print-dialog.sh'], {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 60_000,
        });
        expect({
            status: build.status,
            stderr: build.stderr,
        }).toEqual({
            status: 0,
            stderr: '',
        });
    });

    it('reports its version and exits successfully', () => {
        const result = runHelper(['--version']);

        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('evb-pdf-print-dialog 1');
        expect(result.stderr).toBe('');
    });

    it('rejects an invalid argument count with usage', () => {
        const result = runHelper([]);

        expect(result.status).toBe(64);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('usage: pdf-print-dialog <path>\n');
    });

    it('rejects an unreadable PDF path', () => {
        const result = runHelper(['/definitely/missing/evb-print-dialog-test.pdf']);

        expect(result.status).toBe(65);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('unable to open PDF\n');
    });
});
