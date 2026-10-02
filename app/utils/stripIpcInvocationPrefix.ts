/**
 * A message as a person may read it: without the wrapper Electron puts around
 * an error thrown in the main process ("Error invoking remote method 'x':
 * Error: ...").
 */
export function stripIpcInvocationPrefix(message: string) {
    return message
        .replace(/^Error invoking remote method '[^']+':\s*/u, '')
        .replace(/^(?:Error:\s*)+/u, '')
        .trim();
}
