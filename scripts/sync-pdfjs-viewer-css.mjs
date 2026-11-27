import {copyFile, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..');

const sourceCssPath = path.join(projectRoot, 'node_modules', 'pdfjs-dist', 'web', 'pdf_viewer.css');
const sourceImagesDir = path.join(projectRoot, 'node_modules', 'pdfjs-dist', 'web', 'images');
const targetCssPath = path.join(projectRoot, 'app', 'assets', 'css', 'vendor', 'pdfjs-viewer-sanitized.css');
const targetImagesDir = path.join(projectRoot, 'public', 'pdfjs', 'images');

const removableRulePatterns = ['.dialog.newAltText', '#viewsManager'];
const legacyViewsManagerContainerPattern = '#outerContainer.viewsManager';

function collectBlockRanges(cssText, shouldRemoveBlock) {
    const ranges = [];
    const stack = [{segmentStart: 0}];

    let inComment = false;
    let inString = false;
    let stringChar = '';

    for (let index = 0; index < cssText.length; index += 1) {
        const current = cssText[index];
        const next = cssText[index + 1];

        if (inComment) {
            if (current === '*' && next === '/') {
                inComment = false;
                index += 1;
            }
            continue;
        }

        if (inString) {
            if (current === '\\') {
                index += 1;
                continue;
            }
            if (current === stringChar) {
                inString = false;
                stringChar = '';
            }
            continue;
        }

        if (current === '/' && next === '*') {
            inComment = true;
            index += 1;
            continue;
        }

        if (current === '"' || current === "'") {
            inString = true;
            stringChar = current;
            continue;
        }

        if (current === '{') {
            const parent = stack[stack.length - 1];
            const preludeStart = parent.segmentStart;
            stack.push({
                segmentStart: index + 1,
                preludeStart,
                braceStart: index,
                prelude: cssText.slice(preludeStart, index),
            });
            continue;
        }

        if (current !== '}' || stack.length === 1) {
            continue;
        }

        const block = stack.pop();
        const blockEnd = index + 1;
        const body = cssText.slice(block.braceStart + 1, index);
        const prelude = block.prelude.trim();
        if (shouldRemoveBlock(prelude, body)) {
            ranges.push({
                start: block.preludeStart,
                end: blockEnd,
            });
        }

        const parent = stack[stack.length - 1];
        parent.segmentStart = blockEnd;
    }

    return ranges;
}

function applyRanges(cssText, ranges) {
    if (ranges.length === 0) {
        return cssText;
    }

    const merged = ranges
        .slice()
        .sort((a, b) => a.start - b.start)
        .reduce((result, range) => {
            const previous = result[result.length - 1];
            if (previous !== undefined && range.start <= previous.end) {
                previous.end = Math.max(previous.end, range.end);
            } else {
                result.push({...range});
            }
            return result;
        }, []);
    const sorted = merged.sort((a, b) => b.start - a.start);
    let output = cssText;
    for (const range of sorted) {
        output = `${output.slice(0, range.start)}\n${output.slice(range.end)}`;
    }
    return output;
}

export function removeUnusedUiBlocks(cssText) {
    const matchedPatterns = new Set();
    const removableRules = collectBlockRanges(cssText, (prelude) => {
        const matchedPattern = removableRulePatterns.find((pattern) => prelude.includes(pattern));
        if (matchedPattern === undefined) {
            return false;
        }

        matchedPatterns.add(matchedPattern);
        return true;
    });
    const legacyContainerRules = collectBlockRanges(cssText, (prelude) => prelude.includes(legacyViewsManagerContainerPattern));
    if (legacyContainerRules.length > 0) {
        removableRules.push(...legacyContainerRules);
        matchedPatterns.add(legacyViewsManagerContainerPattern);
    } else {
        const nestedContainerRules = collectBlockRanges(cssText, (prelude) => prelude.trim() === '#outerContainer');
        if (nestedContainerRules.length === 1) {
            removableRules.push(...nestedContainerRules);
            matchedPatterns.add(legacyViewsManagerContainerPattern);
        }
    }
    const missingPatterns = [...removableRulePatterns, legacyViewsManagerContainerPattern].filter(
        (pattern) => !matchedPatterns.has(pattern),
    );
    if (missingPatterns.length > 0) {
        throw new Error('PDF.js viewer CSS removal pattern(s) no longer match upstream css: ' + missingPatterns.join(', '));
    }

    let sanitized = applyRanges(cssText, removableRules);

    while (true) {
        const emptyAtRules = collectBlockRanges(sanitized, (prelude, body) => {
            if (!prelude.startsWith('@')) {
                return false;
            }

            const compactBody = body.replace(/\/\*[\s\S]*?\*\//gu, '').trim();
            return compactBody.length === 0;
        });

        if (emptyAtRules.length === 0) {
            break;
        }

        sanitized = applyRanges(sanitized, emptyAtRules);
    }

    return sanitized;
}

export function rewriteImageUrls(cssText, sourceImageNames) {
    const availableImageNames = new Set(sourceImageNames);

    let sanitized = cssText.replace(/url\((['"]?)images\/([^)"']+)\1\)/gu, (fullMatch, _quote, rawName) => {
        const imageName = String(rawName).trim();
        if (!availableImageNames.has(imageName)) {
            return '__PDFJS_MISSING_ASSET__';
        }

        return `url('/pdfjs/images/${imageName}')`;
    });

    sanitized = sanitized.replace(/^[ \t]*[^{}\n]+:\s*__PDFJS_MISSING_ASSET__[^;]*;\s*$/gmu, '');

    return sanitized;
}

export function collectReferencedImages(cssText) {
    const images = new Set();
    for (const match of cssText.matchAll(/\/pdfjs\/images\/([^)'"?\s]+)/gu)) {
        images.add(match[1]);
    }
    return Array.from(images).sort((a, b) => a.localeCompare(b));
}

export function collectRequiredImageNames(cssText, sourceImageNames) {
    const runtimeAnnotationImages = sourceImageNames.filter((imageName) => /^annotation-[a-z0-9-]+\.svg$/u.test(imageName));
    return Array.from(new Set([...collectReferencedImages(cssText), ...runtimeAnnotationImages])).sort((a, b) => a.localeCompare(b));
}

export function normalizeWhitespace(cssText) {
    return cssText
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .concat('\n');
}

async function syncImages(imageNames) {
    await rm(targetImagesDir, {
        recursive: true,
        force: true,
    });
    await mkdir(targetImagesDir, {recursive: true});

    await Promise.all(
        imageNames.map(async (imageName) => {
            const sourcePath = path.join(sourceImagesDir, imageName);
            const targetPath = path.join(targetImagesDir, imageName);
            await copyFile(sourcePath, targetPath);
        }),
    );
}

export async function createPdfjsViewerCssSyncPlan() {
    const [sourceCss, sourceImages] = await Promise.all([readFile(sourceCssPath, 'utf8'), readdir(sourceImagesDir)]);

    const withoutUnusedUi = removeUnusedUiBlocks(sourceCss);
    const rewrittenUrls = rewriteImageUrls(withoutUnusedUi, sourceImages);
    const withoutEmptyRules = applyRanges(
        rewrittenUrls,
        collectBlockRanges(
            rewrittenUrls,
            (prelude, body) => !prelude.startsWith('@') && body.replace(/\/\*[\s\S]*?\*\//gu, '').trim().length === 0,
        ),
    );
    const normalizedCss = normalizeWhitespace(`/* Auto-generated by scripts/sync-pdfjs-viewer-css.mjs. */\n\n${withoutEmptyRules}`);
    const referencedImages = collectRequiredImageNames(normalizedCss, sourceImages);

    return {
        normalizedCss,
        referencedImages,
    };
}

export async function syncPdfjsViewerCss() {
    const plan = await createPdfjsViewerCssSyncPlan();
    const {normalizedCss, referencedImages} = plan;

    await mkdir(path.dirname(targetCssPath), {recursive: true});
    await writeFile(targetCssPath, normalizedCss, 'utf8');
    await syncImages(referencedImages);

    return {imageCount: referencedImages.length};
}

async function main() {
    if (process.argv.length > 2) {
        throw new Error('Usage: node scripts/sync-pdfjs-viewer-css.mjs');
    }
    const result = await syncPdfjsViewerCss();
    console.log(`Synced PDF.js viewer CSS (${result.imageCount} image assets): ${path.relative(projectRoot, targetCssPath)}`);
}

const isDirectCliRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    main().catch((error) => {
        console.error('Failed to sync PDF.js viewer CSS:', error);
        process.exit(1);
    });
}
