import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ref} from 'vue';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireEpochMs} from '@contracts/timestamps';

const stateStore = new Map<string, ReturnType<typeof ref>>();

function installUseStateStub() {
    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
        const existing = stateStore.get(key);
        if (existing) {
            return existing;
        }
        const state = ref(init());
        stateStore.set(key, state);
        return state;
    });
}

async function createFatalRuntimeError() {
    const {useFatalRuntimeError} = await import('@app/composables/useFatalRuntimeError');
    return useFatalRuntimeError();
}

function createFailure(): FailureReceipt {
    return {
        eventId: 'fedcba9876543210fedcba9876543210' as FailureReceipt['eventId'],
        code: 'MAIN_STARTUP_CRASH',
        occurredAt: requireEpochMs(1767225600000),
        severity: 'fatal',
    };
}

describe('useFatalRuntimeError', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.resetModules();
        stateStore.clear();
        installUseStateStub();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        stateStore.clear();
    });

    it('stores the receipt and local presentation without capturing', async () => {
        const fatal = await createFatalRuntimeError();
        const failure = createFailure();
        const presentation = {
            failure,
            title: 'Startup failure',
            description: 'The application could not start.',
        };

        fatal.setFatalRuntimeError('startup', presentation);

        expect(fatal.fatalRuntimeError.value).toMatchObject({
            kind: 'startup',
            detail: presentation.description,
            description: presentation.description,
            failure,
            source: failure.code,
            title: presentation.title,
        });
    });

    it('does not create a new occurrence when the same receipt is presented again', async () => {
        const fatal = await createFatalRuntimeError();
        const presentation = {
            failure: createFailure(),
            title: 'Startup failure',
            description: 'The application could not start.',
        };

        fatal.setFatalRuntimeError(presentation);
        const firstState = fatal.fatalRuntimeError.value;
        fatal.setFatalRuntimeError(presentation);

        expect(fatal.fatalRuntimeError.value).toBe(firstState);
    });

    it('rejects the removed receipt-free signature at runtime', async () => {
        const fatal = await createFatalRuntimeError();

        expect(() => Reflect.apply(fatal.setFatalRuntimeError, null, ['runtime', new Error('legacy failure'), 'legacy-source'])).toThrow(
            TypeError,
        );
        expect(fatal.fatalRuntimeError.value).toBeNull();
    });
});
