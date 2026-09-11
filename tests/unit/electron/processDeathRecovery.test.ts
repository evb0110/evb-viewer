import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    configureProcessSafeMode,
    createProcessDeathRecovery,
    DOCUMENT_FINGERPRINT_SERVICE_NAME,
    DOCUMENT_SAVE_SERVICE_NAME,
    PDF_PRINT_LAYOUT_SERVICE_NAME,
    PROCESS_SAFE_MODE_ARGUMENT,
} from '@electron/processDeathRecovery';
import {
    createShutdownCoordinator,
    type IShutdownContext,
} from '@electron/bootstrap/shutdown';
import type {DiagnosticCode} from '@contracts/diagnostics/diagnosticCodes';
import type {
    CaptureFailureInput,
    FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';

type TFailureCapture = <C extends DiagnosticCode>(input: CaptureFailureInput<C>) => FailureReceipt | undefined;

function createFixture(
    argv = ['/app/evb-viewer'],
    options: {captureFailure?: TFailureCapture} = {},
) {
    const app = {commandLine: {appendSwitch: vi.fn()}};
    const logger = {
        error: vi.fn(),
        warn: vi.fn(),
    };
    const requestSafeModeRelaunch = vi.fn();
    return {
        app,
        argv,
        logger,
        recovery: createProcessDeathRecovery({
            argv,
            logger,
            requestSafeModeRelaunch,
            ...options,
        }),
        requestSafeModeRelaunch,
    };
}

function createReportingFixture(argv = ['/app/evb-viewer']) {
    const captureFailure = vi.fn().mockReturnValue({
        eventId: 'a'.repeat(32),
        code: 'MAIN_CHILD_PROCESS_GONE',
        occurredAt: 1,
        severity: 'error',
    });
    return {
        ...createFixture(argv, {captureFailure}),
        captureFailure,
    };
}

describe('processDeathRecovery', () => {
    it('owns one closed child-process occurrence with bounded context', () => {
        const fixture = createReportingFixture();

        fixture.recovery.handleChildProcessGone({
            type: 'Utility',
            reason: 'crashed',
            exitCode: 133,
            name: 'Audio Service',
        });

        expect(fixture.captureFailure).toHaveBeenCalledOnce();
        expect(fixture.captureFailure).toHaveBeenCalledWith(expect.objectContaining({
            code: 'MAIN_CHILD_PROCESS_GONE',
            operation: 'main-error',
            context: {
                processType: 'utility',
                reason: 'crashed',
                exitCode: 133,
            },
            local: expect.objectContaining({source: 'process-death'}),
        }));
        expect(fixture.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('[process-death] Utility process gone (Audio Service, reason=crashed, exitCode=133)'),
            expect.objectContaining({
                eventId: 'a'.repeat(32),
                code: 'MAIN_CHILD_PROCESS_GONE',
                occurredAt: 1,
                severity: 'error',
            }),
        );
    });

    it('uses one receipt per GPU death and a specific safe-mode recovery code', () => {
        const fixture = createReportingFixture();
        const details = {
            type: 'GPU',
            reason: 'crashed',
            exitCode: 9,
        };

        fixture.recovery.handleChildProcessGone(details);
        fixture.recovery.handleChildProcessGone(details);

        expect(fixture.captureFailure).toHaveBeenCalledTimes(2);
        expect(fixture.captureFailure.mock.calls.map(([input]) => input.code)).toEqual([
            'MAIN_CHILD_PROCESS_GONE',
            'MAIN_GPU_SAFE_MODE_RECOVERY',
        ]);
        expect(fixture.captureFailure.mock.calls[1]?.[0]).toEqual(expect.objectContaining({context: {
            safeMode: false,
            action: 'relaunch',
            crashCount: 2,
        }}));
        expect(fixture.logger.error.mock.calls.map(([
            , receipt,
        ]) => receipt?.eventId)).toEqual([
            'a'.repeat(32),
            'a'.repeat(32),
        ]);
    });

    it('keeps expected utility teardown at warning level with no occurrence', () => {
        const fixture = createReportingFixture();

        fixture.recovery.handleChildProcessGone({
            type: 'Utility',
            reason: 'killed',
            exitCode: 15,
            name: DOCUMENT_SAVE_SERVICE_NAME,
        });

        expect(fixture.captureFailure).not.toHaveBeenCalled();
        expect(fixture.logger.error).not.toHaveBeenCalled();
        expect(fixture.logger.warn).toHaveBeenCalledOnce();
    });

    it('leaves renderer child death to the webContents owner', () => {
        const fixture = createReportingFixture();

        fixture.recovery.handleChildProcessGone({
            type: 'Renderer',
            reason: 'crashed',
            exitCode: 1,
        });

        expect(fixture.captureFailure).not.toHaveBeenCalled();
        expect(fixture.logger.error).not.toHaveBeenCalled();
        expect(fixture.logger.warn).toHaveBeenCalledOnce();
    });

    it('enables software rendering before startup when relaunched in safe mode', () => {
        const fixture = createFixture([
            '/app/evb-viewer',
            PROCESS_SAFE_MODE_ARGUMENT,
        ]);

        expect(configureProcessSafeMode(fixture.app, fixture.argv)).toBe(true);
        expect(fixture.app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu');
    });

    it('relaunches in safe mode after two GPU crashes in the rolling window', () => {
        const fixture = createFixture([
            '/app/evb-viewer',
            '--document',
            '/tmp/a.pdf',
        ]);
        const details = {
            type: 'GPU',
            reason: 'crashed',
            exitCode: 9,
        };

        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('logged');
        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('safe-mode-relaunch');

        expect(fixture.requestSafeModeRelaunch).toHaveBeenCalledWith([
            '--document',
            '/tmp/a.pdf',
            PROCESS_SAFE_MODE_ARGUMENT,
        ]);
    });

    it('does not enter a relaunch loop when the GPU fails in safe mode', () => {
        const fixture = createReportingFixture([
            '/app/evb-viewer',
            PROCESS_SAFE_MODE_ARGUMENT,
        ]);
        const details = {
            type: 'GPU',
            reason: 'crashed',
            exitCode: 9,
        };

        fixture.recovery.handleChildProcessGone(details);
        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('safe-mode-failed');
        expect(fixture.requestSafeModeRelaunch).not.toHaveBeenCalled();
        expect(fixture.captureFailure.mock.calls.map(([input]) => input.code)).toEqual([
            'MAIN_CHILD_PROCESS_GONE',
            'MAIN_GPU_SAFE_MODE_RECOVERY',
        ]);
        expect(fixture.captureFailure.mock.calls[1]?.[0]).toEqual(expect.objectContaining({context: {
            safeMode: true,
            action: 'failed',
            crashCount: 2,
        }}));
    });

    // The app kills its own utility processes as their ordinary teardown, and
    // error level is what the renderer turns into a user-visible diagnostic
    // report. Reporting those killed a successful document fingerprint's exit
    // as a fault, and the resulting report card covered the toolbar it is
    // anchored over.
    it('keeps a utility process the app terminated out of the error channel', () => {
        const fixture = createFixture();

        expect(fixture.recovery.handleChildProcessGone({
            type: 'Utility',
            reason: 'killed',
            exitCode: 15,
            name: DOCUMENT_FINGERPRINT_SERVICE_NAME,
        }).action).toBe('logged');

        expect(fixture.logger.error).not.toHaveBeenCalled();
        expect(fixture.logger.warn).toHaveBeenCalledWith(
            '[process-death] Utility process gone (EVB document fingerprint, reason=killed, exitCode=15)',
        );
    });

    // `utilityProcess.fork` documents its `serviceName` option as arriving in
    // the `name` field, and Chromium fills `serviceName` with the mojo service
    // identity, so the rule reads both rather than betting on one Electron
    // build's field.
    it('recognises the app\'s own utility teardown reported under serviceName', () => {
        const fixture = createFixture();

        expect(fixture.recovery.handleChildProcessGone({
            type: 'Utility',
            reason: 'killed',
            exitCode: 15,
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
        }).action).toBe('logged');

        expect(fixture.logger.error).not.toHaveBeenCalled();
        expect(fixture.logger.warn).toHaveBeenCalledWith(
            '[process-death] Utility process gone (EVB document save, reason=killed, exitCode=15)',
        );
    });

    it('keeps normal PDF print layout utility teardown out of the error channel', () => {
        const fixture = createFixture();

        expect(fixture.recovery.handleChildProcessGone({
            type: 'Utility',
            reason: 'killed',
            exitCode: 15,
            serviceName: PDF_PRINT_LAYOUT_SERVICE_NAME,
        }).action).toBe('logged');

        expect(fixture.logger.error).not.toHaveBeenCalled();
        expect(fixture.logger.warn).toHaveBeenCalledWith(
            '[process-death] Utility process gone (EVB PDF print layout, reason=killed, exitCode=15)',
        );
    });

    it('still reports a utility process that failed on its own', () => {
        const fixture = createFixture();

        expect(fixture.recovery.handleChildProcessGone({
            type: 'Utility',
            reason: 'crashed',
            exitCode: 133,
            name: DOCUMENT_FINGERPRINT_SERVICE_NAME,
        }).action).toBe('logged');

        expect(fixture.logger.error).toHaveBeenCalledWith(
            '[process-death] Utility process gone (EVB document fingerprint, reason=crashed, exitCode=133)',
            {
                code: 'MAIN_PROCESS_RECOVERY_FAILED',
                context: {},
            },
        );
        expect(fixture.logger.warn).not.toHaveBeenCalled();
    });

    // Only named utility processes that the app forks are expected to be
    // terminated during ordinary teardown. A signal that ended any other
    // utility process came from outside the app, which is a fault the user
    // should see.
    it('still reports a killed utility process the app did not fork', () => {
        const fixture = createFixture();

        expect(fixture.recovery.handleChildProcessGone({
            type: 'Utility',
            reason: 'killed',
            exitCode: 9,
            name: 'Audio Service',
        }).action).toBe('logged');

        expect(fixture.logger.error).toHaveBeenCalledWith(
            '[process-death] Utility process gone (Audio Service, reason=killed, exitCode=9)',
            {
                code: 'MAIN_PROCESS_RECOVERY_FAILED',
                context: {},
            },
        );
        expect(fixture.logger.warn).not.toHaveBeenCalled();
    });

    it('still reports a killed utility process that carries no identity', () => {
        const fixture = createFixture();

        expect(fixture.recovery.handleChildProcessGone({
            type: 'Utility',
            reason: 'killed',
            exitCode: 9,
        }).action).toBe('logged');

        expect(fixture.logger.error).toHaveBeenCalledWith(
            '[process-death] Utility process gone (Utility, reason=killed, exitCode=9)',
            {
                code: 'MAIN_PROCESS_RECOVERY_FAILED',
                context: {},
            },
        );
        expect(fixture.logger.warn).not.toHaveBeenCalled();
    });

    // The app forks no process of these types at all, so nothing it does can
    // explain a signal that ended one.
    it.each([
        'Zygote',
        'Sandbox helper',
        'Pepper Plugin',
        'Pepper Plugin Broker',
        'Unknown',
    ])('still reports a killed %s process', (type) => {
        const fixture = createFixture();

        expect(fixture.recovery.handleChildProcessGone({
            type,
            reason: 'killed',
            exitCode: 9,
        }).action).toBe('logged');

        expect(fixture.logger.error).toHaveBeenCalledWith(
            `[process-death] ${type} process gone (${type}, reason=killed, exitCode=9)`,
            {
                code: 'MAIN_PROCESS_RECOVERY_FAILED',
                context: {},
            },
        );
        expect(fixture.logger.warn).not.toHaveBeenCalled();
    });

    // Nothing in the app kills the GPU, so a killed GPU process is a fault like
    // any other and still has to reach the relaunch decision below.
    it('reports a killed GPU process and still counts it toward safe mode', () => {
        const fixture = createFixture();
        const details = {
            type: 'GPU',
            reason: 'killed',
            exitCode: 9,
        };

        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('logged');
        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('safe-mode-relaunch');
        expect(fixture.logger.error).toHaveBeenCalledTimes(2);
        expect(fixture.logger.error).toHaveBeenNthCalledWith(
            1,
            '[process-death] GPU process gone (GPU, reason=killed, exitCode=9)',
            {
                code: 'MAIN_PROCESS_RECOVERY_FAILED',
                context: {},
            },
        );
        expect(fixture.logger.error).toHaveBeenNthCalledWith(
            2,
            '[process-death] GPU process gone (GPU, reason=killed, exitCode=9)',
            {
                code: 'MAIN_PROCESS_RECOVERY_FAILED',
                context: {},
            },
        );
    });

    it('requests at most one coordinated relaunch after repeated GPU crashes', () => {
        const fixture = createReportingFixture();
        const details = {
            type: 'GPU',
            reason: 'crashed',
            exitCode: 9,
        };

        fixture.recovery.handleChildProcessGone(details);
        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('safe-mode-relaunch');
        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('safe-mode-relaunch-pending');
        expect(fixture.requestSafeModeRelaunch).toHaveBeenCalledOnce();
        expect(fixture.captureFailure).toHaveBeenCalledTimes(2);
        expect(fixture.logger.warn).toHaveBeenCalledWith(expect.stringContaining('GPU process gone'));
    });

    it('orders the safe-mode relaunch after coordinated cleanup', async () => {
        const cleanup = createDeferred();
        const app = {
            commandLine: {appendSwitch: vi.fn()},
            exit: vi.fn(),
            quit: vi.fn(),
            relaunch: vi.fn(),
        };
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };
        let observedContext: IShutdownContext | null = null;
        const coordinator = createShutdownCoordinator({
            app,
            logger,
            runBestEffortCleanupSteps: vi.fn(async () => {}),
            runPreservationSteps: context => {
                observedContext = context;
                return cleanup.promise;
            },
        });
        const recovery = createProcessDeathRecovery({
            argv: ['/app/evb-viewer'],
            logger,
            requestSafeModeRelaunch: args => coordinator.requestGracefulQuit({
                afterCleanup: () => {
                    app.relaunch({args});
                    app.quit();
                },
                preserveRecoveryState: true,
                reason: 'recovery-relaunch',
            }),
        });
        const details = {
            type: 'GPU',
            reason: 'crashed',
            exitCode: 9,
        };

        recovery.handleChildProcessGone(details);
        recovery.handleChildProcessGone(details);
        await vi.waitFor(() => {
            expect(observedContext).toMatchObject({
                preserveRecoveryState: true,
                reason: 'recovery-relaunch',
            });
        });
        expect(app.relaunch).not.toHaveBeenCalled();
        expect(app.quit).not.toHaveBeenCalled();
        expect(app.exit).not.toHaveBeenCalled();

        cleanup.resolve();
        await vi.waitFor(() => {
            expect(app.relaunch).toHaveBeenCalledWith({args: [PROCESS_SAFE_MODE_ARGUMENT]});
            expect(app.quit).toHaveBeenCalledOnce();
        });
        expect(app.exit).not.toHaveBeenCalled();
    });
});

function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return {
        promise,
        resolve,
    };
}
