import {
    onRendererDiagnosticNotice,
    type IRendererDiagnosticNotice,
} from '@app/utils/rendererDiagnosticNotices';

const MAX_RETAINED_NOTICES = 50;

let unsubscribe: (() => void) | null = null;
let notices: IRendererDiagnosticNotice[] = [];

/**
 * Subscribes to the renderer error guard's own notices. The guard keeps
 * ownership of the global handlers; this only retains a bounded tail of what
 * it already reported.
 */
export function ensureViewerDiagnosticLog() {
    if (unsubscribe) {
        return;
    }
    unsubscribe = onRendererDiagnosticNotice((notice) => {
        notices.push(notice);
        if (notices.length > MAX_RETAINED_NOTICES) {
            notices.splice(0, notices.length - MAX_RETAINED_NOTICES);
        }
    });
}

export function readViewerDiagnosticNotices(): readonly IRendererDiagnosticNotice[] {
    return notices;
}

export function clearViewerDiagnosticNotices() {
    notices = [];
}

export function disposeViewerDiagnosticLog() {
    unsubscribe?.();
    unsubscribe = null;
    clearViewerDiagnosticNotices();
}
