import type {TWorkspaceUndoSource} from '@app/types/workspaceUndoSource';

export interface IWorkspaceCommandRegistration {
    source: TWorkspaceUndoSource;
    undo: () => Promise<boolean> | boolean;
    cmd: () => Promise<boolean> | boolean;
    canUndo?: (() => boolean) | undefined;
    canRedo?: (() => boolean) | undefined;
    estimatedBytes?: number;
    /**
     * Entities this command replays, named in the producer's own id space. Hard
     * removal of any of them invalidates the command; the ledger uses this as
     * the ownership boundary for {@link IWorkspaceCommandSink.forget}.
     */
    entityIds?: readonly string[] | undefined;
}

export interface IWorkspaceCommandSink {
    register: (command: IWorkspaceCommandRegistration) => void;
    reset: (source?: TWorkspaceUndoSource) => void;
    /** Drops only the source's commands that replay one of the removed entities. */
    forget: (source: TWorkspaceUndoSource, entityIds: ReadonlySet<string>) => void;
    /** Routes editor keyboard history through the single workspace timeline. */
    undo?: () => Promise<boolean> | boolean;
    redo?: () => Promise<boolean> | boolean;
}
