export interface IPdfNavLogEntry {
    message: string;
    args: unknown[];
    loggedAtMs: number;
}

export interface IPdfRenderTraceEntry {
    event: string;
    payload: Record<string, unknown>;
}
