import type { TTabUpdate } from '@app/types/tabs';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';

export interface IDocumentOpenIntent {
    action: string;
    commandTarget?: TWorkspaceCommandTarget | undefined;
    preparedOpeningGeometry?: IPdfOpeningGeometry | undefined;
    preparedSourceModifiedAt?: number | undefined;
    preparedSourceSize?: number | undefined;
    preserveDirtyOnFailure?: boolean | undefined;
    target?: TTabUpdate | null;
}
