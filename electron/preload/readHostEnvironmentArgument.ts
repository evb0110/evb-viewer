import {HOST_ENVIRONMENT_ARGUMENT_PREFIX, decodePreloadHostEnvironmentSnapshot} from '@electron/preload/preloadDecoders';
import {readStartupArgumentJson} from '@electron/preload/readStartupArgumentJson';

export function readHostEnvironmentArgument(argv: readonly string[] = process.argv) {
    return decodePreloadHostEnvironmentSnapshot(readStartupArgumentJson(HOST_ENVIRONMENT_ARGUMENT_PREFIX, argv));
}
