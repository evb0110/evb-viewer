import {describe, expect, it} from 'vitest';
import {
    formatProcessSnapshot,
    parseUnixProcessSnapshot,
    selectInterestingProcessRows,
    summarizeProcessSnapshot,
} from '@scripts/electron-run/electronRunStartupDiagnostics';
import {isE2ESessionName, selectStaleE2ESessionDirs} from '@scripts/electron-run/electronRunE2ESessionPrune';

describe('Electron startup diagnostics', () => {
    it('parses and summarizes project, Electron, Nuxt, and pnpm processes', () => {
        const root = '/repo/evb-viewer';
        const rows = parseUnixProcessSnapshot(
            [
                '  101     1 S      00:03 /Applications/Electron.app/Contents/MacOS/Electron --remote-debugging-port=4567',
                '  102   101 S+     00:02 node /repo/evb-viewer/node_modules/.bin/nuxi dev',
                '  103     1 S      00:01 pnpm electron:run --session=e2e-viewer',
                '  104     1 S      00:01 /usr/bin/true',
            ].join('\n'),
        );

        expect(rows).toHaveLength(4);
        expect(summarizeProcessSnapshot(rows, root)).toEqual({
            projectRoot: 1,
            electron: 1,
            nuxt: 1,
            pnpm: 1,
            interesting: 3,
        });
        expect(selectInterestingProcessRows(rows, root).map((row) => row.pid)).toEqual([101, 102, 103]);
    });

    it('formats process counts before capped process rows', () => {
        const root = '/repo/evb-viewer';
        const rows = parseUnixProcessSnapshot('  201 1 S 00:10 node /repo/evb-viewer/node_modules/.bin/vite --host 127.0.0.1');

        expect(formatProcessSnapshot(rows, root)).toContain('Counts: projectRoot=1, electron=0, nuxt=1, pnpm=0, interesting=1');
        expect(formatProcessSnapshot([], root)).toContain('No project-rooted / Electron / Nuxt / pnpm processes found.');
    });
});

describe('stale Electron e2e session selection', () => {
    it('selects only stale e2e-prefixed session directories', () => {
        expect(isE2ESessionName('e2e-viewer-smoke')).toBe(true);
        expect(isE2ESessionName('default')).toBe(false);

        const stale = selectStaleE2ESessionDirs(
            [
                {
                    name: 'default',
                    path: '/sessions/default',
                    mtimeMs: 10,
                },
                {
                    name: 'e2e-fresh',
                    path: '/sessions/e2e-fresh',
                    mtimeMs: 95,
                },
                {
                    name: 'e2e-older',
                    path: '/sessions/e2e-older',
                    mtimeMs: 20,
                },
                {
                    name: 'e2e-oldest',
                    path: '/sessions/e2e-oldest',
                    mtimeMs: 5,
                },
            ],
            {
                nowMs: 100,
                maxAgeMs: 50,
            },
        );

        expect(stale.map((candidate) => candidate.name)).toEqual(['e2e-oldest', 'e2e-older']);
    });

    it('keeps sessions at the age boundary', () => {
        const stale = selectStaleE2ESessionDirs(
            [
                {
                    name: 'e2e-boundary',
                    path: '/sessions/e2e-boundary',
                    mtimeMs: 76,
                },
            ],
            {
                nowMs: 100,
                maxAgeMs: 24,
            },
        );

        expect(stale).toEqual([]);
    });
});
