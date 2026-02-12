import type { TWorkerLog } from '@electron/ocr/worker/types';
import { runCommand } from '@electron/ocr/worker/run-command';

export async function detectSourceDpi(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TWorkerLog,
): Promise<number | null> {
    if (!pdfimagesBinary) {
        return null;
    }

    try {
        const result = await runCommand(pdfimagesBinary, [
            '-list',
            pdfPath,
        ]);
        const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length <= 1) {
            return null;
        }

        let best = 0;
        for (const line of lines.slice(1)) {
            const parts = line.split(/\s+/);
            if (parts.length < 14) {
                continue;
            }
            const xPpi = parseInt(parts[12] ?? '', 10);
            const yPpi = parseInt(parts[13] ?? '', 10);
            const dpi = Math.max(
                Number.isFinite(xPpi) ? xPpi : 0,
                Number.isFinite(yPpi) ? yPpi : 0,
            );
            if (dpi > best) {
                best = dpi;
            }
        }

        if (best > 0) {
            return best;
        }
    } catch (err) {
        log('debug', `pdfimages detection failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return null;
}

export function clampDpi(value: number) {
    if (!Number.isFinite(value)) {
        return 300;
    }
    return Math.min(1200, Math.max(72, Math.round(value)));
}
