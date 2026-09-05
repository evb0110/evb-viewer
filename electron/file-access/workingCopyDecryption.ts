import {
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import {
    isPdfDecryptPassword,
    PDF_DECRYPT_PASSWORD_MAX_BYTES,
    type TPdfDecryptFailureOutcome,
} from '@contracts/pdfDecryptSchemas';
import { hasNativeErrorCode } from '@contracts/nativeErrors';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {createManagedScratchTempDir} from '@electron/utils/managedScratchTemp';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public/nativePageOpsPath';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getErrorMessage } from '@electron/utils/error';
import { isRecord } from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';

const DECRYPT_TIMEOUT_MS = 2 * 60 * 1000;
const logger = createLogger('working-copy-decryption');

export type TWorkingCopyDecryptionResult =
    | {
        outcome: 'plain';
        wasEncrypted: false;
        revision: null;
    }
    | {
        outcome: 'decrypted';
        wasEncrypted: true;
        revision: number | null;
    }
    | {
        outcome: 'needs-password';
        wasEncrypted: true;
        revision: null;
    }
    | {
        outcome: 'unsupported';
        wasEncrypted: true;
        revision: null;
    };

interface IDecryptOutcomeSidecar {
    format: 'evb-pdf-decrypt';
    schemaVersion: 1;
    outcome: 'opened' | 'rewritten';
    wasEncrypted: boolean;
    revision: number | null;
}

/** Error used only inside the main-process open attempt. */
export class PdfDecryptAttemptError extends Error {
    readonly outcome: TPdfDecryptFailureOutcome;

    constructor(outcome: TPdfDecryptFailureOutcome) {
        super(outcome);
        this.name = 'PdfDecryptAttemptError';
        this.outcome = outcome;
    }
}

function parseOutcomeSidecar(value: unknown): IDecryptOutcomeSidecar {
    if (!isRecord(value)
        || value.format !== 'evb-pdf-decrypt'
        || value.schemaVersion !== 1
        || (value.outcome !== 'opened' && value.outcome !== 'rewritten')
        || typeof value.wasEncrypted !== 'boolean'
        || (value.revision !== null
            && (typeof value.revision !== 'number'
                || !Number.isSafeInteger(value.revision)
                || value.revision <= 0))) {
        throw new Error('Native PDF decrypt returned an invalid outcome receipt');
    }
    if (value.outcome === 'opened' && (value.wasEncrypted || value.revision !== null)) {
        throw new Error('Native PDF decrypt returned an inconsistent plain outcome');
    }
    if (value.outcome === 'rewritten' && (!value.wasEncrypted || value.revision === null)) {
        throw new Error('Native PDF decrypt returned an inconsistent rewritten outcome');
    }
    return {
        format: 'evb-pdf-decrypt',
        schemaVersion: 1,
        outcome: value.outcome,
        wasEncrypted: value.wasEncrypted,
        revision: value.revision ?? null,
    };
}

function failureOutcome(error: unknown): TPdfDecryptFailureOutcome | null {
    if (!hasNativeErrorCode(error)) {
        return null;
    }
    if (error.code === 'needs-password') {
        return 'needs-password';
    }
    if (error.code === 'unsupported-filter' || error.code === 'encrypted') {
        return 'unsupported-encryption';
    }
    return null;
}

function assertPasswordSize(password: string) {
    if (!isPdfDecryptPassword(password)) {
        throw new Error(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
    }
}

/**
 * Runs the native writer against a disposable working copy. The input is
 * never used as the output, so a failed password attempt cannot replace the
 * encrypted source. Password contents live only in a managed scratch file.
 */
export async function decryptWorkingCopyWithWriter(
    workingPath: string,
    password?: string,
    signal?: AbortSignal,
): Promise<TWorkingCopyDecryptionResult> {
    if (typeof password === 'string') {
        assertPasswordSize(password);
    }
    if (isNativePageOpsDisabled()) {
        throw new Error('Native PDF decrypt operation is disabled');
    }
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native PDF decrypt operation is unavailable');
    }

    const scratchPath = await createManagedScratchTempDir('pdf-page-ops-');
    const outputPath = join(scratchPath, 'decrypted.pdf');
    const sidecarPath = `${outputPath}.decrypt.json`;
    let passwordPath: string | undefined;
    try {
        if (password !== undefined) {
            passwordPath = join(scratchPath, 'password.txt');
            await writeFile(passwordPath, `${password}\n`, {
                encoding: 'utf8',
                mode: 0o600,
            });
        }
        const args = [
            'decrypt',
            '--input',
            workingPath,
            '--output',
            outputPath,
            ...(passwordPath === undefined ? [] : [
                '--password-file',
                passwordPath,
            ]),
        ];
        try {
            await runNativeToolCommand(binaryPath, args, {
                timeoutMs: DECRYPT_TIMEOUT_MS,
                commandLabel: 'evb-pdf-page-ops(decrypt)',
                ...(signal === undefined ? {} : {signal}),
            });
        } catch (error) {
            const outcome = failureOutcome(error);
            if (outcome) {
                return {
                    outcome: outcome === 'unsupported-encryption' ? 'unsupported' : outcome,
                    wasEncrypted: true,
                    revision: null,
                };
            }
            throw error;
        }

        const receipt = parseOutcomeSidecar(JSON.parse(await readFile(sidecarPath, 'utf8')));
        if (receipt.outcome === 'opened') {
            return {
                outcome: 'plain',
                wasEncrypted: false,
                revision: null,
            };
        }
        await stat(outputPath);
        await atomicReplace(outputPath, workingPath, {markMutationCommitStarted: false});
        return {
            outcome: 'decrypted',
            wasEncrypted: true,
            revision: receipt.revision,
        };
    } catch (error) {
        const outcome = failureOutcome(error);
        if (outcome) {
            throw new PdfDecryptAttemptError(outcome);
        }
        throw error instanceof Error
            ? error
            : new Error(`Native PDF decrypt failed: ${getErrorMessage(error)}`);
    } finally {
        await rm(scratchPath, {
            recursive: true,
            force: true,
        }).catch(error => {
            logger.warn(`Failed to cleanup PDF decrypt scratch directory "${scratchPath}": ${getErrorMessage(error)}`);
        });
    }
}
