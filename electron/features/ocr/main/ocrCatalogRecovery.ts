import {
    open,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {createIsoTimestamp} from '@contracts/timestamps';
import {isErrnoException} from '@contracts/runtimeGuards';
import {quarantineCorruptFile} from '@electron/utils/quarantineCorruptFile';

const OCR_CATALOG_RECOVERY_RECEIPT_VERSION = 1 as const;
const OCR_CATALOG_RECOVERY_RECEIPT_SUFFIX = '.recovery.json' as const;

export interface IOcrCatalogRecoveryReceipt {
    readonly version: typeof OCR_CATALOG_RECOVERY_RECEIPT_VERSION;
    readonly documentRevision: TDocumentRevisionToken;
    readonly detectedAt: string;
    readonly reason: string;
    readonly quarantinedPath: string | null;
}

async function syncDirectory(path: string) {
    const directory = await open(path, 'r');
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

export function getOcrCatalogRecoveryReceiptPath(catalogRoot: string): string {
    return `${catalogRoot}${OCR_CATALOG_RECOVERY_RECEIPT_SUFFIX}`;
}

function decodeRecoveryReceipt(value: unknown): IOcrCatalogRecoveryReceipt | null {
    if (!value || typeof value !== 'object'
        || !('version' in value)
        || value.version !== OCR_CATALOG_RECOVERY_RECEIPT_VERSION
        || !('documentRevision' in value)
        || typeof value.documentRevision !== 'string'
        || !('detectedAt' in value)
        || typeof value.detectedAt !== 'string'
        || !('reason' in value)
        || typeof value.reason !== 'string'
        || !('quarantinedPath' in value)
        || (typeof value.quarantinedPath !== 'string' && value.quarantinedPath !== null)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (!documentRevision) {
        return null;
    }
    return {
        version: OCR_CATALOG_RECOVERY_RECEIPT_VERSION,
        documentRevision,
        detectedAt: value.detectedAt,
        reason: value.reason,
        quarantinedPath: value.quarantinedPath,
    };
}

export async function readOcrCatalogRecoveryReceipt(
    catalogRoot: string,
): Promise<IOcrCatalogRecoveryReceipt | null> {
    let raw: string;
    try {
        raw = await readFile(getOcrCatalogRecoveryReceiptPath(catalogRoot), 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
    return decodeRecoveryReceipt(value);
}

export async function hasOcrCatalogRecoveryReceipt(
    catalogRoot: string,
    documentRevision: TDocumentRevisionToken,
): Promise<boolean> {
    return (await readOcrCatalogRecoveryReceipt(catalogRoot))?.documentRevision === documentRevision;
}

async function writeReceiptAtomically(
    receiptPath: string,
    receipt: IOcrCatalogRecoveryReceipt,
): Promise<void> {
    const temporaryPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, JSON.stringify(receipt), 'utf8');
        const file = await open(temporaryPath, 'r');
        try {
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporaryPath, receiptPath);
        await syncDirectory(dirname(receiptPath));
    } catch (error) {
        await rm(temporaryPath, {force: true});
        throw error;
    }
}

export async function quarantineOcrCatalog(
    catalogRoot: string,
    documentRevision: TDocumentRevisionToken,
    cause: unknown,
): Promise<IOcrCatalogRecoveryReceipt> {
    const quarantinedPath = await quarantineCorruptFile(catalogRoot);
    await syncDirectory(dirname(catalogRoot));
    const receipt: IOcrCatalogRecoveryReceipt = {
        version: OCR_CATALOG_RECOVERY_RECEIPT_VERSION,
        documentRevision,
        detectedAt: createIsoTimestamp(),
        reason: cause instanceof Error ? cause.message : String(cause),
        quarantinedPath,
    };
    await writeReceiptAtomically(getOcrCatalogRecoveryReceiptPath(catalogRoot), receipt);
    return receipt;
}

export async function clearOcrCatalogRecoveryReceipt(catalogRoot: string): Promise<void> {
    await rm(getOcrCatalogRecoveryReceiptPath(catalogRoot), {force: true});
    await syncDirectory(dirname(catalogRoot));
}
