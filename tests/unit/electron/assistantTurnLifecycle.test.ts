import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    advanceAssistantTurnScope,
    canCompleteAssistantTurnWithoutProviderTurn,
    claimAssistantTurn,
    completeAssistantTurn,
    createInitialAssistantTurnOwner,
    getAssistantTurnPhase,
    getAssistantTurnProviderTurnId,
    isAssistantTurnActive,
    markAssistantTurnInterrupting,
    markAssistantTurnRunning,
    supersedeAssistantTurn,
    type IAssistantSessionScopeBinding,
} from '@electron/features/agent/assistantTurnLifecycle';
import {requireDocumentInstanceId} from '@contracts/documentInstanceId';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireTabId} from '@contracts/windowTabs';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireSessionId} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';
import type {IAgentCommandSuccessor} from '@contracts/agent';

const scopeBinding = {
    sessionKey: 'codex:document:/tmp/a.pdf',
    scopeKey: 'document:/tmp/a.pdf',
    provider: 'codex',
    windowId: 42,
    tabId: requireTabId('tab-a'),
    documentSessionKey: 'document:/tmp/a.pdf',
    documentInstanceId: requireDocumentInstanceId('instance-a'),
    documentRef: requireDocumentRef('/tmp/a.pdf'),
    documentIdentity: null,
} satisfies Omit<IAssistantSessionScopeBinding, 'turnGeneration'>;

function revision(value: number, overrides: Partial<IAgentCommandSuccessor['commandTarget']> = {}): IAgentCommandSuccessor {
    const documentRevisionToken = requireDocumentRevisionToken(`revision-${value}`);
    return {
        commandTarget: {
            kind: 'revision',
            tabId: scopeBinding.tabId,
            sessionId: requireSessionId('session-a'),
            documentRef: scopeBinding.documentRef,
            documentInstanceId: scopeBinding.documentInstanceId,
            documentRevisionToken,
            sessionRevision: value,
            ...overrides,
        } as IAgentCommandSuccessor['commandTarget'],
        documentIdentity: {
            version: 1,
            token: documentRevisionToken,
            // A working copy, as on desktop: not the tab's original file.
            documentRef: requireDocumentRef('/tmp/working/a.pdf'),
            authority: 'electron-working-copy',
            contentRevision: value,
            mintedAt: requireEpochMs(value),
        },
    };
}

describe('assistant turn lifecycle', () => {
    it('moves a turn to the revision its own command committed, for the same document only', () => {
        const first = revision(1);
        const running = markAssistantTurnRunning(claimAssistantTurn(createInitialAssistantTurnOwner(), {
            ...scopeBinding,
            commandTarget: first.commandTarget,
            documentIdentity: first.documentIdentity,
        }, 'local-1'), 1, 'turn-1');
        const saved = revision(2);

        expect(advanceAssistantTurnScope(running, running.generation, saved)).toMatchObject({
            phase: 'running',
            generation: running.generation,
            scope: {
                commandTarget: saved.commandTarget,
                documentIdentity: saved.documentIdentity,
                tabId: scopeBinding.tabId,
            },
        });
        for (const other of [
            revision(2, {documentRef: requireDocumentRef('/tmp/b.pdf')}),
            revision(2, {documentInstanceId: requireDocumentInstanceId('instance-b')}),
            revision(2, {tabId: requireTabId('tab-b')}),
            revision(2, {sessionId: requireSessionId('session-b')}),
            {
                ...saved,
                documentIdentity: {
                    ...saved.documentIdentity!,
                    documentRef: requireDocumentRef('/tmp/working/b.pdf'),
                },
            },
        ]) {
            expect(advanceAssistantTurnScope(running, running.generation, other)).toBe(running);
        }
        expect(advanceAssistantTurnScope(running, running.generation - 1, saved)).toBe(running);
        const interrupting = markAssistantTurnInterrupting(running);
        expect(advanceAssistantTurnScope(interrupting, interrupting.generation, saved)).toBe(interrupting);
    });

    it('claims turns with monotonically increasing generations', () => {
        const initial = createInitialAssistantTurnOwner();
        const first = claimAssistantTurn(initial, scopeBinding, 'local-1');
        const second = claimAssistantTurn(first, scopeBinding, 'local-2');

        expect(first).toMatchObject({
            phase: 'starting',
            generation: 1,
            localTurnId: 'local-1',
            providerTurnId: null,
            scope: {
                ...scopeBinding,
                turnGeneration: 1,
            },
        });
        expect(second).toMatchObject({
            phase: 'starting',
            generation: 2,
            localTurnId: 'local-2',
            scope: {
                ...scopeBinding,
                turnGeneration: 2,
            },
        });
    });

    it('drops stale starts and completions by generation and provider turn', () => {
        const claimed = claimAssistantTurn(createInitialAssistantTurnOwner(), scopeBinding, 'local-1');
        const staleStart = markAssistantTurnRunning(claimed, claimed.generation - 1, 'turn-old');
        const running = markAssistantTurnRunning(claimed, claimed.generation, 'turn-1');
        expect(markAssistantTurnRunning(running, running.generation, 'turn-1')).toBe(running);
        const wrongCompletion = completeAssistantTurn(running, running.generation, 'turn-2');
        const staleCompletion = completeAssistantTurn(running, running.generation - 1, 'turn-1');
        const completed = completeAssistantTurn(running, running.generation, 'turn-1');

        expect(staleStart).toBe(claimed);
        expect(wrongCompletion).toBe(running);
        expect(staleCompletion).toBe(running);
        expect(completed.phase).toBe('idle');
        expect(completed.generation).toBe(running.generation);
    });

    it('accepts providerless completion only for running or interrupting turns', () => {
        const claimed = claimAssistantTurn(createInitialAssistantTurnOwner(), scopeBinding, 'local-1');
        const startingCompletion = completeAssistantTurn(claimed, claimed.generation, null);
        const running = markAssistantTurnRunning(claimed, claimed.generation, 'turn-1');
        const runningCompletion = completeAssistantTurn(running, running.generation, null);

        expect(canCompleteAssistantTurnWithoutProviderTurn(claimed)).toBe(false);
        expect(startingCompletion).toBe(claimed);
        expect(canCompleteAssistantTurnWithoutProviderTurn(running)).toBe(true);
        expect(runningCompletion.phase).toBe('idle');
    });

    it('allows explicitly trusted providerless completion while a turn is starting', () => {
        const claimed = claimAssistantTurn(createInitialAssistantTurnOwner(), scopeBinding, 'local-1');
        const completed = completeAssistantTurn(claimed, claimed.generation, null, {allowStartingWithoutProviderTurn: true});

        expect(completed).toMatchObject({
            phase: 'idle',
            generation: claimed.generation,
        });
    });

    it('supersedes interrupted turns so stale completions cannot clear the next generation', () => {
        const claimed = claimAssistantTurn(createInitialAssistantTurnOwner(), scopeBinding, 'local-1');
        const running = markAssistantTurnRunning(claimed, claimed.generation, 'turn-1');
        const interrupting = markAssistantTurnInterrupting(running);
        const superseded = supersedeAssistantTurn(interrupting);
        const staleCompletion = completeAssistantTurn(superseded, running.generation, 'turn-1');

        expect(interrupting).toMatchObject({
            phase: 'interrupting',
            providerTurnId: 'turn-1',
        });
        expect(superseded).toMatchObject({
            phase: 'idle',
            generation: running.generation + 1,
        });
        expect(staleCompletion).toBe(superseded);
        expect(isAssistantTurnActive(superseded)).toBe(false);
        expect(getAssistantTurnProviderTurnId(superseded)).toBeNull();
        expect(getAssistantTurnPhase(superseded)).toBe('idle');
    });
});
