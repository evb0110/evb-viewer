import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import * as detachedSession from '@scripts/electron-run/startSessionDetached';
import * as sessionArtifacts from '@scripts/electron-run/electronRunSessionArtifacts';
import * as sessionCommands from '@scripts/electron-run/sendCommand';
import * as sessionStop from '@scripts/electron-run/stopSession';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {
    createDetachedSessionReadinessFailure,
    waitForDetachedChildSpawn,
} from '@scripts/electron-run/startSessionDetached';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';
import {
    createElectronE2EHealthReadinessFailure,
    ElectronE2EInfrastructureError,
    formatElectronE2ESessionFailure,
    runElectronE2EInfrastructureStage,
    runElectronE2EProcessLaunchStage,
} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';

describe('Electron E2E session failure classification', () => {
    it('stops an acquired session when application health fails before the outer deadline', async () => {
        vi.useFakeTimers();
        let sessionRunning = false;
        vi.spyOn(detachedSession, 'startSessionDetached').mockImplementation(async () => { sessionRunning = true; });
        vi.spyOn(sessionArtifacts, 'waitForSessionReady').mockResolvedValue(true);
        vi.spyOn(sessionCommands, 'sendCommand').mockResolvedValue({ready: false});
        vi.spyOn(sessionStop, 'stopSingleSession').mockImplementation(async () => { sessionRunning = false; });
        try {
            const failure = startElectronE2ESession(`e2e-unit-health-failure-${process.pid}`, {clean: false})
                .catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(0);
            expect(sessionRunning).toBe(true);
            await vi.advanceTimersByTimeAsync(detachedSession.E2E_SESSION_START_TIMEOUT_MS);
            expect(await failure).toMatchObject({message: expect.stringContaining('did not become ready')});
            expect(sessionRunning).toBe(false);
        } finally {
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it.each([
        'process-launch',
        'transport',
        'cdp-connection',
        'session-runner',
    ] as const)('marks a typed %s failure as retryable infrastructure', async (kind) => {
        const cause = new Error('connection refused');

        const failure = await runElectronE2EInfrastructureStage(
            kind,
            'Connecting to the Electron session',
            async () => Promise.reject(cause),
        ).catch((error: unknown) => error);
        const formatted = formatElectronE2ESessionFailure('Electron E2E session boot failed.', failure);

        expect(failure).toBeInstanceOf(ElectronE2EInfrastructureError);
        expect(failure).toMatchObject({
            cause,
            kind,
        });
        expect(formatted.message).toMatch(/^\[INFRA\] Electron E2E session boot failed\./u);
        expect(formatted.message).toContain('connection refused');
    });

    it.each([
        'Electron preload bridge is unavailable',
        'Electron renderer did not become ready',
        'Internal Server Error',
        'Application startup contract failed',
    ])('keeps an untyped application failure non-retryable: %s', (message) => {
        const source = new Error(message);
        const formatted = formatElectronE2ESessionFailure('Electron E2E session boot failed.', source);

        expect(formatted).not.toBeInstanceOf(ElectronE2EInfrastructureError);
        expect(formatted.message).not.toContain('[INFRA]');
        expect(formatted.message).toContain(message);
        expect(formatted.stack).toContain(source.message);
    });

    it('preserves infrastructure classification through nested fixture context', async () => {
        const failure = new ElectronE2EInfrastructureError(
            'session-runner',
            'The session runner exited before publishing metadata',
        );

        const bootFailure = formatElectronE2ESessionFailure('Electron E2E session boot failed.', failure);
        const restartFailure = formatElectronE2ESessionFailure('Electron E2E session restart failed.', bootFailure);

        expect(restartFailure).toBeInstanceOf(ElectronE2EInfrastructureError);
        expect(restartFailure).toMatchObject({kind: 'session-runner'});
        expect(restartFailure.message).toMatch(/^\[INFRA\] Electron E2E session restart failed\./u);
        expect(restartFailure.message.match(/\[INFRA\]/gu)).toHaveLength(1);
    });

    it('retains sanitized AggregateError diagnostics in typed infrastructure failures', () => {
        const aggregate = new AggregateError([
            new Error('session runner cleanup failed'),
            new Error('[INFRA] nested diagnostic marker'),
        ], 'session runner reported multiple failures');

        const failure = new ElectronE2EInfrastructureError(
            'session-runner',
            'Electron E2E session runner failed',
            aggregate,
        );

        expect(failure.message).toContain('session runner reported multiple failures');
        expect(failure.message).toContain('Contained error 1: session runner cleanup failed');
        expect(failure.message).toContain('Contained error 2: [application-infra-marker] nested diagnostic marker');
        expect(failure.message.match(/\[INFRA\]/gu)).toHaveLength(1);
    });

    it('does not let an application error forge the infrastructure retry marker', () => {
        const formatted = formatElectronE2ESessionFailure(
            'Electron E2E session boot failed.',
            new Error('[INFRA] application contract failed'),
        );

        expect(formatted).not.toBeInstanceOf(ElectronE2EInfrastructureError);
        expect(formatted.message).not.toContain('[INFRA]');
        expect(formatted.message).toContain('[application-infra-marker] application contract failed');
    });

    it('classifies an unavailable health transport separately from renderer readiness', () => {
        const transportCause = new Error('command socket refused the connection');
        const applicationCause = new Error('preload bridge evaluation failed');
        const noHealthResponse = createElectronE2EHealthReadinessFailure(
            'e2e-session',
            0,
            transportCause,
        );
        const rendererNotReady = createElectronE2EHealthReadinessFailure(
            'e2e-session',
            3,
            transportCause,
            applicationCause,
        );

        expect(noHealthResponse).toBeInstanceOf(ElectronE2EInfrastructureError);
        expect(noHealthResponse).toMatchObject({
            cause: transportCause,
            kind: 'transport',
        });
        expect(rendererNotReady).not.toBeInstanceOf(ElectronE2EInfrastructureError);
        expect(rendererNotReady.message).not.toContain('[INFRA]');
        expect(rendererNotReady.message).toContain('reported application health but did not become ready');
        expect(rendererNotReady.message).toContain('preload bridge evaluation failed');
    });

    it('does not mark a detached-start product readiness failure as infrastructure', async () => {
        const productFailure = new Error(
            'Detached session failed after renderer readiness: preload bindings are unavailable',
        );

        const failure = await runElectronE2EProcessLaunchStage(
            'Starting the detached Electron E2E session',
            async () => Promise.reject(productFailure),
        ).catch((error: unknown) => error);

        expect(failure).toBe(productFailure);
        expect((failure as Error).message).not.toContain('[INFRA]');
    });

    it('marks a Node system failure during detached process launch as infrastructure', async () => {
        const systemFailure = Object.assign(new Error('spawn failed'), {
            code: 'ENOENT',
            errno: -2,
            syscall: 'spawn',
        });

        const failure = await runElectronE2EProcessLaunchStage(
            'Starting the detached Electron E2E session',
            async () => Promise.reject(systemFailure),
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ElectronE2EInfrastructureError);
        expect(failure).toMatchObject({
            cause: systemFailure,
            kind: 'process-launch',
        });
    });

    it('observes a real detached spawn error before classifying it as infrastructure', async () => {
        const missingExecutable = join(
            process.cwd(),
            '.devkit',
            `missing-electron-e2e-executable-${String(process.pid)}`,
        );
        const child = spawn(missingExecutable, [], {stdio: 'ignore'});

        try {
            const failure = await runElectronE2EProcessLaunchStage(
                'Starting the detached Electron E2E session',
                async () => waitForDetachedChildSpawn(child),
            ).catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(ElectronE2EInfrastructureError);
            expect(failure).toMatchObject({kind: 'process-launch'});
            expect((failure as ElectronE2EInfrastructureError).cause).toMatchObject({
                code: 'ENOENT',
                errno: expect.any(Number),
                syscall: expect.stringContaining('spawn'),
            });
        } finally {
            if (child.pid && isProcessAlive(child.pid)) {
                child.kill();
            }
        }
    });

    it('does not let a cleanup system error hide detached product readiness failure', async () => {
        const cleanupFailure = Object.assign(new Error('cleanup denied'), {
            code: 'EPERM',
            errno: -1,
            syscall: 'kill',
        });
        const readinessFailure = createDetachedSessionReadinessFailure(
            'Detached session failed after application readiness checks',
            [cleanupFailure],
        );

        const failure = await runElectronE2EProcessLaunchStage(
            'Starting the detached Electron E2E session',
            async () => Promise.reject(readinessFailure),
        ).catch((error: unknown) => error);

        expect(failure).toBe(readinessFailure);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as Error).message).not.toContain('[INFRA]');
        expect((failure as AggregateError).errors).toEqual([
            expect.objectContaining({message: 'Detached session failed after application readiness checks'}),
            cleanupFailure,
        ]);

        const formatted = formatElectronE2ESessionFailure(
            'Electron E2E session boot failed.',
            failure,
        );
        expect(formatted.message).not.toContain('[INFRA]');
        expect(formatted.message).toContain('Contained error 2: cleanup denied');
        expect(formatted.cause).toBeUndefined();
    });
});
