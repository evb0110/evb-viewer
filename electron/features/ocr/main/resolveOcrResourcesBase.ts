import { resolveNativeResourcesBase } from '@electron/native-tools/resolveNativeResourcesBase';

export function resolveOcrResourcesBase(
    moduleDir: string,
    isPackaged: boolean,
) {
    return resolveNativeResourcesBase(moduleDir, isPackaged, {expectedResourceNames: ['tesseract']});
}
