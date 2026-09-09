#!/usr/bin/env node

import { getCliErrorMessage } from '../lib/cli-error.mjs';
import {inflateSync} from 'node:zlib';
import {
    mkdtemp,
    mkdir,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    basename,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tsImport} from 'tsx/esm/api';
import {runDiagnosticCommand} from './scan-cleanup-command.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const {
    sha256ScanCleanupFile,
    verifyScanCleanupProvenanceStampHex,
} = await tsImport('../../scan-cleanup-core/index.ts', import.meta.url);
const {resolveCliNativeToolPath} = await tsImport('../scanCleanupCliAdapters.ts', import.meta.url);
const AUDIT_TOOL_CRATES = {
    qpdf: 'qpdf',
    pdftoppm: 'poppler',
    pdfinfo: 'poppler',
    pdfimages: 'poppler',
};
const auditToolPaths = new Map();
function resolveAuditTool(command) {
    const crate = AUDIT_TOOL_CRATES[command];
    if (crate === undefined) {
        return command;
    }
    let resolved = auditToolPaths.get(command);
    if (resolved === undefined) {
        const envOverride = command === 'pdfimages'
            ? process.env.EVB_PDFIMAGES_PATH
            : undefined;
        resolved = resolveCliNativeToolPath(command, crate, projectRoot, envOverride) ?? command;
        if (
            process.platform === 'win32'
            && command === 'pdfimages'
            && resolved.toLowerCase().endsWith('.mjs')
        ) {
            // CreateProcess does not dispatch .mjs files when shell execution is disabled.
            resolved = {
                args: [resolved],
                command: process.execPath,
            };
        }
        auditToolPaths.set(command, resolved);
    }
    return resolved;
}
const artifactDirectory = join(
    projectRoot,
    '.devkit/tasks/scan-cleanup/stage22-audit2',
);
const defaultOutputPath = join(
    artifactDirectory,
    'scan-cleanup-word-loss-audit.json',
);
const CROP_SCALE = 2197 / 2261;
const ALIGNMENT_RADIUS_FULL_PX = 160;
const ALIGNMENT_MIN_RELIABLE_OVERLAP = 0.4;
// Output-side support drops by definition when the cleaned page really does
// contain invented ink. A strong source-side match is therefore sufficient;
// otherwise require both directions to agree before classifying differences.
const ALIGNMENT_STRONG_SOURCE_OVERLAP = 0.75;
const QUARTER_DOWNSAMPLE = 4;
const BROAD_DOWNSAMPLE = 16;
const MAX_BROAD_ALIGNMENT_SAMPLES = 30_000;
const MAX_QUARTER_ALIGNMENT_SAMPLES = 30_000;
const MAX_FULL_ALIGNMENT_SAMPLES = 4_000;
const LOCAL_ALIGNMENT_RADIUS_FULL_PX = 8;
const MAX_COMPONENT_PIXELS_FOR_LOCAL_SEARCH = 50_000;
const SOURCE_SUPPORT_PAPER_DELTA = 0;
const SOURCE_SUPPORT_PERCENTILE = 0.75;
const INVENTED_UNSUPPORTED_AREA_FACTOR = 1;
// A mostly preserved component can acquire a connected unsupported fringe
// when a thin source rule is rotated or resampled onto a much finer output
// grid. Treat a component as invented only when the unsupported region is
// both physically material (the area gate below) and a material share of the
// component; standalone invented shapes remain 100% unsupported.
const INVENTED_MIN_UNSUPPORTED_FRACTION = 0.25;
const SILHOUETTE_MIN_SIZE_MM = 3;
const SILHOUETTE_COARSE_DOWNSAMPLE = 24;
const SILHOUETTE_COARSE_MAX_BBOX_PX = 600;
const SILHOUETTE_COARSE_MIN_BBOX_PX = 120;
const SILHOUETTE_COARSE_MIN_DARK_FRACTION = 0.1;
const SILHOUETTE_MIN_DIMENSION_FACTOR = 2;
const SILHOUETTE_SOURCE_MAX_LIGHT_FRACTION = 0.02;
const SILHOUETTE_SOURCE_MAX_DARK_FRACTION = 0.35;
const SILHOUETTE_SOURCE_MIN_MIDTONE_FRACTION = 0.6;
const SILHOUETTE_SOURCE_MAX_STANDARD_DEVIATION = 64;
// Permit one source-grid pixel of stencil tolerance for mapped bilevel or grayscale sources.
const MAPPED_STENCIL_MAX_DILATION_RADIUS = 8;
const GRAY_INK_THRESHOLD = 192;
const GRAY_MEAN_TOLERANCE = 112;
const GRAY_MIN_SHAPE_IOU = 0.28;
const GRAY_MIN_SHAPE_RECALL = 0.38;
const GRAY_EDGE_MIN_SHAPE_IOU = 0.06;
const GRAY_EDGE_MIN_SHAPE_RECALL = 0.15;
const GRAY_EDGE_MAX_MEAN = 245;
const BLACK_THRESHOLD = 128;
const RGB_SUPPORT_MAX_INK = 128;
const RGB_SUPPORT_MIN_PAPER_SEPARATION = 32;

function scaleLabel(scale) {
    if (typeof scale === 'object') {
        return scale.label;
    }
    if (scale === 1) {
        return '1.0';
    }
    if (Math.abs(scale - CROP_SCALE) < 1e-9) {
        return '2197/2261';
    }
    return `dimension-fit(${scale.toFixed(6)})`;
}

function parseArgs(argv) {
    const options = {
        cleaned: null,
        from: null,
        mapping: null,
        baseline: null,
        failOn: 'none',
        minArea: 24,
        out: defaultOutputPath,
        source: null,
        to: null,
        verifyStamp: false,
        workers: 4,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--' || argument === '') {
            continue;
        }
        if (argument === '--help' || argument === '-h') {
            console.log(`Usage: node scripts/diagnostics/scan-cleanup-word-loss-audit.mjs --source <pdf> --cleaned <pdf> [options]

Options:
  --source <pdf>       Source PDF with the original text smask
  --cleaned <pdf>      Cleaned MRC PDF to audit
  --mapping <summary>  Converter summary with source/output page mapping
  --from <page>        First PDF page (default: 1)
  --to <page>          Last PDF page (default: source page count)
  --out <json>         JSON report path (default: ${defaultOutputPath})
  --baseline <report>  Previous JSON report for regression comparison
  --fail-on <class>    Exit 1 for text-loss, silhouette, invented-ink, any, or none (default: none)
  --min-area <pixels>  Minimum source component area (default: 24)
  --verify-stamp       Verify the cleaned PDF's /EVBScanCleanup provenance stamp
  --workers <count>    Concurrent page workers (default: 4)`);
            return {
                ...options,
                help: true,
            };
        }
        const valueArguments = new Set([
            '--baseline',
            '--cleaned',
            '--fail-on',
            '--from',
            '--mapping',
            '--min-area',
            '--out',
            '--source',
            '--to',
            '--workers',
        ]);
        if (argument === '--verify-stamp') {
            options.verifyStamp = true;
            continue;
        }
        if (!valueArguments.has(argument)) {
            throw new Error(`Unknown argument: ${argument}`);
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing value for ${argument}`);
        }
        if (argument === '--source' || argument === '--cleaned' || argument === '--baseline' || argument === '--mapping') {
            options[argument.slice(2)] = resolve(value);
        } else if (argument === '--out') {
            options.out = resolve(value);
        } else if (argument === '--fail-on') {
            options.failOn = parseFailOn(value);
        } else if (argument === '--from' || argument === '--to') {
            options[argument.slice(2)] = parsePositiveInteger(value, argument);
        } else if (argument === '--min-area') {
            options.minArea = parsePositiveInteger(value, argument);
        } else if (argument === '--workers') {
            options.workers = parsePositiveInteger(value, argument);
        }
        index += 1;
    }
    if (!options.source || !options.cleaned) {
        throw new Error('Both --source and --cleaned are required');
    }
    return options;
}

function parsePositiveInteger(value, argument) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${argument} must be a positive integer`);
    }
    return parsed;
}

function parseFailOn(value) {
    const allowed = new Set([
        'any',
        'invented-ink',
        'none',
        'silhouette',
        'text-loss',
    ]);
    if (!allowed.has(value)) {
        throw new Error('--fail-on must be one of text-loss, silhouette, invented-ink, any, or none');
    }
    return value;
}

async function run(command, args) {
    const result = await runDiagnosticCommand(command, args, {
        cwd: projectRoot,
        env: process.env,
        onFailure: ({
            args: failedArgs,
            code,
            command: failedCommand,
            stderr,
        }) => {
            const commandLine = [
                failedCommand,
                ...failedArgs,
            ].join(' ');
            return new Error(
                `${commandLine} exited with ${String(code)}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
            );
        },
        resolveCommand: resolveAuditTool,
    });
    return {
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

function parsePdfImagesListing(text) {
    return text.split(/\r?\n/u).flatMap(line => {
        const parts = line.trim().split(/\s+/u);
        if (
            parts.length < 14
            || !/^\d+$/u.test(parts[0])
            || !/^\d+$/u.test(parts[1])
            || !/^\d+$/u.test(parts[3])
            || !/^\d+$/u.test(parts[4])
            || !/^\d+$/u.test(parts[7])
        ) {
            return [];
        }
        return [{
            bpc: Number(parts[7]),
            color: parts[5],
            encoding: parts[8],
            height: Number(parts[4]),
            num: Number(parts[1]),
            page: Number(parts[0]),
            type: parts[2],
            width: Number(parts[3]),
            xPpi: Number(parts[12]),
            yPpi: Number(parts[13]),
        }];
    });
}

function groupRowsByPage(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const pageRows = grouped.get(row.page) ?? [];
        pageRows.push(row);
        grouped.set(row.page, pageRows);
    }
    return grouped;
}

function selectSourceMaskRow(rows) {
    const maskRows = rows
        .filter(row => row.type === 'smask' && row.bpc === 1)
        .sort((left, right) => right.width * right.height - left.width * left.height);
    if (maskRows.length > 0) {
        return maskRows[0];
    }
    const imageRows = rows.filter(row => row.type === 'image' || row.type === 'stencil');
    const bilevelRows = imageRows
        .filter(row => row.bpc === 1)
        .sort((left, right) => {
            if (left.type !== right.type) {
                return left.type === 'stencil' ? -1 : 1;
            }
            return right.width * right.height - left.width * left.height;
        });
    if (bilevelRows.length > 0) {
        return bilevelRows[0];
    }
    if (imageRows.length !== 1) {
        return null;
    }
    const [singleImage] = imageRows;
    return singleImage?.color === 'gray' || singleImage?.color === 'rgb'
        ? singleImage
        : null;
}

function selectCleanedInkRow(rows) {
    return rows
        .filter(row =>
            row.bpc === 1
            && (row.type === 'stencil' || row.type === 'image'),
        )
        .sort((left, right) => {
            if (left.type !== right.type) {
                return left.type === 'stencil' ? -1 : 1;
            }
            return right.width * right.height - left.width * left.height;
        })[0]
        ?? null;
}

function pngFileNumber(fileName) {
    const match = /-(\d+)\.png$/u.exec(fileName);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

async function extractPngMask({
    includeGray = false,
    pageNumber,
    pdfPath,
    row,
    rows,
    role,
    workDirectory,
}) {
    const rowIndex = rows.indexOf(row);
    if (rowIndex < 0) {
        throw new Error(`Could not map ${role} image row on PDF page ${pageNumber}`);
    }
    const prefix = join(
        workDirectory,
        `${role}-page-${String(pageNumber)}-${String(row.num)}`,
    );
    await run('pdfimages', [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-png',
        pdfPath,
        prefix,
    ]);
    const prefixName = basename(prefix);
    const extractedNames = (await readdir(workDirectory))
        .filter(name => name.startsWith(`${prefixName}-`) && name.endsWith('.png'))
        .sort((left, right) => pngFileNumber(left) - pngFileNumber(right));
    try {
        const extractedName = extractedNames[rowIndex];
        if (!extractedName) {
            throw new Error(
                `pdfimages did not produce ${role} row ${String(rowIndex)} on PDF page ${pageNumber}`,
            );
        }
        return decodePng(await readFile(join(workDirectory, extractedName)), includeGray);
    } finally {
        await Promise.all(extractedNames.map(name =>
            rm(join(workDirectory, name), {force: true}),
        ));
    }
}

function decodePng(buffer, includeGray = false) {
    const signature = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ]);
    if (buffer.subarray(0, signature.length).compare(signature) !== 0) {
        throw new Error('Invalid PNG signature');
    }
    let offset = signature.length;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlaceMethod = 0;
    const imageData = [];
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length) {
            throw new Error('Truncated PNG chunk');
        }
        if (type === 'IHDR') {
            width = buffer.readUInt32BE(dataStart);
            height = buffer.readUInt32BE(dataStart + 4);
            bitDepth = buffer[dataStart + 8];
            colorType = buffer[dataStart + 9];
            interlaceMethod = buffer[dataStart + 12];
        } else if (type === 'IDAT') {
            imageData.push(buffer.subarray(dataStart, dataEnd));
        } else if (type === 'IEND') {
            break;
        }
        offset = dataEnd + 4;
    }
    if (
        width <= 0
        || height <= 0
        || (colorType !== 0 && colorType !== 2)
        || (colorType === 2 && bitDepth !== 8)
        || (colorType === 0 && bitDepth !== 1 && bitDepth !== 8)
        || interlaceMethod !== 0
    ) {
        throw new Error(
            `Unsupported grayscale PNG: ${String(width)}x${String(height)}, bit depth ${String(bitDepth)}, color type ${String(colorType)}, interlace ${String(interlaceMethod)}`,
        );
    }
    const rowBytes = colorType === 2
        ? width * 3
        : Math.ceil(width * bitDepth / 8);
    const bytesPerPixel = colorType === 2 ? 3 : 1;
    const inflated = inflateSync(Buffer.concat(imageData));
    const pixels = new Uint8Array(width * height);
    const gray = includeGray ? new Uint8Array(width * height) : null;
    const previous = Buffer.alloc(rowBytes);
    const current = Buffer.alloc(rowBytes);
    let inputOffset = 0;
    let darkPixelCount = 0;
    for (let y = 0; y < height; y += 1) {
        if (inputOffset + rowBytes + 1 > inflated.length) {
            throw new Error('Truncated PNG image data');
        }
        const filter = inflated[inputOffset];
        inputOffset += 1;
        inflated.copy(current, 0, inputOffset, inputOffset + rowBytes);
        inputOffset += rowBytes;
        unfilterPngRow(current, previous, filter, bytesPerPixel);
        const outputOffset = y * width;
        if (bitDepth === 8) {
            for (let x = 0; x < width; x += 1) {
                const grayValue = colorType === 2
                    ? Math.round(
                        current[x * 3] * 0.299
                        + current[x * 3 + 1] * 0.587
                        + current[x * 3 + 2] * 0.114,
                    )
                    : current[x];
                if (gray) {
                    gray[outputOffset + x] = grayValue;
                }
                if (grayValue < BLACK_THRESHOLD) {
                    pixels[outputOffset + x] = 1;
                    darkPixelCount += 1;
                }
            }
        } else {
            for (let x = 0; x < width; x += 1) {
                const sample = (current[x >> 3] >> (7 - (x & 7))) & 1;
                if (gray) {
                    gray[outputOffset + x] = sample === 0 ? 0 : 255;
                }
                if (sample === 0) {
                    pixels[outputOffset + x] = 1;
                    darkPixelCount += 1;
                }
            }
        }
        current.copy(previous);
    }
    const totalPixels = width * height;
    // RGB camera pages are not masks. A dark photographed page must not be
    // inverted into an all-white support mask merely because its paper or
    // exposure is unusual. Bilevel and grayscale mask behavior stays as it
    // was before RGB sources were admitted.
    const invertForeground = colorType !== 2 && darkPixelCount > totalPixels / 2;
    if (invertForeground) {
        for (let index = 0; index < pixels.length; index += 1) {
            pixels[index] = pixels[index] ? 0 : 1;
            if (gray) {
                gray[index] = 255 - gray[index];
            }
        }
    }
    return {
        blackCount: invertForeground ? totalPixels - darkPixelCount : darkPixelCount,
        height,
        inverted: invertForeground,
        gray,
        pixels,
        width,
    };
}

function resizeBitmapValues(bitmap, width, height, scaleX, scaleY, sourceValues) {
    const values = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        const sourceY = Math.min(
            bitmap.height - 1,
            Math.max(0, Math.floor((y + 0.5) / scaleY - 0.5)),
        );
        const sourceOffset = sourceY * bitmap.width;
        const targetOffset = y * width;
        for (let x = 0; x < width; x += 1) {
            const sourceX = Math.min(
                bitmap.width - 1,
                Math.max(0, Math.floor((x + 0.5) / scaleX - 0.5)),
            );
            values[targetOffset + x] = sourceValues[sourceOffset + sourceX];
        }
    }
    return {
        height,
        values,
        width,
    };
}

function resizeGrayBitmap(bitmap, width, height, scaleX, scaleY = scaleX) {
    return resizeBitmapValues(bitmap, width, height, scaleX, scaleY, bitmap.values);
}

async function renderPdfPageGray({
    dpi,
    pageNumber,
    pdfPath,
    role,
    workDirectory,
}) {
    const prefix = join(
        workDirectory,
        `${role}-gray-page-${String(pageNumber)}`,
    );
    const outputPath = `${prefix}.png`;
    await run('pdftoppm', [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-r',
        String(dpi),
        '-gray',
        '-png',
        '-singlefile',
        pdfPath,
        prefix,
    ]);
    try {
        const decoded = decodePng(await readFile(outputPath), true);
        if (!decoded.gray) {
            throw new Error(`pdftoppm did not produce grayscale pixels for page ${pageNumber}`);
        }
        return {
            height: decoded.height,
            values: decoded.gray,
            width: decoded.width,
        };
    } finally {
        await rm(outputPath, {force: true});
    }
}

function unfilterPngRow(current, previous, filter, bytesPerPixel) {
    if (filter === 0) {
        return;
    }
    if (filter === 1) {
        for (let index = 0; index < current.length; index += 1) {
            const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
            current[index] = (current[index] + left) & 0xff;
        }
        return;
    }
    if (filter === 2) {
        for (let index = 0; index < current.length; index += 1) {
            current[index] = (current[index] + previous[index]) & 0xff;
        }
        return;
    }
    if (filter === 3) {
        for (let index = 0; index < current.length; index += 1) {
            const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
            const up = previous[index];
            current[index] = (current[index] + Math.floor((left + up) / 2)) & 0xff;
        }
        return;
    }
    if (filter === 4) {
        for (let index = 0; index < current.length; index += 1) {
            const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
            const up = previous[index];
            const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
            current[index] = (current[index] + paethPredictor(left, up, upLeft)) & 0xff;
        }
        return;
    }
    throw new Error(`Unsupported PNG filter ${String(filter)}`);
}

function paethPredictor(left, up, upLeft) {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upLeftDistance = Math.abs(estimate - upLeft);
    if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
        return left;
    }
    if (upDistance <= upLeftDistance) {
        return up;
    }
    return upLeft;
}

function makeBitmap(width, height, pixels) {
    let blackCount = 0;
    for (const pixel of pixels) {
        blackCount += pixel;
    }
    return {
        blackCount,
        height,
        pixels,
        width,
    };
}

/**
 * Turn a single RGB camera image into the small amount of source support the
 * audit needs. This is deliberately stricter than the rendered grayscale
 * fallback. Paper texture and illumination gradients remain background; only
 * pixels that are both dark in absolute terms and separated from the page's
 * upper-quartile paper level become support. Component and coverage checks
 * still decide whether that support looks like text.
 */
function makeConservativeRgbSupport(decoded) {
    if (!decoded.gray) {
        throw new Error('RGB source image did not produce grayscale support samples');
    }
    const histogram = new Uint32Array(256);
    for (const value of decoded.gray) {
        histogram[value] += 1;
    }
    const paperReference = histogramPercentile(
        histogram,
        decoded.gray.length,
        SOURCE_SUPPORT_PERCENTILE,
    );
    const threshold = Math.min(
        RGB_SUPPORT_MAX_INK,
        Math.max(0, paperReference - RGB_SUPPORT_MIN_PAPER_SEPARATION),
    );
    const pixels = new Uint8Array(decoded.gray.length);
    let blackCount = 0;
    for (let index = 0; index < decoded.gray.length; index += 1) {
        if (decoded.gray[index] <= threshold) {
            pixels[index] = 1;
            blackCount += 1;
        }
    }
    return {
        ...decoded,
        blackCount,
        pixels,
        rgbSupport: {
            paperReference,
            threshold,
        },
    };
}

function bitmapBounds(bitmap) {
    let minX = bitmap.width;
    let minY = bitmap.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < bitmap.height; y += 1) {
        const offset = y * bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            if (!bitmap.pixels[offset + x]) {
                continue;
            }
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }
    return maxX < 0
        ? null
        : {
            maxX,
            maxY,
            minX,
            minY,
        };
}

export function rotateBitmapValues(bitmap, quarterTurns, sourceValues) {
    const turns = ((quarterTurns % 4) + 4) % 4;
    if (turns === 0) {
        return {
            height: bitmap.height,
            values: sourceValues,
            width: bitmap.width,
        };
    }
    const width = turns % 2 === 0 ? bitmap.width : bitmap.height;
    const height = turns % 2 === 0 ? bitmap.height : bitmap.width;
    const values = new Uint8Array(width * height);
    for (let y = 0; y < bitmap.height; y += 1) {
        for (let x = 0; x < bitmap.width; x += 1) {
            let targetX;
            let targetY;
            if (turns === 1) {
                targetX = bitmap.height - 1 - y;
                targetY = x;
            } else if (turns === 2) {
                targetX = bitmap.width - 1 - x;
                targetY = bitmap.height - 1 - y;
            } else {
                targetX = y;
                targetY = bitmap.width - 1 - x;
            }
            values[targetY * width + targetX] = sourceValues[y * bitmap.width + x];
        }
    }
    return {
        height,
        values,
        width,
    };
}

function rotateBitmap(bitmap, quarterTurns) {
    const turns = ((quarterTurns % 4) + 4) % 4;
    if (turns === 0) {
        return bitmap;
    }
    const rotated = rotateBitmapValues(bitmap, turns, bitmap.pixels);
    return makeBitmap(rotated.width, rotated.height, rotated.values);
}

function cropBitmapValues(bitmap, x, y, width, height, sourceValues) {
    const pixels = new Uint8Array(width * height);
    for (let row = 0; row < height; row += 1) {
        const sourceOffset = (y + row) * bitmap.width + x;
        pixels.set(
            sourceValues.subarray(sourceOffset, sourceOffset + width),
            row * width,
        );
    }
    return pixels;
}

function cropBitmap(bitmap, x, y, width, height) {
    return makeBitmap(
        width,
        height,
        cropBitmapValues(bitmap, x, y, width, height, bitmap.pixels),
    );
}

function rotateGrayBitmap(bitmap, quarterTurns) {
    const turns = ((quarterTurns % 4) + 4) % 4;
    if (turns === 0) {
        return bitmap;
    }
    const rotated = rotateBitmapValues(bitmap, turns, bitmap.values);
    return {
        height: rotated.height,
        values: rotated.values,
        width: rotated.width,
    };
}

function cropGrayBitmap(bitmap, x, y, width, height) {
    const values = cropBitmapValues(bitmap, x, y, width, height, bitmap.values);
    return {
        height,
        values,
        width,
    };
}

function resolveSplitSourceTransform(source, cleanedRows, splitCount, splitIndex) {
    const outputWidth = cleanedRows.reduce((total, row) => total + row.width, 0) / cleanedRows.length;
    const outputHeight = cleanedRows.reduce((total, row) => total + row.height, 0) / cleanedRows.length;
    const targetAspect = outputWidth * splitCount / outputHeight;
    const candidates = [
        0,
        1,
        3,
    ].map(quarterTurns => {
        const width = quarterTurns % 2 === 0 ? source.width : source.height;
        const height = quarterTurns % 2 === 0 ? source.height : source.width;
        return {
            quarterTurns,
            score: Math.abs(Math.log((width / height) / targetAspect)),
            width,
            height,
        };
    });
    const orientation = candidates.reduce((best, candidate) =>
        candidate.score < best.score ? candidate : best,
    );
    const left = Math.floor(orientation.width * splitIndex / splitCount);
    const right = Math.floor(orientation.width * (splitIndex + 1) / splitCount);
    return {
        height: orientation.height,
        quarterTurns: orientation.quarterTurns,
        width: orientation.width,
        x: left,
        y: 0,
        cropWidth: right - left,
    };
}

function applySourceSplitTransform(source, transform) {
    return cropBitmap(
        rotateBitmap(source, transform.quarterTurns),
        transform.x,
        transform.y,
        transform.cropWidth,
        transform.height,
    );
}

function applySourceGraySplitTransform(source, transform) {
    return cropGrayBitmap(
        rotateGrayBitmap(source, transform.quarterTurns),
        transform.x,
        transform.y,
        transform.cropWidth,
        transform.height,
    );
}

function mapSplitLocalPointToFullSource(point, transform) {
    const rotatedX = point.x + transform.x;
    const rotatedY = point.y + transform.y;
    const turns = ((transform.quarterTurns % 4) + 4) % 4;
    if (turns === 0) {
        return {
            x: rotatedX,
            y: rotatedY,
        };
    }
    if (turns === 1) {
        return {
            x: rotatedY,
            y: transform.fullHeight - 1 - rotatedX,
        };
    }
    if (turns === 2) {
        return {
            x: transform.fullWidth - 1 - rotatedX,
            y: transform.fullHeight - 1 - rotatedY,
        };
    }
    return {
        x: transform.fullWidth - 1 - rotatedY,
        y: rotatedX,
    };
}

function mapFullSourcePointToSplitLocal(point, transform) {
    const turns = ((transform.quarterTurns % 4) + 4) % 4;
    let rotatedX;
    let rotatedY;
    if (turns === 0) {
        rotatedX = point.x;
        rotatedY = point.y;
    } else if (turns === 1) {
        rotatedX = transform.fullHeight - 1 - point.y;
        rotatedY = point.x;
    } else if (turns === 2) {
        rotatedX = transform.fullWidth - 1 - point.x;
        rotatedY = transform.fullHeight - 1 - point.y;
    } else {
        rotatedX = point.y;
        rotatedY = transform.fullWidth - 1 - point.x;
    }
    return {
        x: rotatedX - transform.x,
        y: rotatedY - transform.y,
    };
}

function downsampleBitmap(bitmap, factor) {
    const width = Math.ceil(bitmap.width / factor);
    const height = Math.ceil(bitmap.height / factor);
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < bitmap.height; y += 1) {
        const targetY = Math.floor(y / factor);
        const sourceOffset = y * bitmap.width;
        const targetOffset = targetY * width;
        for (let x = 0; x < bitmap.width; x += 1) {
            if (bitmap.pixels[sourceOffset + x]) {
                pixels[targetOffset + Math.floor(x / factor)] = 1;
            }
        }
    }
    return makeBitmap(width, height, pixels);
}

function resizeBitmap(bitmap, width, height, scaleX, scaleY = scaleX) {
    const resized = resizeBitmapValues(bitmap, width, height, scaleX, scaleY, bitmap.pixels);
    return makeBitmap(resized.width, resized.height, resized.values);
}

function collectBlackRows(bitmap, maxSamples) {
    const stride = Math.max(1, Math.ceil(bitmap.blackCount / maxSamples));
    const rows = Array.from({length: bitmap.height}, () => []);
    let ordinal = 0;
    let sampleCount = 0;
    for (let y = 0; y < bitmap.height; y += 1) {
        const offset = y * bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            if (!bitmap.pixels[offset + x]) {
                continue;
            }
            if (ordinal % stride === 0) {
                rows[y].push(x);
                sampleCount += 1;
            }
            ordinal += 1;
        }
    }
    return {
        rows,
        sampleCount,
    };
}

function scoreRows(sourceRows, sourceWidth, target, targetWidth, dx, dy) {
    let overlap = 0;
    const sourceHeight = sourceRows.length;
    const targetHeight = target.length / targetWidth;
    const firstSourceX = Math.max(0, -dx);
    const lastSourceX = Math.min(sourceWidth, targetWidth - dx);
    for (let sourceY = 0; sourceY < sourceHeight; sourceY += 1) {
        const targetY = sourceY + dy;
        if (targetY < 0 || targetY >= targetHeight) {
            continue;
        }
        const sourceRow = sourceRows[sourceY];
        if (sourceRow.length === 0) {
            continue;
        }
        const targetOffset = targetY * targetWidth + dx;
        for (const sourceX of sourceRow) {
            if (
                sourceX >= firstSourceX
                && sourceX < lastSourceX
                && target[targetOffset + sourceX]
            ) {
                overlap += 1;
            }
        }
    }
    return overlap;
}

function preferCandidate(candidate, best, preferredDx, preferredDy) {
    if (candidate.score !== best.score) {
        return candidate.score > best.score;
    }
    const candidateDistance =
        Math.abs(candidate.dx - preferredDx) + Math.abs(candidate.dy - preferredDy);
    const bestDistance = Math.abs(best.dx - preferredDx) + Math.abs(best.dy - preferredDy);
    return candidateDistance < bestDistance;
}

function searchReverseRows({
    maxDx,
    maxDy,
    minDx,
    minDy,
    preferredDx,
    preferredDy,
    sourceRows,
    sourceWidth,
    step,
    target,
    targetWidth,
}) {
    let best = {
        dx: preferredDx,
        dy: preferredDy,
        score: -1,
    };
    for (let dy = minDy; dy <= maxDy; dy += step) {
        for (let dx = minDx; dx <= maxDx; dx += step) {
            const candidate = {
                dx,
                dy,
                score: scoreRows(sourceRows, sourceWidth, target, targetWidth, -dx, -dy),
            };
            if (preferCandidate(candidate, best, preferredDx, preferredDy)) {
                best = candidate;
            }
        }
    }
    return best;
}

function exactOverlap(source, target, dx, dy) {
    let overlap = 0;
    const targetHeight = target.height;
    for (let sourceY = 0; sourceY < source.height; sourceY += 1) {
        const targetY = sourceY + dy;
        if (targetY < 0 || targetY >= targetHeight) {
            continue;
        }
        const firstSourceX = Math.max(0, -dx);
        const lastSourceX = Math.min(source.width, target.width - dx);
        const sourceOffset = sourceY * source.width;
        const targetOffset = targetY * target.width + dx;
        for (let sourceX = firstSourceX; sourceX < lastSourceX; sourceX += 1) {
            if (source.pixels[sourceOffset + sourceX] && target.pixels[targetOffset + sourceX]) {
                overlap += 1;
            }
        }
    }
    return overlap;
}

function makeScaleMap(length, scale) {
    const mapped = new Int32Array(length);
    for (let index = 0; index < length; index += 1) {
        mapped[index] = Math.max(0, Math.floor((index + 0.5) * scale));
    }
    return mapped;
}

function collectMappedBlackPoints(source, scale, maxSamples) {
    const stride = Math.max(1, Math.ceil(source.blackCount / maxSamples));
    const capacity = Math.ceil(source.blackCount / stride);
    const xs = new Uint16Array(capacity);
    const ys = new Uint16Array(capacity);
    const xMap = makeScaleMap(source.width, scale);
    const yMap = makeScaleMap(source.height, scale);
    let ordinal = 0;
    let pointCount = 0;
    for (let y = 0; y < source.height; y += 1) {
        const offset = y * source.width;
        for (let x = 0; x < source.width; x += 1) {
            if (!source.pixels[offset + x]) {
                continue;
            }
            if (ordinal % stride === 0) {
                xs[pointCount] = xMap[x];
                ys[pointCount] = yMap[y];
                pointCount += 1;
            }
            ordinal += 1;
        }
    }
    return {
        count: pointCount,
        xs: xs.subarray(0, pointCount),
        ys: ys.subarray(0, pointCount),
    };
}

function scoreInverseMappedPoints(points, source, dx, dy, scaleX, scaleY) {
    let overlap = 0;
    for (let index = 0; index < points.count; index += 1) {
        const sourceX = Math.round((points.xs[index] - dx) / scaleX);
        const sourceY = Math.round((points.ys[index] - dy) / scaleY);
        if (
            sourceX >= 0
            && sourceX < source.width
            && sourceY >= 0
            && sourceY < source.height
            && source.pixels[sourceY * source.width + sourceX]
        ) {
            overlap += 1;
        }
    }
    return overlap;
}

function searchInverseMappedPoints({
    maxDx,
    maxDy,
    minDx,
    minDy,
    points,
    preferredDx,
    preferredDy,
    scaleX,
    scaleY,
    source,
}) {
    let best = {
        dx: preferredDx,
        dy: preferredDy,
        score: -1,
    };
    for (let dy = minDy; dy <= maxDy; dy += 1) {
        for (let dx = minDx; dx <= maxDx; dx += 1) {
            const candidate = {
                dx,
                dy,
                score: scoreInverseMappedPoints(points, source, dx, dy, scaleX, scaleY),
            };
            if (preferCandidate(candidate, best, preferredDx, preferredDy)) {
                best = candidate;
            }
        }
    }
    return best;
}

function makeAlignmentBitmap(source, minArea, collectComponents = false) {
    const maxAlignmentArea = 3_500;
    const maxAlignmentWidth = 180;
    const maxAlignmentHeight = 60;
    const minAlignmentDensity = 0.18;
    const visited = new Uint8Array(source.pixels.length);
    const pixels = new Uint8Array(source.pixels.length);
    const stack = [];
    const candidateComponents = [];
    const metricComponents = [];
    const plateRegions = [];
    const componentLabels = collectComponents
        ? new Int32Array(source.pixels.length)
        : null;
    let nextComponentId = 0;
    for (let start = 0; start < source.pixels.length; start += 1) {
        if (!source.pixels[start] || visited[start]) {
            continue;
        }
        stack.length = 0;
        stack.push(start);
        visited[start] = 1;
        nextComponentId += 1;
        const componentId = nextComponentId;
        let area = 0;
        let minX = source.width;
        let minY = source.height;
        let maxX = -1;
        let maxY = -1;
        let keepPixels = true;
        let componentPixels = [];
        let metricPixelsAvailable = true;
        while (stack.length > 0) {
            const current = stack.pop();
            const currentX = current % source.width;
            const currentY = Math.floor(current / source.width);
            area += 1;
            minX = Math.min(minX, currentX);
            minY = Math.min(minY, currentY);
            maxX = Math.max(maxX, currentX);
            maxY = Math.max(maxY, currentY);
            if (componentLabels) {
                componentLabels[current] = componentId;
            }
            if (keepPixels || (collectComponents && metricPixelsAvailable)) {
                componentPixels.push(current);
            }
            if (
                area > maxAlignmentArea
                || maxX - minX + 1 > maxAlignmentWidth
                || maxY - minY + 1 > maxAlignmentHeight
            ) {
                keepPixels = false;
                if (!collectComponents) {
                    componentPixels = [];
                }
            }
            if (
                collectComponents
                && componentPixels.length > MAX_COMPONENT_PIXELS_FOR_LOCAL_SEARCH
            ) {
                componentPixels = [];
                metricPixelsAvailable = false;
            }
            for (let neighborY = Math.max(0, currentY - 1); neighborY <= Math.min(source.height - 1, currentY + 1); neighborY += 1) {
                const neighborOffset = neighborY * source.width;
                for (let neighborX = Math.max(0, currentX - 1); neighborX <= Math.min(source.width - 1, currentX + 1); neighborX += 1) {
                    const neighbor = neighborOffset + neighborX;
                    if (source.pixels[neighbor] && !visited[neighbor]) {
                        visited[neighbor] = 1;
                        stack.push(neighbor);
                    }
                }
            }
        }
        const componentWidth = maxX - minX + 1;
        const componentHeight = maxY - minY + 1;
        if (
            componentHeight > 220
            || componentHeight > 40
            || (componentWidth > 500 && componentHeight > 50)
        ) {
            const padding = 160;
            const regionX = Math.max(0, minX - padding);
            const regionY = Math.max(0, minY - padding);
            const regionRight = Math.min(source.width, maxX + 1 + padding);
            const regionBottom = Math.min(source.height, maxY + 1 + padding);
            plateRegions.push({
                height: regionBottom - regionY,
                width: regionRight - regionX,
                x: regionX,
                y: regionY,
            });
        }
        if (
            keepPixels
            && area >= minArea
            && componentHeight >= 8
            && area / (componentWidth * componentHeight) >= minAlignmentDensity
        ) {
            candidateComponents.push({
                height: componentHeight,
                pixels: componentPixels,
                width: componentWidth,
                x: minX,
                y: minY,
            });
        }
        if (
            collectComponents
            && area >= minArea
            && componentHeight >= 8
            && componentHeight <= 220
        ) {
            metricComponents.push({
                area,
                height: componentHeight,
                id: componentId,
                pixels: metricPixelsAvailable ? componentPixels : null,
                width: componentWidth,
                x: minX,
                y: minY,
            });
        }
    }
    for (const component of candidateComponents) {
        const centerX = component.x + component.width / 2;
        const centerY = component.y + component.height / 2;
        if (plateRegions.some(region =>
            centerX >= region.x
            && centerX < region.x + region.width
            && centerY >= region.y
            && centerY < region.y + region.height,
        )) {
            continue;
        }
        for (const pixelIndex of component.pixels) {
            pixels[pixelIndex] = 1;
        }
    }
    const alignment = makeBitmap(source.width, source.height, pixels);
    return {
        bitmap: alignment.blackCount === 0 ? source : alignment,
        componentCount: nextComponentId,
        componentLabels,
        components: metricComponents,
        plateRegions,
    };
}

function alignAtScale(
    source,
    cleaned,
    scale,
    alignmentSource = source,
    alignmentCleaned = cleaned,
) {
    const scaleX = typeof scale === 'number' ? scale : scale.x;
    const scaleY = typeof scale === 'number' ? scale : scale.y;
    const sourceQuarter = downsampleBitmap(alignmentSource, QUARTER_DOWNSAMPLE);
    const cleanedQuarter = downsampleBitmap(alignmentCleaned, QUARTER_DOWNSAMPLE);
    const scaledQuarter = scaleX === 1 && scaleY === 1
        ? sourceQuarter
        : resizeBitmap(
            sourceQuarter,
            Math.max(1, Math.ceil(alignmentSource.width * scaleX / QUARTER_DOWNSAMPLE)),
            Math.max(1, Math.ceil(alignmentSource.height * scaleY / QUARTER_DOWNSAMPLE)),
            scaleX,
            scaleY,
        );
    const sourceBroad = downsampleBitmap(scaledQuarter, BROAD_DOWNSAMPLE / QUARTER_DOWNSAMPLE);
    const cleanedBroad = downsampleBitmap(cleanedQuarter, BROAD_DOWNSAMPLE / QUARTER_DOWNSAMPLE);
    const usesUniformFitAlignment = typeof scale === 'object'
        && scale.label.startsWith('uniform-fit(');
    const preferredFullDx = typeof scale === 'object' && Number.isFinite(scale.preferredDx)
        ? scale.preferredDx
        : null;
    const preferredFullDy = typeof scale === 'object' && Number.isFinite(scale.preferredDy)
        ? scale.preferredDy
        : null;
    const sourceBounds = usesUniformFitAlignment ? bitmapBounds(sourceBroad) : null;
    const cleanedBounds = usesUniformFitAlignment ? bitmapBounds(cleanedBroad) : null;
    const preferredBroadDx = preferredFullDx === null
        ? sourceBounds && cleanedBounds
            ? Math.round(cleanedBounds.minX - sourceBounds.minX)
            : 0
        : Math.round(preferredFullDx / BROAD_DOWNSAMPLE);
    const preferredBroadDy = preferredFullDy === null
        ? sourceBounds && cleanedBounds
            ? Math.round(cleanedBounds.minY - sourceBounds.minY)
            : 0
        : Math.round(preferredFullDy / BROAD_DOWNSAMPLE);
    const broadRows = collectBlackRows(cleanedBroad, MAX_BROAD_ALIGNMENT_SAMPLES);
    const broadRadius = Math.ceil(ALIGNMENT_RADIUS_FULL_PX / BROAD_DOWNSAMPLE);
    const broad = searchReverseRows({
        maxDx: preferredBroadDx + broadRadius,
        maxDy: preferredBroadDy + broadRadius,
        minDx: preferredBroadDx - broadRadius,
        minDy: preferredBroadDy - broadRadius,
        preferredDx: preferredBroadDx,
        preferredDy: preferredBroadDy,
        sourceRows: broadRows.rows,
        sourceWidth: cleanedBroad.width,
        step: 2,
        target: sourceBroad.pixels,
        targetWidth: sourceBroad.width,
    });
    const quarterRows = collectBlackRows(cleanedQuarter, MAX_QUARTER_ALIGNMENT_SAMPLES);
    const quarterCenterDx = broad.dx * (BROAD_DOWNSAMPLE / QUARTER_DOWNSAMPLE);
    const quarterCenterDy = broad.dy * (BROAD_DOWNSAMPLE / QUARTER_DOWNSAMPLE);
    const quarter = searchReverseRows({
        maxDx: quarterCenterDx + 4,
        maxDy: quarterCenterDy + 4,
        minDx: quarterCenterDx - 4,
        minDy: quarterCenterDy - 4,
        preferredDx: quarterCenterDx,
        preferredDy: quarterCenterDy,
        sourceRows: quarterRows.rows,
        sourceWidth: cleanedQuarter.width,
        step: 1,
        target: scaledQuarter.pixels,
        targetWidth: scaledQuarter.width,
    });
    const fullPoints = collectMappedBlackPoints(
        usesUniformFitAlignment ? cleaned : alignmentCleaned,
        1,
        MAX_FULL_ALIGNMENT_SAMPLES,
    );
    const sourceFullBounds = usesUniformFitAlignment ? bitmapBounds(source) : null;
    const cleanedFullBounds = usesUniformFitAlignment ? bitmapBounds(cleaned) : null;
    const fullCenterDx = preferredFullDx === null
        ? sourceFullBounds && cleanedFullBounds
            ? Math.round(cleanedFullBounds.minX - Math.floor((sourceFullBounds.minX + 0.5) * scaleX))
            : quarter.dx * QUARTER_DOWNSAMPLE
        : Math.round(preferredFullDx);
    const fullCenterDy = preferredFullDy === null
        ? sourceFullBounds && cleanedFullBounds
            ? Math.round(cleanedFullBounds.minY - Math.floor((sourceFullBounds.minY + 0.5) * scaleY))
            : quarter.dy * QUARTER_DOWNSAMPLE
        : Math.round(preferredFullDy);
    const full = searchInverseMappedPoints({
        maxDx: fullCenterDx + (usesUniformFitAlignment ? 8 : 4),
        maxDy: fullCenterDy + (usesUniformFitAlignment ? 8 : 4),
        minDx: fullCenterDx - (usesUniformFitAlignment ? 8 : 4),
        minDy: fullCenterDy - (usesUniformFitAlignment ? 8 : 4),
        points: fullPoints,
        preferredDx: fullCenterDx,
        preferredDy: fullCenterDy,
        scaleX,
        scaleY,
        source: usesUniformFitAlignment ? source : alignmentSource,
    });
    const quarterOverlap = exactOverlap(
        scaledQuarter,
        cleanedQuarter,
        quarter.dx,
        quarter.dy,
    );
    const quarterOverlapScore = scaledQuarter.blackCount === 0
        ? 0
        : quarterOverlap / scaledQuarter.blackCount;
    const fullOverlapScore = fullPoints.count === 0
        ? 0
        : full.score / fullPoints.count;
    return {
        broadDx: broad.dx,
        broadDy: broad.dy,
        dx: full.dx,
        dy: full.dy,
        fullOverlapScore,
        overlapScore: quarterOverlapScore,
        quarterDx: quarter.dx,
        quarterDy: quarter.dy,
        scale,
        scaleX,
        scaleY,
    };
}

function dilateOnePixel(bitmap) {
    const horizontal = new Uint8Array(bitmap.width * bitmap.height);
    for (let y = 0; y < bitmap.height; y += 1) {
        const offset = y * bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            horizontal[offset + x] = bitmap.pixels[offset + x]
                || (x > 0 && bitmap.pixels[offset + x - 1])
                || (x + 1 < bitmap.width && bitmap.pixels[offset + x + 1])
                ? 1
                : 0;
        }
    }
    const pixels = new Uint8Array(bitmap.width * bitmap.height);
    for (let y = 0; y < bitmap.height; y += 1) {
        const offset = y * bitmap.width;
        const previousOffset = offset - bitmap.width;
        const nextOffset = offset + bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            pixels[offset + x] = horizontal[offset + x]
                || (y > 0 && horizontal[previousOffset + x])
                || (y + 1 < bitmap.height && horizontal[nextOffset + x])
                ? 1
                : 0;
        }
    }
    return {
        height: bitmap.height,
        pixels,
        width: bitmap.width,
    };
}

function dilateBitmap(bitmap, radius) {
    let result = bitmap;
    for (let pass = 0; pass < radius; pass += 1) {
        result = dilateOnePixel(result);
    }
    return result;
}

function resolveOutputGridTolerances(alignment) {
    const scaleX = Math.max(1, Math.abs(alignment.scaleX ?? alignment.scale));
    const scaleY = Math.max(1, Math.abs(alignment.scaleY ?? alignment.scale));
    return {
        areaScale: scaleX * scaleY,
        localRadiusX: Math.max(1, Math.ceil(
            LOCAL_ALIGNMENT_RADIUS_FULL_PX * Math.min(MAPPED_STENCIL_MAX_DILATION_RADIUS, scaleX),
        )),
        localRadiusY: Math.max(1, Math.ceil(
            LOCAL_ALIGNMENT_RADIUS_FULL_PX * Math.min(MAPPED_STENCIL_MAX_DILATION_RADIUS, scaleY),
        )),
    };
}

function resolveAuditDilationRadius(cleanedRow, mappingActive, alignment) {
    if (!mappingActive || cleanedRow.bpc !== 1) {
        return 1;
    }
    const scale = Math.max(alignment.scaleX ?? alignment.scale, alignment.scaleY ?? alignment.scale);
    if (scale < 2) {
        return 1;
    }
    return Math.min(
        MAPPED_STENCIL_MAX_DILATION_RADIUS,
        Math.max(1, Math.ceil(scale)),
    );
}

function finitePositive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function resolveCanonicalGeometryScale(geometry, source, cleaned) {
    const crop = geometry?.cropRect;
    const matrix = geometry?.forwardTransform?.matrix;
    if (
        geometry?.dewarped !== false
        || !crop
        || !Array.isArray(matrix)
        || matrix.length < 2
        || !Array.isArray(matrix[0])
        || !Array.isArray(matrix[1])
        || matrix[0].length < 3
        || matrix[1].length < 3
        || ![
            geometry.canvasWidthPx,
            geometry.canvasHeightPx,
            geometry.inputWidthPx,
            geometry.inputHeightPx,
            geometry.matchedCanvasContentWidthPx,
            geometry.matchedCanvasContentHeightPx,
            geometry.placementOffsetXPx,
            geometry.placementOffsetYPx,
            crop.widthPx,
            crop.heightPx,
            ...matrix[0].slice(0, 3),
            ...matrix[1].slice(0, 3),
        ].every(Number.isFinite)
        || ![
            geometry.canvasWidthPx,
            geometry.canvasHeightPx,
            geometry.inputWidthPx,
            geometry.inputHeightPx,
            geometry.matchedCanvasContentWidthPx,
            geometry.matchedCanvasContentHeightPx,
            crop.widthPx,
            crop.heightPx,
        ].every(finitePositive)
    ) {
        return null;
    }
    const [
        a,
        b,
        c,
    ] = matrix[0];
    const [
        d,
        e,
        f,
    ] = matrix[1];
    const inputScaleX = geometry.inputWidthPx / source.width;
    const inputScaleY = geometry.inputHeightPx / source.height;
    const matchScaleX = geometry.matchedCanvasContentWidthPx / crop.widthPx;
    const matchScaleY = geometry.matchedCanvasContentHeightPx / crop.heightPx;
    const canvasScaleX = cleaned.width / geometry.canvasWidthPx;
    const canvasScaleY = cleaned.height / geometry.canvasHeightPx;
    const scaleX = Math.abs(a) * inputScaleX * matchScaleX * canvasScaleX;
    const scaleY = Math.abs(e) * inputScaleY * matchScaleY * canvasScaleY;
    if (!finitePositive(scaleX) || !finitePositive(scaleY)) {
        return null;
    }
    const crossX = b * inputScaleY * matchScaleX * canvasScaleX;
    const crossY = d * inputScaleX * matchScaleY * canvasScaleY;
    const preferredDx = (
        geometry.placementOffsetXPx
        + matchScaleX * c
    ) * canvasScaleX + crossX * (source.height - 1) / 2;
    const preferredDy = (
        geometry.placementOffsetYPx
        + matchScaleY * f
    ) * canvasScaleY + crossY * (source.width - 1) / 2;
    if (!Number.isFinite(preferredDx) || !Number.isFinite(preferredDy)) {
        return null;
    }
    return {
        label: `canonical-geometry(${scaleX.toFixed(6)}x${scaleY.toFixed(6)})`,
        preferredDx,
        preferredDy,
        x: scaleX,
        y: scaleY,
    };
}

function finitePoint(value) {
    return value
        && typeof value === 'object'
        && Number.isFinite(value.x)
        && Number.isFinite(value.y);
}

function interpolateDewarpGrid(points, columns, rows, width, height, x, y) {
    const gridX = Math.min(
        columns - 1,
        Math.max(0, (x / width) * (columns - 1)),
    );
    const gridY = Math.min(
        rows - 1,
        Math.max(0, (y / height) * (rows - 1)),
    );
    const left = Math.floor(gridX);
    const top = Math.floor(gridY);
    const right = Math.min(columns - 1, left + 1);
    const bottom = Math.min(rows - 1, top + 1);
    const tx = gridX - left;
    const ty = gridY - top;
    const at = (column, row) => points[row * columns + column];
    const lerp = (start, end, amount) => start + (end - start) * amount;
    const bilinearCoordinate = coordinate => lerp(
        lerp(at(left, top)[coordinate], at(right, top)[coordinate], tx),
        lerp(at(left, bottom)[coordinate], at(right, bottom)[coordinate], tx),
        ty,
    );
    return {
        x: bilinearCoordinate('x'),
        y: bilinearCoordinate('y'),
    };
}

function dewarpGridCellDeterminant(points, columns, row, column) {
    const at = (x, y) => points[y * columns + x];
    const topLeft = at(column, row);
    const topRight = at(column + 1, row);
    const bottomLeft = at(column, row + 1);
    return (
        (topRight.x - topLeft.x) * (bottomLeft.y - topLeft.y)
        - (topRight.y - topLeft.y) * (bottomLeft.x - topLeft.x)
    );
}

function validateDewarpGridSemantics({
    columns,
    mapping,
    rows,
    sourceRegionHeight,
    sourceRegionWidth,
    sourceRegionX,
    sourceRegionY,
}) {
    const outputAllowance = Math.max(
        4,
        Math.max(mapping.outputWidth, mapping.outputHeight) * 0.25,
    );
    const sourceAllowance = Math.max(4, Math.max(sourceRegionWidth, sourceRegionHeight) * 0.25);
    const outputPointsInBounds = mapping.sourceToOutput.every(point =>
        point.x >= -outputAllowance
        && point.x <= mapping.outputWidth + outputAllowance
        && point.y >= -outputAllowance
        && point.y <= mapping.outputHeight + outputAllowance,
    );
    const sourcePointsInBounds = mapping.outputToSource.every(point =>
        point.x >= sourceRegionX - sourceAllowance
        && point.x <= sourceRegionX + sourceRegionWidth + sourceAllowance
        && point.y >= sourceRegionY - sourceAllowance
        && point.y <= sourceRegionY + sourceRegionHeight + sourceAllowance,
    );
    if (!outputPointsInBounds || !sourcePointsInBounds) {
        return 'dewarpMapping contains out-of-bounds coordinates';
    }
    for (const points of [
        mapping.sourceToOutput,
        mapping.outputToSource,
    ]) {
        for (let row = 0; row < rows - 1; row += 1) {
            for (let column = 0; column < columns - 1; column += 1) {
                const determinant = dewarpGridCellDeterminant(points, columns, row, column);
                if (!Number.isFinite(determinant) || determinant <= 1e-6) {
                    return 'dewarpMapping is folded or non-invertible';
                }
            }
        }
    }
    const sourceTolerance = Math.max(
        8,
        Math.max(sourceRegionWidth, sourceRegionHeight) * 0.1,
    );
    const outputTolerance = Math.max(
        8,
        Math.max(mapping.outputWidth, mapping.outputHeight) * 0.1,
    );
    const sourceToOutput = point => interpolateDewarpGrid(
        mapping.sourceToOutput,
        columns,
        rows,
        sourceRegionWidth,
        sourceRegionHeight,
        point.x - sourceRegionX,
        point.y - sourceRegionY,
    );
    const outputToSource = point => interpolateDewarpGrid(
        mapping.outputToSource,
        columns,
        rows,
        mapping.outputWidth,
        mapping.outputHeight,
        point.x,
        point.y,
    );
    for (let row = 0; row < rows; row += 1) {
        const sourceY = sourceRegionY + row / (rows - 1) * sourceRegionHeight;
        const outputY = row / (rows - 1) * mapping.outputHeight;
        for (let column = 0; column < columns; column += 1) {
            const sourceX = sourceRegionX + column / (columns - 1) * sourceRegionWidth;
            const outputX = column / (columns - 1) * mapping.outputWidth;
            const sourceRoundTrip = outputToSource(sourceToOutput({
                x: sourceX,
                y: sourceY,
            }));
            const outputRoundTrip = sourceToOutput(outputToSource({
                x: outputX,
                y: outputY,
            }));
            if (
                Math.hypot(sourceRoundTrip.x - sourceX, sourceRoundTrip.y - sourceY) > sourceTolerance
                || Math.hypot(outputRoundTrip.x - outputX, outputRoundTrip.y - outputY) > outputTolerance
            ) {
                return 'dewarpMapping source/output grids are not mutual inverses';
            }
        }
    }
    return null;
}

function resolveDewarpGeometryAlignment(
    geometry,
    source,
    cleaned,
    sourceCoordinateTransform = null,
) {
    if (geometry?.dewarped !== true) {
        return {kind: 'not-dewarped'};
    }
    const mapping = geometry.dewarpMapping;
    if (mapping === undefined || mapping === null) {
        return {
            kind: 'missing',
            reason: 'dewarped output has no declared dewarpMapping',
        };
    }
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        return {
            kind: 'malformed',
            reason: 'dewarpMapping must be an object',
        };
    }
    const columns = mapping.columns;
    const rows = mapping.rows;
    const pointCount = columns * rows;
    if (
        !Number.isSafeInteger(columns)
        || !Number.isSafeInteger(rows)
        || columns < 2
        || rows < 2
        || columns > 1024
        || rows > 1024
        || !Number.isSafeInteger(pointCount)
        || pointCount <= 0
    ) {
        return {
            kind: 'malformed',
            reason: 'dewarpMapping grid dimensions are invalid',
        };
    }
    if (
        !Number.isSafeInteger(mapping.outputWidth)
        || !Number.isSafeInteger(mapping.outputHeight)
        || mapping.outputWidth <= 0
        || mapping.outputHeight <= 0
        || !finitePoint(mapping.outputOrigin)
        || !Array.isArray(mapping.outputToSource)
        || !Array.isArray(mapping.sourceToOutput)
        || mapping.outputToSource.length !== pointCount
        || mapping.sourceToOutput.length !== pointCount
        || mapping.outputToSource.some(point => !finitePoint(point))
        || mapping.sourceToOutput.some(point => !finitePoint(point))
    ) {
        return {
            kind: 'malformed',
            reason: 'dewarpMapping grid points or output dimensions are invalid',
        };
    }
    const canvasWidth = geometry.canvasWidthPx;
    const canvasHeight = geometry.canvasHeightPx;
    const inputWidth = geometry.inputWidthPx;
    const inputHeight = geometry.inputHeightPx;
    const placementOffsetX = geometry.placementOffsetXPx;
    const placementOffsetY = geometry.placementOffsetYPx;
    if (
        !finitePositive(canvasWidth)
        || !finitePositive(canvasHeight)
        || !finitePositive(inputWidth)
        || !finitePositive(inputHeight)
        || !Number.isFinite(placementOffsetX)
        || !Number.isFinite(placementOffsetY)
    ) {
        return {
            kind: 'malformed',
            reason: 'dewarpMapping geometry has invalid canvas, input, or placement dimensions',
        };
    }
    const sourceRegion = geometry.sourceRegion;
    const sourceRegionValid = sourceRegion === undefined
        || (
            sourceRegion
            && Number.isFinite(sourceRegion.xPx)
            && Number.isFinite(sourceRegion.yPx)
            && finitePositive(sourceRegion.widthPx)
            && finitePositive(sourceRegion.heightPx)
        );
    if (!sourceRegionValid) {
        return {
            kind: 'malformed',
            reason: 'dewarpMapping sourceRegion is invalid',
        };
    }
    const sourceRegionX = sourceRegion?.xPx ?? 0;
    const sourceRegionY = sourceRegion?.yPx ?? 0;
    const sourceRegionWidth = sourceRegion?.widthPx ?? inputWidth;
    const sourceRegionHeight = sourceRegion?.heightPx ?? inputHeight;
    const matchWidth = geometry.matchedCanvasContentWidthPx
        ?? geometry.outputWidthPx
        ?? mapping.outputWidth;
    const matchHeight = geometry.matchedCanvasContentHeightPx
        ?? geometry.outputHeightPx
        ?? mapping.outputHeight;
    if (!finitePositive(matchWidth) || !finitePositive(matchHeight)) {
        return {
            kind: 'malformed',
            reason: 'dewarpMapping has no positive output content dimensions',
        };
    }
    const semanticError = validateDewarpGridSemantics({
        columns,
        mapping,
        rows,
        sourceRegionHeight,
        sourceRegionWidth,
        sourceRegionX,
        sourceRegionY,
    });
    if (semanticError !== null) {
        return {
            kind: 'malformed',
            reason: semanticError,
        };
    }
    const canvasScaleX = cleaned.width / canvasWidth;
    const canvasScaleY = cleaned.height / canvasHeight;
    const outputScaleX = matchWidth / mapping.outputWidth;
    const outputScaleY = matchHeight / mapping.outputHeight;
    const scaleX = outputScaleX * canvasScaleX;
    const scaleY = outputScaleY * canvasScaleY;
    if (!finitePositive(scaleX) || !finitePositive(scaleY)) {
        return {
            kind: 'malformed',
            reason: 'dewarpMapping resolves to a non-positive output scale',
        };
    }
    const sourceToInput = point => {
        const fullSource = sourceCoordinateTransform === null
            ? point
            : mapSplitLocalPointToFullSource(point, sourceCoordinateTransform);
        const fullWidth = sourceCoordinateTransform?.fullWidth ?? source.width;
        const fullHeight = sourceCoordinateTransform?.fullHeight ?? source.height;
        return {
            x: fullSource.x / fullWidth * inputWidth,
            y: fullSource.y / fullHeight * inputHeight,
        };
    };
    const inputToSource = point => {
        const fullWidth = sourceCoordinateTransform?.fullWidth ?? source.width;
        const fullHeight = sourceCoordinateTransform?.fullHeight ?? source.height;
        const fullSource = {
            x: point.x / inputWidth * fullWidth,
            y: point.y / inputHeight * fullHeight,
        };
        return sourceCoordinateTransform === null
            ? {
                x: fullSource.x / fullWidth * source.width,
                y: fullSource.y / fullHeight * source.height,
            }
            : mapFullSourcePointToSplitLocal(fullSource, sourceCoordinateTransform);
    };
    const sourceToOutput = point => {
        const inputPoint = sourceToInput(point);
        const inputPointX = inputPoint.x;
        const inputPointY = inputPoint.y;
        if (
            inputPointX < sourceRegionX
            || inputPointX > sourceRegionX + sourceRegionWidth
            || inputPointY < sourceRegionY
            || inputPointY > sourceRegionY + sourceRegionHeight
        ) {
            return {
                x: Number.NaN,
                y: Number.NaN,
            };
        }
        const output = interpolateDewarpGrid(
            mapping.sourceToOutput,
            columns,
            rows,
            sourceRegionWidth,
            sourceRegionHeight,
            inputPointX - sourceRegionX,
            inputPointY - sourceRegionY,
        );
        return {
            x: (output.x * outputScaleX + placementOffsetX) * canvasScaleX,
            y: (output.y * outputScaleY + placementOffsetY) * canvasScaleY,
        };
    };
    const outputToSource = point => {
        const output = {
            x: (point.x / canvasScaleX - placementOffsetX) / outputScaleX,
            y: (point.y / canvasScaleY - placementOffsetY) / outputScaleY,
        };
        const sourcePoint = interpolateDewarpGrid(
            mapping.outputToSource,
            columns,
            rows,
            mapping.outputWidth,
            mapping.outputHeight,
            output.x,
            output.y,
        );
        return inputToSource(sourcePoint);
    };
    return {
        alignment: {
            dx: 0,
            dy: 0,
            fullOverlapScore: 0,
            mapOutputPoint: outputToSource,
            mapSourcePoint: sourceToOutput,
            overlapScore: 0,
            scale: {
                label: `canonical-dewarp-grid(${String(columns)}x${String(rows)})`,
                x: scaleX,
                y: scaleY,
            },
            scaleX,
            scaleY,
        },
        kind: 'valid',
    };
}

function alignAtDewarpGrid(source, cleaned, alignment) {
    const stride = Math.max(1, Math.ceil(source.blackCount / MAX_FULL_ALIGNMENT_SAMPLES));
    let ordinal = 0;
    let sampleCount = 0;
    let overlap = 0;
    for (let y = 0; y < source.height; y += 1) {
        const offset = y * source.width;
        for (let x = 0; x < source.width; x += 1) {
            if (!source.pixels[offset + x]) {
                continue;
            }
            if (ordinal % stride === 0) {
                const mapped = alignment.mapSourcePoint({
                    x,
                    y,
                });
                const targetX = Math.round(mapped.x);
                const targetY = Math.round(mapped.y);
                if (
                    targetX >= 0
                    && targetX < cleaned.width
                    && targetY >= 0
                    && targetY < cleaned.height
                    && cleaned.pixels[targetY * cleaned.width + targetX]
                ) {
                    overlap += 1;
                }
                sampleCount += 1;
            }
            ordinal += 1;
        }
    }
    const score = sampleCount === 0 ? 0 : overlap / sampleCount;
    return {
        ...alignment,
        fullOverlapScore: score,
        overlapScore: score,
    };
}

function ensureComponentPixels(component, componentLabels, sourceWidth) {
    if (component.pixels || !componentLabels) {
        return component.pixels ?? [];
    }
    const pixels = [];
    for (let y = component.y; y <= component.y + component.height - 1; y += 1) {
        const offset = y * sourceWidth;
        for (let x = component.x; x <= component.x + component.width - 1; x += 1) {
            if (componentLabels[offset + x] === component.id) {
                pixels.push(offset + x);
            }
        }
    }
    component.pixels = pixels;
    return pixels;
}

function mapSourcePixel(sourceX, sourceY, alignment, xMap, yMap) {
    if (typeof alignment.mapSourcePoint === 'function') {
        const mapped = alignment.mapSourcePoint({
            x: sourceX,
            y: sourceY,
        });
        if (!Number.isFinite(mapped.x) || !Number.isFinite(mapped.y)) {
            return null;
        }
        return {
            x: Math.round(mapped.x),
            y: Math.round(mapped.y),
        };
    }
    return {
        x: xMap[sourceX] + alignment.dx,
        y: yMap[sourceY] + alignment.dy,
    };
}

function mapComponentPixels(
    component,
    componentLabels,
    sourceWidth,
    xMap,
    yMap,
    alignment,
    targetWidth,
    targetHeight,
) {
    const sourcePixels = ensureComponentPixels(component, componentLabels, sourceWidth);
    const mappedPixels = new Int32Array(sourcePixels.length);
    let count = 0;
    let minX = targetWidth;
    let minY = targetHeight;
    let maxX = -1;
    let maxY = -1;
    for (const pixelIndex of sourcePixels) {
        const sourceX = pixelIndex % sourceWidth;
        const sourceY = Math.floor(pixelIndex / sourceWidth);
        const mapped = mapSourcePixel(sourceX, sourceY, alignment, xMap, yMap);
        if (mapped === null) {
            continue;
        }
        const targetX = mapped.x;
        const targetY = mapped.y;
        if (
            targetX < 0
            || targetX >= targetWidth
            || targetY < 0
            || targetY >= targetHeight
        ) {
            continue;
        }
        mappedPixels[count] = targetY * targetWidth + targetX;
        count += 1;
        minX = Math.min(minX, targetX);
        minY = Math.min(minY, targetY);
        maxX = Math.max(maxX, targetX);
        maxY = Math.max(maxY, targetY);
    }
    return {
        maxX,
        maxY,
        minX,
        minY,
        pixels: mappedPixels.subarray(0, count),
        sourcePixels,
    };
}

function countComponentCoverage(
    component,
    componentLabels,
    sourceWidth,
    xMap,
    yMap,
    alignment,
    target,
) {
    const sourcePixels = ensureComponentPixels(component, componentLabels, sourceWidth);
    let overlap = 0;
    for (const pixelIndex of sourcePixels) {
        const sourceX = pixelIndex % sourceWidth;
        const sourceY = Math.floor(pixelIndex / sourceWidth);
        const mapped = mapSourcePixel(sourceX, sourceY, alignment, xMap, yMap);
        if (mapped === null) {
            continue;
        }
        const targetX = mapped.x;
        const targetY = mapped.y;
        if (
            targetX >= 0
            && targetX < target.width
            && targetY >= 0
            && targetY < target.height
            && target.pixels[targetY * target.width + targetX]
        ) {
            overlap += 1;
        }
    }
    return overlap;
}

function countMappedComponentCoverage(mapped, target, deltaX = 0, deltaY = 0) {
    if (mapped.pixels.length === 0) {
        return 0;
    }
    const targetWidth = target.width;
    const targetHeight = target.height;
    const translatedMinX = mapped.minX + deltaX;
    const translatedMaxX = mapped.maxX + deltaX;
    const translatedMinY = mapped.minY + deltaY;
    const translatedMaxY = mapped.maxY + deltaY;
    let overlap = 0;
    if (
        translatedMinX >= 0
        && translatedMaxX < targetWidth
        && translatedMinY >= 0
        && translatedMaxY < targetHeight
    ) {
        const offset = deltaY * targetWidth + deltaX;
        for (const pixelIndex of mapped.pixels) {
            if (target.pixels[pixelIndex + offset]) {
                overlap += 1;
            }
        }
        return overlap;
    }
    for (const pixelIndex of mapped.pixels) {
        const baseX = pixelIndex % targetWidth;
        const baseY = Math.floor(pixelIndex / targetWidth);
        const targetX = baseX + deltaX;
        const targetY = baseY + deltaY;
        if (
            targetX >= 0
            && targetX < targetWidth
            && targetY >= 0
            && targetY < targetHeight
            && target.pixels[targetY * targetWidth + targetX]
        ) {
            overlap += 1;
        }
    }
    return overlap;
}

function searchLocalComponentCoverage(mapped, target, initialCount, radiusX, radiusY) {
    let best = {
        dx: 0,
        dy: 0,
        score: initialCount,
    };
    for (let dy = -radiusY; dy <= radiusY; dy += 1) {
        for (let dx = -radiusX; dx <= radiusX; dx += 1) {
            const candidate = {
                dx,
                dy,
                score: countMappedComponentCoverage(mapped, target, dx, dy),
            };
            if (preferCandidate(candidate, best, 0, 0)) {
                best = candidate;
            }
        }
    }
    return best;
}

function countComponentSupport(component, sourceSupport, deltaX = 0, deltaY = 0) {
    let supported = 0;
    for (const pixelIndex of component.pixels) {
        const baseX = pixelIndex % sourceSupport.width;
        const baseY = Math.floor(pixelIndex / sourceSupport.width);
        const supportX = baseX - deltaX;
        const supportY = baseY - deltaY;
        if (
            supportX >= 0
            && supportX < sourceSupport.width
            && supportY >= 0
            && supportY < sourceSupport.height
            && sourceSupport.pixels[supportY * sourceSupport.width + supportX]
        ) {
            supported += 1;
        }
    }
    return supported;
}

function searchLocalComponentSupport(component, sourceSupport, initialCount, radiusX, radiusY) {
    let best = {
        dx: 0,
        dy: 0,
        score: initialCount,
    };
    for (let dy = -radiusY; dy <= radiusY; dy += 1) {
        for (let dx = -radiusX; dx <= radiusX; dx += 1) {
            const candidate = {
                dx,
                dy,
                score: countComponentSupport(component, sourceSupport, dx, dy),
            };
            if (preferCandidate(candidate, best, 0, 0)) {
                best = candidate;
            }
        }
    }
    return best;
}

function evaluateGrayPreservation({
    alignment,
    cleanedGray,
    component,
    localDx,
    localDy,
    mapped,
    source,
    sourceGray,
    xMap,
    yMap,
}) {
    if (!cleanedGray || !sourceGray || !mapped || mapped.pixels.length === 0) {
        return null;
    }
    let sourceSum = 0;
    let cleanedSum = 0;
    let darkAtSource = 0;
    let sampleCount = 0;
    const sourceWidth = source.width;
    const cleanedWidth = cleanedGray.width;
    const sourcePixels = mapped.sourcePixels;
    for (const pixelIndex of sourcePixels) {
        const sourceX = pixelIndex % sourceWidth;
        const sourceY = Math.floor(pixelIndex / sourceWidth);
        const mappedPoint = mapSourcePixel(sourceX, sourceY, alignment, xMap, yMap);
        if (mappedPoint === null) {
            continue;
        }
        const targetX = mappedPoint.x + localDx;
        const targetY = mappedPoint.y + localDy;
        if (
            targetX < 0
            || targetX >= cleanedGray.width
            || targetY < 0
            || targetY >= cleanedGray.height
        ) {
            continue;
        }
        const sourceGrayValue = sourceGray.values[sourceY * sourceGray.width + sourceX];
        const cleanedGrayValue = cleanedGray.values[targetY * cleanedWidth + targetX];
        sourceSum += sourceGrayValue;
        cleanedSum += cleanedGrayValue;
        if (cleanedGrayValue <= GRAY_INK_THRESHOLD) {
            darkAtSource += 1;
        }
        sampleCount += 1;
    }
    if (sampleCount === 0) {
        return null;
    }
    const minX = mapped.minX + localDx;
    const maxX = mapped.maxX + localDx;
    const minY = mapped.minY + localDy;
    const maxY = mapped.maxY + localDy;
    let targetDarkCount = 0;
    if (
        minX <= maxX
        && minY <= maxY
        && minX >= 0
        && minY >= 0
        && maxX < cleanedGray.width
        && maxY < cleanedGray.height
    ) {
        for (let y = minY; y <= maxY; y += 1) {
            const offset = y * cleanedGray.width;
            for (let x = minX; x <= maxX; x += 1) {
                if (cleanedGray.values[offset + x] <= GRAY_INK_THRESHOLD) {
                    targetDarkCount += 1;
                }
            }
        }
    }
    const sourceMean = sourceSum / sampleCount;
    const cleanedMean = cleanedSum / sampleCount;
    const shapeRecall = darkAtSource / sampleCount;
    const shapeIntersection = darkAtSource;
    const shapeUnion = sampleCount + targetDarkCount - shapeIntersection;
    const shapeIoU = shapeUnion === 0 ? 0 : shapeIntersection / shapeUnion;
    const regularPreserved =
        Math.abs(cleanedMean - sourceMean) <= GRAY_MEAN_TOLERANCE
        && shapeRecall >= GRAY_MIN_SHAPE_RECALL
        && shapeIoU >= GRAY_MIN_SHAPE_IOU;
    const edgeCandidate =
        component.x <= 16
        || component.y <= 16
        || component.x + component.width >= source.width - 16
        || component.y + component.height >= source.height - 16;
    const edgePreserved =
        edgeCandidate
        && cleanedMean <= GRAY_EDGE_MAX_MEAN
        && shapeRecall >= GRAY_EDGE_MIN_SHAPE_RECALL
        && shapeIoU >= GRAY_EDGE_MIN_SHAPE_IOU;
    return {
        cleanedMeanGray: roundNumber(cleanedMean, 2),
        meanGrayDelta: roundNumber(Math.abs(cleanedMean - sourceMean), 2),
        preserved: regularPreserved || edgePreserved,
        preservationRule: edgePreserved ? 'edge' : regularPreserved ? 'shape' : null,
        shapeIoU: roundNumber(shapeIoU),
        shapeRecall: roundNumber(shapeRecall),
        sourceMeanGray: roundNumber(sourceMean, 2),
        targetDarkPixels: targetDarkCount,
    };
}

function analyzeComponents(
    source,
    cleanedDilated,
    alignment,
    minArea,
    plateRegions = [],
    sourceComponents = [],
    componentLabels = null,
    cleanedGray = null,
    sourceGray = null,
) {
    const sourceWidth = source.width;
    const components = [];
    const dustArea = Math.max(minArea, 200);
    const eligibleComponents = [];
    let ignoredDustCount = 0;
    let ignoredDustInkPixels = 0;
    let lostCount = 0;
    let damagedCount = 0;
    let lostInkPixels = 0;
    let globalLostCount = 0;
    let globalLostInkPixels = 0;
    let grayPreservedCount = 0;
    let grayPreservedInkPixels = 0;
    let textInkPixels = 0;
    let localSearchCount = 0;
    let localImprovedCount = 0;
    let maxLocalCoverageGain = 0;
    let maxLocalShiftDistance = 0;
    const {
        localRadiusX,
        localRadiusY,
    } = resolveOutputGridTolerances(alignment);
    const xMap = makeScaleMap(source.width, alignment.scaleX ?? alignment.scale);
    const yMap = makeScaleMap(source.height, alignment.scaleY ?? alignment.scale);
    for (const component of sourceComponents) {
        const {
            area,
            height: componentHeight,
            width: componentWidth,
            x: minX,
            y: minY,
        } = component;
        if (
            area < minArea
            || componentHeight < 8
            || componentHeight > 220
        ) {
            continue;
        }
        const centerX = minX + (componentWidth - 1) / 2;
        const centerY = minY + (componentHeight - 1) / 2;
        if (plateRegions.some(region =>
            centerX >= region.x
            && centerX < region.x + region.width
            && centerY >= region.y
            && centerY < region.y + region.height,
        )) {
            continue;
        }
        eligibleComponents.push(component);
        textInkPixels += area;
    }
    for (const component of eligibleComponents) {
        const {
            area,
            height: componentHeight,
            width: componentWidth,
            x: minX,
            y: minY,
        } = component;
        const globalCoveredPixels = countComponentCoverage(
            component,
            componentLabels,
            sourceWidth,
            xMap,
            yMap,
            alignment,
            cleanedDilated,
        );
        let localDx = 0;
        let localDy = 0;
        let coveredPixels = globalCoveredPixels;
        let coverage = area === 0 ? 0 : coveredPixels / area;
        let mapped = null;
        const isDust = area < dustArea;
        if (!isDust && coverage < 0.25) {
            globalLostCount += 1;
            globalLostInkPixels += area;
        }
        if (coverage < 0.6) {
            localSearchCount += 1;
            mapped = mapComponentPixels(
                component,
                componentLabels,
                sourceWidth,
                xMap,
                yMap,
                alignment,
                cleanedDilated.width,
                cleanedDilated.height,
            );
            const local = searchLocalComponentCoverage(
                mapped,
                cleanedDilated,
                globalCoveredPixels,
                localRadiusX,
                localRadiusY,
            );
            localDx = local.dx;
            localDy = local.dy;
            coveredPixels = local.score;
            coverage = area === 0 ? 0 : coveredPixels / area;
            const coverageGain = coverage - (area === 0 ? 0 : globalCoveredPixels / area);
            const shiftDistance = Math.abs(local.dx) + Math.abs(local.dy);
            maxLocalCoverageGain = Math.max(maxLocalCoverageGain, coverageGain);
            maxLocalShiftDistance = Math.max(maxLocalShiftDistance, shiftDistance);
            if (local.score > globalCoveredPixels) {
                localImprovedCount += 1;
            }
        }
        let classification = isDust
            ? 'ignored-dust'
            : coverage < 0.25
                ? 'lost'
                : coverage < 0.6
                    ? 'damaged'
                    : 'preserved';
        let gray = null;
        if (classification === 'lost') {
            gray = evaluateGrayPreservation({
                alignment,
                cleanedGray,
                localDx,
                localDy,
                mapped,
                component,
                source,
                sourceGray,
                xMap,
                yMap,
            });
            if (gray?.preserved) {
                classification = 'gray-preserved';
            }
        }
        if (isDust) {
            ignoredDustCount += 1;
            ignoredDustInkPixels += area;
        }
        if (classification === 'lost') {
            lostCount += 1;
            lostInkPixels += area;
        }
        if (classification === 'damaged') {
            damagedCount += 1;
        }
        if (classification === 'gray-preserved') {
            grayPreservedCount += 1;
            grayPreservedInkPixels += area;
        }
        components.push({
            area,
            bbox: {
                height: componentHeight,
                width: componentWidth,
                x: minX,
                y: minY,
            },
            classification,
            coverage: roundNumber(coverage),
            ...(localDx !== 0 || localDy !== 0
                ? {localAlignment: {
                    dx: localDx,
                    dy: localDy,
                }}
                : {}),
            ...(gray ? {gray} : {}),
        });
    }
    return {
        components,
        damagedCount,
        globalLostCount,
        globalLostInkFraction: textInkPixels === 0
            ? 0
            : globalLostInkPixels / textInkPixels,
        grayPreservedCount,
        grayPreservedInkPixels,
        ignoredDustCount,
        ignoredDustInkPixels,
        lostCount,
        lostInkFraction: textInkPixels === 0 ? 0 : lostInkPixels / textInkPixels,
        localRealignment: {
            improvedComponents: localImprovedCount,
            maxCoverageGain: roundNumber(maxLocalCoverageGain),
            maxShiftDistance: maxLocalShiftDistance,
            radiusPx: Math.max(localRadiusX, localRadiusY),
            radiusXPx: localRadiusX,
            radiusYPx: localRadiusY,
            searchedComponents: localSearchCount,
        },
        textInkPixels,
        totalTextComponents: components.length,
    };
}

function collectBinaryComponents(bitmap, includePixels = false) {
    const visited = new Uint8Array(bitmap.pixels.length);
    const stack = [];
    const components = [];
    for (let start = 0; start < bitmap.pixels.length; start += 1) {
        if (!bitmap.pixels[start] || visited[start]) {
            continue;
        }
        stack.length = 0;
        stack.push(start);
        visited[start] = 1;
        let area = 0;
        let minX = bitmap.width;
        let minY = bitmap.height;
        let maxX = -1;
        let maxY = -1;
        const pixels = includePixels ? [] : null;
        while (stack.length > 0) {
            const current = stack.pop();
            const currentX = current % bitmap.width;
            const currentY = Math.floor(current / bitmap.width);
            area += 1;
            minX = Math.min(minX, currentX);
            minY = Math.min(minY, currentY);
            maxX = Math.max(maxX, currentX);
            maxY = Math.max(maxY, currentY);
            if (pixels) {
                pixels.push(current);
            }
            for (
                let neighborY = Math.max(0, currentY - 1);
                neighborY <= Math.min(bitmap.height - 1, currentY + 1);
                neighborY += 1
            ) {
                const neighborOffset = neighborY * bitmap.width;
                for (
                    let neighborX = Math.max(0, currentX - 1);
                    neighborX <= Math.min(bitmap.width - 1, currentX + 1);
                    neighborX += 1
                ) {
                    const neighbor = neighborOffset + neighborX;
                    if (bitmap.pixels[neighbor] && !visited[neighbor]) {
                        visited[neighbor] = 1;
                        stack.push(neighbor);
                    }
                }
            }
        }
        components.push({
            area,
            fillRatio: area / ((maxX - minX + 1) * (maxY - minY + 1)),
            height: maxY - minY + 1,
            ...(pixels ? {pixels} : {}),
            width: maxX - minX + 1,
            x: minX,
            y: minY,
        });
    }
    return components;
}

function sourceRegionHistogram(sourceGray, bbox, alignment) {
    const histogram = new Uint32Array(256);
    const scaleX = alignment.scaleX ?? alignment.scale;
    const scaleY = alignment.scaleY ?? alignment.scale;
    let sampleCount = 0;
    const step = Math.max(1, Math.ceil(Math.sqrt(
        (bbox.width * bbox.height) / 60_000,
    )));
    for (let y = bbox.y; y < bbox.y + bbox.height; y += step) {
        const mappedY = typeof alignment.mapOutputPoint === 'function'
            ? alignment.mapOutputPoint({
                x: bbox.x,
                y,
            })
            : null;
        const sourceY = mappedY === null
            ? Math.min(
                sourceGray.height - 1,
                Math.max(0, Math.round((y - alignment.dy) / scaleY)),
            )
            : Math.min(sourceGray.height - 1, Math.max(0, Math.round(mappedY.y)));
        for (let x = bbox.x; x < bbox.x + bbox.width; x += step) {
            const mapped = typeof alignment.mapOutputPoint === 'function'
                ? alignment.mapOutputPoint({
                    x,
                    y,
                })
                : null;
            const sourceX = mapped === null
                ? Math.min(
                    sourceGray.width - 1,
                    Math.max(0, Math.round((x - alignment.dx) / scaleX)),
                )
                : Math.min(sourceGray.width - 1, Math.max(0, Math.round(mapped.x)));
            const sampledY = mapped === null
                ? sourceY
                : Math.min(sourceGray.height - 1, Math.max(0, Math.round(mapped.y)));
            histogram[sourceGray.values[sampledY * sourceGray.width + sourceX]] += 1;
            sampleCount += 1;
        }
    }
    let darkPixels = 0;
    let midtonePixels = 0;
    let lightPixels = 0;
    let weightedSum = 0;
    let weightedSquareSum = 0;
    let populatedBins = 0;
    for (let value = 0; value < histogram.length; value += 1) {
        const count = histogram[value];
        if (count > 0) {
            populatedBins += 1;
        }
        weightedSum += value * count;
        weightedSquareSum += value * value * count;
        if (value < 64) {
            darkPixels += count;
        } else if (value < 192) {
            midtonePixels += count;
        } else {
            lightPixels += count;
        }
    }
    const mean = sampleCount === 0 ? 0 : weightedSum / sampleCount;
    const variance = sampleCount === 0
        ? 0
        : Math.max(0, weightedSquareSum / sampleCount - mean * mean);
    const midtoneFraction = sampleCount === 0 ? 0 : midtonePixels / sampleCount;
    const darkFraction = sampleCount === 0 ? 0 : darkPixels / sampleCount;
    const lightFraction = sampleCount === 0 ? 0 : lightPixels / sampleCount;
    const bimodal =
        darkFraction >= 0.12
        && lightFraction >= 0.35
        && midtoneFraction < 0.18;
    return {
        bimodal,
        darkFraction: roundNumber(darkFraction),
        lightFraction: roundNumber(lightFraction),
        meanGray: roundNumber(mean, 2),
        midtoneFraction: roundNumber(midtoneFraction),
        paperReference: histogramPercentile(histogram, sampleCount, SOURCE_SUPPORT_PERCENTILE),
        populatedBins,
        photographic:
            sampleCount > 0
            && !bimodal
            && midtoneFraction >= 0.18
            && populatedBins >= 20
            && variance >= 400,
        sampleCount,
        standardDeviation: roundNumber(Math.sqrt(variance), 2),
    };
}

function histogramPercentile(histogram, sampleCount, fraction) {
    if (sampleCount === 0) {
        return 255;
    }
    const target = Math.round((sampleCount - 1) * fraction);
    let cumulative = 0;
    for (let value = 0; value < histogram.length; value += 1) {
        cumulative += histogram[value];
        if (cumulative > target) {
            return value;
        }
    }
    return 255;
}

function markSourceSupportForComponent({
    alignment,
    component,
    paddingX,
    paddingY,
    sourceGray,
    supportPixels,
    targetHeight,
    targetWidth,
    xMap,
    yMap,
}) {
    const bbox = {
        height: component.height + paddingY * 2,
        width: component.width + paddingX * 2,
        x: component.x - paddingX,
        y: component.y - paddingY,
    };
    const histogram = sourceRegionHistogram(sourceGray, bbox, alignment);
    const paperFloor = Math.max(
        0,
        histogram.paperReference - SOURCE_SUPPORT_PAPER_DELTA,
    );
    const scaleX = alignment.scaleX ?? alignment.scale;
    const scaleY = alignment.scaleY ?? alignment.scale;
    const mappedCorners = typeof alignment.mapOutputPoint === 'function'
        ? [
            [
                bbox.x,
                bbox.y,
            ],
            [
                bbox.x + bbox.width - 1,
                bbox.y,
            ],
            [
                bbox.x,
                bbox.y + bbox.height - 1,
            ],
            [
                bbox.x + bbox.width - 1,
                bbox.y + bbox.height - 1,
            ],
        ].map(([
            x,
            y,
        ]) => alignment.mapOutputPoint({
            x,
            y,
        }))
            .filter(point => point !== null && Number.isFinite(point.x) && Number.isFinite(point.y))
        : [];
    const sourceLeft = Math.max(0, Math.floor(mappedCorners.length > 0
        ? Math.min(...mappedCorners.map(point => point.x))
        : (bbox.x - alignment.dx) / scaleX) - 1);
    const sourceTop = Math.max(0, Math.floor(mappedCorners.length > 0
        ? Math.min(...mappedCorners.map(point => point.y))
        : (bbox.y - alignment.dy) / scaleY) - 1);
    const sourceRight = Math.min(sourceGray.width - 1, Math.ceil(mappedCorners.length > 0
        ? Math.max(...mappedCorners.map(point => point.x))
        : (bbox.x + bbox.width - 1 - alignment.dx) / scaleX) + 1);
    const sourceBottom = Math.min(sourceGray.height - 1, Math.ceil(mappedCorners.length > 0
        ? Math.max(...mappedCorners.map(point => point.y))
        : (bbox.y + bbox.height - 1 - alignment.dy) / scaleY) + 1);
    for (let sourceY = sourceTop; sourceY <= sourceBottom; sourceY += 1) {
        const sourceOffset = sourceY * sourceGray.width;
        for (let sourceX = sourceLeft; sourceX <= sourceRight; sourceX += 1) {
            if (sourceGray.values[sourceOffset + sourceX] >= paperFloor) {
                continue;
            }
            const mapped = mapSourcePixel(sourceX, sourceY, alignment, xMap, yMap);
            if (mapped === null) {
                continue;
            }
            const targetX = mapped.x;
            const targetY = mapped.y;
            if (
                targetX >= 0
                && targetX < targetWidth
                && targetY >= 0
                && targetY < targetHeight
            ) {
                supportPixels[targetY * targetWidth + targetX] = 1;
            }
        }
    }
    return {
        paperFloor,
        paperReference: histogram.paperReference,
    };
}

function analyzeInventedInk(cleaned, sourceGray, alignment, minArea) {
    const {
        areaScale,
        localRadiusX,
        localRadiusY,
    } = resolveOutputGridTolerances(alignment);
    const minimumComponentArea = Math.ceil(minArea * areaScale);
    const dustArea = Math.ceil(Math.max(minArea, 200) * areaScale);
    const inventedUnsupportedArea = dustArea * INVENTED_UNSUPPORTED_AREA_FACTOR;
    const components = collectBinaryComponents(cleaned, true)
        .filter(component => component.area >= minimumComponentArea);
    const scaleX = alignment.scaleX ?? alignment.scale;
    const scaleY = alignment.scaleY ?? alignment.scale;
    const supportPixels = new Uint8Array(cleaned.width * cleaned.height);
    const xMap = makeScaleMap(sourceGray.width, scaleX);
    const yMap = makeScaleMap(sourceGray.height, scaleY);
    let minimumPaperFloor = 255;
    let maximumPaperFloor = 0;
    let minimumPaperReference = 255;
    let maximumPaperReference = 0;
    for (const component of components) {
        const support = markSourceSupportForComponent({
            alignment,
            component,
            paddingX: localRadiusX,
            paddingY: localRadiusY,
            sourceGray,
            supportPixels,
            targetHeight: cleaned.height,
            targetWidth: cleaned.width,
            xMap,
            yMap,
        });
        minimumPaperFloor = Math.min(minimumPaperFloor, support.paperFloor);
        maximumPaperFloor = Math.max(maximumPaperFloor, support.paperFloor);
        minimumPaperReference = Math.min(minimumPaperReference, support.paperReference);
        maximumPaperReference = Math.max(maximumPaperReference, support.paperReference);
    }
    const sourceSupport = dilateBitmap(
        makeBitmap(cleaned.width, cleaned.height, supportPixels),
        Math.max(localRadiusX, localRadiusY),
    );
    const cleanedComponentLabels = new Int32Array(cleaned.width * cleaned.height);
    const unsupportedBitmap = new Uint8Array(cleaned.width * cleaned.height);
    let cleanedComponentInkPixels = 0;
    let ignoredDustCount = 0;
    let ignoredDustInkPixels = 0;
    const componentMetrics = components.map((component, componentIndex) => {
        for (const pixelIndex of component.pixels) {
            cleanedComponentLabels[pixelIndex] = componentIndex + 1;
        }
        const globalSupportedPixels = countComponentSupport(component, sourceSupport);
        const local = globalSupportedPixels / component.area < 0.6
            ? searchLocalComponentSupport(
                component,
                sourceSupport,
                globalSupportedPixels,
                localRadiusX,
                localRadiusY,
            )
            : {
                dx: 0,
                dy: 0,
                score: globalSupportedPixels,
            };
        let unsupportedPixels = 0;
        for (const pixelIndex of component.pixels) {
            const baseX = pixelIndex % cleaned.width;
            const baseY = Math.floor(pixelIndex / cleaned.width);
            const supportX = baseX - local.dx;
            const supportY = baseY - local.dy;
            const supported =
                supportX >= 0
                && supportX < cleaned.width
                && supportY >= 0
                && supportY < cleaned.height
                && sourceSupport.pixels[supportY * cleaned.width + supportX];
            if (!supported) {
                unsupportedBitmap[pixelIndex] = 1;
                unsupportedPixels += 1;
            }
        }
        cleanedComponentInkPixels += component.area;
        return {
            component,
            local,
            unsupportedFraction: roundNumber(unsupportedPixels / component.area),
            unsupportedPixels,
        };
    });
    const unsupportedComponents = collectBinaryComponents(
        makeBitmap(cleaned.width, cleaned.height, unsupportedBitmap),
        true,
    );
    const inventedUnsupportedPixels = new Uint32Array(components.length);
    for (const unsupportedComponent of unsupportedComponents) {
        if (unsupportedComponent.area < inventedUnsupportedArea) {
            continue;
        }
        const owner = cleanedComponentLabels[unsupportedComponent.pixels[0]] - 1;
        if (owner >= 0) {
            inventedUnsupportedPixels[owner] += unsupportedComponent.area;
        }
    }
    let inventedCount = 0;
    let inventedInkPixels = 0;
    const analyzedComponents = componentMetrics.map((metrics, componentIndex) => {
        const {
            component,
            local,
        } = metrics;
        const isDust = component.area < dustArea;
        const inventedPixels = inventedUnsupportedPixels[componentIndex];
        const materiallyUnsupported = inventedPixels / component.area
            >= INVENTED_MIN_UNSUPPORTED_FRACTION;
        const classification = isDust
            ? 'ignored-dust'
            : materiallyUnsupported
                ? 'invented'
                : 'preserved';
        if (isDust) {
            ignoredDustCount += 1;
            ignoredDustInkPixels += component.area;
        }
        if (classification === 'invented') {
            inventedCount += 1;
            inventedInkPixels += inventedPixels;
        }
        return {
            area: component.area,
            bbox: {
                height: component.height,
                width: component.width,
                x: component.x,
                y: component.y,
            },
            classification,
            coverage: roundNumber(local.score / component.area),
            ...(local.dx !== 0 || local.dy !== 0
                ? {localAlignment: {
                    dx: local.dx,
                    dy: local.dy,
                }}
                : {}),
            unsupportedFraction: metrics.unsupportedFraction,
            ...(classification === 'invented'
                ? {unsupportedComponentArea: inventedPixels}
                : {}),
        };
    });
    return {
        cleanedComponentInkPixels,
        components: analyzedComponents,
        ignoredDustCount,
        ignoredDustInkPixels,
        inventedCount,
        inventedInkFraction: cleaned.blackCount === 0
            ? 0
            : inventedInkPixels / cleaned.blackCount,
        inventedInkPixels,
        sourceSupport: {
            alignmentRadiusPx: Math.max(localRadiusX, localRadiusY),
            alignmentRadiusXPx: localRadiusX,
            alignmentRadiusYPx: localRadiusY,
            maximumPaperFloor,
            maximumPaperReference,
            minimumPaperFloor: components.length === 0 ? null : minimumPaperFloor,
            minimumPaperReference: components.length === 0 ? null : minimumPaperReference,
            paperDelta: SOURCE_SUPPORT_PAPER_DELTA,
            minimumComponentArea,
            minimumUnsupportedComponentArea: inventedUnsupportedArea,
            minimumUnsupportedComponentFraction: INVENTED_MIN_UNSUPPORTED_FRACTION,
        },
    };
}

function collectSilhouetteComponents(cleaned, cleanedRow) {
    if (cleanedRow.type !== 'stencil') {
        return [];
    }
    const xPpi = cleanedRow.xPpi || 360;
    const yPpi = cleanedRow.yPpi || xPpi;
    const minArea =
        (SILHOUETTE_MIN_SIZE_MM * xPpi / 25.4)
        * (SILHOUETTE_MIN_SIZE_MM * yPpi / 25.4);
    const fullResolutionComponents = collectBinaryComponents(cleaned)
        .filter(component => component.area >= minArea && component.fillRatio >= 0.8)
        .map(component => ({
            component,
            factor: 1,
        }));
    return fullResolutionComponents.length > 0
        ? fullResolutionComponents
        : collectBinaryComponents(downsampleBitmap(cleaned, SILHOUETTE_COARSE_DOWNSAMPLE))
            .filter(component =>
                component.area * SILHOUETTE_COARSE_DOWNSAMPLE ** 2 >= minArea
                && component.fillRatio >= 0.8,
            )
            .filter(component =>
                component.width * SILHOUETTE_COARSE_DOWNSAMPLE <= SILHOUETTE_COARSE_MAX_BBOX_PX
                && component.height * SILHOUETTE_COARSE_DOWNSAMPLE <= SILHOUETTE_COARSE_MAX_BBOX_PX,
            )
            .filter(component =>
                component.width * SILHOUETTE_COARSE_DOWNSAMPLE >= SILHOUETTE_COARSE_MIN_BBOX_PX
                && component.height * SILHOUETTE_COARSE_DOWNSAMPLE >= SILHOUETTE_COARSE_MIN_BBOX_PX,
            )
            .map(component => ({
                component,
                factor: SILHOUETTE_COARSE_DOWNSAMPLE,
            }));
}

function detectSilhouettes(cleaned, cleanedRow, sourceGray, alignment, candidates = null) {
    if (cleanedRow.type !== 'stencil' || !sourceGray) {
        return [];
    }
    const candidateComponents = candidates ?? collectSilhouetteComponents(cleaned, cleanedRow);
    const xPpi = cleanedRow.xPpi || 360;
    const yPpi = cleanedRow.yPpi || xPpi;
    const minimumDimensionPx = SILHOUETTE_MIN_SIZE_MM
        * Math.min(xPpi, yPpi)
        / 25.4
        * SILHOUETTE_MIN_DIMENSION_FACTOR;
    return candidateComponents.flatMap(({
        component,
        factor,
    }) => {
        const x = component.x * factor;
        const y = component.y * factor;
        const bbox = {
            height: Math.min(cleaned.height, y + component.height * factor) - y,
            width: Math.min(cleaned.width, x + component.width * factor) - x,
            x,
            y,
        };
        const histogram = sourceRegionHistogram(sourceGray, bbox, alignment);
        if (
            component.width * factor < minimumDimensionPx
                || component.height * factor < minimumDimensionPx
                || histogram.lightFraction > SILHOUETTE_SOURCE_MAX_LIGHT_FRACTION
                || histogram.darkFraction > SILHOUETTE_SOURCE_MAX_DARK_FRACTION
                || histogram.midtoneFraction < SILHOUETTE_SOURCE_MIN_MIDTONE_FRACTION
                || histogram.standardDeviation > SILHOUETTE_SOURCE_MAX_STANDARD_DEVIATION
                || !histogram.photographic
                || (
                    factor > 1
                    && histogram.darkFraction < SILHOUETTE_COARSE_MIN_DARK_FRACTION
                )
        ) {
            return [];
        }
        return [{
            area: component.area * factor ** 2,
            bbox,
            fillRatio: roundNumber(component.fillRatio),
            resolution: factor === 1 ? 'full' : `coarse-${String(factor)}x`,
            sourceHistogram: histogram,
        }];
    });
}

function roundNumber(value, digits = 6) {
    return Number(value.toFixed(digits));
}

function pageError(pageNumber, outputPageNumber, error) {
    return {
        flagged: false,
        inventedFlagged: false,
        inventedCount: 0,
        inventedInkFraction: 0,
        outputPage: outputPageNumber,
        page: pageNumber,
        status: 'error',
        error: getCliErrorMessage(error),
        silhouetteFlagged: false,
        silhouettes: [],
    };
}

async function analyzePage({
    cleanedRowsByPage,
    mappingActive,
    minArea,
    outputPageNumber,
    outputPageNumbers,
    pageNumber,
    renderGeometry,
    splitIndex,
    sourceRowsByPage,
    sourcePdf,
    cleanedPdf,
    workDirectory,
}) {
    const sourceRows = sourceRowsByPage.get(pageNumber) ?? [];
    const cleanedRows = cleanedRowsByPage.get(outputPageNumber) ?? [];
    const sourceRow = selectSourceMaskRow(sourceRows);
    if (!sourceRow) {
        return {
            flagged: false,
            inventedFlagged: false,
            inventedCount: 0,
            inventedInkFraction: 0,
            page: pageNumber,
            outputPage: outputPageNumber,
            reason: 'source has no bilevel mask or single grayscale image',
            status: 'skipped',
        };
    }
    const cleanedRow = selectCleanedInkRow(cleanedRows);
    if (!cleanedRow) {
        return {
            flagged: false,
            inventedFlagged: false,
            inventedCount: 0,
            inventedInkFraction: 0,
            outputPage: outputPageNumber,
            page: pageNumber,
            reason: 'cleaned page publishes no bilevel image or stencil',
            status: 'skipped',
        };
    }
    try {
        let source = await extractPngMask({
            includeGray: sourceRow.color === 'rgb',
            pageNumber,
            pdfPath: sourcePdf,
            role: 'source',
            row: sourceRow,
            rows: sourceRows,
            workDirectory,
        });
        if (sourceRow.color === 'rgb') {
            source = makeConservativeRgbSupport(source);
        }
        const cleaned = await extractPngMask({
            pageNumber: outputPageNumber,
            pdfPath: cleanedPdf,
            role: 'cleaned',
            row: cleanedRow,
            rows: cleanedRows,
            workDirectory,
        });
        const splitRows = outputPageNumbers
            .map(outputPage => selectCleanedInkRow(cleanedRowsByPage.get(outputPage) ?? []))
            .filter(row => row !== null);
        const sourceSplitTransform = outputPageNumbers.length > 1
            ? resolveSplitSourceTransform(source, splitRows, outputPageNumbers.length, splitIndex)
            : null;
        const sourceForAudit = sourceSplitTransform === null
            ? source
            : applySourceSplitTransform(source, sourceSplitTransform);
        const sourceCoordinateTransform = sourceSplitTransform === null
            ? null
            : {
                ...sourceSplitTransform,
                fullHeight: source.height,
                fullWidth: source.width,
            };
        const dewarpGeometry = resolveDewarpGeometryAlignment(
            renderGeometry,
            sourceForAudit,
            cleaned,
            sourceCoordinateTransform,
        );
        if (dewarpGeometry.kind === 'missing') {
            return {
                flagged: false,
                inventedFlagged: false,
                inventedCount: 0,
                inventedInkFraction: 0,
                outputPage: outputPageNumber,
                page: pageNumber,
                reason: dewarpGeometry.reason,
                status: 'skipped',
            };
        }
        if (dewarpGeometry.kind === 'malformed') {
            return pageError(
                pageNumber,
                outputPageNumber,
                dewarpGeometry.reason,
            );
        }
        const sourceAlignment = makeAlignmentBitmap(sourceForAudit, minArea, true);
        const cleanedAlignment = makeAlignmentBitmap(cleaned, minArea);
        const alignmentSource = sourceAlignment.bitmap;
        const alignmentCleaned = cleanedAlignment.bitmap;
        const alignmentSourceTop = alignmentSource;
        const alignmentCleanedTop = alignmentCleaned;
        const canonicalGeometryScale = dewarpGeometry.kind === 'valid'
            ? null
            : resolveCanonicalGeometryScale(
                renderGeometry,
                sourceForAudit,
                cleaned,
            );
        const canonicalGeometryAlignment = dewarpGeometry.kind === 'valid'
            ? alignAtDewarpGrid(sourceForAudit, cleaned, dewarpGeometry.alignment)
            : canonicalGeometryScale === null
                ? null
                : alignAtScale(
                    sourceForAudit,
                    cleaned,
                    canonicalGeometryScale,
                    alignmentSourceTop,
                    alignmentCleanedTop,
                );
        const alignmentOne = canonicalGeometryAlignment === null
            ? alignAtScale(
                sourceForAudit,
                cleaned,
                1,
                alignmentSourceTop,
                alignmentCleanedTop,
            )
            : null;
        const alignments = canonicalGeometryAlignment === null
            ? [alignmentOne]
            : [canonicalGeometryAlignment];
        if (alignmentOne !== null && alignmentOne.overlapScore < 0.4) {
            alignments.push(alignAtScale(
                sourceForAudit,
                cleaned,
                CROP_SCALE,
                alignmentSourceTop,
                alignmentCleanedTop,
            ));
        }
        if (
            canonicalGeometryAlignment === null
            && Math.max(...alignments.map(candidate => candidate.fullOverlapScore)) < 0.7
        ) {
            const dimensionScaleX = cleaned.width / sourceForAudit.width;
            const dimensionScaleY = cleaned.height / sourceForAudit.height;
            const dimensionScale = {
                label: `dimension-fit(${dimensionScaleX.toFixed(6)}x${dimensionScaleY.toFixed(6)})`,
                x: dimensionScaleX,
                y: dimensionScaleY,
            };
            if (
                Math.abs(dimensionScale.x - 1) > 1e-6
                || Math.abs(dimensionScale.y - 1) > 1e-6
            ) {
                alignments.push(alignAtScale(
                    sourceForAudit,
                    cleaned,
                    dimensionScale,
                    alignmentSourceTop,
                    alignmentCleanedTop,
                ));
            }
        }
        const uniformScaleValue = cleaned.height / sourceForAudit.height;
        if (
            canonicalGeometryAlignment === null
            && mappingActive
            && Math.abs(uniformScaleValue - 1) > 1e-6
        ) {
            alignments.push(alignAtScale(
                sourceForAudit,
                cleaned,
                {
                    label: `uniform-fit(${uniformScaleValue.toFixed(6)})`,
                    x: uniformScaleValue,
                    y: uniformScaleValue,
                },
                alignmentSourceTop,
                alignmentCleanedTop,
            ));
        }
        // Canonical V3 geometry is the conversion contract. Empirical fitting
        // remains a fallback for old summaries and fixtures, but must not
        // override known page placement with a visually plausible transform
        // that compares different source lines. Declared dewarp grids take the
        // nonlinear path above and never fall back to an affine fit.
        const alignment = canonicalGeometryAlignment ?? alignments.reduce((best, candidate) =>
            candidate.fullOverlapScore > best.fullOverlapScore ? candidate : best,
        );
        const alignmentReliable =
            (
                alignment.overlapScore >= ALIGNMENT_MIN_RELIABLE_OVERLAP
                && (
                    alignment.fullOverlapScore >= ALIGNMENT_MIN_RELIABLE_OVERLAP
                    || alignment.overlapScore >= ALIGNMENT_STRONG_SOURCE_OVERLAP
                )
            )
            || (
                sourceRow.color === 'rgb'
                && cleaned.blackCount === 0
                && sourceAlignment.bitmap.blackCount > 0
            );
        const auditDilationRadius = resolveAuditDilationRadius(
            cleanedRow,
            mappingActive,
            alignment,
        );
        const cleanedDilated = dilateBitmap(cleaned, auditDilationRadius);
        const preliminaryMetrics = analyzeComponents(
            sourceForAudit,
            cleanedDilated,
            alignment,
            minArea,
            sourceAlignment.plateRegions,
            sourceAlignment.components,
            sourceAlignment.componentLabels,
        );
        const silhouetteCandidates = collectSilhouetteComponents(cleaned, cleanedRow);
        const dpi = Math.round(Math.max(sourceRow.xPpi || 360, sourceRow.yPpi || 360));
        const renderedSource = await renderPdfPageGray({
            dpi,
            pageNumber,
            pdfPath: sourcePdf,
            role: 'source',
            workDirectory,
        });
        const sourceGrayFrame = resizeGrayBitmap(
            renderedSource,
            sourceSplitTransform?.width ?? source.width,
            sourceSplitTransform?.height ?? source.height,
            renderedSource.width / (sourceSplitTransform?.width ?? source.width),
            renderedSource.height / (sourceSplitTransform?.height ?? source.height),
        );
        const sourceGray = sourceSplitTransform === null
            ? sourceGrayFrame
            : applySourceGraySplitTransform(sourceGrayFrame, sourceSplitTransform);
        let cleanedGray = null;
        if (preliminaryMetrics.lostCount > 0) {
            const renderedCleaned = await renderPdfPageGray({
                dpi: Math.round(Math.max(cleanedRow.xPpi || dpi, cleanedRow.yPpi || dpi)),
                pageNumber: outputPageNumber,
                pdfPath: cleanedPdf,
                role: 'cleaned',
                workDirectory,
            });
            cleanedGray = resizeGrayBitmap(
                renderedCleaned,
                cleaned.width,
                cleaned.height,
                renderedCleaned.width / cleaned.width,
                renderedCleaned.height / cleaned.height,
            );
        }
        const componentMetrics = preliminaryMetrics.lostCount > 0
            ? analyzeComponents(
                sourceForAudit,
                cleanedDilated,
                alignment,
                minArea,
                sourceAlignment.plateRegions,
                sourceAlignment.components,
                sourceAlignment.componentLabels,
                cleanedGray,
                // The rendered fallback for a raw ImageMask can invert its
                // paper plane. Never let that gray rendering turn a removed
                // RGB source component into a false preservation result.
                sourceRow.color === 'rgb' || renderGeometry?.dewarped === true
                    ? null
                    : sourceGray,
            )
            : preliminaryMetrics;
        const inventedMetrics = analyzeInventedInk(
            cleaned,
            sourceGray,
            alignment,
            minArea,
        );
        const silhouettes = alignmentReliable && silhouetteCandidates.length > 0
            ? detectSilhouettes(cleaned, cleanedRow, sourceGray, alignment, silhouetteCandidates)
            : [];
        const potentialFlagged =
            componentMetrics.lostCount >= 3
            || componentMetrics.lostInkFraction >= 0.01;
        const comparisonSuppressed = !alignmentReliable;
        const lossFlagged = alignmentReliable && potentialFlagged;
        const inventedFlagged = alignmentReliable && inventedMetrics.inventedCount > 0;
        const flagged = lossFlagged || inventedFlagged;
        const silhouetteFlagged = silhouettes.length > 0;
        const result = {
            alignment: {
                attemptedScales: alignments.map(candidate =>
                    scaleLabel(candidate.scale),
                ),
                dx: alignment.dx,
                dy: alignment.dy,
                fullOverlapScore: roundNumber(alignment.fullOverlapScore),
                overlapScore: roundNumber(alignment.overlapScore),
                reliable: alignmentReliable,
                scale: scaleLabel(alignment.scale),
                scaleX: roundNumber(alignment.scaleX),
                scaleY: roundNumber(alignment.scaleY),
                attempts: alignments.map(candidate => ({
                    broadDx: candidate.broadDx,
                    broadDy: candidate.broadDy,
                    dx: candidate.dx,
                    dy: candidate.dy,
                    fullOverlapScore: roundNumber(candidate.fullOverlapScore),
                    overlapScore: roundNumber(candidate.overlapScore),
                    quarterDx: candidate.quarterDx,
                    quarterDy: candidate.quarterDy,
                    scale: scaleLabel(candidate.scale),
                })),
            },
            cleanedInkPixels: cleaned.blackCount,
            alignmentSourceInkPixels: alignmentSource.blackCount,
            alignmentCleanedInkPixels: alignmentCleaned.blackCount,
            cleanedImage: {
                encoding: cleanedRow.encoding,
                height: cleaned.height,
                type: cleanedRow.type,
                width: cleaned.width,
            },
            damagedCount: componentMetrics.damagedCount,
            flagged,
            globalLostCount: componentMetrics.globalLostCount,
            globalLostInkFraction: roundNumber(componentMetrics.globalLostInkFraction),
            grayPreservedCount: componentMetrics.grayPreservedCount,
            grayPreservedInkPixels: componentMetrics.grayPreservedInkPixels,
            ignoredDustCount: componentMetrics.ignoredDustCount,
            ignoredDustInkPixels: componentMetrics.ignoredDustInkPixels,
            inventedFlagged,
            inventedCount: inventedMetrics.inventedCount,
            inventedInkFraction: roundNumber(inventedMetrics.inventedInkFraction),
            inventedInkPixels: inventedMetrics.inventedInkPixels,
            inventedSourceSupport: inventedMetrics.sourceSupport,
            lossFlagged,
            lostCount: componentMetrics.lostCount,
            lostInkFraction: roundNumber(componentMetrics.lostInkFraction),
            localRealignment: componentMetrics.localRealignment,
            auditDilationRadius,
            ...(comparisonSuppressed
                ? {comparisonSuppressed: 'alignment overlap below reliable threshold'}
                : {}),
            outputPage: outputPageNumber,
            page: pageNumber,
            silhouetteFlagged,
            silhouettes,
            sourceImage: {
                bpc: sourceRow.bpc,
                color: sourceRow.color,
                encoding: sourceRow.encoding,
                height: sourceForAudit.height,
                type: sourceRow.type,
                width: sourceForAudit.width,
                ...(sourceForAudit.rgbSupport === undefined
                    ? {}
                    : {support: {
                        kind: 'conservative-rgb',
                        paperReference: sourceForAudit.rgbSupport.paperReference,
                        threshold: sourceForAudit.rgbSupport.threshold,
                    }}),
            },
            sourceInkPixels: sourceForAudit.blackCount,
            status: 'analyzed',
            totalTextComponents: componentMetrics.totalTextComponents,
            textInkPixels: componentMetrics.textInkPixels,
        };
        if (flagged || componentMetrics.grayPreservedCount > 0) {
            result.components = [
                ...componentMetrics.components,
                ...inventedMetrics.components,
            ];
        }
        return result;
    } catch (error) {
        return pageError(pageNumber, outputPageNumber, error);
    }
}

function sumPageValues(pages, key) {
    return pages.reduce((total, page) => total + (page[key] ?? 0), 0);
}

function weightedPageFraction(pages, fractionKey, weightKey) {
    const weight = sumPageValues(pages, weightKey);
    return weight === 0
        ? 0
        : pages.reduce(
            (total, page) => total + (page[fractionKey] ?? 0) * (page[weightKey] ?? 0),
            0,
        ) / weight;
}

function summarizeMappedPage(pageNumber, outputPageNumbers, pageAudits) {
    const analyzed = pageAudits.filter(page => page.status === 'analyzed');
    const first = pageAudits[0] ?? {
        flagged: false,
        page: pageNumber,
        status: 'skipped',
    };
    if (analyzed.length === 0) {
        return {
            ...first,
            outputPage: outputPageNumbers.length === 1 ? outputPageNumbers[0] : null,
            outputPages: outputPageNumbers,
            page: pageNumber,
        };
    }
    if (analyzed.length === 1 && pageAudits.length === 1) {
        return {
            ...analyzed[0],
            outputPages: outputPageNumbers,
        };
    }
    const silhouettes = pageAudits.flatMap(page => (page.silhouettes ?? []).map(silhouette => ({
        ...silhouette,
        outputPage: page.outputPage,
    })));
    const components = pageAudits.flatMap(page => (page.components ?? []).map(component => ({
        ...component,
        outputPage: page.outputPage,
    })));
    const textInkPixels = sumPageValues(analyzed, 'textInkPixels');
    const result = {
        alignment: null,
        alignmentCleanedInkPixels: sumPageValues(analyzed, 'alignmentCleanedInkPixels'),
        alignmentSourceInkPixels: sumPageValues(analyzed, 'alignmentSourceInkPixels'),
        cleanedImage: analyzed[0].cleanedImage,
        cleanedInkPixels: sumPageValues(analyzed, 'cleanedInkPixels'),
        damagedCount: sumPageValues(analyzed, 'damagedCount'),
        flagged: analyzed.some(page => page.flagged),
        globalLostCount: sumPageValues(analyzed, 'globalLostCount'),
        globalLostInkFraction: weightedPageFraction(analyzed, 'globalLostInkFraction', 'textInkPixels'),
        grayPreservedCount: sumPageValues(analyzed, 'grayPreservedCount'),
        grayPreservedInkPixels: sumPageValues(analyzed, 'grayPreservedInkPixels'),
        ignoredDustCount: sumPageValues(analyzed, 'ignoredDustCount'),
        ignoredDustInkPixels: sumPageValues(analyzed, 'ignoredDustInkPixels'),
        inventedFlagged: analyzed.some(page => page.inventedFlagged),
        inventedCount: sumPageValues(analyzed, 'inventedCount'),
        inventedInkFraction: weightedPageFraction(analyzed, 'inventedInkFraction', 'cleanedInkPixels'),
        inventedInkPixels: sumPageValues(analyzed, 'inventedInkPixels'),
        ...(analyzed.some(page => page.comparisonSuppressed !== undefined)
            ? {comparisonSuppressed: 'one or more output comparisons had unreliable alignment'}
            : {}),
        lossFlagged: analyzed.some(page => page.lossFlagged),
        localRealignment: {
            improvedComponents: analyzed.reduce(
                (total, page) => total + (page.localRealignment?.improvedComponents ?? 0),
                0,
            ),
            maxCoverageGain: Math.max(...analyzed.map(page => page.localRealignment?.maxCoverageGain ?? 0)),
            maxShiftDistance: Math.max(...analyzed.map(page => page.localRealignment?.maxShiftDistance ?? 0)),
            radiusPx: Math.max(...analyzed.map(page => page.localRealignment?.radiusPx ?? 0)),
            searchedComponents: analyzed.reduce(
                (total, page) => total + (page.localRealignment?.searchedComponents ?? 0),
                0,
            ),
        },
        lostCount: sumPageValues(analyzed, 'lostCount'),
        lostInkFraction: weightedPageFraction(analyzed, 'lostInkFraction', 'textInkPixels'),
        outputAudits: pageAudits,
        outputPage: null,
        outputPages: outputPageNumbers,
        page: pageNumber,
        silhouetteFlagged: silhouettes.length > 0,
        silhouettes,
        sourceImage: analyzed[0].sourceImage,
        sourceInkPixels: sumPageValues(analyzed, 'sourceInkPixels'),
        status: 'analyzed',
        textInkPixels,
        totalTextComponents: sumPageValues(analyzed, 'totalTextComponents'),
    };
    if (result.flagged || result.grayPreservedCount > 0 || components.length > 0) {
        result.components = components;
    }
    return result;
}

async function analyzeMappedPage({
    cleanedRowsByPage,
    mappingActive,
    minArea,
    outputPageNumbers,
    pageNumber,
    renderGeometryByOutput,
    sourceRowsByPage,
    sourcePdf,
    cleanedPdf,
    workDirectory,
}) {
    if (outputPageNumbers.length === 0) {
        return {
            flagged: false,
            outputPages: [],
            page: pageNumber,
            reason: 'mapping has no cleaned output page',
            status: 'skipped',
        };
    }
    const pageAudits = [];
    for (const [
        splitIndex,
        outputPageNumber,
    ] of outputPageNumbers.entries()) {
        pageAudits.push(await analyzePage({
            cleanedRowsByPage,
            mappingActive,
            minArea,
            outputPageNumber,
            outputPageNumbers,
            pageNumber,
            renderGeometry: renderGeometryByOutput.get(outputPageNumber) ?? null,
            splitIndex,
            sourceRowsByPage,
            sourcePdf,
            cleanedPdf,
            workDirectory,
        }));
    }
    return summarizeMappedPage(pageNumber, outputPageNumbers, pageAudits);
}

async function mapPages(pages, workers, task) {
    const results = new Array(pages.length);
    let cursor = 0;
    const workerCount = Math.min(workers, pages.length || 1);
    await Promise.all(Array.from({length: workerCount}, async (_, workerIndex) => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= pages.length) {
                return;
            }
            results[index] = await task(pages[index], workerIndex);
        }
    }));
    return results;
}

async function readPageCount(pdfPath, fallback) {
    const result = await run('pdfinfo', [pdfPath]);
    const match = /^Pages:\s+(\d+)$/mu.exec(result.stdout);
    return match ? Number(match[1]) : fallback;
}

async function readProvenanceStampHex(pdfPath) {
    const trailerResult = await run('qpdf', [
        '--json',
        '--object-streams=disable',
        pdfPath,
        '-',
    ]);
    let document;
    try {
        document = JSON.parse(trailerResult.stdout);
    } catch {
        throw new Error(`qpdf returned invalid JSON while reading ${pdfPath}`);
    }
    const trailer = Array.isArray(document?.qpdf)
        ? document.qpdf.find(entry => entry?.trailer?.value !== undefined)?.trailer?.value
        : undefined;
    const infoReference = trailer?.['/Info'];
    if (infoReference === undefined) {
        return null;
    }
    if (typeof infoReference !== 'string') {
        return '__invalid_info_reference__';
    }
    const reference = /^(\d+) (\d+) R$/u.exec(infoReference);
    if (!reference) {
        return '__invalid_info_reference__';
    }
    // The Info dictionary is read from qpdf's structured JSON rather than
    // from rendered object text: a regex over rendered text could match a
    // stamp-shaped payload embedded inside another string value such as
    // /Producer. Native writers store the lowercase hex payload as a PDF
    // literal string and test injections use a hexadecimal string; qpdf's
    // JSON encodes both as "u:<text>" when the bytes are printable, or
    // "b:<hex>" otherwise, so both wire spellings collapse here while the
    // core decoder stays fail-closed.
    const infoEntry = document.qpdf.find(entry => Object.hasOwn(entry, `obj:${infoReference}`));
    const infoValue = infoEntry?.[`obj:${infoReference}`]?.value;
    if (infoValue === undefined || typeof infoValue !== 'object') {
        return '__invalid_info_reference__';
    }
    const stamp = infoValue['/EVBScanCleanup'];
    if (stamp === undefined) {
        return null;
    }
    if (typeof stamp !== 'string') {
        return '__invalid_stamp_encoding__';
    }
    if (stamp.startsWith('u:')) {
        return stamp.slice(2);
    }
    if (stamp.startsWith('b:')) {
        return Buffer.from(stamp.slice(2), 'hex').toString('latin1');
    }
    return '__invalid_stamp_encoding__';
}

function stampMappingMismatch(payload, pageMapping, from, to) {
    if (pageMapping === null) {
        return null;
    }
    const mappingsBySource = new Map();
    for (const mapping of payload.outputMappings) {
        const current = mappingsBySource.get(mapping.sourcePage) ?? [];
        current.push(mapping);
        mappingsBySource.set(mapping.sourcePage, current);
    }
    for (let sourcePage = from; sourcePage <= to; sourcePage += 1) {
        const actualMappings = mappingsBySource.get(sourcePage);
        const expectedOutputPages = pageMapping.pages.get(sourcePage);
        if (actualMappings === undefined || expectedOutputPages === undefined) {
            return `stamp mapping is missing source page ${String(sourcePage)}`;
        }
        const actualOutputPages = actualMappings
            .filter(mapping => mapping.outputOrdinal !== null)
            .map(mapping => mapping.outputOrdinal)
            .sort((left, right) => left - right);
        const expected = [...expectedOutputPages].sort((left, right) => left - right);
        if (JSON.stringify(actualOutputPages) !== JSON.stringify(expected)) {
            return `stamp mapping disagrees with published output mapping for source page ${String(sourcePage)}`;
        }
    }
    return null;
}

async function verifyCleanedStamp(options, pageMapping, from, to) {
    const stampHex = await readProvenanceStampHex(options.cleaned);
    const sourceSha256 = await sha256ScanCleanupFile(options.source);
    const verification = verifyScanCleanupProvenanceStampHex(stampHex, {expectedSourceSha256: sourceSha256});
    if (verification.status !== 'valid') {
        return verification;
    }
    const mappingError = stampMappingMismatch(verification.payload, pageMapping, from, to);
    return mappingError === null
        ? verification
        : {
            status: 'invalid',
            reason: mappingError,
        };
}

function outputPageNumbers(value) {
    if (Array.isArray(value)) {
        return value.flatMap(item => outputPageNumbers(item));
    }
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? [value] : [];
    }
    if (!value || typeof value !== 'object') {
        return [];
    }
    return outputPageNumbers(
        value.outputPages
        ?? value.outputs
        ?? value.outputPageNumber
        ?? value.outputPage,
    );
}

function addPageMapping(mapping, sourcePage, outputs) {
    const parsedSourcePage = Number(sourcePage);
    if (!Number.isSafeInteger(parsedSourcePage) || parsedSourcePage <= 0) {
        return;
    }
    const current = mapping.get(parsedSourcePage) ?? [];
    for (const outputPage of outputs) {
        if (!current.includes(outputPage)) {
            current.push(outputPage);
        }
    }
    mapping.set(parsedSourcePage, current);
}

function parsePageMappingValue(value) {
    const mapping = new Map();
    if (Array.isArray(value)) {
        for (const entry of value) {
            if (Array.isArray(entry) && entry.length >= 2) {
                addPageMapping(mapping, entry[0], outputPageNumbers(entry[1]));
                continue;
            }
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const sourcePage = entry.sourcePage
                ?? entry.sourcePageNumber
                ?? entry.page;
            if (sourcePage !== undefined) {
                addPageMapping(
                    mapping,
                    sourcePage,
                    outputPageNumbers(entry),
                );
            }
        }
        return mapping;
    }
    if (!value || typeof value !== 'object') {
        return mapping;
    }
    for (const [
        sourcePage,
        outputs,
    ] of Object.entries(value)) {
        addPageMapping(mapping, sourcePage, outputPageNumbers(outputs));
    }
    return mapping;
}

function readSummaryPageMapping(summary) {
    const explicitMapping = summary.sourcePageToOutputPages
        ?? summary.pageMapping
        ?? summary.mapping?.sourcePageToOutputPages;
    const parsedExplicitMapping = parsePageMappingValue(explicitMapping);
    if (parsedExplicitMapping.size > 0) {
        return parsedExplicitMapping;
    }
    const perPageRows = summary.perPageStreamSizes
        ?? summary.representation?.pages;
    const parsedPerPageMapping = new Map();
    if (Array.isArray(perPageRows)) {
        for (const row of perPageRows) {
            if (!row || typeof row !== 'object') {
                continue;
            }
            const sourcePage = row.sourcePageNumber ?? row.sourcePage;
            const outputPage = row.outputPageNumber ?? row.outputPage;
            addPageMapping(parsedPerPageMapping, sourcePage, outputPageNumbers(outputPage));
        }
    }
    return parsedPerPageMapping;
}

function readSummaryRenderGeometry(summary) {
    const rows = summary.perPageStreamSizes
        ?? summary.representation?.pages;
    const geometryByOutput = new Map();
    if (!Array.isArray(rows)) {
        return geometryByOutput;
    }
    for (const row of rows) {
        const outputPage = row?.outputPageNumber ?? row?.outputPage;
        if (
            Number.isSafeInteger(outputPage)
            && outputPage > 0
            && row.renderGeometry
            && typeof row.renderGeometry === 'object'
        ) {
            geometryByOutput.set(outputPage, row.renderGeometry);
        }
    }
    return geometryByOutput;
}

async function loadPageMapping(options) {
    const automaticPath = `${options.cleaned}.summary.json`;
    const mappingPath = options.mapping ?? automaticPath;
    let summaryText;
    try {
        summaryText = await readFile(mappingPath, 'utf8');
    } catch (error) {
        if (!options.mapping && error?.code === 'ENOENT') {
            return null;
        }
        throw new Error(
            `Could not read mapping summary ${mappingPath}: ${getCliErrorMessage(error)}`,
        );
    }
    let summary;
    try {
        summary = JSON.parse(summaryText);
    } catch (error) {
        throw new Error(
            `Could not parse mapping summary ${mappingPath}: ${getCliErrorMessage(error)}`,
        );
    }
    const pages = readSummaryPageMapping(summary);
    if (pages.size === 0) {
        throw new Error(`Mapping summary ${mappingPath} contains no source-to-output page entries`);
    }
    return {
        pages,
        path: mappingPath,
        renderGeometryByOutput: readSummaryRenderGeometry(summary),
    };
}

function tableLine(page) {
    const offset = page.alignment
        ? `${String(page.alignment.dx)},${String(page.alignment.dy)}`
        : '-';
    const overlap = page.alignment ? page.alignment.overlapScore.toFixed(3) : '-';
    const scale = page.alignment?.scale ?? '-';
    return [
        String(page.page).padStart(4),
        String(page.totalTextComponents).padStart(10),
        String(page.lostCount).padStart(4),
        String(page.damagedCount).padStart(8),
        page.lostInkFraction.toFixed(4).padStart(9),
        String(page.inventedCount ?? 0).padStart(8),
        Number(page.inventedInkFraction ?? 0).toFixed(4).padStart(12),
        offset.padStart(9),
        overlap.padStart(7),
        scale.padStart(10),
    ].join(' ');
}

function makePageMap(report) {
    return new Map((report.pages ?? [])
        .filter(page => Number.isSafeInteger(page.page))
        .map(page => [
            page.page,
            page,
        ]));
}

async function compareBaseline(report, baselinePath) {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const previousPages = makePageMap(baseline);
    const currentPages = makePageMap(report);
    const lostCountDeltas = [];
    const silhouetteDeltas = [];
    for (const [
        pageNumber,
        currentPage,
    ] of currentPages) {
        const previousPage = previousPages.get(pageNumber);
        const previousLostCount = previousPage?.lostCount ?? 0;
        const currentLostCount = currentPage.lostCount ?? 0;
        const previousSilhouetteCount = previousPage?.silhouettes?.length ?? 0;
        const currentSilhouetteCount = currentPage.silhouettes?.length ?? 0;
        lostCountDeltas.push({
            current: currentLostCount,
            delta: currentLostCount - previousLostCount,
            page: pageNumber,
            previous: previousLostCount,
        });
        silhouetteDeltas.push({
            current: currentSilhouetteCount,
            delta: currentSilhouetteCount - previousSilhouetteCount,
            page: pageNumber,
            previous: previousSilhouetteCount,
        });
    }
    const previousFlaggedPages = new Set(
        baseline.summary?.flaggedPages ?? baseline.pages
            ?.filter(page => page.flagged)
            .map(page => page.page) ?? [],
    );
    const currentFlaggedPages = new Set(
        report.summary?.flaggedPages ?? report.pages
            ?.filter(page => page.flagged)
            .map(page => page.page) ?? [],
    );
    const previousSilhouettePages = new Set(
        baseline.summary?.silhouettePages ?? baseline.pages
            ?.filter(page => page.silhouetteFlagged)
            .map(page => page.page) ?? [],
    );
    const currentSilhouettePages = new Set(
        report.summary?.silhouettePages ?? report.pages
            ?.filter(page => page.silhouetteFlagged)
            .map(page => page.page) ?? [],
    );
    const newlyFlaggedPages = [...currentFlaggedPages]
        .filter(page => !previousFlaggedPages.has(page))
        .sort((left, right) => left - right);
    const resolvedPages = [...previousFlaggedPages]
        .filter(page => !currentFlaggedPages.has(page))
        .sort((left, right) => left - right);
    const newlySilhouettePages = [...currentSilhouettePages]
        .filter(page => !previousSilhouettePages.has(page))
        .sort((left, right) => left - right);
    const resolvedSilhouettePages = [...previousSilhouettePages]
        .filter(page => !currentSilhouettePages.has(page))
        .sort((left, right) => left - right);
    return {
        baseline: baselinePath,
        newlyFlaggedPages,
        newlySilhouettePages,
        resolvedPages,
        resolvedSilhouettePages,
        lostCountDeltas,
        silhouetteDeltas,
        hasRegressions:
            newlyFlaggedPages.length > 0
            || newlySilhouettePages.length > 0
            || lostCountDeltas.some(item => item.delta > 0)
            || silhouetteDeltas.some(item => item.delta > 0),
    };
}

function formatPageList(pages) {
    return pages.length === 0 ? '(none)' : pages.join(', ');
}

function auditRowsForPage(page) {
    return Array.isArray(page.outputAudits) && page.outputAudits.length > 0
        ? page.outputAudits
        : [page];
}

function uniqueSortedPageNumbers(rows) {
    return [...new Set(rows
        .map(row => row.page)
        .filter(page => Number.isSafeInteger(page)))]
        .sort((left, right) => left - right);
}

function summarizeAuditCoverage(pageResults, pagePlans) {
    const auditRows = pageResults.flatMap(auditRowsForPage);
    const analyzedRows = auditRows.filter(page => page.status === 'analyzed');
    const errorRows = auditRows.filter(page => page.status === 'error');
    const skippedRows = auditRows.filter(page => page.status === 'skipped');
    const incompletePages = uniqueSortedPageNumbers(
        pageResults.filter(page => auditRowsForPage(page).some(row => row.status !== 'analyzed')),
    );
    const expectedOutputPages = pagePlans.reduce(
        (total, pagePlan) => total + Math.max(pagePlan.outputPageNumbers.length, 1),
        0,
    );
    const complete = incompletePages.length === 0
        && analyzedRows.length > 0
        && analyzedRows.length === expectedOutputPages;
    return {
        analyzedOutputPages: analyzedRows.length,
        complete,
        errorPages: uniqueSortedPageNumbers(errorRows),
        expectedOutputPages,
        incompletePages,
        skippedPages: uniqueSortedPageNumbers(skippedRows),
    };
}

function shouldFailFor(
    options,
    lossFlaggedPages,
    silhouettePages,
    inventedPages,
    suppressedPages,
    coverage,
) {
    if (options.failOn !== 'none' && !coverage.complete) {
        return true;
    }
    if (options.failOn === 'text-loss') {
        return lossFlaggedPages.length > 0 || suppressedPages.length > 0;
    }
    if (options.failOn === 'silhouette') {
        return silhouettePages.length > 0;
    }
    if (options.failOn === 'invented-ink') {
        return inventedPages.length > 0;
    }
    if (options.failOn === 'any') {
        return lossFlaggedPages.length > 0
            || silhouettePages.length > 0
            || inventedPages.length > 0
            || suppressedPages.length > 0;
    }
    return false;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        return;
    }
    await mkdir(artifactDirectory, {recursive: true});
    await mkdir(dirname(options.out), {recursive: true});
    const [
        sourceListingResult,
        cleanedListingResult,
    ] = await Promise.all([
        run('pdfimages', [
            '-list',
            options.source,
        ]),
        run('pdfimages', [
            '-list',
            options.cleaned,
        ]),
    ]);
    const sourceRows = parsePdfImagesListing(sourceListingResult.stdout);
    const cleanedRows = parsePdfImagesListing(cleanedListingResult.stdout);
    const sourceRowsByPage = groupRowsByPage(sourceRows);
    const cleanedRowsByPage = groupRowsByPage(cleanedRows);
    const [
        sourcePageCount,
        cleanedPageCount,
    ] = await Promise.all([
        readPageCount(options.source, Math.max(...sourceRows.map(row => row.page), 0)),
        readPageCount(options.cleaned, Math.max(...cleanedRows.map(row => row.page), 0)),
    ]);
    const pageMapping = await loadPageMapping(options);
    const from = options.from ?? 1;
    const to = options.to ?? sourcePageCount;
    if (from > to) {
        throw new Error('--from must not be greater than --to');
    }
    if (to > sourcePageCount) {
        throw new Error(`--to ${String(to)} exceeds source page count ${String(sourcePageCount)}`);
    }
    if (pageMapping === null && to > cleanedPageCount) {
        throw new Error(`--to ${String(to)} exceeds cleaned page count ${String(cleanedPageCount)}`);
    }
    // A mapping that omits a source page means that page was not part of
    // the conversion (partial runs): it is skipped, never defaulted to an
    // identity mapping that points past a shorter cleaned document.
    const pages = Array.from({length: to - from + 1}, (_, index) => from + index)
        .filter(pageNumber => pageMapping === null || pageMapping.pages.has(pageNumber));
    if (pages.length === 0) {
        throw new Error('No audited source page falls inside the mapping and page range');
    }
    const pagePlans = pages.map(pageNumber => ({
        outputPageNumbers: pageMapping === null
            ? [pageNumber]
            : pageMapping.pages.get(pageNumber) ?? [],
        pageNumber,
    }));
    for (const pagePlan of pagePlans) {
        for (const outputPageNumber of pagePlan.outputPageNumbers) {
            if (outputPageNumber > cleanedPageCount) {
                throw new Error(
                    `Mapping sends source page ${String(pagePlan.pageNumber)} to cleaned page ${String(outputPageNumber)}, `
                    + `but cleaned page count is ${String(cleanedPageCount)}`,
                );
            }
        }
    }
    const stampVerification = options.verifyStamp
        ? await verifyCleanedStamp(options, pageMapping, from, to)
        : null;
    const temporaryRoot = await mkdtemp(join(artifactDirectory, '.word-loss-audit-'));
    try {
        await Promise.all(Array.from({length: Math.min(options.workers, pages.length || 1)}, (_, index) =>
            mkdir(join(temporaryRoot, `worker-${String(index)}`), {recursive: true}),
        ));
        const startedAt = Date.now();
        const pageResults = await mapPages(pagePlans, options.workers, (pagePlan, workerIndex) =>
            analyzeMappedPage({
                cleanedPdf: options.cleaned,
                cleanedRowsByPage,
                mappingActive: pageMapping !== null,
                minArea: options.minArea,
                outputPageNumbers: pagePlan.outputPageNumbers,
                pageNumber: pagePlan.pageNumber,
                renderGeometryByOutput: pageMapping?.renderGeometryByOutput ?? new Map(),
                sourcePdf: options.source,
                sourceRowsByPage,
                workDirectory: join(temporaryRoot, `worker-${String(workerIndex)}`),
            }),
        );
        const elapsedMs = Date.now() - startedAt;
        const flaggedPages = pageResults
            .filter(page => page.status === 'analyzed' && page.flagged)
            .map(page => page.page);
        const lossFlaggedPages = pageResults
            .filter(page => page.status === 'analyzed' && page.lossFlagged)
            .map(page => page.page);
        const inventedPages = pageResults
            .filter(page => page.status === 'analyzed' && page.inventedFlagged)
            .map(page => page.page);
        const silhouettePages = pageResults
            .filter(page => page.status === 'analyzed' && page.silhouetteFlagged)
            .map(page => page.page);
        const suppressedPages = pageResults
            .filter(page => page.status === 'analyzed' && page.comparisonSuppressed !== undefined)
            .map(page => page.page);
        const coverage = summarizeAuditCoverage(pageResults, pagePlans);
        const report = {
            generatedAt: new Date().toISOString(),
            inputs: {
                cleaned: options.cleaned,
                from,
                baseline: options.baseline,
                failOn: options.failOn,
                mapping: pageMapping?.path ?? null,
                minArea: options.minArea,
                source: options.source,
                to,
                verifyStamp: options.verifyStamp,
                workers: options.workers,
            },
            stampVerification,
            mapping: pageMapping === null
                ? null
                : {
                    path: pageMapping.path,
                    sourcePageToOutputPages: [...pageMapping.pages].map(([
                        sourcePage,
                        outputPages,
                    ]) => ({
                        outputPages,
                        sourcePage,
                    })),
                },
            pages: pageResults,
            summary: {
                analyzedOutputPages: coverage.analyzedOutputPages,
                analyzedPages: pageResults.filter(page => page.status === 'analyzed').length,
                auditCoverageComplete: coverage.complete,
                elapsedMs,
                errorPages: coverage.errorPages,
                flaggedCount: flaggedPages.length,
                flaggedPages,
                inventedCount: pageResults.reduce(
                    (total, page) => total + (page.inventedCount ?? 0),
                    0,
                ),
                inventedPages,
                grayPreservedCount: pageResults.reduce(
                    (total, page) => total + (page.grayPreservedCount ?? 0),
                    0,
                ),
                pageCount: pageResults.length,
                skippedPages: coverage.skippedPages,
                incompletePages: coverage.incompletePages,
                expectedOutputPages: coverage.expectedOutputPages,
                suppressedCount: suppressedPages.length,
                suppressedPages,
                silhouetteCount: pageResults.reduce(
                    (total, page) => total + (page.silhouettes?.length ?? 0),
                    0,
                ),
                silhouettePages,
            },
            tool: {
                alignment: {
                    broadDownsample: '16x',
                    quarterDownsample: '4x',
                    refinementRadiusFullPixels: 4,
                    searchRadiusFullPixels: ALIGNMENT_RADIUS_FULL_PX,
                    scaleFallback: '2197/2261',
                },
                grayPreserved: {
                    edgeMaxMeanGray: GRAY_EDGE_MAX_MEAN,
                    edgeMinShapeIoU: GRAY_EDGE_MIN_SHAPE_IOU,
                    edgeMinShapeRecall: GRAY_EDGE_MIN_SHAPE_RECALL,
                    inkThreshold: GRAY_INK_THRESHOLD,
                    meanTolerance: GRAY_MEAN_TOLERANCE,
                    minShapeIoU: GRAY_MIN_SHAPE_IOU,
                    minShapeRecall: GRAY_MIN_SHAPE_RECALL,
                },
                name: 'scan-cleanup-word-loss-audit',
                inventedInk: {
                    minimumUnsupportedComponentFraction: INVENTED_MIN_UNSUPPORTED_FRACTION,
                    minimumUnsupportedComponentAreaFactor: INVENTED_UNSUPPORTED_AREA_FACTOR,
                    paperDelta: SOURCE_SUPPORT_PAPER_DELTA,
                    paperPercentile: SOURCE_SUPPORT_PERCENTILE,
                },
                silhouette: {
                    coarseDownsample: SILHOUETTE_COARSE_DOWNSAMPLE,
                    coarseMaxBboxPixels: SILHOUETTE_COARSE_MAX_BBOX_PX,
                    coarseMinBboxPixels: SILHOUETTE_COARSE_MIN_BBOX_PX,
                    coarseMinDarkFraction: SILHOUETTE_COARSE_MIN_DARK_FRACTION,
                    minAreaMillimeters: SILHOUETTE_MIN_SIZE_MM,
                    minFillRatio: 0.8,
                },
                version: 5,
            },
        };
        if (options.baseline) {
            report.regressions = await compareBaseline(report, options.baseline);
        }
        await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`Wrote JSON report: ${options.out}`);
        console.log(`Pages: ${String(from)}-${String(to)}; flagged: ${String(flaggedPages.length)}; elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
        console.log(`Silhouettes: ${formatPageList(silhouettePages)}`);
        console.log('');
        console.log('page components lost damaged lost-ink invented invented-ink offset overlap scale');
        console.log('---- ---------- ---- ------- -------- -------- --------- -------- ------- ----------');
        if (flaggedPages.length === 0) {
            console.log('(none)');
        } else {
            // Audited pages can be a sparse subset of from..to when a partial
            // mapping filters them, so results are looked up by page number.
            const resultByPage = new Map(pages.map((pageNumber, index) => [
                pageNumber,
                pageResults[index],
            ]));
            for (const pageNumber of flaggedPages) {
                console.log(tableLine(resultByPage.get(pageNumber)));
            }
        }
        if (report.regressions) {
            console.log('');
            console.log('REGRESSIONS');
            console.log(`newly flagged pages: ${formatPageList(report.regressions.newlyFlaggedPages)}`);
            console.log(`resolved pages: ${formatPageList(report.regressions.resolvedPages)}`);
            console.log(`new silhouette pages: ${formatPageList(report.regressions.newlySilhouettePages)}`);
            console.log(`resolved silhouette pages: ${formatPageList(report.regressions.resolvedSilhouettePages)}`);
            const changedLost = report.regressions.lostCountDeltas
                .filter(item => item.delta !== 0)
                .map(item => `${String(item.page)}:${item.delta > 0 ? '+' : ''}${String(item.delta)}`);
            const changedSilhouettes = report.regressions.silhouetteDeltas
                .filter(item => item.delta !== 0)
                .map(item => `${String(item.page)}:${item.delta > 0 ? '+' : ''}${String(item.delta)}`);
            console.log(`lostCount deltas: ${formatPageList(changedLost)}`);
            console.log(`silhouette deltas: ${formatPageList(changedSilhouettes)}`);
        }
        const stampFail = options.verifyStamp && stampVerification?.status !== 'valid';
        if (stampFail) {
            console.error(`FAIL: provenance stamp verification is ${stampVerification?.status ?? 'missing'}`);
        }
        if (options.failOn !== 'none' && !coverage.complete) {
            console.error(
                `FAIL: --fail-on ${options.failOn} could not fully analyze the requested pages `
                + `(incomplete: ${formatPageList(coverage.incompletePages)}; `
                + `errors: ${formatPageList(coverage.errorPages)}; `
                + `skipped: ${formatPageList(coverage.skippedPages)}; `
                + `analyzed outputs: ${String(coverage.analyzedOutputPages)}/${String(coverage.expectedOutputPages)})`,
            );
        }
        const fail = shouldFailFor(
            options,
            lossFlaggedPages,
            silhouettePages,
            inventedPages,
            suppressedPages,
            coverage,
        ) || stampFail;
        if (fail && coverage.complete && !stampFail) {
            console.error(`FAIL: --fail-on ${options.failOn} found a matching flag`);
        }
        return fail;
    } finally {
        await rm(temporaryRoot, {
            force: true,
            recursive: true,
        });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = (await main()) ? 1 : 0;
    } catch (error) {
        console.error(getCliErrorMessage(error));
        process.exitCode = 1;
    }
}
