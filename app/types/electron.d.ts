type TMenuEventCallback = () => void;
type TMenuEventUnsubscribe = () => void;

interface IElectronAPI {
    openPdfDialog: () => Promise<string | null>;
    readFile: (path: string) => Promise<Uint8Array>;
    writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
    setWindowTitle: (title: string) => Promise<void>;
    onMenuOpenPdf: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuSave: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuZoomIn: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuZoomOut: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuActualSize: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuFitWidth: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuFitHeight: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuAbout: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
}

declare global {
    interface Window {electronAPI: IElectronAPI;}
}

export {};
