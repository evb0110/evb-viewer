import type { TTabUpdate } from '@app/types/tabs';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';

export interface IDocumentOpenIntent {
    action: string;
    commandTarget?: TWorkspaceCommandTarget | undefined;
    /**
     * Source size known before the open claims its surface. It only informs
     * the opening-surface policy until the loaded source reports its own size.
     */
    declaredSourceSize?: number | undefined;
    preparedOpeningGeometry?: IPdfOpeningGeometry | undefined;
    preparedSourceModifiedAt?: number | undefined;
    preparedSourceSize?: number | undefined;
    preserveDirtyOnFailure?: boolean | undefined;
    acceptDocumentWithoutVisual?: boolean | undefined;
    target?: TTabUpdate | null;
}
