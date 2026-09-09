export const RAW_IPC_HANDLER_DESCRIPTORS = [
    {
        name: 'diagnostics-canary',
        reason: 'automation-only trusted-sender canary, not a renderer feature invoke',
    },
    {
        name: 'renderer-log',
        reason: 'one-way renderer diagnostic bridge with process-level suppression metadata',
    },
    {
        name: 'renderer-diagnostic',
        reason: 'one-way renderer diagnostic bridge with trusted-sender capture',
    },
    {
        name: 'shutdown-save-flush-result',
        reason: 'temporary renderer-to-main shutdown handshake, not a feature request',
    },
    {
        name: 'window-close-response',
        reason: 'temporary native window-close handshake response',
    },
] as const;

export type TRawIpcHandlerName = typeof RAW_IPC_HANDLER_DESCRIPTORS[number]['name'];

export interface IRawIpcRegistrationAudit {
    register(name: TRawIpcHandlerName, register: () => void, scope?: string): void;
    release(name: TRawIpcHandlerName, scope?: string): void;
    getRegisteredNames(): readonly TRawIpcHandlerName[];
}

export function createRawIpcRegistrationAudit(): IRawIpcRegistrationAudit {
    const registeredNames = new Map<string, TRawIpcHandlerName>();
    const knownNames = new Set(RAW_IPC_HANDLER_DESCRIPTORS.map(descriptor => descriptor.name));
    const keyFor = (name: TRawIpcHandlerName, scope: string) => `${name}:${scope}`;

    return {
        register(name, register, scope = 'global') {
            if (!knownNames.has(name)) {
                throw new Error(`Unknown raw IPC registration: ${name}`);
            }
            const key = keyFor(name, scope);
            if (registeredNames.has(key)) {
                throw new Error(`Duplicate raw IPC registration: ${name} (${scope})`);
            }
            register();
            registeredNames.set(key, name);
        },
        release(name, scope = 'global') {
            registeredNames.delete(keyFor(name, scope));
        },
        getRegisteredNames: () => [...registeredNames.values()],
    };
}
