// Renders recorded films to the videos the landing plays, with Remotion's renderer:
//   node recorder/render.mjs [flow] [--locale <code>] [--theme <light|dark>]
// Reads the captures record.mjs wrote to ../.devkit/films/capture and writes, per locale/theme,
// public/films/<flow>/<locale>-<theme>.mp4 with a poster and a still, plus app/films/<flow>.json.
// The page plays a plain video, so the browser never rasterises the heavy SVG states itself.
import { bundle } from '@remotion/bundler';
import {
    renderMedia,
    renderStill,
    selectComposition,
} from '@remotion/renderer';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '..');
const CAPTURE = path.resolve(LANDING, '../.devkit/films/capture');
// 1280x800 recordings at 1.5x match the film's size on a 2x display without upscaling text.
const SCALE = 1.5;
/** First frame after the opening fade: the poster, and where playback starts. */
const INTRO_FRAMES = 10;
/** Share of the film shown as a still to visitors who prefer reduced motion. */
const STILL_AT = 0.3;

const args = process.argv.slice(2);
const flow = args[0] && !args[0].startsWith('--') ? args.shift() : 'viewer';
let localeFilter;
let themeFilter;
for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--locale') localeFilter = args[index + 1];
    else if (args[index] === '--theme') themeFilter = args[index + 1];
    else throw new Error(`Unknown option: ${args[index]}`);
}

const manifests = readdirSync(path.join(CAPTURE, 'manifests'))
    .filter((name) => name.startsWith(`${flow}.`) && name.endsWith('.json'))
    .map((name) => {
        // <flow>.<locale>.<theme>.json
        const parts = name.slice(0, -'.json'.length).split('.');
        return {
            locale: parts[1],
            theme: parts[2],
            manifest: JSON.parse(readFileSync(path.join(CAPTURE, 'manifests', name), 'utf8')),
        };
    })
    .filter(({
        locale,
        theme,
    }) => (!localeFilter || locale === localeFilter) && (!themeFilter || theme === themeFilter));
if (!manifests.length) {
    throw new Error(`No captures for ${flow} in ${CAPTURE}. Record them first with recorder/record.mjs.`);
}

const serveUrl = await bundle({
    entryPoint: path.join(HERE, 'film/registerFilmRoot.tsx'),
    publicDir: CAPTURE,
});
const outDir = path.join(LANDING, 'public/films', flow);
mkdirSync(outDir, { recursive: true });
const indexPath = path.join(LANDING, 'app/films', `${flow}.json`);
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {
    fps: 30,
    intro: INTRO_FRAMES,
    variants: {},
};

for (const {
    locale,
    theme,
    manifest,
} of manifests) {
    const variant = `${locale}-${theme}`;
    const inputProps = { manifest };
    const composition = await selectComposition({
        serveUrl,
        id: 'film',
        inputProps,
    });
    const still = Math.round(composition.durationInFrames * STILL_AT);
    console.log(`Rendering ${flow}: ${variant}, ${composition.durationInFrames} frames`);
    await renderMedia({
        serveUrl,
        composition,
        inputProps,
        codec: 'h264',
        // Lossless frames keep small interface text sharp. Still stretches cost almost nothing;
        // camera moves and crossfades over the dense scan take most of the bits.
        imageFormat: 'png',
        crf: 26,
        x264Preset: 'veryslow',
        pixelFormat: 'yuv420p',
        scale: SCALE,
        outputLocation: path.join(outDir, `${variant}.mp4`),
    });
    for (const [
        name,
        frame,
    ] of [
            [
                'poster',
                INTRO_FRAMES,
            ],
            [
                'still',
                still,
            ],
        ]) {
        await renderStill({
            serveUrl,
            composition,
            inputProps,
            frame,
            imageFormat: 'jpeg',
            jpegQuality: 85,
            scale: SCALE,
            output: path.join(outDir, `${variant}-${name}.jpg`),
        });
    }
    index.variants[variant] = {
        frames: composition.durationInFrames,
        still,
    };
    index.width = composition.width;
    index.height = composition.height;
}

index.variants = Object.fromEntries(Object.entries(index.variants).sort(([a], [b]) => a.localeCompare(b)));
mkdirSync(path.dirname(indexPath), { recursive: true });
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
