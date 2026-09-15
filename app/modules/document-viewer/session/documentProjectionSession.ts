import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentPageSource,
    IDocumentSourceCapabilities,
} from '@app/modules/document-viewer/source/documentPageSource';

export type TPdfProjectionReason = 'edit' | 'ocr' | 'save-as-pdf' | 'print';
export type TPdfProjectionState =
    | { status: 'idle' }
    | {
        status: 'building';
        reason: TPdfProjectionReason
    }
    | {
        status: 'ready';
        reason: TPdfProjectionReason;
        documentRef: TDocumentRef
    }
    | {
        status: 'failed';
        reason: TPdfProjectionReason;
        error: unknown
    };

export interface IDocumentProjectionSession {
    readonly id: string;
    readonly originalRef: TDocumentRef;
    source: IDocumentPageSource;
    capabilities: IDocumentSourceCapabilities;
    projection: TPdfProjectionState;
}

export interface IPdfProjectionBuilder {build(options: {
    session: IDocumentProjectionSession;
    reason: TPdfProjectionReason;
    signal?: AbortSignal;
}): Promise<{
    documentRef: TDocumentRef;
    source: IDocumentPageSource;
    capabilities: IDocumentSourceCapabilities;
}>;}

export function createDocumentProjectionSession(options: {
    id: string;
    originalRef: TDocumentRef;
    source: IDocumentPageSource;
    capabilities: IDocumentSourceCapabilities;
}): IDocumentProjectionSession {
    return {
        ...options,
        projection: { status: 'idle' },
    };
}

/** Atomically swaps a DjVu session to its PDF projection while preserving session/view identity. */
export async function ensurePdfProjection(
    session: IDocumentProjectionSession,
    builder: IPdfProjectionBuilder,
    reason: TPdfProjectionReason,
    signal?: AbortSignal,
) {
    if (session.source.kind === 'pdf') {
        return session.source;
    }
    session.projection = {
        status: 'building',
        reason,
    };
    try {
        const projection = await builder.build({
            session,
            reason,
            ...(signal === undefined ? {} : {signal}),
        });
        signal?.throwIfAborted();
        const previousSource = session.source;
        session.source = projection.source;
        session.capabilities = projection.capabilities;
        session.projection = {
            status: 'ready',
            reason,
            documentRef: projection.documentRef,
        };
        previousSource.dispose();
        return projection.source;
    } catch (error) {
        session.projection = {
            status: 'failed',
            reason,
            error,
        };
        throw error;
    }
}
