// Records landing films from a packaged EVB Viewer build. By default the viewer flow records every
// locale/theme pair. Linux only: run it inside a private X server, for example
//   xvfb-run -a -s '-screen 0 1600x1000x24' node recorder/record.mjs viewer --app '/opt/EVB Viewer/evb-viewer'
// A hidden window gets no frames, so the recorder shows the window on that private display.
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import {
    FilmRecorder,
    LANDING,
    pruneSharedAssets,
} from './recorder.mjs';

const REPO = path.resolve(LANDING, '..');
const FILMS = path.join(REPO, '.devkit/films');
const args = process.argv.slice(2);
const flowName = args[0] && !args[0].startsWith('--') ? args.shift() : 'viewer';
const {
    default: flow, title, size = {
        width: 1280,
        height: 800,
    }, prepare,
} = await import(`./flows/${flowName}.mjs`);
const locales = [
    'en',
    'ru',
    'fr',
    'de',
    'es',
    'it',
    'pt',
    'pt-BR',
    'nl',
];
const themes = [
    'light',
    'dark',
];

let localeFilter;
let themeFilter;
let executablePath = process.env.FILM_APP || '/opt/EVB Viewer/evb-viewer';
for (let index = 0; index < args.length; index++) {
    const option = args[index];
    const value = args[index + 1];
    if (option === '--locale' && value) {
        localeFilter = value;
        index++;
    } else if (option === '--theme' && value) {
        themeFilter = value;
        index++;
    } else if (option === '--app' && value) {
        executablePath = value;
        index++;
    } else if (option === '--help') {
        console.log('Usage: node recorder/record.mjs [flow] [--app <executable>] [--locale <code>] [--theme <light|dark>]');
        process.exit(0);
    } else {
        throw new Error(`Unknown option: ${option}`);
    }
}
if (localeFilter && !locales.includes(localeFilter)) {
    throw new Error(`Unsupported locale: ${localeFilter}. Choose ${locales.join(', ')}.`);
}
if (themeFilter && !themes.includes(themeFilter)) {
    throw new Error(`Unsupported theme: ${themeFilter}. Choose light or dark.`);
}
if (process.platform !== 'linux' || !process.env.DISPLAY) {
    throw new Error('Record on Linux inside a private X server (xvfb-run), so the app window never reaches a desktop.');
}
if (!existsSync(executablePath)) {
    throw new Error(`No EVB Viewer executable at ${executablePath}. Pass --app with a packaged build.`);
}

const variants = (localeFilter ? [localeFilter] : locales).flatMap((locale) =>
    (themeFilter ? [themeFilter] : themes).map((theme) => ({
        locale,
        theme,
    })),
);

for (const {
    locale,
    theme,
} of variants) {
    const variant = `${locale}-${theme}`;
    const profile = path.join(FILMS, 'profile', flowName, variant);
    rmSync(profile, {
        recursive: true,
        force: true,
    });
    const userData = path.join(profile, 'config', 'EVB Viewer');
    mkdirSync(userData, { recursive: true });
    // Missing settings fall back to defaults, so theme and locale are all the profile needs.
    writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
        theme,
        locale,
    }, null, 2));
    const setup = prepare?.({
        profile,
        userData,
        repo: REPO,
    }) ?? {};
    // Chromium keeps its singleton socket in TMPDIR, and socket paths are limited to about 100 bytes.
    const appTemp = mkdtempSync('/tmp/evb-film-');

    console.log(`Recording ${flowName}: ${locale} / ${theme}`);
    const app = await electron.launch({
        executablePath,
        // Two device pixels per CSS pixel keep the QA screenshots sharp for review.
        args: [
            '--no-sandbox',
            '--force-device-scale-factor=2',
        ],
        env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(profile, 'config'),
            TMPDIR: appTemp,
        },
        timeout: 60_000,
    });
    try {
        const win = await app.firstWindow();
        await win.waitForLoadState('load');
        // Resize once the window has painted: before its first frame, the initial configure can still
        // override the request. A film recorded at another size leaves blank strips, so check first.
        await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await app.evaluate(({ BrowserWindow }, {
            width,
            height,
        }) => {
            BrowserWindow.getAllWindows()[0].setContentSize(width, height);
        }, size);
        await win.waitForFunction(({
            width,
            height,
        }) => innerWidth === width && innerHeight === height, size, { timeout: 10_000 }).catch(async () => {
            const actual = await win.evaluate(() => `${innerWidth}x${innerHeight}`);
            throw new Error(`The window is ${actual}, not ${size.width}x${size.height}. Use a larger virtual screen.`);
        });
        await win.waitForTimeout(1500);
        const rec = new FilmRecorder(win, flowName, {
            ...size,
            qaDir: path.join(FILMS, 'qa'),
            locale,
            theme,
        });
        await flow(win, rec, {
            app,
            ...setup,
        });
        await rec.save({ title });
    } finally {
        // Quit without prompts about the edited document.
        await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
        await app.close().catch(() => {});
        rmSync(appTemp, {
            recursive: true,
            force: true,
        });
    }
}
pruneSharedAssets(flowName);
