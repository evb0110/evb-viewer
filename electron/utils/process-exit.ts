interface IDescribeProcessExitCodeOptions {platform?: NodeJS.Platform;}

const WINDOWS_NTSTATUS_HINTS: Record<string, string> = {
    '0xC000007B': 'STATUS_INVALID_IMAGE_FORMAT (often caused by mixed 32/64-bit binaries or DLLs)',
    '0xC0000135': 'STATUS_DLL_NOT_FOUND (required DLL is missing)',
    '0xC0000142': 'STATUS_DLL_INIT_FAILED (a dependent DLL failed to initialize)',
};

function normalizeWindowsNtStatus(exitCode: number): number | null {
    const normalized = exitCode >>> 0;
    if (normalized <= 0x7FFFFFFF) {
        return null;
    }
    return normalized;
}

export function describeProcessExitCode(
    exitCode: number,
    options: IDescribeProcessExitCodeOptions = {},
): string {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') {
        return String(exitCode);
    }

    const ntStatus = normalizeWindowsNtStatus(exitCode);
    if (ntStatus === null) {
        return String(exitCode);
    }

    const hex = `0x${ntStatus.toString(16).toUpperCase().padStart(8, '0')}`;
    const hint = WINDOWS_NTSTATUS_HINTS[hex];
    if (hint) {
        return `${exitCode} (${hex} ${hint})`;
    }

    return `${exitCode} (${hex})`;
}
