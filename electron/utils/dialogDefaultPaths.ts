import {app} from 'electron';
import {runtimeConfig} from '@electron/runtimeConfig';

export function getDocumentsDialogDefaultPath() {
    return app.getPath('documents');
}

/**
 * Automation sessions have no one to answer a native save dialog. An isolated
 * automation profile may name the destination up front instead; ordinary runs
 * always show the dialog.
 */
export function getAutomationSaveDialogPath() {
    if (!runtimeConfig.automationUserDataDir) {
        return null;
    }
    const targetPath = runtimeConfig.test.e2eSaveDialogPath ?? '';
    return targetPath.length > 0 ? targetPath : null;
}
