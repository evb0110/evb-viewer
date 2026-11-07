/* eslint-disable custom/file-naming -- Declaration must share deployVercelPrivate.mjs's filename. */
export interface IProductionDeployLock {
    (): Promise<void>;
    fd: number;
}

export function acquireProductionDeployLock(options: {
    env: NodeJS.ProcessEnv;
    projectId: string;
}): Promise<IProductionDeployLock>;

export function resolveViewerAppVersion(projectRoot: string): string;

export function shouldCopyPrivateDeployPath(
    sourcePath: string,
    projectRoot: string,
    deployTarget?: 'viewer' | 'landing',
    vendorDependencies?: Set<string>,
): boolean;
