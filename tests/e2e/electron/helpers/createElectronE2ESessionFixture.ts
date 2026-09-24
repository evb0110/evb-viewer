import {
    afterAll,
    beforeAll,
    beforeEach,
} from 'vitest';
import { stopSingleSession } from '@scripts/electron-run/stopSession';
import {
    startElectronE2ESession,
    startHostVisibleElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    formatElectronE2ESessionFailure,
    runElectronE2EInfrastructureStage,
} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';
import { getErrorMessage } from '@contracts/getErrorMessage';

type TSessionNameFactory = string | (() => string);
type TElectronE2ESessionStarter = typeof startElectronE2ESession;

interface IElectronE2ESessionRestartOptions {
    sessionName?: TSessionNameFactory;
    clean?: boolean;
    hard?: boolean;
    extraEnv?: Record<string, string>;
}

// Every accessor fails closed. A test that receives no session never ran the
// app, and a guard that returned quietly from that state reported the test as
// passed. Throwing here makes the missing app a failure with a reason.
interface IElectronE2ESessionFixtureControls {
    getSession: () => IElectronE2ESession;
    start: (options?: Pick<IElectronE2ESessionRestartOptions, 'sessionName' | 'clean' | 'extraEnv'>) => Promise<IElectronE2ESession>;
    restart: (options?: IElectronE2ESessionRestartOptions) => Promise<IElectronE2ESession>;
    resetForE2E: () => Promise<IElectronE2ESession>;
    stop: (options?: { preserveArtifacts?: boolean }) => Promise<void>;
}

interface IElectronE2ESessionFixtureOptions {
    sessionName: TSessionNameFactory;
    clean?: boolean;
    extraEnv?: Record<string, string>;
    restartBeforeEach?: boolean;
    timeoutMs?: number;
}

function resolveSessionName(sessionName: TSessionNameFactory) {
    return typeof sessionName === 'function' ? sessionName() : sessionName;
}

function createElectronE2ESessionFixtureWithStarter(
    options: IElectronE2ESessionFixtureOptions,
    startSession: TElectronE2ESessionStarter,
) {
    let session: IElectronE2ESession | null = null;
    let sessionName = resolveSessionName(options.sessionName);
    let bootFailure: Error | null = null;
    let preserveFailureArtifacts = false;
    let testExecutionCount = 0;

    const controls: IElectronE2ESessionFixtureControls = {
        getSession: () => {
            if (session) {
                return session;
            }
            throw bootFailure ?? new Error(
                `Electron E2E session '${sessionName}' is not initialized; the suite boot hook may not have completed.`,
            );
        },
        start: async (startOptions: Pick<IElectronE2ESessionRestartOptions, 'sessionName' | 'clean' | 'extraEnv'> = {}) => {
            try {
                await controls.stop();
                sessionName = startOptions.sessionName
                    ? resolveSessionName(startOptions.sessionName)
                    : sessionName;
                const extraEnv = startOptions.extraEnv ?? options.extraEnv;
                const started = await startSession(sessionName, {
                    clean: startOptions.clean ?? true,
                    ...(extraEnv ? {extraEnv} : {}),
                });
                session = started;
                bootFailure = null;
                return started;
            } catch (error) {
                bootFailure = formatElectronE2ESessionFailure('Electron E2E session boot failed.', error);
                throw bootFailure;
            }
        },
        restart: async (restartOptions: IElectronE2ESessionRestartOptions = {}) => {
            const previousSession = controls.getSession();

            try {
                const clean = restartOptions.clean ?? true;
                const hard = restartOptions.hard ?? false;
                if (clean && !hard && !restartOptions.extraEnv) {
                    await previousSession.resetForE2E();
                    return previousSession;
                }
                await runElectronE2EInfrastructureStage(
                    'transport',
                    `Disconnecting Electron E2E session '${previousSession.name}' browser transport`,
                    async () => previousSession.browser.disconnect(),
                );
                if (hard && clean) {
                    await previousSession.stop({preserveArtifacts: preserveFailureArtifacts});
                } else {
                    // A non-clean hard restart must retain Electron user data.
                    // Calling the session wrapper's stop method here removes
                    // the whole session directory, including the workspace
                    // checkpoint, and turns the supposed restart into a fresh
                    // profile launch.
                    await runElectronE2EInfrastructureStage(
                        'session-runner',
                        `Stopping Electron E2E session '${previousSession.name}' for restart`,
                        async () => stopSingleSession(previousSession.name, {
                            preserveWorkspaceCheckpoint: hard && !clean,
                            crashElectronBeforeStop: hard && !clean,
                        }),
                    );
                }
                session = null;
                sessionName = restartOptions.sessionName
                    ? resolveSessionName(restartOptions.sessionName)
                    : previousSession.name;
                return await controls.start({
                    sessionName,
                    clean,
                    ...(restartOptions.extraEnv
                        ? {extraEnv: restartOptions.extraEnv}
                        : {}),
                });
            } catch (error) {
                bootFailure = formatElectronE2ESessionFailure('Electron E2E session restart failed.', error);
                throw bootFailure;
            }
        },
        resetForE2E: async () => {
            const currentSession = controls.getSession();
            await currentSession.resetForE2E();
            return currentSession;
        },
        stop: async (stopOptions = {}) => {
            await session?.stop(stopOptions);
            session = null;
        },
    };

    beforeAll(async () => {
        try {
            sessionName = resolveSessionName(options.sessionName);
            session = await startSession(sessionName, {
                clean: options.clean ?? true,
                ...(options.extraEnv ? {extraEnv: options.extraEnv} : {}),
            });
            bootFailure = null;
        } catch (error) {
            bootFailure = formatElectronE2ESessionFailure('Electron E2E session boot failed.', error);
            throw bootFailure;
        }
    }, options.timeoutMs);

    beforeEach((context) => {
        context.onTestFailed(async (failureContext) => {
            preserveFailureArtifacts = true;
            try {
                await session?.captureFailureArtifacts(failureContext.task.fullTestName ?? failureContext.task.name);
            } catch (error) {
                console.warn(`[E2E artifacts] Failed to capture failure state: ${getErrorMessage(error)}`);
            }
        }, 15_000);
    });

    beforeEach(async () => {
        if (options.restartBeforeEach === false) {
            return;
        }
        if (testExecutionCount > 0) {
            await controls.resetForE2E();
        }
        testExecutionCount += 1;
    }, options.timeoutMs);

    afterAll(async () => {
        await controls.stop({ preserveArtifacts: preserveFailureArtifacts });
    });

    return controls;
}

export function createElectronE2ESessionFixture(options: IElectronE2ESessionFixtureOptions) {
    return createElectronE2ESessionFixtureWithStarter(options, startElectronE2ESession);
}

export function createVisibleWindowElectronE2ESessionFixture(
    options: IElectronE2ESessionFixtureOptions,
) {
    return createElectronE2ESessionFixtureWithStarter(options, startHostVisibleElectronE2ESession);
}
