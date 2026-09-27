import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';

import * as v from 'valibot';

const finiteNumber = v.pipe(v.number(), v.finite());
const nativeNetpbmProbeSchema = v.object({
    magic: v.picklist([
        'P4',
        'P5',
        'P6',
    ]),
    width: finiteNumber,
    height: finiteNumber,
    dataOffset: finiteNumber,
    nonWhiteRatio: finiteNumber,
    darkRatio: finiteNumber,
    colorRatio: finiteNumber,
    maxDarkRunRatio: finiteNumber,
    minChannel: finiteNumber,
    maxChannel: finiteNumber,
    blackRatio: finiteNumber,
    maxBlackRunRatio: finiteNumber,
    dominantColor: v.tuple([
        v.pipe(v.number(), v.integer()),
        v.pipe(v.number(), v.integer()),
        v.pipe(v.number(), v.integer()),
    ]),
});

type INativeNetpbmProbe = v.InferOutput<typeof nativeNetpbmProbeSchema>;

function parseNativeNetpbmProbe(value: unknown): INativeNetpbmProbe {
    if (!value || typeof value !== 'object') {
        throw new Error('Native Netpbm probe returned an invalid payload');
    }
    const parsed = v.safeParse(nativeNetpbmProbeSchema, value, {abortEarly: true});
    if (parsed.success) {
        return parsed.output;
    }
    const dominantColorIssue = parsed.issues[0]?.path?.some(path => path.key === 'dominantColor') === true;
    throw new Error(dominantColorIssue
        ? 'Native Netpbm probe returned an invalid dominant color'
        : 'Native Netpbm probe returned invalid metrics');
}

export async function probeNativeNetpbm(binaryPath: string | null, path: string) {
    if (!binaryPath) {
        return null;
    }
    try {
        const result = await runNativeToolCommand(binaryPath, [
            '--probe-netpbm',
            path,
        ], {
            commandLabel: 'evb-pdf-image-combine(probe-netpbm)',
            maxStdoutBytes: 64 * 1024,
            rejectOnStdoutTruncation: true,
            timeoutMs: 60_000,
        });
        return parseNativeNetpbmProbe(JSON.parse(result.stdout));
    } catch (error) {
        if (process.env.VITEST === 'true') {
            return null;
        }
        throw error;
    }
}
