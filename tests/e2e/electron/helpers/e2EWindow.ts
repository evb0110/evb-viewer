import type {IPlatformApi} from '@contracts/platformApi';
import type {IElectronAPI} from '@contracts/electronApi';
import type {TDocumentRef} from '@contracts/documentRef';
import type {IEvbTestApi} from '@app/types/evbTestApi';

export interface IE2EWindow extends Window {
    __e2eOpenExternalCalls?: string[];
    __e2eOriginalOpenExternal?: IPlatformApi['shell']['openExternal'];
    __evbTestApi?: IEvbTestApi;
    __openFileDirect?: (path: TDocumentRef) => Promise<boolean>;
    electronAPI?: IElectronAPI;
}
