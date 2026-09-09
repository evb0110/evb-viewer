import {
    describe,
    expect,
    it,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
    join,
    resolve,
} from 'node:path';

const {
    assertVersionNotBehindAncestorRelease,
    getReleaseMainUpstream,
    parsePinnedNodeMajor,
    restoreVersionIfChanged,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/shared.mjs')).href,
);

describe('release shared helpers', () => {
    it('rejects a lower manifest when a release tag is reachable through a merge parent', () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-release-ancestry-'));
        const git = (args: string[]) => execFileSync('git', args, {
            cwd: root,
            encoding: 'utf8',
        }).trim();
        const writeVersion = (version: string) => writeFileSync(
            join(root, 'package.json'),
            `${JSON.stringify({version})}\n`,
        );

        try {
            git([
                'init',
                '-b',
                'main',
            ]);
            git([
                'config',
                'user.email',
                'release-test@example.com',
            ]);
            git([
                'config',
                'user.name',
                'Release test',
            ]);
            writeVersion('0.1.452');
            git([
                'add',
                'package.json',
            ]);
            git([
                'commit',
                '-m',
                'base',
            ]);
            const baseSha = git([
                'rev-parse',
                'HEAD',
            ]);

            git([
                'checkout',
                '-b',
                'unrelated',
            ]);
            writeFileSync(join(root, 'unrelated.txt'), 'unrelated\n');
            git([
                'add',
                'unrelated.txt',
            ]);
            git([
                'commit',
                '-m',
                'unrelated change',
            ]);
            git([
                'tag',
                'v99.0.0',
            ]);
            git([
                'checkout',
                'main',
            ]);

            git([
                'checkout',
                '-b',
                'release',
            ]);
            writeVersion('0.1.453');
            git([
                'add',
                'package.json',
            ]);
            git([
                'commit',
                '-m',
                'release',
            ]);
            git([
                'tag',
                'v0.1.453',
            ]);

            git([
                'checkout',
                'main',
            ]);
            writeFileSync(join(root, 'marker.txt'), 'main\n');
            git([
                'add',
                'marker.txt',
            ]);
            git([
                'commit',
                '-m',
                'main change',
            ]);
            git([
                'merge',
                '--no-commit',
                'release',
            ]);
            writeVersion('0.1.452');
            git([
                'add',
                'package.json',
            ]);
            git([
                'commit',
                '-m',
                'merge stale manifest',
            ]);
            const candidateSha = git([
                'rev-parse',
                'HEAD',
            ]);

            expect(candidateSha).not.toBe(baseSha);
            const runCommand = (command: string, args: string[], options: object = {}) => {
                if (command === 'git' && args[0] === 'fetch') {
                    return '';
                }
                return execFileSync(command, args, {
                    cwd: root,
                    encoding: 'utf8',
                    ...options,
                }).trim();
            };
            expect(() => assertVersionNotBehindAncestorRelease('0.1.452', candidateSha, {runCommand})).toThrow(new RegExp(
                `candidate ${candidateSha}.*0\\.1\\.452.*v0\\.1\\.453`,
                'u',
            ));
            expect(() => assertVersionNotBehindAncestorRelease('0.1.453', candidateSha, {runCommand})).not.toThrow();
        } finally {
            rmSync(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('accepts only main configured to publish to origin/main', () => {
        const canonicalUpstream = {
            branch: 'main',
            ref: 'origin/main',
            remote: 'origin',
        };
        expect(getReleaseMainUpstream('Release test', {
            readBranch: () => 'main',
            readUpstream: () => canonicalUpstream,
        })).toEqual(canonicalUpstream);

        expect(() => getReleaseMainUpstream('Release test', {
            readBranch: () => 'feature/release',
            readUpstream: () => {
                throw new Error('upstream must not be read');
            },
        })).toThrow('current branch to be main');
        expect(() => getReleaseMainUpstream('Release test', {
            readBranch: () => 'main',
            readUpstream: () => ({
                branch: 'release',
                ref: 'origin/release',
                remote: 'origin',
            }),
        })).toThrow('track origin/main');
        expect(() => getReleaseMainUpstream('Release test', {
            readBranch: () => 'main',
            readUpstream: () => ({
                branch: 'main',
                ref: 'fork/main',
                remote: 'fork',
            }),
        })).toThrow('track origin/main');
    });

    it('parses the project node baseline from a pinned major range', () => {
        expect(parsePinnedNodeMajor('24.x')).toBe(24);
        expect(parsePinnedNodeMajor('26.x')).toBe(26);
    });

    it('rejects non-pinned node engine ranges', () => {
        expect(() => parsePinnedNodeMajor('lts/*')).toThrow(
            'requires package.json engines.node to use a pinned "<major>.x" range',
        );
        expect(() => parsePinnedNodeMajor('>=24')).toThrow(
            'requires package.json engines.node to use a pinned "<major>.x" range',
        );
    });

    it('restores the intended release version when verification drifts package metadata', () => {
        const writes: string[] = [];
        const messages: string[] = [];

        const restored = restoreVersionIfChanged('0.1.205', {
            readVersionFn: () => '0.1.204',
            stderr: { write: (message: string) => messages.push(message) },
            writeVersionFn: (version: string) => writes.push(version),
        });

        expect(restored).toBe(true);
        expect(writes).toEqual(['0.1.205']);
        expect(messages[0]).toContain('restoring 0.1.205 before committing');
    });

    it('leaves release metadata alone when verification preserves the bumped version', () => {
        const writes: string[] = [];

        const restored = restoreVersionIfChanged('0.1.205', {
            readVersionFn: () => '0.1.205',
            stderr: { write: () => undefined },
            writeVersionFn: (version: string) => writes.push(version),
        });

        expect(restored).toBe(false);
        expect(writes).toEqual([]);
    });
});
