import { te } from '@electron/te';

export const MAX_OPEN_INPUT_PATHS = 512;
export const MAX_COMBINE_INPUT_PATHS = Number.MAX_SAFE_INTEGER;

export function assertOpenInputPathCount(
    paths: readonly unknown[],
    maxPaths = MAX_OPEN_INPUT_PATHS,
) {
    if (paths.length > maxPaths) {
        throw new Error(te('errors.file.invalid'));
    }
}
