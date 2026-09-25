import type {
    BrowserWindow,
    WebContents,
} from 'electron';
import type { TOpenPathOwner } from '@electron/features/documents/main/openPathOwner';

/** Sender facts each documents handler receives from its IPC binding. */
export interface IDocumentsWebContentsContext {
    sender: WebContents;
    senderId: number;
}

export interface IDocumentsDialogContext extends IDocumentsWebContentsContext { parentWindow: BrowserWindow | null; }

export interface IDocumentsSenderIdContext {
    sender?: WebContents;
    senderId?: number;
}

export interface IDocumentsWindowContext {
    onNativePrintDialogOpened?: (requestId: string) => void;
    senderId?: number;
    window: BrowserWindow | null;
}

export interface IDocumentsOpenPathContext { owner?: TOpenPathOwner; }
