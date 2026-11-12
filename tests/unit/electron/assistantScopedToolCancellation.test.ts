import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAssistantSessionScopeBinding } from '@electron/features/agent/assistantMcpSessionScope';
import { abortAssistantToolRequestsForBinding } from '@electron/features/agent/mcpServer';
import { requireTabId } from '@contracts/windowTabs';

function createBinding(sessionKey: string, generation: number, windowId = 1): IAssistantSessionScopeBinding {
    return {
        sessionKey,
        scopeKey: sessionKey,
        provider: 'codex',
        turnGeneration: generation,
        windowId,
        tabId: requireTabId(`tab-${sessionKey}`),
        documentRef: null,
        documentIdentity: null,
    };
}

describe('assistant scoped tool cancellation', () => {
    it('aborts only tool calls owned by the interrupted session and turn generation', () => {
        const active = new AbortController();
        const concurrent = new AbortController();
        const previousGeneration = new AbortController();
        const anotherWindow = new AbortController();
        const binding = createBinding('session-a', 4);
        const calls = new Map([
            [
                active,
                binding,
            ],
            [
                concurrent,
                createBinding('session-b', 4),
            ],
            [
                previousGeneration,
                createBinding('session-a', 3),
            ],
            [
                anotherWindow,
                createBinding('session-a', 4, 2),
            ],
        ]);

        expect(abortAssistantToolRequestsForBinding(calls, binding)).toBe(1);
        expect(active.signal.aborted).toBe(true);
        expect(concurrent.signal.aborted).toBe(false);
        expect(previousGeneration.signal.aborted).toBe(false);
        expect(anotherWindow.signal.aborted).toBe(false);
    });
});
