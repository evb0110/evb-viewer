import { basename } from 'node:path';

// Poppler decodes font and content streams without a size limit, so a small
// crafted PDF can make it allocate many gigabytes (#1255). Each Poppler process
// is held to 4 GiB, several times the largest page any caller renders.
// Enforcement lives inside the native process supervisor (`evb-windows-job-launcher`):
// - Windows: Job Object `JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY`
// - Linux: `RLIMIT_DATA` in `pre_exec` plus zero-spawn `/proc` group accounting
// - macOS: zero-spawn `proc_pid_rusage` (`ri_phys_footprint`) in the `kqueue` loop
const POPPLER_TOOL_NAMES = new Set([
    'pdfimages',
    'pdfinfo',
    'pdftoppm',
    'pdftotext',
]);

export const POPPLER_MEMORY_LIMIT_BYTES = 4 * 1024 ** 3;

export function isPopplerTool(command: string) {
    return POPPLER_TOOL_NAMES.has(basename(command).replace(/\.exe$/iu, ''));
}

export function getNativeCommandMemoryLimitBytes(command: string) {
    return isPopplerTool(command) ? POPPLER_MEMORY_LIMIT_BYTES : undefined;
}
