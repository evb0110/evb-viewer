import { decodeBase64UrlUtf8 } from '@electron/preload/decodeBase64UrlUtf8';

/**
 * Parses the one `<prefix><base64url JSON>` argument main passed to this
 * window at creation; null when it is absent, repeated or malformed. Callers
 * validate the result with the value's contract decoder.
 */
export function readStartupArgumentJson(
    prefix: string,
    argv: readonly string[] = process.argv,
): unknown {
    const matchingArguments = argv.filter(argument => argument.startsWith(prefix));
    if (matchingArguments.length !== 1) {
        return null;
    }

    const decodedJson = decodeBase64UrlUtf8(matchingArguments[0]!.slice(prefix.length));
    if (decodedJson === null) {
        return null;
    }

    try {
        return JSON.parse(decodedJson) as unknown;
    } catch {
        return null;
    }
}
