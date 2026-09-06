import {
    HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX,
    decodeHostResourceProfileSnapshot,
} from '@contracts/hostResourceProfile';
import { decodeBase64UrlUtf8 } from '@electron/preload/decodeBase64UrlUtf8';

export function readHostResourceProfileArgument(
    argv: readonly string[] = process.argv,
) {
    const matchingArguments = argv.filter(argument =>
        argument.startsWith(HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX),
    );
    if (matchingArguments.length !== 1) {
        return null;
    }

    const encodedSnapshot = matchingArguments[0]!.slice(
        HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX.length,
    );
    const decodedJson = decodeBase64UrlUtf8(encodedSnapshot);
    if (decodedJson === null) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(decodedJson);
        return decodeHostResourceProfileSnapshot(parsed);
    } catch {
        return null;
    }
}
