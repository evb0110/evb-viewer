import { te } from '@electron/te';

export function createClaudeContextUnavailableError() {
    return te('dialogs.agentAssistant.contextUnavailable');
}
