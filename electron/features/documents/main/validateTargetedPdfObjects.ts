import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import type { IRunNativeToolCommandOptions } from '@electron/native-tools/runNativeToolCommand';
import type { IProcessResult } from '@electron/native-tools/processResult';

type TRunNativeToolCommand = (
    command: string,
    args: string[],
    options?: IRunNativeToolCommandOptions,
) => Promise<IProcessResult>;

function qpdfObjectArgument(ref: string) {
    const match = /^(\d+) (\d+) R$/u.exec(ref);
    if (!match) {
        throw new Error(`Invalid changed PDF object reference: ${ref}`);
    }
    const objectNumber = match[1] ?? '<missing>';
    const generation = match[2] ?? '<missing>';
    return `--show-object=${objectNumber},${generation}`;
}

export async function validateTargetedPdfObjects(
    pdfPath: string,
    validationBinary: string,
    changedObjectRefs: readonly string[],
    run: TRunNativeToolCommand = runNativeToolCommand,
) {
    for (const ref of changedObjectRefs) {
        const result = await run(validationBinary, [
            qpdfObjectArgument(ref),
            pdfPath,
        ], {
            timeoutMs: 60_000,
            maxStdoutBytes: 256 * 1024,
            maxStderrBytes: 256 * 1024,
        });
        const output = result.stdout.trim();
        if (!output || output === 'null') {
            throw new Error(`Changed PDF object ${ref} is missing from the staged output xref`);
        }
    }
}
