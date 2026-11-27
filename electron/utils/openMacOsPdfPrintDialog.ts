import {runNativeCommand} from '@electron/native-tools/runNativeCommand';
import {resolveMacOsPdfPrintDialogBinary} from '@electron/utils/resolveMacOsPdfPrintDialogBinary';

const MACOS_PRINT_DIALOG_TIMEOUT_MS = 30 * 60_000;

interface IMacOsPdfPrintDialogResult {
    success: boolean;
    canceled?: boolean;
    error?: string;
}

export async function openMacOsPdfPrintDialog(
    pdfPath: string,
    options: {
        onNativeDialogOpened?: () => void;
        signal?: AbortSignal;
    } = {},
): Promise<IMacOsPdfPrintDialogResult> {
    const binary = resolveMacOsPdfPrintDialogBinary();
    const result = await runNativeCommand(binary, [pdfPath], {
        allowedExitCodes: [0, 2],
        commandLabel: 'pdf-print-dialog',
        maxStderrBytes: 64 * 1024,
        maxStdoutBytes: 64 * 1024,
        onSpawn: () => options.onNativeDialogOpened?.(),
        ...(options.signal ? {signal: options.signal} : {}),
        timeoutMs: MACOS_PRINT_DIALOG_TIMEOUT_MS,
    });
    return result.exitCode === 0
        ? {success: true}
        : {
              success: false,
              canceled: true,
              error: 'Print dialog canceled',
          };
}
