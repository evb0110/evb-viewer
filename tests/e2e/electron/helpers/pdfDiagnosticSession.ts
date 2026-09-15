import type { Page } from 'puppeteer-core';
import type {
    IPdfNavLogEntry,
    IPdfRenderTraceEntry,
} from '@contracts/pdfDiagnostics';

interface IPdfDiagnosticWindow extends Window {
    __clearPdfNavLog?: () => void;
    __clearPdfRenderTrace?: () => void;
    __getPdfNavLog?: () => IPdfNavLogEntry[];
    __getPdfRenderTrace?: () => IPdfRenderTraceEntry[];
    __pdfNavLog?: boolean;
    __pdfNavLogBuffer?: IPdfNavLogEntry[];
    __pdfNavLogConsole?: boolean;
    __pdfRenderTrace?: boolean;
    __pdfRenderTraceBuffer?: IPdfRenderTraceEntry[];
    __pdfRenderTraceConsole?: boolean;
}

export interface IPdfDiagnosticSessionOptions {
    console?: boolean;
    navigation?: boolean;
    render?: boolean;
}

export async function enablePdfDiagnosticSession(
    page: Pick<Page, 'evaluate'>,
    options: IPdfDiagnosticSessionOptions = {},
) {
    await page.evaluate((sessionOptions: IPdfDiagnosticSessionOptions) => {
        const diagnosticWindow = window as IPdfDiagnosticWindow;
        const consoleEnabled = sessionOptions.console === true;
        if (sessionOptions.navigation === true) {
            diagnosticWindow.__pdfNavLog = true;
            diagnosticWindow.__pdfNavLogConsole = consoleEnabled;
            diagnosticWindow.__pdfNavLogBuffer = [];
            diagnosticWindow.__getPdfNavLog = () => [...(diagnosticWindow.__pdfNavLogBuffer ?? [])];
            diagnosticWindow.__clearPdfNavLog = () => {
                diagnosticWindow.__pdfNavLogBuffer = [];
            };
        }
        if (sessionOptions.render === true) {
            diagnosticWindow.__pdfRenderTrace = true;
            diagnosticWindow.__pdfRenderTraceConsole = consoleEnabled;
            diagnosticWindow.__pdfRenderTraceBuffer = [];
            diagnosticWindow.__getPdfRenderTrace = () => [...(diagnosticWindow.__pdfRenderTraceBuffer ?? [])];
            diagnosticWindow.__clearPdfRenderTrace = () => {
                diagnosticWindow.__pdfRenderTraceBuffer = [];
            };
        }
    }, options);
}

export async function disablePdfDiagnosticSession(page: Pick<Page, 'evaluate'>) {
    await page.evaluate(() => {
        const diagnosticWindow = window as IPdfDiagnosticWindow;
        diagnosticWindow.__clearPdfNavLog?.();
        diagnosticWindow.__clearPdfRenderTrace?.();
        delete diagnosticWindow.__pdfNavLog;
        delete diagnosticWindow.__pdfNavLogConsole;
        delete diagnosticWindow.__pdfNavLogBuffer;
        delete diagnosticWindow.__getPdfNavLog;
        delete diagnosticWindow.__clearPdfNavLog;
        delete diagnosticWindow.__pdfRenderTrace;
        delete diagnosticWindow.__pdfRenderTraceConsole;
        delete diagnosticWindow.__pdfRenderTraceBuffer;
        delete diagnosticWindow.__getPdfRenderTrace;
        delete diagnosticWindow.__clearPdfRenderTrace;
    });
}
