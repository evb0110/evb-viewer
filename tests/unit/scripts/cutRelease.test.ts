import {
    describe, expect, it,
} from 'vitest';
import {
    bumpReleaseVersion, parseCutReleaseArgs, planRelease, releaseVersionParts, selectReleaseCandidate,
} from '@scripts/release/cut-release.mjs';

describe('tag release cutter', () => {
    it('accepts only one release level', () => {
        expect(parseCutReleaseArgs(['patch'])).toBe('patch');
        expect(parseCutReleaseArgs(['minor'])).toBe('minor');
        expect(() => parseCutReleaseArgs(['--resume'])).toThrow('Usage:');
    });

    it('derives versions from the newest stable tag', () => {
        expect(releaseVersionParts('v1.2.3')).toEqual([
            1,
            2,
            3,
        ]);
        expect(bumpReleaseVersion([
            1,
            2,
            3,
        ], 'patch')).toBe('1.2.4');
        expect(bumpReleaseVersion([
            1,
            2,
            3,
        ], 'minor')).toBe('1.3.0');
        expect(bumpReleaseVersion([
            1,
            2,
            3,
        ], 'major')).toBe('2.0.0');
        expect(() => releaseVersionParts('v1.2.3-drill.42')).toThrow('Invalid stable release tag');
    });

    it('chooses the newest exact green CI commit descended from the last release', () => {
        const commands: string[][] = [];
        const result = selectReleaseCandidate({
            runCommand: (_command, args) => {
                commands.push(args);
                if (args[0] === 'tag') return 'v1.2.3';
                if (args[0] === 'rev-parse') return args[1] === 'origin/main' ? 'main' : 'tag-sha';
                if (args[0] === 'merge-base') return '';
                return '';
            },
            listRuns: () => [
                {
                    id: 7,
                    head_sha: 'new',
                    html_url: 'https://ci/new',
                },
                {
                    id: 6,
                    head_sha: 'old',
                },
            ],
            gates: id => id === 7 ? 'success' : 'failure',
        });
        expect(result).toMatchObject({
            sha: 'new',
            lastTag: 'v1.2.3',
        });
        expect(commands).toContainEqual([
            'merge-base',
            '--is-ancestor',
            'new',
            'main',
        ]);
        expect(commands).toContainEqual([
            'merge-base',
            '--is-ancestor',
            'tag-sha',
            'new',
        ]);
    });

    it('fetches the release tag set and plans without changing package.json', () => {
        const commands: string[][] = [];
        const result = planRelease('patch', {
            runCommand: (_command, args) => {
                commands.push(args);
                if (args[0] === 'tag') return 'v1.2.3';
                if (args[0] === 'rev-parse') return args[1] === 'origin/main' ? 'main' : 'tag-sha';
                if (args[0] === 'merge-base') return '';
                return '';
            },
            listRuns: () => [{
                id: 10,
                head_sha: 'candidate',
                html_url: 'https://ci/candidate',
            }],
            gates: () => 'success',
        });
        expect(commands[0]).toEqual([
            'fetch',
            '--tags',
            'origin',
            'main',
        ]);
        expect(result.tag).toBe('v1.2.4');
    });

    it('requires an existing stable tag as the version baseline', () => {
        expect(() => planRelease('patch', {
            runCommand: (_command, args) => {
                if (args[0] === 'rev-parse') return 'main';
                return '';
            },
            listRuns: () => [{
                id: 11,
                head_sha: 'candidate',
            }],
            gates: () => 'success',
        })).toThrow('No stable release tag exists');
    });
});
