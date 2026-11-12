import {join} from 'node:path';
import {GlobalFonts} from '@napi-rs/canvas';

export const FIXTURE_SANS_FONT_FAMILY = 'EvbFixtureSans';
export const FIXTURE_SERIF_FONT_FAMILY = 'EvbFixtureSerif';

// A runner may have only an emoji font. Draw the scan's words with checked-in
// fonts, as the OCR corpus does, instead of silently generating blank input.
for (const [filename, family] of [
    ['NotoSans-Regular.ttf', FIXTURE_SANS_FONT_FAMILY],
    ['NotoSerif-Regular.ttf', FIXTURE_SERIF_FONT_FAMILY],
] as const) {
    if (!GlobalFonts.registerFromPath(join(process.cwd(), 'scripts/fixtures/ocr-language-fonts', filename), family)) {
        throw new Error(`Could not register scan fixture font: ${filename}`);
    }
}
