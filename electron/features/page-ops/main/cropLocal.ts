import type { ICropMargins } from '@contracts/shared';
import { normalizeCropMargins } from '@contracts/shared';
import {
    tryCropPagesWithNativePageOps,
    tryRemoveCropWithNativePageOps,
    assertPageOpsLocalFallbackAllowed,
} from '@electron/features/page-ops/main/nativeCrop';
import { PdfPageOpsCapabilityError } from '@electron/features/page-ops/main/pageOpsErrors';

function throwNativePageOperationDeclined(operation: string): never {
    throw new PdfPageOpsCapabilityError(
        'native-failure',
        `Native page operation ${operation} did not produce a result`,
        {operation},
    );
}

export async function cropPagesLocal(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    signal?: AbortSignal,
) {
    const normalizedMargins = normalizeCropMargins(margins);

    if (await tryCropPagesWithNativePageOps(workingCopyPath, pages, normalizedMargins, signal)) {
        return;
    }

    await assertPageOpsLocalFallbackAllowed(workingCopyPath, 'crop', signal);
    throwNativePageOperationDeclined('crop');
}

export async function removeCropFromPagesLocal(
    workingCopyPath: string,
    pages: number[],
    signal?: AbortSignal,
) {
    if (await tryRemoveCropWithNativePageOps(workingCopyPath, pages, signal)) {
        return;
    }

    await assertPageOpsLocalFallbackAllowed(workingCopyPath, 'remove-crop', signal);
    throwNativePageOperationDeclined('remove-crop');
}
