import {join} from 'node:path';
import type {IScanCleanupRunCommandOptions} from '@evb/scan-cleanup/core/types';
import {runCliNativeToolCommand} from '@scripts/scanCleanupCliAdapters';

async function identifyDimensions(
    magickBinary: string,
    inputPath: string,
    options: IScanCleanupRunCommandOptions,
) {
    const result = await runCliNativeToolCommand(
        magickBinary,
        [
            'identify',
            '-format',
            '%wx%h',
            inputPath,
        ],
        options,
    );
    const match = /^(\d+)x(\d+)$/u.exec(result.stdout.trim());
    if (!match) throw new Error(`Could not read image dimensions for ${inputPath}`);
    return {
        height: Number.parseInt(match[2]!, 10),
        width: Number.parseInt(match[1]!, 10),
    };
}

export async function flattenLayeredManifestPage(
    parts: string[],
    pageDirectory: string,
    magickBinary: string,
    options: IScanCleanupRunCommandOptions,
) {
    const kind = parts[0]!;
    const backgroundPath = parts[4]!;
    const dimensions = await identifyDimensions(magickBinary, backgroundPath, options);
    const size = `${String(dimensions.width)}x${String(dimensions.height)}!`;
    const isAffine = kind === 'affine-masked-layered-jpeg';
    const foregroundPath = isAffine ? parts[5] : undefined;
    const maskPath = isAffine ? parts[6]! : parts[5]!;
    const decode = isAffine ? parts[13] : undefined;
    const foregroundColor = kind === 'layered-color-jpeg'
        ? `rgb(${parts[6] ?? '0'},${parts[7] ?? '0'},${parts[8] ?? '0'})`
        : 'black';
    const layerPath = join(pageDirectory, 'foreground.png');
    const layerInputs = foregroundPath === undefined
        ? [
            '-size',
            `${String(dimensions.width)}x${String(dimensions.height)}`,
            `xc:${foregroundColor}`,
        ]
        : [
            foregroundPath,
            '-resize',
            size,
        ];
    const maskInputs = [
        maskPath,
        '-resize',
        size,
    ];
    if (decode === 'inverted') maskInputs.push('-negate');
    await runCliNativeToolCommand(magickBinary, [
        ...layerInputs,
        ...maskInputs,
        '-alpha',
        'off',
        '-compose',
        'CopyOpacity',
        '-composite',
        layerPath,
    ], options);
    const flattenedPath = join(pageDirectory, 'flattened.png');
    await runCliNativeToolCommand(magickBinary, [
        backgroundPath,
        layerPath,
        '-compose',
        'Over',
        '-composite',
        flattenedPath,
    ], options);
    return flattenedPath;
}
