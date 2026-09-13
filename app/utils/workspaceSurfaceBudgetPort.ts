export interface IWorkspaceSurfaceBudgetLeasePort {
    promotePriority?: (priority: number) => void;
    release: () => void;
}

export interface IWorkspaceSurfaceBudgetPort {
    reserve: (options: {
        scopeId: string;
        category: 'native-preview';
        bytes: number;
        evict?: (() => void) | undefined;
        priority?: number | undefined;
    }) => IWorkspaceSurfaceBudgetLeasePort;
    releaseScope: (scopeId: string) => void;
}

let workspaceSurfaceBudgetPort: IWorkspaceSurfaceBudgetPort | null = null;

export function registerWorkspaceSurfaceBudgetPort(port: IWorkspaceSurfaceBudgetPort) {
    workspaceSurfaceBudgetPort = port;
}

export function requireWorkspaceSurfaceBudgetPort() {
    if (!workspaceSurfaceBudgetPort) {
        throw new Error('Workspace surface budget is unavailable');
    }
    return workspaceSurfaceBudgetPort;
}
