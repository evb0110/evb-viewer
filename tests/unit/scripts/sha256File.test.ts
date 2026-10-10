import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';

const tempDirs: string[] = [];
const helperPath = resolve(process.cwd(), 'scripts/sha256-file.sh');
const expectedSha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'evb-sha256-file-'));
    tempDirs.push(dir);
    return dir;
}

function runSha256WithPath(pathValue: string, filePath: string) {
    return execFileSync(
        '/bin/bash',
        [
            '-lc',
            'source "$1"; sha256_file "$2"',
            'bash',
            helperPath,
            filePath,
        ],
        {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: pathValue,
            },
        },
    ).trim();
}

function addRequiredUnixTools(binDir: string) {
    symlinkSync('/usr/bin/awk', join(binDir, 'awk'));
}

describe('sha256_file shell helper', () => {
    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, {
                force: true,
                recursive: true,
            });
        }
    });

    // Bash and the /usr/bin/awk shell fixtures run only on POSIX hosts.
    it.skipIf(process.platform === 'win32')('uses sha256sum when shasum is unavailable', () => {
        const dir = createTempDir();
        const filePath = join(dir, 'payload.txt');
        writeFileSync(filePath, 'hello');

        const binDir = join(dir, 'bin');
        const sha256sumPath = join(binDir, 'sha256sum');
        mkdirSync(binDir);
        addRequiredUnixTools(binDir);
        writeFileSync(
            sha256sumPath,
            `#!/bin/sh\nprintf '\\\\%s  %s\\n' '${expectedSha256}' "$1"\n`,
            { mode: 0o755 },
        );

        expect(runSha256WithPath(binDir, filePath)).toBe(expectedSha256);
    });

    // Bash and the /usr/bin/awk shell fixtures run only on POSIX hosts.
    it.skipIf(process.platform === 'win32')('falls back to certutil-style output when Unix checksum tools are unavailable', () => {
        const dir = createTempDir();
        const filePath = join(dir, 'payload.txt');
        writeFileSync(filePath, 'hello');

        const binDir = join(dir, 'bin');
        const certutilPath = join(binDir, 'certutil');
        mkdirSync(binDir);
        addRequiredUnixTools(binDir);
        writeFileSync(
            certutilPath,
            `#!/bin/sh\nprintf '%s\\n' 'SHA256 hash of file payload.txt:' '${expectedSha256.toUpperCase().replace(/(.{2})/gu, '$1 ').trim()}' 'CertUtil: -hashfile command completed successfully.'\n`,
            { mode: 0o755 },
        );

        expect(runSha256WithPath(binDir, filePath)).toBe(expectedSha256);
    });
});
