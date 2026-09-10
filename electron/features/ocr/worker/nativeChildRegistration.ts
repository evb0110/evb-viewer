import {
    createRequestId,
    type TJobId,
} from '@contracts/shared';
import { readOcrNativeChildProcessIdentityAtSpawn } from '@electron/features/ocr/main/ocrNativeChildProcessIdentity';
import type {
    TOcrWorkerOutboundMessage,
    TOcrWorkerInboundMessage,
} from '@electron/ocr/worker/types';

type TOcrNativeChildAck = Extract<
    TOcrWorkerInboundMessage,
    {type: 'native-child-intent-ack' | 'native-child-register-ack' | 'native-child-exit-ack'}
>;
type TOcrNativeChildAckType = TOcrNativeChildAck['type'];

interface IOcrNativeChildPendingAck {
    resolve: () => void;
    reject: (error: Error) => void;
}

interface IOcrNativeChildRegistrationState {
    childId: ReturnType<typeof createRequestId>;
    commandLabel: string;
    status: 'intent' | 'registered' | 'unproven' | 'exited' | 'no-child';
    pid: number | null;
    processIdentity: ReturnType<typeof readOcrNativeChildProcessIdentityAtSpawn>;
    pending: Map<TOcrNativeChildAckType, IOcrNativeChildPendingAck>;
}

export interface IOcrNativeChildRegistrationHandle {
    register(pid: number): Promise<void>;
    markExited(): Promise<void>;
    markNoSpawn(): void;
    markUnproven(detail: string): void;
}

export interface IOcrNativeChildRegistrationProvider {
    prepare(commandLabel: string): Promise<IOcrNativeChildRegistrationHandle>;
    handleMessage(message: TOcrWorkerInboundMessage): boolean;
}

let activeProvider: IOcrNativeChildRegistrationProvider | null = null;

export function setOcrNativeChildRegistrationProvider(provider: IOcrNativeChildRegistrationProvider | null) {
    activeProvider = provider;
}

export function getOcrNativeChildRegistrationProvider() {
    return activeProvider;
}

function postNativeChildMessage(
    postMessage: (message: TOcrWorkerOutboundMessage) => void,
    message: TOcrWorkerOutboundMessage,
) {
    try {
        postMessage(message);
        return null;
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
}

export function createOcrNativeChildRegistrationProvider(
    jobId: TJobId,
    postMessage: (message: TOcrWorkerOutboundMessage) => void,
): IOcrNativeChildRegistrationProvider {
    const states = new Map<string, IOcrNativeChildRegistrationState>();

    function waitForAck(
        state: IOcrNativeChildRegistrationState,
        type: TOcrNativeChildAckType,
        message: TOcrWorkerOutboundMessage,
    ) {
        const promise = new Promise<void>((resolve, reject) => {
            state.pending.set(type, {
                resolve,
                reject,
            });
        });
        const postError = postNativeChildMessage(postMessage, message);
        if (postError) {
            state.pending.delete(type);
            return Promise.reject(postError);
        }
        return promise;
    }

    async function prepare(commandLabel: string): Promise<IOcrNativeChildRegistrationHandle> {
        const state: IOcrNativeChildRegistrationState = {
            childId: createRequestId('ocr-child'),
            commandLabel,
            status: 'intent',
            pid: null,
            processIdentity: null,
            pending: new Map(),
        };
        states.set(state.childId, state);
        try {
            await waitForAck(state, 'native-child-intent-ack', {
                type: 'native-child-intent',
                jobId,
                childId: state.childId,
                commandLabel,
            });
        } catch (error) {
            states.delete(state.childId);
            throw error;
        }

        return {
            register: async (pid: number) => {
                if (state.status === 'registered') {
                    return;
                }
                if (state.status !== 'intent') {
                    throw new Error(`OCR native child ${state.childId} cannot register from ${state.status}`);
                }
                const processIdentity = readOcrNativeChildProcessIdentityAtSpawn(pid);
                if (processIdentity === null) {
                    state.status = 'unproven';
                    thisMarkUnproven(state, `could not read process identity for pid ${pid}`);
                    throw new Error(`Could not register OCR native child pid ${pid}`);
                }
                state.pid = pid;
                state.processIdentity = processIdentity;
                try {
                    await waitForAck(state, 'native-child-register-ack', {
                        type: 'native-child-register',
                        jobId,
                        childId: state.childId,
                        pid,
                        processIdentity,
                    });
                    state.status = 'registered';
                } catch (error) {
                    state.status = 'unproven';
                    thisMarkUnproven(state, error instanceof Error ? error.message : String(error));
                    throw error;
                }
            },
            markExited: async () => {
                if (state.status === 'exited') {
                    return;
                }
                if (state.status !== 'registered' || state.pid === null || state.processIdentity === null) {
                    throw new Error(`OCR native child ${state.childId} cannot prove exit from ${state.status}`);
                }
                try {
                    await waitForAck(state, 'native-child-exit-ack', {
                        type: 'native-child-exit',
                        jobId,
                        childId: state.childId,
                        pid: state.pid,
                        processIdentity: state.processIdentity,
                    });
                    state.status = 'exited';
                } catch (error) {
                    state.status = 'unproven';
                    thisMarkUnproven(state, error instanceof Error ? error.message : String(error));
                    throw error;
                }
            },
            markNoSpawn: () => {
                if (state.status !== 'intent' && state.status !== 'no-child') {
                    return;
                }
                if (state.status === 'no-child') {
                    return;
                }
                state.status = 'no-child';
                const postError = postNativeChildMessage(postMessage, {
                    type: 'native-child-no-spawn',
                    jobId,
                    childId: state.childId,
                });
                if (postError) {
                    thisMarkUnproven(state, `could not report no-spawn: ${postError.message}`);
                }
            },
            markUnproven: (detail: string) => {
                thisMarkUnproven(state, detail);
            },
        };
    }

    function thisMarkUnproven(state: IOcrNativeChildRegistrationState, detail: string) {
        if (state.status === 'exited' || state.status === 'no-child') {
            return;
        }
        state.status = 'unproven';
        postNativeChildMessage(postMessage, {
            type: 'native-child-unproven',
            jobId,
            childId: state.childId,
            detail: detail.trim() || 'native child termination was not proven',
        });
    }

    function handleMessage(message: TOcrWorkerInboundMessage) {
        if (
            message.type !== 'native-child-intent-ack'
            && message.type !== 'native-child-register-ack'
            && message.type !== 'native-child-exit-ack'
        ) {
            return false;
        }
        if (message.jobId !== jobId) {
            return false;
        }
        const state = states.get(message.childId);
        const pending = state?.pending.get(message.type);
        if (!state || !pending) {
            return false;
        }
        state.pending.delete(message.type);
        if (message.accepted) {
            pending.resolve();
        } else {
            pending.reject(new Error(message.reason ?? 'OCR native child protocol rejected the request'));
        }
        return true;
    }

    return {
        prepare,
        handleMessage,
    };
}
