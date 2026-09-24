import type {IpcRenderer} from 'electron';
import type {
    IDocumentsFileCapability,
    IDocumentsMenuCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
} from '@contracts/electronApiDocuments';
import type { IDocxExportFileCapability } from '@contracts/docxExport';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';

type TDocumentsMigratedMethod =
    | keyof IDocumentsMenuCapability
    | keyof IDocumentsPickerCapability
    | keyof IDocumentsRecentFilesCapability
    | keyof IDocumentsWindowCapability;
type TDocumentsOptionalDirectMethod =
    | 'createCombinedPdfFromFiles';

export function createDocumentsPreloadClient(
    ipcRenderer: IpcRenderer,
): Omit<IDocumentsFileCapability, TDocumentsMigratedMethod>
    & Partial<Pick<IDocumentsFileCapability, TDocumentsOptionalDirectMethod>>
    & IDocxExportFileCapability {
    return createDocumentsPreloadFileClient(ipcRenderer);
}
