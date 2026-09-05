import type { TTranslateFn } from '@i18n-app';
import type { TDocumentRef } from '@contracts/documentRef';
import {isBrowserFilePickerSetupDeniedError} from '@app/platform/browser-api/public';
import {getDocumentRefBaseName} from '@app/utils/documentRef';

export function classifyDocumentOpenError(
    error: unknown,
    path: TDocumentRef | null,
    t: TTranslateFn,
) {
    if (isBrowserFilePickerSetupDeniedError(error)) {
        return t('errors.browser.filePickerSetupDenied');
    }
    const rawMessage = error instanceof Error ? error.message : '';
    if (rawMessage && /ENOENT|could not be found|no such file|chunk missing|does not exist/i.test(rawMessage)) {
        const baseName = path ? getDocumentRefBaseName(path) : '';
        const name = baseName && baseName.length > 0 ? baseName : path ? String(path) : '';
        return t('errors.file.openNotFound', {name});
    }
    return rawMessage || t('errors.file.open');
}
