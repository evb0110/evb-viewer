import {
    HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX,
    decodeHostResourceProfileSnapshot,
} from '@contracts/hostResourceProfile';
import { readStartupArgumentJson } from '@electron/preload/readStartupArgumentJson';

export function readHostResourceProfileArgument(
    argv: readonly string[] = process.argv,
) {
    return decodeHostResourceProfileSnapshot(
        readStartupArgumentJson(HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX, argv),
    );
}
