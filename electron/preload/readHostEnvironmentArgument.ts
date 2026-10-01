import {
    HOST_ENVIRONMENT_ARGUMENT_PREFIX,
    decodeHostEnvironmentSnapshot,
} from '@contracts/hostPlatformFeature';
import { readStartupArgumentJson } from '@electron/preload/readStartupArgumentJson';

export function readHostEnvironmentArgument(
    argv: readonly string[] = process.argv,
) {
    return decodeHostEnvironmentSnapshot(
        readStartupArgumentJson(HOST_ENVIRONMENT_ARGUMENT_PREFIX, argv),
    );
}
