import {
    DIAGNOSTICS_POLICY_ARGUMENT_PREFIX,
    createDiagnosticsStartupPolicy,
    type IDiagnosticsStartupPolicy,
} from '@electron/platform-ipc/coreContract';
import { decodeBase64UrlUtf8 } from '@electron/preload/decodeBase64UrlUtf8';

export function readDiagnosticsPolicyArgument(
    argv: readonly string[] = process.argv,
): Readonly<IDiagnosticsStartupPolicy> {
    const matchingArguments = argv.filter(argument => argument.startsWith(DIAGNOSTICS_POLICY_ARGUMENT_PREFIX));
    if (matchingArguments.length !== 1) {
        return createDiagnosticsStartupPolicy('unknown');
    }

    const encoded = matchingArguments[0]!.slice(DIAGNOSTICS_POLICY_ARGUMENT_PREFIX.length);
    const decodedJson = decodeBase64UrlUtf8(encoded);
    if (decodedJson === null) {
        return createDiagnosticsStartupPolicy('unknown');
    }

    try {
        const parsed: unknown = JSON.parse(decodedJson);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
            || Reflect.ownKeys(parsed).length !== 1
            || !Object.hasOwn(parsed, 'mode')) {
            return createDiagnosticsStartupPolicy('unknown');
        }
        return createDiagnosticsStartupPolicy((parsed as {mode?: unknown}).mode);
    } catch {
        return createDiagnosticsStartupPolicy('unknown');
    }
}
