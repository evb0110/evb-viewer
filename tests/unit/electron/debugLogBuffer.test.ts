import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IDebugLogEntry} from '@contracts/electronApiCommon';
import {requireIsoTimestamp} from '@contracts/timestamps';

describe('preload debug log buffer', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('preserves failure references while retaining only the newest 2000 entries', async () => {
        const {
            getDebugLogMessages,
            pushDebugLogMessage,
        } = await import('@electron/preload/debugLogBuffer');
        const eventId = 'b'.repeat(32);

        for (let index = 0; index < 2_000; index += 1) {
            const timestamp = requireIsoTimestamp(`2026-09-03T00:00:${String(index % 60).padStart(2, '0')}.000Z`);
            const entry: IDebugLogEntry = index === 1_000
                ? {
                    source: `main-${index}`,
                    message: '[ERROR] preserved failure',
                    timestamp,
                    level: 'ERROR',
                    failureRef: {
                        eventId,
                        code: 'UNCLASSIFIED_MAIN_ERROR',
                        severity: 'error',
                    },
                }
                : {
                    source: `main-${index}`,
                    message: `[INFO] message ${index}`,
                    timestamp,
                    level: 'INFO',
                };
            pushDebugLogMessage(entry);
        }

        const buffered = getDebugLogMessages();
        expect(buffered).toHaveLength(2_000);
        expect(buffered.find(entry => entry.failureRef?.eventId === eventId)).toEqual(expect.objectContaining({failureRef: expect.objectContaining({eventId})}));

        pushDebugLogMessage({
            source: 'main-final',
            message: '[INFO] final',
            timestamp: requireIsoTimestamp('2026-09-03T00:01:00.000Z'),
            level: 'INFO',
        });
        expect(getDebugLogMessages()).toHaveLength(2_000);
        expect(getDebugLogMessages()[0]?.source).toBe('main-1');
    });
});
