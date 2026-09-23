import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    matchesSessionProcessIdentity,
    type IProcessIdentitySnapshot,
} from '@scripts/electron-run/electronRunProcessIdentity';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    electronUserDataPath,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';

function snapshot(overrides: Partial<IProcessIdentitySnapshot> = {}): IProcessIdentitySnapshot {
    return {
        pid: 72_000,
        platform: process.platform,
        command: '',
        cwd: projectRoot,
        environment: '',
        descendantPids: [],
        pidsOnExpectedPort: [],
        ...overrides,
    };
}

describe('electron run process identity', () => {
    const sessionName = 'e2e-process-identity';
    const cdpPort = 49_321;
    const nuxtPort = 49_322;

    it('accepts only Electron launched from the session automation entry with both isolation tokens', () => {
        const appEntry = join(sessionDir(sessionName), 'automation-electron-app-entry', 'automation-app');
        const userDataDir = electronUserDataPath(sessionName);
        const expectation = {
            kind: 'electron' as const,
            sessionName,
            cdpPort,
        };

        expect(matchesSessionProcessIdentity(snapshot({command: `/repo/node_modules/electron/dist/Electron --remote-debugging-port=${cdpPort} `
                + `--user-data-dir=${userDataDir} ${appEntry}`}), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({command: '/Applications/EVB Viewer.app/Contents/MacOS/EVB Viewer '
                + `--remote-debugging-port=${cdpPort} --user-data-dir=${userDataDir}`}), expectation)).toBe(false);
    });

    it('rejects a reused Electron PID when any recorded identity token differs', () => {
        const appEntry = join(sessionDir(sessionName), 'automation-electron-app-entry', 'automation-app');
        const userDataDir = electronUserDataPath(sessionName);
        const expectation = {
            kind: 'electron' as const,
            sessionName,
            cdpPort,
        };

        expect(matchesSessionProcessIdentity(snapshot({command: `/repo/node_modules/electron/dist/Electron --remote-debugging-port=${cdpPort + 1} `
                + `--user-data-dir=${userDataDir} ${appEntry}`}), expectation)).toBe(false);
        expect(matchesSessionProcessIdentity(snapshot({command: `/repo/node_modules/electron/dist/Electron --remote-debugging-port=${cdpPort} `
                + `--user-data-dir=${userDataDir}-reused ${appEntry}`}), expectation)).toBe(false);
    });

    it('requires the exact project, session, and start command for a controller PID', () => {
        const expectation = {
            kind: 'controller' as const,
            sessionName,
        };
        expect(matchesSessionProcessIdentity(snapshot({command: `pnpm --dir ${projectRoot} electron:run --session=${sessionName} start`}), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({command: `node /repo/node_modules/tsx/dist/cli.mjs ${join(projectRoot, 'scripts', 'electronRun.ts')} --session=${sessionName} start`}), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({command: `node /repo/node_modules/tsx/dist/cli.mjs scripts/electronRun.ts --session=${sessionName} start`}), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({command: `pnpm --dir ${projectRoot} electron:run --session ${sessionName} start`}), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({command: `node /repo/node_modules/tsx/dist/cli.mjs scripts/electronRun.ts -s ${sessionName} start`}), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({command: `pnpm --dir ${projectRoot} electron:run --session=${sessionName}-reused start`}), expectation)).toBe(false);
        expect(matchesSessionProcessIdentity(snapshot({command: `pnpm --dir ${projectRoot} electron:run --session ${sessionName}-reused start`}), expectation)).toBe(false);
        expect(matchesSessionProcessIdentity(snapshot({command: '/usr/bin/sleep 3600'}), expectation)).toBe(false);

        const defaultExpectation = {
            kind: 'controller' as const,
            sessionName: 'default',
        };
        expect(matchesSessionProcessIdentity(snapshot({command: `pnpm --dir ${projectRoot} electron:run start`}), defaultExpectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({command: `pnpm -s --dir ${projectRoot} electron:run start`}), defaultExpectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({command: `pnpm --dir ${projectRoot} electron:run --session ${sessionName} start`}), defaultExpectation)).toBe(false);
    });

    it('accepts the detached E2E controller only with its exact entry, session, and project identity', () => {
        const expectation = {
            kind: 'controller' as const,
            sessionName,
        };
        const ephemeralEntry = join('scripts', 'electron-run', 'ephemeralSessionEntry.ts');
        const absoluteEphemeralEntry = join(projectRoot, ephemeralEntry);

        expect(matchesSessionProcessIdentity(
            snapshot({command: `node --import tsx ${ephemeralEntry} ${sessionName}`}),
            expectation,
        )).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({
            command: `node --import tsx "${absoluteEphemeralEntry}" ${sessionName}`,
            cwd: null,
        }), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(
            snapshot({command: `node --import tsx ${ephemeralEntry} ${sessionName}-reused`}),
            expectation,
        )).toBe(false);
        expect(matchesSessionProcessIdentity(
            snapshot({command: `node --import tsx scripts/electron-run/otherEntry.ts ${sessionName}`}),
            expectation,
        )).toBe(false);
        expect(matchesSessionProcessIdentity(snapshot({
            command: `node --import tsx ${ephemeralEntry} ${sessionName}`,
            cwd: '/repo/another-project',
        }), expectation)).toBe(false);
    });

    it('accepts a Windows controller only when its absolute entry, session, and command match', () => {
        const expectation = {
            kind: 'controller' as const,
            sessionName,
        };
        const windowsSnapshot = {
            platform: 'win32' as const,
            cwd: null,
            environment: '',
        };
        const controllerEntry = join(projectRoot, 'scripts', 'electronRun.ts');

        expect(matchesSessionProcessIdentity(snapshot({
            ...windowsSnapshot,
            command: `node C:\\repo\\node_modules\\tsx\\cli.mjs "${controllerEntry}" --session=${sessionName} start`,
        }), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({
            ...windowsSnapshot,
            command: `node C:\\repo\\node_modules\\tsx\\cli.mjs electronRun.ts --session=${sessionName} start`,
        }), expectation)).toBe(false);
    });

    it('requires the project Nuxt root, exact port, and ownership of the listener', () => {
        const expectation = {
            kind: 'nuxt' as const,
            sessionName,
            nuxtPort,
        };
        expect(matchesSessionProcessIdentity(snapshot({
            command: 'pnpm run dev:nuxt',
            environment: `PATH=/bin PORT=${nuxtPort}`,
            descendantPids: [73_001],
            pidsOnExpectedPort: [73_001],
        }), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({
            command: 'pnpm run dev:nuxt',
            environment: `PATH=/bin PORT=${nuxtPort + 1}`,
            descendantPids: [73_001],
            pidsOnExpectedPort: [73_001],
        }), expectation)).toBe(false);
        expect(matchesSessionProcessIdentity(snapshot({
            command: 'pnpm run dev:nuxt',
            environment: `PATH=/bin PORT=${nuxtPort}`,
            descendantPids: [73_001],
            pidsOnExpectedPort: [84_002],
        }), expectation)).toBe(false);
    });

    it('uses Windows process ancestry and the recorded listener port when cwd and env are unavailable', () => {
        const expectation = {
            kind: 'nuxt' as const,
            sessionName,
            nuxtPort,
        };
        const windowsSnapshot = {
            platform: 'win32' as const,
            command: 'pnpm.cmd run dev:nuxt',
            cwd: null,
            environment: '',
            descendantPids: [73_001],
        };

        expect(matchesSessionProcessIdentity(snapshot({
            ...windowsSnapshot,
            pidsOnExpectedPort: [73_001],
        }), expectation)).toBe(true);
        expect(matchesSessionProcessIdentity(snapshot({
            ...windowsSnapshot,
            pidsOnExpectedPort: [84_002],
        }), expectation)).toBe(false);
    });
});
