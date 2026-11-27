import {existsSync, readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import tailwindColors from 'tailwindcss/colors';

/**
 * Compiles the application's real stylesheet entry (`app/assets/css/main.css`)
 * the way the app build does: Tailwind resolves `@import 'tailwindcss'` and
 * `@import '@nuxt/ui'`, so the result carries the genuine design tokens, the
 * Nuxt UI token layer and the utility classes the components ask for.
 *
 * Tests that need real layout can therefore hand a browser the product's own CSS
 * instead of a hand-written stand-in that silently drifts away from it.
 */

// Derived from this module's own location rather than `process.cwd()`: a test
// runner may be invoked from anywhere, and a cwd-derived root would either fail
// outright or quietly compile some other tree's stylesheet. `fileURLToPath`
// keeps percent-encoded path segments and Windows drive letters intact; it takes
// `import.meta.url` as a string because DOM test environments replace the global
// `URL` with one that resolves against the document origin, not the file base.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_CSS_DIR = join(REPO_ROOT, 'app/assets/css');
const APP_CSS_ENTRY = join(APP_CSS_DIR, 'main.css');
// Nuxt's `#build` alias points at the generated `.nuxt` directory, and
// `@nuxt/ui`'s stylesheet imports `#build/ui.css` from there. `nuxi prepare`
// writes it during install, so a missing file means an unprepared workspace.
const NUXT_BUILD_SPECIFIER = '#build/';
const NUXT_BUILD_DIR = join(REPO_ROOT, '.nuxt');
const PUBLIC_DIR = join(REPO_ROOT, 'public');
// Only the app's own root-relative font URLs; anything else stays a plain URL so
// a stylesheet change cannot quietly turn images into megabytes of base64.
const ROOT_RELATIVE_FONT_URL_PATTERN = /url\((['"]?)\/(fonts\/[^'")]+\.(woff2|woff|ttf|otf))\1\)/gu;
const FONT_MEDIA_TYPES: Record<string, string> = {
    otf: 'font/otf',
    ttf: 'font/ttf',
    woff: 'font/woff',
    woff2: 'font/woff2',
};
const NUXT_UI_COLOR_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

function resolvePackageStylesheet(specifier: string) {
    const packageRoot = join(REPO_ROOT, 'node_modules', specifier);
    const manifestPath = join(packageRoot, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        exports?: {'.'?: {style?: string}};
        style?: string;
    };
    const stylesheet = manifest.exports?.['.']?.style ?? manifest.style;
    if (!stylesheet) {
        throw new Error(`Package "${specifier}" declares no stylesheet entry in ${manifestPath}`);
    }
    return join(packageRoot, stylesheet);
}

function resolveStylesheetPath(specifier: string, base: string) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
        return resolve(base, specifier);
    }
    if (specifier.startsWith(NUXT_BUILD_SPECIFIER)) {
        const generated = join(NUXT_BUILD_DIR, specifier.slice(NUXT_BUILD_SPECIFIER.length));
        if (!existsSync(generated)) {
            throw new Error(`Missing ${generated}; run \`pnpm exec nuxi prepare\` to generate the Nuxt build stylesheets`);
        }
        return generated;
    }
    return resolvePackageStylesheet(specifier);
}

/**
 * Runs `read` with a fallback `defineAppConfig` in place, then puts the global
 * back exactly as it was — restoring the original property descriptor when one
 * existed and removing the fallback outright when none did, on the throwing path
 * too. A test helper that reads one module must not leave a Nuxt build-time
 * global behind for whatever runs next in the same worker.
 */
async function withFallbackDefineAppConfig<T>(read: () => Promise<T>) {
    const scope = globalThis as {defineAppConfig?: <C>(config: C) => C};
    const previousDescriptor = Object.getOwnPropertyDescriptor(scope, 'defineAppConfig');
    scope.defineAppConfig ??= (config) => config;
    try {
        return await read();
    } finally {
        if (previousDescriptor) {
            Object.defineProperty(scope, 'defineAppConfig', previousDescriptor);
        } else {
            delete scope.defineAppConfig;
        }
    }
}

/**
 * Nuxt UI's build plugin turns the colour roles declared in `app/app.config.ts`
 * into `--ui-color-<role>-<shade>` custom properties, and its stylesheet builds
 * `--ui-border`, `--ui-text` and friends on top of them. A standalone Tailwind
 * compile cannot run that plugin, so re-derive the same mapping from the same app
 * config and Tailwind's own palette. Roles pointing at an app-defined palette
 * (`brand`) are left unresolved: they only tint, never size, anything.
 */
async function nuxtUiColorRoleDeclarations() {
    // `defineAppConfig` is a Nuxt build-time global around a plain object
    // literal, so declaring it is enough to read the real app config here.
    const {default: appConfig} = await withFallbackDefineAppConfig(() => import('@app/app.config'));
    const palette: Record<string, unknown> = tailwindColors;
    return Object.entries(appConfig.ui?.colors ?? {})
        .flatMap(([role, colorName]) => {
            const ramp = palette[String(colorName)];
            if (typeof ramp !== 'object' || ramp === null) {
                return [];
            }
            const shades: Record<string, unknown> = {...ramp};
            return NUXT_UI_COLOR_SHADES.map((shade) => [shade, shades[String(shade)]] as const)
                .filter((entry): entry is readonly [number, string] => typeof entry[1] === 'string')
                .map(([shade, value]) => `--ui-color-${role}-${String(shade)}: ${value};`);
        })
        .join('\n');
}

/**
 * A browser test hands this stylesheet to a page built with `setContent`, where
 * the app's root-relative font URLs resolve against nothing and text falls back
 * to a system face. Inlining the files from `public/` keeps measurements on the
 * font the app really ships, which sizes non-Latin text differently enough to
 * decide whether a label fits its control.
 */
function inlineAppFonts(css: string) {
    return css.replaceAll(ROOT_RELATIVE_FONT_URL_PATTERN, (match, _quote: string, path: string, extension: string) => {
        const fontPath = join(PUBLIC_DIR, path);
        if (!existsSync(fontPath)) {
            return match;
        }
        const mediaType = FONT_MEDIA_TYPES[extension] ?? 'application/octet-stream';
        return `url("data:${mediaType};base64,${readFileSync(fontPath).toString('base64')}")`;
    });
}

/**
 * @param utilityCandidates Utility class names to emit, normally harvested from
 * the markup a component actually rendered rather than listed out by hand.
 */
export async function compileAppStylesheet(utilityCandidates: Iterable<string>) {
    const compiler = await compile(await readFile(APP_CSS_ENTRY, 'utf8'), {
        base: APP_CSS_DIR,
        loadStylesheet: async (specifier: string, base: string) => {
            const path = resolveStylesheetPath(specifier, base);
            return {
                base: dirname(path),
                content: await readFile(path, 'utf8'),
                path,
            };
        },
        loadModule: (specifier: string) => {
            throw new Error(`Compiling ${APP_CSS_ENTRY} unexpectedly required the JS module "${specifier}"`);
        },
    });

    return `:root {\n${await nuxtUiColorRoleDeclarations()}\n}\n${inlineAppFonts(compiler.build([...utilityCandidates]))}`;
}
