import type {IAgentOcrRunOptions} from '@contracts/agentOcr';

/** The agent command an OCR run belongs to: aborted with it, and bound to its document. */
export interface IAgentOcrRunAdmission {
    signal: AbortSignal;
    assertCurrentDocument: () => void;
}

export interface IOcrPopupAgentExpose {
    runOcrForAgent: (options?: IAgentOcrRunOptions, admission?: IAgentOcrRunAdmission) => Promise<Record<string, unknown>>;
    cancelOcrForAgent: () => Promise<Record<string, unknown>>;
    getAgentOcrSnapshot: () => Record<string, unknown>;
}
