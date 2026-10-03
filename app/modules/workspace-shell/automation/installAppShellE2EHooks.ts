import type { TTabMemoryPolicy } from '@contracts/shared';
import {
    workspaceSurfaceBudgetController,
    type IWorkspaceSurfaceBudgetSnapshot,
    type TWorkspaceResourcePressureLevel,
} from '@app/modules/document-viewer/public';
import { getPerformanceProfile } from '@app/utils/performanceProfile';

interface IAppShellE2EHookBindings {setTabMemoryPolicy: (policy: TTabMemoryPolicy) => void;}

type TAppShellE2EWindow = Window & {
    __getPdfRasterProfileForE2E?: () => {maxBufferCanvasPixels: number};
    __getWorkspaceSurfaceBudgetForE2E?: () => IWorkspaceSurfaceBudgetSnapshot;
    __setTabMemoryPolicyForE2E?: (policy: TTabMemoryPolicy) => void;
    __setWorkspaceSurfacePressureForE2E?: (level: TWorkspaceResourcePressureLevel) => void;
};

export function installAppShellE2EHooks(bindings: IAppShellE2EHookBindings) {
    const target = window as TAppShellE2EWindow;
    target.__getWorkspaceSurfaceBudgetForE2E = () => workspaceSurfaceBudgetController.getSnapshot();
    target.__getPdfRasterProfileForE2E = () => ({maxBufferCanvasPixels: getPerformanceProfile().maxBufferCanvasPixels});
    target.__setWorkspaceSurfacePressureForE2E = level => workspaceSurfaceBudgetController.setPressureLevel(level);
    target.__setTabMemoryPolicyForE2E = bindings.setTabMemoryPolicy;

    return () => {
        delete target.__getWorkspaceSurfaceBudgetForE2E;
        delete target.__getPdfRasterProfileForE2E;
        delete target.__setWorkspaceSurfacePressureForE2E;
        delete target.__setTabMemoryPolicyForE2E;
    };
}
