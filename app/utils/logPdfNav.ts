import { BrowserLogger } from '@app/utils/browserLogger';
import type { IPdfNavLogEntry } from '@contracts/pdfDiagnostics';

const PDF_NAV_LOG_SECTION = 'pdf-nav';
const PDF_NAV_LOG_BUFFER_LIMIT = 5_000;

type TPdfNavLogWindow = Window & {
    __pdfNavLog?: boolean;
    __pdfNavLogConsole?: boolean;
    __pdfNavLogBuffer?: IPdfNavLogEntry[];
    __getPdfNavLog?: () => IPdfNavLogEntry[];
    __clearPdfNavLog?: () => void;
};

function getLogWindow() {
    if (typeof window === 'undefined') {
        return null;
    }

    const logWindow = window as TPdfNavLogWindow;
    logWindow.__pdfNavLogBuffer ??= [];
    logWindow.__getPdfNavLog ??= () => [...(logWindow.__pdfNavLogBuffer ?? [])];
    logWindow.__clearPdfNavLog ??= () => {
        logWindow.__pdfNavLogBuffer = [];
    };
    return logWindow;
}

function isPdfNavLogEnabled() {
    if (typeof window === 'undefined') {
        return false;
    }

    return (window as TPdfNavLogWindow).__pdfNavLog === true;
}

function isPdfNavLogConsoleEnabled() {
    if (typeof window === 'undefined') {
        return false;
    }

    return (window as TPdfNavLogWindow).__pdfNavLogConsole === true;
}

export function logPdfNav(message: string, ...args: unknown[]) {
    if (!isPdfNavLogEnabled()) {
        return;
    }

    const logWindow = getLogWindow();
    if (!logWindow) {
        return;
    }

    const entry = {
        message,
        args,
        loggedAtMs: typeof performance === 'undefined' ? Date.now() : performance.now(),
    };
    const buffer = logWindow.__pdfNavLogBuffer ?? [];
    buffer.push(entry);
    if (buffer.length > PDF_NAV_LOG_BUFFER_LIMIT) {
        buffer.splice(0, buffer.length - PDF_NAV_LOG_BUFFER_LIMIT);
    }
    logWindow.__pdfNavLogBuffer = buffer;

    if (isPdfNavLogConsoleEnabled()) {
        BrowserLogger.diagnostic(PDF_NAV_LOG_SECTION, message, args.length > 0 ? args : undefined);
    }
}
