import { randomUUID } from 'node:crypto';
import {
    open,
    rename,
    rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { TDjvuCompactFidelityPreset } from '@contracts/djvuConversionPolicy';

const COMPACT_FIDELITY = {
    small: {
        backgroundQuality: 70,
        photoQuality: 75,
        ppiCap: 180,
    },
    balanced: {
        backgroundQuality: 80,
        photoQuality: 85,
        ppiCap: 300,
    },
    archival: {
        backgroundQuality: 95,
        photoQuality: 95,
        ppiCap: 1200,
    },
} as const;

export function getCompactDjvuFidelity(preset: TDjvuCompactFidelityPreset | undefined) {
    return COMPACT_FIDELITY[preset ?? 'balanced'];
}

interface ICompactDjvuFidelityPage {
    pageNumber: number;
    kind: string;
    reason: string;
    effectivePpi: number;
    jpegQuality?: number;
}

export interface ICompactDjvuFidelityManifestWriter {
    append(pages: readonly ICompactDjvuFidelityPage[]): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
}

function serializePage(page: ICompactDjvuFidelityPage) {
    const {
        pageNumber,
        kind,
        reason,
        effectivePpi,
        jpegQuality,
    } = page;
    return JSON.stringify({
        pageNumber,
        kind,
        reason,
        effectivePpi,
        ...(jpegQuality === undefined ? {} : {jpegQuality}),
    });
}

export async function openCompactDjvuFidelityManifestWriter(
    tempDir: string,
    preset: TDjvuCompactFidelityPreset | undefined,
): Promise<ICompactDjvuFidelityManifestWriter> {
    const destination = join(tempDir, 'compact-fidelity.json');
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'w');
    let firstPage = true;
    let closed = false;
    try {
        await handle.write(`{"version":1,"preset":${JSON.stringify(preset ?? 'balanced')},"pages":[`);
        return {
            async append(pages) {
                if (closed) {
                    throw new Error('Compact DjVu fidelity manifest writer is closed');
                }
                for (const page of pages) {
                    await handle.write(`${firstPage ? '' : ','}${serializePage(page)}`);
                    firstPage = false;
                }
            },
            async close() {
                if (closed) {
                    return;
                }
                closed = true;
                try {
                    await handle.write(']}');
                    await handle.sync();
                    await handle.close();
                    await rename(temporary, destination);
                } catch (error) {
                    await handle.close().catch(() => undefined);
                    await rm(temporary, {force: true});
                    throw error;
                }
            },
            async abort() {
                if (closed) {
                    return;
                }
                closed = true;
                await handle.close().catch(() => undefined);
                await rm(temporary, {force: true});
            },
        };
    } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporary, {force: true});
        throw error;
    }
}
