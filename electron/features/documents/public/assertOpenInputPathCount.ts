import { te } from '@electron/te';
import {MAX_OPEN_INPUT_PATHS} from '@pdf-core/documentOpenFileTypes';

export {MAX_OPEN_INPUT_PATHS};
export const MAX_COMBINE_INPUT_PATHS = Number.MAX_SAFE_INTEGER;

export function assertOpenInputPathCount(
    paths: readonly unknown[],
    maxPaths = MAX_OPEN_INPUT_PATHS,
) {
    if (paths.length > maxPaths) {
        throw new Error(te('errors.file.invalid'));
    }
}
