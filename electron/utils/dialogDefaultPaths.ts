import { app } from 'electron';
import { dirname } from 'path';

export function getDocumentsDialogDefaultPath() {
    return app.getPath('documents');
}

export function getWorkingCopyDialogDefaultPath(workingCopyPath: string) {
    return dirname(workingCopyPath);
}

/**
 * Automation sessions have no one to answer a native save dialog. An isolated
 * automation profile may name the destination up front instead; ordinary runs
 * always show the dialog.
 */
export function getAutomationSaveDialogPath() {
    if (!process.env.EVB_AUTOMATION_USER_DATA_DIR) {
        return null;
    }
    const targetPath = process.env.EVB_E2E_SAVE_DIALOG_PATH?.trim() ?? '';
    return targetPath.length > 0 ? targetPath : null;
}
