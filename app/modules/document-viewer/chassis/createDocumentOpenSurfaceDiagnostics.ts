import { BrowserLogger } from '@app/utils/browserLogger';
import type { IDocumentViewportSessionState } from '@app/modules/document-viewer/chassis/documentOpenSurfaceReducer';

export interface IDocumentOpenSurfaceDiagnosticFence {
    readonly generation: number;
    readonly documentRevision: string;
    readonly viewportIntentId: string;
    readonly renderVersion: number;
    readonly requestId: number;
    readonly pageNumber: number;
}

export interface IDocumentOpenSurfaceDiagnosticEntry {
    readonly timestamp: string;
    readonly operationId: string;
    readonly event: string;
    readonly accepted: boolean;
    readonly reason: string | null;
    readonly generation: number;
    readonly phase: string;
    readonly presentation: string;
    readonly requestedPage: number;
    readonly committedPage: number | null;
    readonly viewportIntentId: string | null;
    readonly renderFence: IDocumentOpenSurfaceDiagnosticFence | null;
    readonly details?: Readonly<Record<string, unknown>>;
}

interface IDocumentOpenSurfaceDiagnosticSnapshot {
    readonly generation: number;
    readonly identity: {readonly documentRevision: string} | null;
    readonly phase: string;
    readonly presentation: string;
}

interface IDocumentOpenSurfaceDiagnosticState {
    snapshot: IDocumentOpenSurfaceDiagnosticSnapshot;
    viewport: IDocumentViewportSessionState;
}

export function createDocumentOpenSurfaceDiagnostics(
    readState: () => IDocumentOpenSurfaceDiagnosticState,
) {
    const history: IDocumentOpenSurfaceDiagnosticEntry[] = [];
    const historyLimit = 20;

    function record(
        event: string,
        accepted: boolean,
        reason: string | null = null,
        details?: Readonly<Record<string, unknown>>,
    ) {
        const {
            snapshot,
            viewport,
        } = readState();
        const revision = snapshot.identity?.documentRevision ?? 'none';
        const viewportRenderFence = viewport.renderFence;
        history.push(Object.freeze({
            timestamp: new Date().toISOString(),
            operationId: `document-open:${String(snapshot.generation)}:${revision}`,
            event,
            accepted,
            reason,
            generation: snapshot.generation,
            phase: snapshot.phase,
            presentation: snapshot.presentation,
            requestedPage: viewport.requestedPage,
            committedPage: viewport.committedPage,
            viewportIntentId: viewport.viewportIntent?.id ?? null,
            renderFence: viewportRenderFence === null ? null : {
                generation: viewportRenderFence.generation,
                documentRevision: viewportRenderFence.revision,
                viewportIntentId: viewportRenderFence.viewportIntentId,
                renderVersion: viewportRenderFence.renderVersion,
                requestId: viewportRenderFence.requestId,
                pageNumber: viewportRenderFence.pageNumber,
            },
            ...(details ? {details: Object.freeze({...details})} : {}),
        }));
        if (history.length > historyLimit) {
            history.splice(0, history.length - historyLimit);
        }
    }

    function reportRejected(
        event: string,
        reason: string,
        details?: Readonly<Record<string, unknown>>,
    ) {
        record(event, false, reason, details);
        const isExpectedSupersession = reason === 'stale-render-fence'
            || reason === 'superseded-render-owner'
            || reason === 'render-fence-older-than-committed';
        const emit = isExpectedSupersession
            ? BrowserLogger.diagnosticThrottled
            : BrowserLogger.warnThrottled;
        emit(
            'document-open-surface',
            `${event}:${reason}`,
            1_000,
            'Lifecycle transition rejected',
            () => history.at(-1),
        );
    }

    return {
        getHistory: () => [...history],
        record,
        reportRejected,
    };
}
