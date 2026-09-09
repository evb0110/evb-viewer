import { useEventListener } from '@vueuse/core';
import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    getDocumentPickerCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { isSupportedWorkspaceDocumentPath } from '@app/utils/supportedDocumentPaths';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getFailureReceipt,
    type ExpectedOutcome,
} from '@contracts/diagnostics/failureReceipt';
import { useFailureToast } from '@app/composables/useFailureToast';
import { isBrowserPlatformActive } from '@app/utils/platform';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';

interface IUseExternalFileDropOptions {
    openPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
    isEnabled?: Ref<boolean>;
}

function hasExternalFilePayload(dataTransfer: DataTransfer | null) {
    if (!dataTransfer) {
        return false;
    }
    return Array.from(dataTransfer.types).includes('Files');
}

function isSidebarDropArea(event: DragEvent) {
    if (typeof Element === 'undefined') {
        return false;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
        return false;
    }
    return Boolean(target.closest('.pdf-sidebar-pages-thumbnails'));
}

function isToolDropArea(event: DragEvent) {
    if (typeof Element === 'undefined') {
        return false;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
        return false;
    }
    return Boolean(target.closest('[data-combine-page]'));
}

async function getDroppedDocumentPaths(
    droppedFiles: File[],
    notifyRegistrationFailure: (error: unknown) => void,
    canRegister: () => boolean,
) {
    const paths: TDocumentRef[] = [];
    const ownedPaths = new Set<TDocumentRef>();
    const seen = new Set<TDocumentRef>();
    const documentPicker = getDocumentPickerCapability();

    for (const file of droppedFiles) {
        if (!canRegister()) {
            break;
        }

        let droppedPaths: Array<{
            path: TDocumentRef;
            owned: boolean
        }>;
        try {
            if (isBrowserPlatformActive()) {
                const registered = await browserDocumentStore.registerFileWithOwnership(file);
                droppedPaths = [{
                    path: registered.ref,
                    owned: registered.created,
                }];
            } else {
                droppedPaths = (await documentPicker.registerFilesForOpen([file]))
                    .map(path => ({
                        path,
                        owned: false,
                    }));
            }
        } catch (error) {
            notifyRegistrationFailure(error);
            continue;
        }

        for (const {
            path, owned,
        } of droppedPaths) {
            if (!path || seen.has(path)) {
                continue;
            }

            if (isSupportedWorkspaceDocumentPath(path)) {
                seen.add(path);
                paths.push(path);
                if (owned) {
                    ownedPaths.add(path);
                }
            } else {
                BrowserLogger.warn('external-file-drop', 'Dropped file type is unsupported', {
                    kind: 'expected',
                    code: 'unsupported-input',
                } satisfies ExpectedOutcome);
                await getDocumentWorkingCopyCapability().cleanupFile(path)
                    .catch(() => undefined);
            }
        }
    }

    return {
        paths,
        ownedPaths,
    };
}

export const useExternalFileDrop = (options: IUseExternalFileDropOptions) => {
    const {
        openPathsInAppropriateTab,
        isEnabled,
    } = options;
    const { t } = useTypedI18n();
    const { presentFailureToast } = useFailureToast();
    let queue: Promise<void> = Promise.resolve();
    let lifecycleToken = 0;
    let disposed = false;

    function notifyRegistrationFailure(error: unknown) {
        const failure = BrowserLogger.error(
            'external-file-drop',
            'Failed to register dropped file',
            error,
            getFailureReceipt(error) ?? {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            },
        );
        presentFailureToast({
            failure,
            title: t('errors.file.open'),
            description: getErrorMessage(error),
        });
    }

    async function processDroppedPaths(
        paths: TDocumentRef[],
        ownedPaths: Set<TDocumentRef>,
        tokenAtSchedule: number,
    ) {
        if (disposed || tokenAtSchedule !== lifecycleToken) {
            return;
        }

        try {
            await openPathsInAppropriateTab(paths);
        } catch (error) {
            await Promise.allSettled(Array.from(ownedPaths, path => (
                getDocumentWorkingCopyCapability().cleanupFile(path)
            )));
            throw error;
        }
    }

    function shouldHandleDropEvent(event: DragEvent) {
        if (disposed) {
            return false;
        }
        if (isEnabled && !isEnabled.value) {
            return false;
        }
        if (isSidebarDropArea(event)) {
            return false;
        }
        if (isToolDropArea(event)) {
            return false;
        }
        return hasExternalFilePayload(event.dataTransfer);
    }

    function enqueueDroppedFiles(files: File[]) {
        if (files.length === 0) {
            return;
        }

        const tokenAtSchedule = lifecycleToken;
        queue = queue
            .catch(() => {
                // Keep the queue flowing after a single file-open failure.
            })
            .then(async () => {
                const registration = await getDroppedDocumentPaths(
                    files,
                    notifyRegistrationFailure,
                    () => !disposed && tokenAtSchedule === lifecycleToken,
                );
                if (disposed || tokenAtSchedule !== lifecycleToken) {
                    await Promise.allSettled(Array.from(registration.ownedPaths, path => (
                        getDocumentWorkingCopyCapability().cleanupFile(path)
                    )));
                    return;
                }
                if (registration.paths.length === 0) {
                    return;
                }
                await processDroppedPaths(registration.paths, registration.ownedPaths, tokenAtSchedule);
            })
            .catch(error => {
                const failure = BrowserLogger.error(
                    'external-file-drop',
                    'Failed to process dropped files',
                    error,
                    getFailureReceipt(error) ?? {
                        code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                        context: {},
                    },
                );
                presentFailureToast({
                    failure,
                    title: t('errors.file.open'),
                    description: getErrorMessage(error),
                });
            });
    }

    const stopDragOver = useEventListener(typeof window !== 'undefined' ? window : undefined, 'dragover', (event: DragEvent) => {
        if (!shouldHandleDropEvent(event)) {
            return;
        }

        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
    }, { capture: true });

    const stopDrop = useEventListener(typeof window !== 'undefined' ? window : undefined, 'drop', (event: DragEvent) => {
        if (!shouldHandleDropEvent(event)) {
            return;
        }

        event.preventDefault();
        enqueueDroppedFiles(Array.from(event.dataTransfer?.files ?? []));
    }, { capture: true });

    function cleanup() {
        if (disposed) {
            return;
        }
        disposed = true;
        lifecycleToken += 1;
        queue = Promise.resolve();
        stopDragOver();
        stopDrop();
    }

    return { cleanup };
};
