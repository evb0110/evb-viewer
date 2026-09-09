import type {
    IAgentAssistantSendMessageResult,
    IAgentAssistantState,
} from '@contracts/agent';
import { withAssistantErrorEnvelope } from '@electron/features/agent/assistantErrorEnvelope';
import { te } from '@electron/te';

export function createAssistantDisabledError() {
    return te('dialogs.agentAssistant.disabledMessage');
}

export function createAssistantDisabledResult(state: IAgentAssistantState): IAgentAssistantSendMessageResult {
    const error = createAssistantDisabledError();
    return withAssistantErrorEnvelope({
        ok: false,
        state,
        error,
    });
}

export function getAssistantTurnBusyError() {
    return te('dialogs.agentAssistant.turnBusy');
}

export function createAssistantBusyResult(
    currentState: () => IAgentAssistantState,
) {
    const error = getAssistantTurnBusyError();
    return withAssistantErrorEnvelope({
        ok: false,
        state: currentState(),
        error,
    });
}
