import type { IWorkspaceOpenFailure } from '@app/types/workspaceExpose';

export type TStartSection = 'recent' | 'combine' | 'settings';

/** An open that failed on an empty tab, reported on Start. */
export interface IStartOpenFailure extends IWorkspaceOpenFailure {fileName: string | null;}
