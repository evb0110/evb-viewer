import type {IAgentWorkspaceSnapshot, TAgentCommand} from '@contracts/agent';
import type {
    IAgentDocumentPageReadOptions,
    IAgentDocumentSearchOptions,
    IAgentDocumentTextOperationInput,
} from '@electron/features/agent/documentText';

export interface ILocalMcpServerIdentity {
    name: string;
    title: string;
    appName: string;
    version: string;
    isPackaged: boolean;
    userDataPath: string | null;
    host: string;
    port: number;
}

export interface ILocalMcpServerDescriptor {
    name: string;
    title: string;
    host: string;
    port: number;
    url: string;
}

export type TMcpCallerKind = 'internal' | 'external';

export interface IProcessMcpRequestOptions {
    identity: ILocalMcpServerIdentity;
    callerKind?: TMcpCallerKind;
    getWorkspaceSnapshot(windowId?: number): Promise<IAgentWorkspaceSnapshot>;
    runCommand(command: TAgentCommand, windowId?: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
    inspectDocumentText?(
        input: IAgentDocumentTextOperationInput<Record<never, never>>,
        windowId?: number,
        signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;
    searchDocument?(
        input: IAgentDocumentTextOperationInput<IAgentDocumentSearchOptions>,
        windowId?: number,
        signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;
    readDocumentPages?(
        input: IAgentDocumentTextOperationInput<IAgentDocumentPageReadOptions>,
        windowId?: number,
        signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;
}
