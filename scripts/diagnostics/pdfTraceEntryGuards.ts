import type {
    IPdfNavLogEntry,
    IPdfRenderTraceEntry,
} from '@contracts/pdfDiagnostics';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isPdfNavLogEntry(value: unknown): value is IPdfNavLogEntry {
    return isRecord(value)
        && typeof value.message === 'string'
        && Array.isArray(value.args)
        && typeof value.loggedAtMs === 'number';
}

function isPdfRenderTraceEntry(value: unknown): value is IPdfRenderTraceEntry {
    return isRecord(value)
        && typeof value.event === 'string'
        && isRecord(value.payload);
}

export function toPdfNavLogEntries(value: unknown): IPdfNavLogEntry[] {
    const entries: unknown[] = Array.isArray(value)
        ? Array.from(value as readonly unknown[])
        : [];
    return entries.filter(isPdfNavLogEntry);
}

export function toPdfRenderTraceEntries(value: unknown): IPdfRenderTraceEntry[] {
    const entries: unknown[] = Array.isArray(value)
        ? Array.from(value as readonly unknown[])
        : [];
    return entries.filter(isPdfRenderTraceEntry);
}
