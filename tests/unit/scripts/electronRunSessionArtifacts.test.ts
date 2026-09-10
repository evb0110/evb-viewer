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
} from 'vitest';
import {
    clearSessionStarting,
    getSessionStartingInfo,
    isSessionRunning,
    markSessionStarting,
    recordSessionStartingAttempt,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    electronUserDataPath,
    sessionDir,
    sessionFilePath,
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
        mkdirSync(sessionDir(), {recursive: true});
        writeFileSync(sessionFilePath(), JSON.stringify({
            port: address.port,
            pid: process.pid,
            cdpPort: 39202,
            electronPid: null,
            nuxtPid: null,
            nuxtPort: 3235,
        }));
        const startedAt = Date.now();
        try {
            await expect(isSessionRunning(testSessionName, AbortSignal.timeout(50))).resolves.toBe(false);
            expect(Date.now() - startedAt).toBeLessThan(1000);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
});
