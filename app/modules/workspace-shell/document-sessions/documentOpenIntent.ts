import type { TTabUpdate } from '@app/types/tabs';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';

export interface IDocumentOpenIntent {
    action: string;
    commandTarget?: TWorkspaceCommandTarget | undefined;
    preserveDirtyOnFailure?: boolean | undefined;
    acceptDocumentWithoutVisual?: boolean | undefined;
    target?: TTabUpdate | null;
}
