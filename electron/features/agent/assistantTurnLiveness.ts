import type {
    IAgentAssistantEvent,
    TAgentAssistantTurnPhase,
} from '@contracts/agent';
import type { IAssistantChatSession } from '@electron/features/agent/assistantChatSessionStore';

const ASSISTANT_STALL_THRESHOLD_MS = 60_000;

export function resolveAssistantTurnLiveness(
    phase: TAgentAssistantTurnPhase,
    lastProviderEventAtMs: number,
    now = Date.now(),
    stallThresholdMs = ASSISTANT_STALL_THRESHOLD_MS,
): TAgentAssistantTurnPhase {
    if (phase === 'idle' || phase === 'done' || phase === 'failed' || phase === 'cancelled') {
        return phase;
    }
    return now - lastProviderEventAtMs >= stallThresholdMs ? 'stalled' : phase;
}

export async function waitForBoundedAssistantInterrupt(operation: Promise<unknown>, timeoutMs = 5_000) {
    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            operation,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Assistant interrupt timed out.')), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export interface IAssistantHeartbeatController {
    sync(): void;
    dispose(): void;
}

export function createAssistantHeartbeatController(options: {
    sessions: () => IAssistantChatSession[];
    isActive: (session: IAssistantChatSession) => boolean;
    recordBoundary: (session: IAssistantChatSession) => void;
    publish: (event: IAgentAssistantEvent, session: IAssistantChatSession) => void;
}): IAssistantHeartbeatController {
    let timer: NodeJS.Timeout | null = null;

    function publishHeartbeat() {
        const now = Date.now();
        for (const session of options.sessions()) {
            if (!options.isActive(session)) continue;
            const lastEventAtMs = session.turnPresentation.lastEventAtMs ?? session.lastAccessedAtMs;
            const phase = resolveAssistantTurnLiveness(session.turnPresentation.phase, lastEventAtMs, now);
            if (phase === 'stalled' && session.turnPresentation.phase !== phase) {
                session.turnPresentation.phase = phase;
                options.recordBoundary(session);
            }
            options.publish({
                type: 'heartbeat',
                phase,
                lastEventAtMs,
            }, session);
        }
    }

    function sync() {
        const hasActiveTurn = options.sessions().some(options.isActive);
        if (hasActiveTurn && !timer) {
            timer = setInterval(publishHeartbeat, 2_000);
            timer.unref();
            return;
        }
        if (!hasActiveTurn && timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    function dispose() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    return {
        sync,
        dispose,
    };
}
