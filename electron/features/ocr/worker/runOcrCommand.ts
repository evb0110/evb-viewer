import {
    runNativeToolCommand,
    type IRunNativeToolCommandOptions,
} from '@electron/native-tools/runNativeToolCommand';
import type { IRunCommandResult } from '@electron/ocr/worker/types';

export type TOcrRunCommandOptions = IRunNativeToolCommandOptions;

export async function runOcrCommand(
    command: string,
    args: string[],
    options: TOcrRunCommandOptions = {},
): Promise<IRunCommandResult> {
    return runNativeToolCommand(command, args, options);
}
