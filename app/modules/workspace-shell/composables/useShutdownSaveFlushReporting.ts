import type {ComputedRef, Ref} from 'vue';
import {tryOnScopeDispose, useEventListener} from '@vueuse/core';
import type {TDocumentRef} from '@contracts/documentRef';
import type {IShutdownSaveFlushResponse, ISystemCapability} from '@contracts/systemPlatformFeature';
import {getSystemCapability} from '@app/utils/getSystemCapability';
import {BrowserLogger} from '@app/utils/browserLogger';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IShutdownSaveFlushReportingDeps {
    workingCopyPath: TReadableRef<TDocumentRef | null>;
    hasPendingUnsavedChanges: TReadableRef<boolean>;
    flushAdditionalState?: () => Promise<void> | void;
    systemCapability?: Pick<ISystemCapability, 'onShutdownSaveFlushRequest'>;
}

export function preventBrowserUnloadWhenDirty(event: BeforeUnloadEvent, hasPendingUnsavedChanges: boolean) {
    if (!hasPendingUnsavedChanges) {
        return false;
    }

    event.preventDefault();
    return true;
}

export const useBrowserDirtyUnloadGuard = (hasPendingUnsavedChanges: () => boolean) => {
    const targetWindow = typeof window === 'undefined' ? undefined : window;
    if (!targetWindow) {
        return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        preventBrowserUnloadWhenDirty(event, hasPendingUnsavedChanges());
    };
    watch(
        hasPendingUnsavedChanges,
        (isDirty, _, onCleanup) => {
            if (!isDirty) {
                return;
            }
            onCleanup(useEventListener(targetWindow, 'beforeunload', handleBeforeUnload));
        },
        {immediate: true},
    );
};

export const useShutdownSaveFlushReporting = (deps: IShutdownSaveFlushReportingDeps) => {
    const systemCapability = deps.systemCapability ?? getSystemCapability();
    const unsubscribe = systemCapability.onShutdownSaveFlushRequest(async (): Promise<IShutdownSaveFlushResponse> => {
        const capturedWorkingCopyPath = deps.workingCopyPath.value;
        await deps.flushAdditionalState?.();
        if (!capturedWorkingCopyPath || !deps.hasPendingUnsavedChanges.value) {
            return {};
        }
        BrowserLogger.info('workspace', 'Leaving dirty document for checkpoint recovery during shutdown', {
            workingCopyPath: capturedWorkingCopyPath,
        });
        return {dirtyWorkingCopyPaths: [capturedWorkingCopyPath]};
    });

    tryOnScopeDispose(unsubscribe);
    return unsubscribe;
};
