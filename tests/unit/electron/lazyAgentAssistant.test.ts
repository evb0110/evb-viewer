import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentAssistantSendMessageRequest } from '@contracts/agent';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireTabId} from '@contracts/windowTabs';

const assistantSendRequest = {
    text: 'test assistant message',
    scope: {
        kind: 'document',
        key: 'document:lazy-assistant-test',
        title: 'Lazy assistant test',
        tabId: requireTabId('tab-lazy-assistant-test'),
        documentRef: requireDocumentRef('/tmp/lazy-assistant-test.pdf'),
    },
} satisfies IAgentAssistantSendMessageRequest;

const observations = vi.hoisted(() => ({
    moduleEvaluations: 0,
    runtimeInitializations: 0,
    stateReads: 0,
    shutdowns: 0,
}));

vi.mock('@electron/features/agent/assistantService', () => {
    observations.moduleEvaluations += 1;
    return {
        initializeAgentAssistantRuntime: () => { observations.runtimeInitializations += 1; },
        getAgentAssistantState: async () => { observations.stateReads += 1; return {state: 'read'}; },
        installAgentAssistantCodex: vi.fn(),
        startAgentAssistantLogin: vi.fn(),
        cancelAgentAssistantLogin: vi.fn(),
        sendAgentAssistantMessage: async () => ({state: 'sent'}),
        interruptAgentAssistant: vi.fn(),
        resetAgentAssistantChat: vi.fn(),
        shutdownAgentAssistant: async () => { observations.shutdowns += 1; },
    };
});

describe('lazy assistant facade', () => {
    it('does not load the assistant runtime only to shut down', async () => {
        const {shutdownAgentAssistantIfLoaded} = await import('@electron/features/agent/lazyAgentAssistant');
        await shutdownAgentAssistantIfLoaded();
        expect(observations.moduleEvaluations).toBe(0);
        expect(observations.shutdowns).toBe(0);
    });

    it('loads the facade runtime for a state read without initializing it', async () => {
        const {getAgentAssistantState} = await import('@electron/features/agent/lazyAgentAssistant');
        await expect(Promise.all([
            getAgentAssistantState(),
            getAgentAssistantState(),
        ])).resolves.toEqual([
            {state: 'read'},
            {state: 'read'},
        ]);
        expect(observations.moduleEvaluations).toBe(1);
        expect(observations.stateReads).toBe(2);
        expect(observations.runtimeInitializations).toBe(0);
    });

    it('initializes the runtime when an operation needs it and reuses the module', async () => {
        const {
            getAgentAssistantState,
            shutdownAgentAssistantIfLoaded,
            sendAgentAssistantMessage,
        } = await import('@electron/features/agent/lazyAgentAssistant');
        await sendAgentAssistantMessage(assistantSendRequest);
        await getAgentAssistantState();
        expect(observations.moduleEvaluations).toBe(1);
        expect(observations.runtimeInitializations).toBe(1);

        await shutdownAgentAssistantIfLoaded();
        expect(observations.shutdowns).toBe(1);
        await sendAgentAssistantMessage(assistantSendRequest);
        expect(observations.moduleEvaluations).toBe(1);
        expect(observations.runtimeInitializations).toBe(2);
    });
});
