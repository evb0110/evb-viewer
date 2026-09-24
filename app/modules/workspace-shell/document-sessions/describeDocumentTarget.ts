import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type { IWorkspaceDocumentTarget } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentSnapshot';
import type { IWorkspaceOpenRequest } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { acceptsDocumentWithoutVisual } from '@app/modules/workspace-shell/document-sessions/acceptsDocumentWithoutVisual';
import { getDocumentRefBaseName } from '@app/utils/documentRef';

type TDocumentTargetSource = TDocumentRef | TOpenFileResult | IRecentFile;

function isOpenFileResult(target: TDocumentTargetSource): target is TOpenFileResult {
    return typeof target === 'object' && 'kind' in target;
}

function isRecentFile(target: TDocumentTargetSource): target is IRecentFile {
    return typeof target === 'object' && 'fileName' in target && 'timestamp' in target;
}

function isDjvuDocumentPath(path: TDocumentRef | null | undefined, fileName: string | null) {
    return /\.djvu?$/iu.test(fileName ?? path ?? '');
}

/** Names the document an open is about to present, for the tab while it opens. */
export function describeDocumentTarget(target: TDocumentTargetSource): IWorkspaceDocumentTarget {
    if (typeof target === 'string') {
        const fileName = getDocumentRefBaseName(target);
        return {
            fileName,
            originalPath: target,
            isDjvu: isDjvuDocumentPath(target, fileName),
        };
    }

    if (isRecentFile(target)) {
        const fileName = target.fileName || getDocumentRefBaseName(target.originalPath);
        return {
            fileName,
            originalPath: target.originalPath,
            isDjvu: isDjvuDocumentPath(target.originalPath, fileName),
        };
    }

    if (isOpenFileResult(target)) {
        const sourcePath = target.originalPath || (target.kind === 'pdf' ? target.workingPath : null);
        return {
            fileName: getDocumentRefBaseName(sourcePath),
            originalPath: target.originalPath,
            isDjvu: target.kind === 'djvu',
        };
    }

    return {};
}

/** The open transaction for an already resolved file: a recovery reopens what the tab owned. */
export function describeOpenResult(result: TOpenFileResult): IWorkspaceOpenRequest {
    return {
        kind: result.kind === 'pdf' && result.recoveryDirtyBaseline === true ? 'restore' : 'open',
        target: describeDocumentTarget(result),
        acceptDocumentWithoutVisual: acceptsDocumentWithoutVisual(result),
    };
}
