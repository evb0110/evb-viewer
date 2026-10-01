// eslint-disable-next-line import-classic/no-restricted-paths -- Electron API contract reuses the aggregate API.
import type { IPlatformApi } from '@contracts/platformApi';
import type { IUpdatesCapability } from '@contracts/updatesPlatformFeature';
import type { IDiagnosticsRendererCapability } from '@contracts/diagnostics/diagnosticsPreference';
import type { IHostEnvironmentSnapshot } from '@contracts/hostPlatformFeature';

export type * from '@contracts/agent';
export type * from '@contracts/pdfConformance';
export type * from '@contracts/documentRevision';
export type * from '@contracts/electronApiCommon';
export type * from '@contracts/electronApiDocuments';
export type * from '@contracts/electronApiOcr';
export type * from '@contracts/ocrPlatformFeature';
export type * from '@contracts/agentPlatformFeature';
export type * from '@contracts/scan-cleanup/electronApiScanCleanup';
export type * from '@contracts/updatesPlatformFeature';
export type * from '@contracts/windowTabsPlatformFeature';
export type * from '@contracts/electronApiDjvu';
export type * from '@contracts/djvuPlatformFeature';
export type * from '@contracts/electronApiPageOps';
export type * from '@contracts/hostPlatformFeature';
export * from '@contracts/hostResourceProfile';
export type * from '@contracts/imageExportPlatformFeature';
export type * from '@contracts/pageOpsPlatformFeature';
export type * from '@contracts/searchPlatformFeature';
export type * from '@contracts/settingsPlatformFeature';
export type * from '@contracts/shellPlatformFeature';

export type IElectronAPI = IPlatformApi & {
    diagnostics: IDiagnosticsRendererCapability;
    /** The host main passed to this window at creation, readable before the first layout. */
    startupHostEnvironment: Readonly<IHostEnvironmentSnapshot> | null;
    updates: IUpdatesCapability;
};
