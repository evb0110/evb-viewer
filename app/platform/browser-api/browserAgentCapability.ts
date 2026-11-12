import type {
    IAgentCommandCancelRequest,
    IAgentMcpIntegrationStatus,
} from '@contracts/agent';
import type { IAgentCapability } from '@contracts/agentPlatformFeature';
import { createIsoTimestamp } from '@contracts/timestamps';
import type {
    IAssistantState, IAssistantStateRequest,
} from '@contracts/assistant';

export function createBrowserAgentMcpStatus(): IAgentMcpIntegrationStatus {
    return {
        enabled: false,
        serverName: 'evb_viewer',
        serverUrl: '',
        serverRunning: false,
        codexInstalled: false,
        codexPath: null,
        codexConfigured: false,
        codexRegistrationState: 'unknown',
        installUrl: 'https://developers.openai.com/codex/app',
        lastCheckedAt: createIsoTimestamp(),
        setupSnippets: {
            codex: '',
            claude: '',
            cursor: '',
        },
    };
}

export function createBrowserAssistantState(): IAssistantState {
    return {
        supported: false,
        enabled: false,
        instances: [],
        selection: null,
        chat: null,
        installProgress: null,
    };
}

export const browserAgentCapability = {
    onWorkspaceSnapshotRequest: (_callback) => () => {},
    submitWorkspaceSnapshot: (_response) => Promise.resolve({
        accepted: false,
        reason: 'unknown-request' as const,
    }),
    onCommandRequest: (_callback) => () => {},
    onCommandCancelRequest: (_callback: (request: IAgentCommandCancelRequest) => void) => () => {},
    submitCommandResponse: (_response) => Promise.resolve({
        accepted: false,
        reason: 'unknown-request' as const,
    }),
    getMcpIntegrationStatus: () => Promise.resolve(createBrowserAgentMcpStatus()),
    setMcpIntegrationEnabled: (_enabled) => Promise.resolve({
        ok: false,
        status: createBrowserAgentMcpStatus(),
    }),
    getAssistantState: (_request?: IAssistantStateRequest) => Promise.resolve(createBrowserAssistantState()),
    installAssistantCodex: () => Promise.resolve({
        ok: false,
        state: createBrowserAssistantState(),
    }),
    startAssistantLogin: (_request) => Promise.resolve({
        ok: false,
        state: createBrowserAssistantState(),
    }),
    cancelAssistantLogin: () => Promise.resolve(createBrowserAssistantState()),
    sendAssistantMessage: (_request) => Promise.resolve({
        ok: false,
        state: createBrowserAssistantState(),
    }),
    interruptAssistant: (_request) => Promise.resolve(createBrowserAssistantState()),
    resetAssistantChat: (_request) => Promise.resolve(createBrowserAssistantState()),
    getAssistantInstances: () => Promise.resolve({
        ok: false,
        instances: [],
        notices: [],
    }),
    saveAssistantInstances: (_instances) => Promise.resolve({
        ok: false,
        instances: [],
        notices: [],
    }),
    importAssistantInstancesFromT3: () => Promise.resolve({
        ok: false,
        instances: [],
        notices: [],
    }),
    onAssistantEvent: (_callback) => () => {},
} as const satisfies IAgentCapability;
