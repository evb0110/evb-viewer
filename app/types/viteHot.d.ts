declare global {
    interface ImportMeta {
        readonly server: boolean;
        readonly client: boolean;
        readonly dev: boolean;
        hot?: {
            data: Record<string, unknown>;
            dispose: (callback: (data: Record<string, unknown>) => void) => void;
            on: (event: string, callback: (payload: unknown) => void) => void;
        };
    }
}

export {};
