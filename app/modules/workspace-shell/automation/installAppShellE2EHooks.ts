import type { TTabMemoryPolicy } from '@contracts/shared';
import {
    workspaceSurfaceBudgetController,
    type IWorkspaceSurfaceBudgetSnapshot,
    type TWorkspaceResourcePressureLevel,
} from '@app/modules/document-viewer/public';
import { getPerformanceProfile } from '@app/utils/performanceProfile';

type TEditorSplitDirection = 'left' | 'right' | 'up' | 'down';
type TEditorSplitHook = (direction: TEditorSplitDirection) => Promise<void> | void;

interface IAppShellE2EHookBindings {
    setTabMemoryPolicy: (policy: TTabMemoryPolicy) => void;
    splitEditorEmpty: TEditorSplitHook;
}

type TAppShellE2EWindow = Window & {
    __getPdfRasterProfileForE2E?: () => {maxBufferCanvasPixels: number};
    __getWorkspaceSurfaceBudgetForE2E?: () => IWorkspaceSurfaceBudgetSnapshot;
    __setTabMemoryPolicyForE2E?: (policy: TTabMemoryPolicy) => void;
    __setWorkspaceSurfacePressureForE2E?: (level: TWorkspaceResourcePressureLevel) => void;
    __splitEditorEmptyForE2E?: TEditorSplitHook;
};

export function installAppShellE2EHooks(bindings: IAppShellE2EHookBindings) {
    const target = window as TAppShellE2EWindow;
    target.__getWorkspaceSurfaceBudgetForE2E = () => workspaceSurfaceBudgetController.getSnapshot();
    target.__getPdfRasterProfileForE2E = () => ({maxBufferCanvasPixels: getPerformanceProfile().maxBufferCanvasPixels});
    target.__setWorkspaceSurfacePressureForE2E = level => workspaceSurfaceBudgetController.setPressureLevel(level);
    target.__setTabMemoryPolicyForE2E = bindings.setTabMemoryPolicy;
    target.__splitEditorEmptyForE2E = bindings.splitEditorEmpty;

    return () => {
        delete target.__getWorkspaceSurfaceBudgetForE2E;
        delete target.__getPdfRasterProfileForE2E;
        delete target.__setWorkspaceSurfacePressureForE2E;
        delete target.__setTabMemoryPolicyForE2E;
        delete target.__splitEditorEmptyForE2E;
    };
}
