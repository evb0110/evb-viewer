import {
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {createServer} from 'node:http';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    clearSessionStarting,
    getSessionStartingInfo,
    markSessionStarting,
    recordSessionStartingAttempt,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    electronUserDataPath,
    sessionDir,
    sessionStartingFilePath,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';

const testSessionName = `unit-artifacts-${process.pid}`;

function resetTestSession() {
    setCurrentSessionName(testSessionName);
    rmSync(sessionDir(), {
        recursive: true,
        force: true,
    });
}

describe('electron run session artifacts', () => {
    afterEach(() => {
        resetTestSession();
        setCurrentSessionName('default');
    });

    it('records pre-ready Electron launch attempt metadata in the starting artifact', () => {
        resetTestSession();

        markSessionStarting(12345);
        recordSessionStartingAttempt({
            cdpPorts: [
                9222,
                9222,
            ],
            electronPids: [
                23456,
                23456,
            ],
            electronUserDataDir: electronUserDataPath(),
            nuxtPid: 34567,
            nuxtPort: 3235,
        });

        expect(getSessionStartingInfo()).toMatchObject({
            pid: 12345,
            cdpPorts: [9222],
            electronPids: [23456],
            electronUserDataDir: electronUserDataPath(),
            nuxtPid: 34567,
            nuxtPort: 3235,
        });
    });

    it('normalizes legacy starting artifacts that only contain the manager pid', () => {
        resetTestSession();
        mkdirSync(sessionDir(), {recursive: true});
        writeFileSync(sessionStartingFilePath(), JSON.stringify({
            pid: 12345,
            startedAt: Date.now(),
        }));

        expect(getSessionStartingInfo()).toMatchObject({
            pid: 12345,
            cdpPorts: [],
            electronPids: [],
            electronUserDataDir: null,
            nuxtPid: null,
            nuxtPort: null,
        });

        clearSessionStarting();
    });

    it.each([
        'headers',
        'body',
    ])('bounds readiness when the controller stalls during %s', async (stallStage) => {
        vi.resetModules();
        vi.doMock('@scripts/electron-run/electronRunProcessIdentity', () => ({
            findSessionOwnedElectronPids: () => [],
            inspectProcessIdentity: () => ({
                pid: 1,
                platform: process.platform,
                command: 'fixture-controller',
                cwd: null,
                environment: '',
                descendantPids: [],
                pidsOnExpectedPort: [],
            }),
            killVerifiedSessionProcess: () => false,
            matchesSessionProcessIdentity: () => true,
        }));
        const {isSessionRunning: isFreshSessionRunning} = await import('@scripts/electron-run/electronRunSessionArtifacts');
        const {
            sessionDir: freshSessionDir,
            sessionFilePath: freshSessionFilePath,
            setCurrentSessionName: setFreshSessionName,
        } = await import('@scripts/electron-run/electronRunSessionPaths');
        setFreshSessionName(testSessionName);
        rmSync(freshSessionDir(), {
            recursive: true,
            force: true,
        });
        resetTestSession();
        const server = createServer((_request, response) => {
            if (stallStage === 'body') {
                response.writeHead(200, {'content-type': 'application/json'});
                response.write('{"success":');
                return;
            }
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            throw new Error('readiness fixture did not expose a TCP port');
        }
        mkdirSync(freshSessionDir(), {recursive: true});
        writeFileSync(freshSessionFilePath(), JSON.stringify({
            port: address.port,
            pid: 1,
            cdpPort: 39202,
            electronPid: null,
            nuxtPid: null,
            nuxtPort: 3235,
        }));
        const startedAt = Date.now();
        try {
            await expect(isFreshSessionRunning(testSessionName, AbortSignal.timeout(50))).resolves.toBe(false);
            expect(Date.now() - startedAt).toBeLessThan(1000);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
});
