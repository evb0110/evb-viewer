import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createAssistantHeartbeatController,
    resolveAssistantTurnLiveness,
} from '@electron/features/agent/assistantTurnLiveness';
import type { IAssistantChatSession } from '@electron/features/agent/assistantChatSessionStore';

describe('assistant turn liveness', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('stalls an active phase after a full provider-silence threshold', () => {
        expect(resolveAssistantTurnLiveness('thinking', 1_000, 1_999, 1_000)).toBe('thinking');
        expect(resolveAssistantTurnLiveness('thinking', 1_000, 2_000, 1_000)).toBe('stalled');
    });

    it.each([
        'idle',
        'done',
        'failed',
        'cancelled',
    ] as const)('never stalls terminal phase %s', phase => {
        expect(resolveAssistantTurnLiveness(phase, 0, 100_000, 1)).toBe(phase);
    });

    it('installs one heartbeat only while at least one turn is active and can restart', async () => {
        vi.useFakeTimers();
        const session = {
            lastAccessedAtMs: 1,
            turnPresentation: {
                phase: 'thinking',
                lastEventAtMs: 1,
            },
        } as IAssistantChatSession;
        let active = false;
        const publish = vi.fn();
        const controller = createAssistantHeartbeatController({
            sessions: () => [session],
            isActive: () => active,
            recordBoundary: vi.fn(),
            publish,
        });

        await vi.advanceTimersByTimeAsync(4_000);
        expect(publish).not.toHaveBeenCalled();

        active = true;
        controller.sync();
        controller.sync();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(publish).toHaveBeenCalledTimes(1);

        active = false;
        controller.sync();
        await vi.advanceTimersByTimeAsync(4_000);
        expect(publish).toHaveBeenCalledTimes(1);

        active = true;
        controller.sync();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(publish).toHaveBeenCalledTimes(2);

        controller.dispose();
        await vi.advanceTimersByTimeAsync(4_000);
        expect(publish).toHaveBeenCalledTimes(2);
    });

    it('preserves provider timestamps across ongoing stalled heartbeats', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100_000);
        const session = {
            lastAccessedAtMs: 1,
            turnPresentation: {
                phase: 'thinking',
                lastEventAtMs: 1,
            },
        } as IAssistantChatSession;
        const recordBoundary = vi.fn();
        const publish = vi.fn();
        const controller = createAssistantHeartbeatController({
            sessions: () => [session],
            isActive: () => true,
            recordBoundary,
            publish,
        });

        controller.sync();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(publish).toHaveBeenCalledTimes(15);
        expect(session.turnPresentation.lastEventAtMs).toBe(1);
        expect(session.turnPresentation.phase).toBe('stalled');
        expect(recordBoundary).toHaveBeenCalledWith(session);
        expect(publish).toHaveBeenCalledWith({
            type: 'heartbeat',
            phase: 'stalled',
            lastEventAtMs: 1,
        }, session);
        controller.dispose();
    });
});
