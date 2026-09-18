import {
    WINDOWS_TEST_SCHEMA_VERSION,
    type IWindowsTestEvidenceEntry,
    type IWindowsTestEvidenceManifest,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    sha256Hex,
    sha256HexOfText,
    type IGuestFileSystem,
} from '@scripts/windows-test/guest/guestRuntime';
import { joinGuestPath } from '@scripts/windows-test/guest/guestPaths';

export async function buildEvidenceManifest(
    fs: IGuestFileSystem,
    runId: string,
    evidenceDir: string,
    separator: string,
): Promise<IWindowsTestEvidenceManifest> {
    // A code-unit sort keeps the manifest order, and so its sha256, identical
    // across guest locales and ICU builds.
    const relativePaths = [...await fs.listFilesRecursively(evidenceDir)]
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const entries: IWindowsTestEvidenceEntry[] = [];
    for (const relativePath of relativePaths) {
        const absolutePath = joinGuestPath(separator, evidenceDir, ...relativePath.split('/'));
        if (fs.fingerprint) {
            entries.push({
                relativePath,
                ...await fs.fingerprint(absolutePath),
            });
        } else {
            const bytes = await fs.readBytes(absolutePath);
            entries.push({
                relativePath,
                sha256: sha256Hex(bytes),
                bytes: bytes.byteLength,
            });
        }
    }
    return {
        schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
        runId,
        entries,
    };
}

export function serializeEvidenceManifest(manifest: IWindowsTestEvidenceManifest) {
    return `${JSON.stringify(manifest, null, 4)}\n`;
}

export function evidenceManifestSha256(manifest: IWindowsTestEvidenceManifest) {
    return sha256HexOfText(serializeEvidenceManifest(manifest));
}

export interface IBoundedLogState {
    truncated: boolean;
    bytes: number;
}

export interface IBoundedLog {
    append(line: string): void;
    state(): IBoundedLogState;
    text(): string;
}

export function createBoundedLog(maxBytes: number): IBoundedLog {
    const lines: string[] = [];
    let bytes = 0;
    let truncated = false;

    return {
        append: (line) => {
            if (truncated) {
                return;
            }
            const rendered = `${line}\n`;
            const renderedBytes = Buffer.byteLength(rendered, 'utf8');
            if (bytes + renderedBytes > maxBytes) {
                truncated = true;
                const marker = '[log truncated: bounded worker log limit reached]\n';
                lines.push(marker);
                bytes += Buffer.byteLength(marker, 'utf8');
                return;
            }
            bytes += renderedBytes;
            lines.push(rendered);
        },
        state: () => ({
            truncated,
            bytes,
        }),
        text: () => lines.join(''),
    };
}
