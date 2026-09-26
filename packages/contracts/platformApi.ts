import type { IAgentCapability } from '@contracts/agentPlatformFeature';
import type { IDjvuCapability } from '@contracts/djvuPlatformFeature';
import type {
    IDocumentsFileIoCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import type { IHostCapability } from '@contracts/hostPlatformFeature';
import type { IOcrCapability } from '@contracts/ocrPlatformFeature';
import type { IScanCleanupCapability } from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import type { IImageExportCapability } from '@contracts/imageExportPlatformFeature';
import type { IPageOpsCapability } from '@contracts/pageOpsPlatformFeature';
import type { ISearchCapability } from '@contracts/searchPlatformFeature';
import type { ISettingsCapability } from '@contracts/settingsPlatformFeature';
import type { IShellCapability } from '@contracts/shellPlatformFeature';
import type { ISystemCapability } from '@contracts/systemPlatformFeature';
import type { IUpdatesCapability } from '@contracts/updatesPlatformFeature';
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';
export type { IImageExportCapability } from '@contracts/imageExportPlatformFeature';
export type { IAgentCapability } from '@contracts/agentPlatformFeature';
export type { IDjvuCapability } from '@contracts/djvuPlatformFeature';
export type { IOcrCapability } from '@contracts/ocrPlatformFeature';
export type { IScanCleanupCapability } from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
export type { IPageOpsCapability } from '@contracts/pageOpsPlatformFeature';
export type * from '@contracts/platformApiDescriptor';
export {
    getPlatformMethodDescriptor,
    PLATFORM_API_DESCRIPTOR,
} from '@contracts/platformApiDescriptor';

export interface IPlatformApi {
    documentPicker: IDocumentsPickerCapability;
    documentOpen: IDocumentsOpenCapability;
    documentWorkingCopy: IDocumentsWorkingCopyCapability;
    documentFiles: IDocumentsFileIoCapability;
    documentPdf: IDocumentsPdfCapability;
    documentRecentFiles: IDocumentsRecentFilesCapability;
    documentWindow: IDocumentsWindowCapability;
    documentMenu: IDocumentsMenuCapability;
    pageOps: IPageOpsCapability;
    imageExport: IImageExportCapability;
    ocr: IOcrCapability;
    scanCleanup?: IScanCleanupCapability;
    search: ISearchCapability;
    djvu: IDjvuCapability;
    settings: ISettingsCapability;
    system: ISystemCapability;
    updates?: IUpdatesCapability;
    windowTabs: IWindowTabsCapability;
    shell: IShellCapability;
    host: IHostCapability;
    agent: IAgentCapability;
}

export type { TDocumentRef } from '@contracts/documentRef';
export type * from '@contracts/platformUnsupported';
export type * from '@contracts/documentRevision';
export type * from '@contracts/shared';
export type * from '@contracts/geometry';
export type * from '@contracts/pageNumbers';
export type * from '@contracts/pdfPageLabels';
export type * from '@contracts/annotations';
export type * from '@contracts/agent';
export type * from '@contracts/agentPlatformFeature';
export type * from '@contracts/electronApiCommon';
export type * from '@contracts/electronApiDocuments';
export type * from '@contracts/electronApiDjvu';
export type * from '@contracts/hostPlatformFeature';
export type * from '@contracts/electronApiOcr';
export type * from '@contracts/ocrPlatformFeature';
export type * from '@contracts/scan-cleanup/electronApiScanCleanup';
export type * from '@contracts/electronApiPageOps';
export type * from '@contracts/systemPlatformFeature';
export type * from '@contracts/updatesPlatformFeature';
export type * from '@contracts/windowTabsPlatformFeature';
export * from '@contracts/hostResourceProfile';
export type * from '@contracts/searchPlatformFeature';
export type * from '@contracts/settingsPlatformFeature';
export type * from '@contracts/shellPlatformFeature';
export type * from '@contracts/pdfConformance';
