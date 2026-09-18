/**
 * One observation point for the failures the renderer error guard already
 * owns. A consumer that wants to know about renderer errors subscribes here
 * instead of installing a second global `error`/`unhandledrejection` handler
 * or a second `console.error` wrapper, so the guard stays the only owner of
 * those hooks.
 *
 * Notices carry a redacted signature, never the raw message, because the
 * subscribers persist them into diagnostics bundles.
 */
export type TRendererDiagnosticSource =
    | 'console-error'
    | 'unhandled-rejection'
    | 'vue'
    | 'window';

export interface IRendererDiagnosticNotice {
    occurredAt: number;
    /** Redacted, length-capped identifier suitable for an allowlist entry. */
    signature: string;
    source: TRendererDiagnosticSource;
}

export type TRendererDiagnosticNoticeListener = (notice: IRendererDiagnosticNotice) => void;

const MAX_SIGNATURE_LENGTH = 200;
const PATH_LIKE_PATTERN = /(?:[a-zA-Z]:\\|file:\/\/|blob:|evb-viewer:\/\/|\/)[^\s"')]{2,}/gu;

const listeners = new Set<TRendererDiagnosticNoticeListener>();

/**
 * Strips path-like and URL-like runs so a document name or a working-copy
 * location can never reach a persisted bundle through an error message.
 */
export function redactRendererDiagnosticSignature(value: string) {
    return value
        .replace(PATH_LIKE_PATTERN, '<path>')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, MAX_SIGNATURE_LENGTH);
}

export function onRendererDiagnosticNotice(listener: TRendererDiagnosticNoticeListener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function notifyRendererDiagnosticNotice(notice: IRendererDiagnosticNotice) {
    if (listeners.size === 0) {
        return;
    }

    for (const listener of [...listeners]) {
        try {
            listener(notice);
        } catch {
            // An observer must never change the failure path it is watching.
        }
    }
}
