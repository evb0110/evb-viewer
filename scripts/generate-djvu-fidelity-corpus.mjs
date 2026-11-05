import { createHash } from 'node:crypto';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    basename,
    join,
    resolve,
} from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const corpusDirectory = join(root, 'tests/fixtures/djvu');
const sourceDirectory = join(corpusDirectory, 'sources');
const goldenDirectory = join(corpusDirectory, 'goldens');
const workDirectory = await mkdtemp(join(tmpdir(), 'evb-djvu-corpus-'));

function run(command, args) {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(command, args, {stdio: [
            'ignore',
            'pipe',
            'pipe',
        ]});
        const stderr = [];
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.on('error', rejectRun);
        child.on('close', code => code === 0
            ? resolveRun()
            : rejectRun(new Error(`${command} failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`)));
    });
}

function ppm(width, height, pixel) {
    const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
    const pixels = Buffer.allocUnsafe(width * height * 3);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const [
                red,
                green,
                blue,
            ] = pixel(x, y);
            const offset = (y * width + x) * 3;
            pixels[offset] = red;
            pixels[offset + 1] = green;
            pixels[offset + 2] = blue;
        }
    }
    return Buffer.concat([
        header,
        pixels,
    ]);
}

function pbm(width, height, isBlack) {
    const rowBytes = Math.ceil(width / 8);
    const pixels = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (isBlack(x, y)) {
                pixels[(y * rowBytes) + Math.floor(x / 8)] |= 0x80 >> (x % 8);
            }
        }
    }
    return Buffer.concat([
        Buffer.from(`P4\n${width} ${height}\n`),
        pixels,
    ]);
}

function insideBox(x, y, left, top, width, height) {
    return x >= left && x < left + width && y >= top && y < top + height;
}

async function sha256(path) {
    return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function encodeC44(input, output, dpi, extra = []) {
    await run('c44', [
        '-dpi',
        String(dpi),
        ...extra,
        input,
        output,
    ]);
}

async function encodeBitonal(input, output, dpi) {
    await run('cjb2', [
        '-dpi',
        String(dpi),
        input,
        output,
    ]);
}

async function renderGolden(input, output, page = 1) {
    await run('ddjvu', [
        '-format=ppm',
        '-scale=72',
        `-page=${page}`,
        input,
        output,
    ]);
}

await mkdir(sourceDirectory, {recursive: true});
await mkdir(goldenDirectory, {recursive: true});

try {
    const bitonalPbm = join(workDirectory, 'bitonal.pbm');
    const faintPpm = join(workDirectory, 'faint.ppm');
    await writeFile(bitonalPbm, pbm(512, 512, (x, y) => (
        insideBox(x, y, 48, 56, 416, 4)
        || insideBox(x, y, 48, 112, 300, 3)
        || insideBox(x, y, 48, 168, 380, 3)
        || (x > 80 && x < 430 && Math.abs(y - (250 + Math.round(Math.sin(x / 18) * 12))) < 2)
    )));
    await writeFile(faintPpm, ppm(512, 512, (x, y) => {
        const pencil = Math.abs(y - (100 + Math.round(Math.sin(x / 25) * 18))) < 2
            || Math.abs(y - (260 + Math.round(Math.cos(x / 31) * 22))) < 2;
        return pencil ? [
            218,
            218,
            216,
        ] : [
            250,
            249,
            245,
        ];
    }));
    const bitonalPage = join(workDirectory, 'bitonal.djvu');
    const faintPage = join(workDirectory, 'faint.djvu');
    await encodeBitonal(bitonalPbm, bitonalPage, 300);
    await encodeC44(faintPpm, faintPage, 300, [
        '-slice',
        '90',
    ]);
    await run('djvm', [
        '-create',
        join(sourceDirectory, 'bitonal-faint-pencil.djvu'),
        bitonalPage,
        faintPage,
    ]);

    const mapPpm = join(workDirectory, 'color-map.ppm');
    await writeFile(mapPpm, ppm(640, 480, (x, y) => {
        if (insideBox(x, y, 390, 55, 170, 90)) {
            return [
                194,
                35,
                42,
            ];
        }
        if ((x + y) % 97 < 3 || Math.abs(y - (x * 0.45 + 90)) < 3) {
            return [
                30,
                90,
                160,
            ];
        }
        if (insideBox(x, y, 60, 300, 220, 70)) {
            return [
                228,
                181,
                45,
            ];
        }
        return [
            244,
            239,
            219,
        ];
    }));
    await encodeC44(mapPpm, join(sourceDirectory, 'color-text-stamps-maps.djvu'), 200, [
        '-crcbfull',
        '-slice',
        '110',
    ]);

    const photoPpm = join(workDirectory, 'photo.ppm');
    await writeFile(photoPpm, ppm(640, 480, (x, y) => {
        const noise = ((x * 17 + y * 31 + x * y * 3) >>> 2) & 15;
        return [
            Math.min(255, Math.round((x / 639) * 210) + noise),
            Math.min(255, Math.round((y / 479) * 190) + noise),
            Math.min(255, 65 + Math.round(((x + y) / 1118) * 150) + noise),
        ];
    }));
    await encodeC44(photoPpm, join(sourceDirectory, 'photo-art.djvu'), 240, [
        '-crcbfull',
        '-slice',
        '100',
    ]);

    const backgroundDjvu = join(workDirectory, 'background.djvu');
    const maskDjvu = join(workDirectory, 'mask.djvu');
    const backgroundChunk = join(workDirectory, 'background.iw44');
    const maskChunk = join(workDirectory, 'mask.sjbz');
    await encodeC44(faintPpm, backgroundDjvu, 300, [
        '-slice',
        '80',
    ]);
    await encodeBitonal(bitonalPbm, maskDjvu, 300);
    await run('djvuextract', [
        backgroundDjvu,
        `BG44=${backgroundChunk}`,
    ]);
    await run('djvuextract', [
        maskDjvu,
        `Sjbz=${maskChunk}`,
    ]);
    await run('djvumake', [
        join(sourceDirectory, 'layered.djvu'),
        'INFO=512,512,300',
        `Sjbz=${maskChunk}`,
        `BG44=${backgroundChunk}`,
        'FGbz=#222222:0,0,512,512',
    ]);

    const lowDpi = join(workDirectory, 'low-dpi.djvu');
    const highDpi = join(workDirectory, 'high-dpi.djvu');
    await encodeC44(photoPpm, lowDpi, 72, [
        '-slice',
        '90',
    ]);
    await encodeBitonal(bitonalPbm, highDpi, 300);
    await run('djvm', [
        '-create',
        join(sourceDirectory, 'mixed-dpi.djvu'),
        lowDpi,
        highDpi,
    ]);

    const hugePgm = join(workDirectory, 'huge.pgm');
    const hugeHeader = Buffer.from('P5\n10000 8001\n255\n');
    const hugePixels = Buffer.alloc(10_000 * 8_001, 247);
    for (let y = 0; y < 8_001; y += 97) {
        hugePixels.fill(40, y * 10_000, Math.min((y * 10_000) + 10_000, hugePixels.length));
    }
    await writeFile(hugePgm, Buffer.concat([
        hugeHeader,
        hugePixels,
    ]));
    await encodeC44(hugePgm, join(sourceDirectory, 'huge-page.djvu'), 300, [
        '-slice',
        '60',
    ]);

    const corruptSource = await readFile(join(sourceDirectory, 'photo-art.djvu'));
    await writeFile(join(sourceDirectory, 'corrupt-truncated.djvu'), corruptSource.subarray(0, 96));

    await run('djvm', [
        '-create',
        join(sourceDirectory, 'browser-tiff-5-pages.djvu'),
        ...Array.from({length: 5}, () => bitonalPage),
    ]);

    const boundaryPages = Array.from({length: 501}, () => bitonalPage);
    await run('djvm', [
        '-create',
        join(sourceDirectory, 'browser-boundary-501-pages.djvu'),
        ...boundaryPages,
    ]);

    const goldenJobs = [
        [
            'bitonal-faint-pencil.djvu',
            'bitonal-faint-pencil-page-1-72dpi.ppm',
            1,
        ],
        [
            'bitonal-faint-pencil.djvu',
            'bitonal-faint-pencil-page-2-72dpi.ppm',
            2,
        ],
        [
            'color-text-stamps-maps.djvu',
            'color-text-stamps-maps-72dpi.ppm',
            1,
        ],
        [
            'photo-art.djvu',
            'photo-art-72dpi.ppm',
            1,
        ],
        [
            'layered.djvu',
            'layered-72dpi.ppm',
            1,
        ],
        [
            'mixed-dpi.djvu',
            'mixed-dpi-page-1-72dpi.ppm',
            1,
        ],
        [
            'mixed-dpi.djvu',
            'mixed-dpi-page-2-72dpi.ppm',
            2,
        ],
    ];
    for (const [
        source,
        golden,
        page,
    ] of goldenJobs) {
        await renderGolden(join(sourceDirectory, source), join(goldenDirectory, golden), page);
    }

    const entries = [
        [
            'bitonal-faint-pencil',
            'bitonal-faint-pencil.djvu',
        ],
        [
            'color-text-stamps-maps',
            'color-text-stamps-maps.djvu',
        ],
        [
            'photo-art',
            'photo-art.djvu',
        ],
        [
            'layered',
            'layered.djvu',
        ],
        [
            'mixed-dpi',
            'mixed-dpi.djvu',
        ],
        [
            'huge-pages',
            'huge-page.djvu',
        ],
        [
            'corrupt-missing-tool-enospc',
            'corrupt-truncated.djvu',
        ],
        [
            'browser-tiff',
            'browser-tiff-5-pages.djvu',
        ],
        [
            'browser-boundary',
            'browser-boundary-501-pages.djvu',
        ],
    ];
    const classes = [];
    for (const [
        id,
        file,
    ] of entries) {
        const path = join(sourceDirectory, file);
        classes.push({
            fixture: `sources/${file}`,
            id,
            license: 'CC0-1.0 (deterministically generated by this repository)',
            sha256: await sha256(path),
            status: 'ready',
        });
    }
    await writeFile(join(corpusDirectory, 'corpus-manifest.json'), `${JSON.stringify({
        schemaVersion: 1,
        comparisonScale: 'matched-physical-page-size',
        generator: basename(import.meta.filename),
        classes,
    }, null, 2)}\n`);
    await chmod(import.meta.filename, 0o755).catch(() => undefined);
} finally {
    await rm(workDirectory, {
        recursive: true,
        force: true,
    });
}
