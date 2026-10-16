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
    // A hard stencil is a PBM whose black pixels are ink, and CopyOpacity reads
    // black as transparent, so it is inverted to opacity. Soft alpha is already
    // white-opaque. An affine mask is inverted only when its decode says so.
    const invertsMask = kind === 'layered-jpeg' || kind === 'layered-color-jpeg' || decode === 'inverted';
    // ImageMagick operators apply to every image on the stack, so the mask is a
    // parenthesised sub-stack: negating it must not invert the foreground layer.
    const maskInputs = [
        '(',
        maskPath,
        '-resize',
        size,
        ...(invertsMask ? ['-negate'] : []),
        ')',
    ];
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
