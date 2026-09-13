import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
} from '@contracts/agent';
import { buildAgentAssistantScopeFingerprint } from '@agent-core/assistantScope';
import { shouldAcceptAssistantEvent } from '@app/modules/agent-panel/utils/assistantEventFence';

function createScope(key: string, revision: string): IAgentAssistantChatScope {
    return {
        kind: 'document',
        key,
        title: key,
        tabId: `tab-${key}`,
        documentSessionKey: `session-${key}`,
        documentRef: `/tmp/${key}.pdf`,
        documentIdentity: {
            documentRef: `/tmp/${key}.pdf`,
            token: revision,
        },
    } as IAgentAssistantChatScope;
}

function createEvent(scope: IAgentAssistantChatScope, generation: number): IAgentAssistantEvent {
    return {
        type: 'message-delta',
        messageId: 'message',
        delta: 'delta',
        binding: {
            scopeFingerprint: buildAgentAssistantScopeFingerprint('codex', scope),
            sessionKey: `codex:${scope.key}`,
            turnGeneration: generation,
            windowId: 1,
        },
    };
}

describe('assistant event fence', () => {
    it('rejects another document and a previous revision after a document switch', () => {
        const generations = new Map<string, number>();
        const documentA = createScope('a', 'revision-a');
        const documentB = createScope('b', 'revision-b');
        const staleRevisionB = createScope('b', 'revision-b-old');

        expect(shouldAcceptAssistantEvent(createEvent(documentA, 1), 'codex', documentB, generations)).toBe(false);
        expect(shouldAcceptAssistantEvent(createEvent(staleRevisionB, 1), 'codex', documentB, generations)).toBe(false);
        expect(shouldAcceptAssistantEvent(createEvent(documentB, 1), 'codex', documentB, generations)).toBe(true);
    });

    it('rejects late events from an older turn generation in the same session', () => {
        const generations = new Map<string, number>();
        const scope = createScope('same', 'revision');

        expect(shouldAcceptAssistantEvent(createEvent(scope, 8), 'codex', scope, generations)).toBe(true);
        expect(shouldAcceptAssistantEvent(createEvent(scope, 7), 'codex', scope, generations)).toBe(false);
        expect(shouldAcceptAssistantEvent(createEvent(scope, 8), 'codex', scope, generations)).toBe(true);
    });

    it('accepts unbound events only when they carry a scope-checked state snapshot', () => {
        const generations = new Map<string, number>();
        const scope = createScope('snapshot', 'revision');
        expect(shouldAcceptAssistantEvent({type: 'heartbeat'}, 'codex', scope, generations)).toBe(false);
        expect(shouldAcceptAssistantEvent({
            type: 'state',
            state: {} as NonNullable<IAgentAssistantEvent['state']>,
        }, 'codex', scope, generations)).toBe(true);
    });
});
