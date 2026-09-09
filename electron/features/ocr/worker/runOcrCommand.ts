import {
    runNativeToolCommand,
    type IRunNativeToolCommandOptions,
} from '@electron/native-tools/runNativeToolCommand';
import type { IRunCommandResult } from '@electron/ocr/worker/types';
import {getOcrNativeChildRegistrationProvider} from '@electron/features/ocr/worker/nativeChildRegistration';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';

export type TOcrRunCommandOptions = IRunNativeToolCommandOptions;

export async function runOcrCommand(
    command: string,
    args: string[],
    options: TOcrRunCommandOptions = {},
): Promise<IRunCommandResult> {
    const provider = getOcrNativeChildRegistrationProvider();
    if (!provider || options.signal?.aborted) {
        return runNativeToolCommand(command, args, options);
    }

    const registration = await provider.prepare(options.commandLabel ?? command);
    let spawned = false;
    let registerPromise: Promise<void> | null = null;
    const runOptions: TOcrRunCommandOptions = {
        ...options,
        onSpawn: (pid) => {
            spawned = true;
            registerPromise = registration.register(pid);
            options.onSpawn?.(pid);
        },
    };

    const markSpawnedFailure = (error: unknown) => {
        registration.markUnproven(
            getUnprovenNativeTerminationDetail(error)
            ?? (error instanceof Error ? error.message : String(error)),
        );
    };

    try {
        const result = await runNativeToolCommand(command, args, runOptions);
        if (!spawned) {
            registration.markNoSpawn();
            return result;
        }
        try {
            await Promise.resolve(registerPromise);
            await registration.markExited();
        } catch (error) {
            markSpawnedFailure(error);
            throw error;
        }
        return result;
    } catch (error) {
        if (!spawned) {
            registration.markNoSpawn();
        } else {
            markSpawnedFailure(error);
        }
        throw error;
    }
}
