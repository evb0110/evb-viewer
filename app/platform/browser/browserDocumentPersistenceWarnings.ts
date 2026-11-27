export interface IBrowserDocumentPersistenceWarning {
    fileName: string;
    error: unknown;
}

type TBrowserDocumentPersistenceWarningListener = (warning: IBrowserDocumentPersistenceWarning) => void;

const listeners = new Set<TBrowserDocumentPersistenceWarningListener>();

export function emitBrowserDocumentPersistenceWarning(warning: IBrowserDocumentPersistenceWarning) {
    for (const listener of listeners) {
        listener(warning);
    }
}

export function onBrowserDocumentPersistenceWarning(listener: TBrowserDocumentPersistenceWarningListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
