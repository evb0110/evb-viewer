import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
    describe,
    expect,
    it,
} from 'vitest';
import buttonTheme from '#build/ui/button';
import modalTheme from '#build/ui/modal';
import { LOCALE_MESSAGES } from '@i18n-app';
import { compileAppStylesheet } from '@tests/helpers/compileAppStylesheet';

const BROWSER_TEST_TIMEOUT_MS = 120_000;
// `app/app.config.ts` adds these to the modal's body slot, and the reserved
// scroll gutter they bring costs the option columns 30px of the dialog. The
// generated theme cannot carry them because app config is applied at runtime.
const APP_MODAL_BODY_CLASS = 'app-scrollbar app-scroll-region--balanced';
const PRINT_DIALOG_PATH = new URL(
    '../../../app/modules/pdf-viewer/components/PdfPrintDialog.vue',
    import.meta.url,
);
const DIALOG_CONTENT_CLASS_PATTERN = /const dialogUi = \{[\s\S]*?content: '([^']+)'/u;
const OPTION_BUTTON_CLASS_PATTERN = /const optionButtonClass = '([^']+)';/u;
const OPTION_GRID_CLASS_PATTERN = /<div(?:\s+[^>]*?)?\s+class="(grid gap-4[^"]*)"[^>]*>/u;
const OPTION_COLUMN_CLASS_PATTERN = /<div class="(flex [^"]*flex-col[^"]*)">/gu;

interface IOptionColumnMarkup {
    buttonClass: string;
    columnClasses: string[];
    contentClass: string;
    gridClass: string;
}

interface IColumnSpec extends IOptionColumnMarkup {
    headings: string[];
    labelColumns: string[][];
    truncatingLabelSlotClass: string | null;
}

/**
 * Reads the classes the component itself puts on its dialog and option columns
 * instead of restating them here, so a change to the component is measured
 * rather than silently tested against a stale copy.
 */
async function readOptionColumnMarkup() {
    const source = await readFile(PRINT_DIALOG_PATH, 'utf8');
    const buttonClass = OPTION_BUTTON_CLASS_PATTERN.exec(source)?.[1];
    const contentClass = DIALOG_CONTENT_CLASS_PATTERN.exec(source)?.[1];
    const gridMatch = OPTION_GRID_CLASS_PATTERN.exec(source);
    const gridClass = gridMatch?.[1];
    // The two columns no longer carry the same classes: the layout column claims
    // more of the grid than the orientation column does.
    const columnClasses = gridMatch
        ? [...source.slice(gridMatch.index).matchAll(OPTION_COLUMN_CLASS_PATTERN)]
            .slice(0, 2)
            .map(match => match[1] ?? '')
        : [];

    if (!buttonClass || !contentClass || !gridClass || columnClasses.length !== 2) {
        throw new Error('PdfPrintDialog.vue no longer exposes its dialog and option column classes in the shape this test reads');
    }

    return {
        buttonClass,
        columnClasses,
        contentClass,
        gridClass,
    };
}

/**
 * The width the dialog really gives its option columns: the modal theme's own
 * content and body classes, the component's width override, and the app's
 * reserved scroll gutter. Deriving it keeps the harness honest when either the
 * theme or the component changes its width.
 */
function buildDialogShellClasses(contentOverride: string) {
    // Nuxt UI merges the `ui` prop through tailwind-merge, so the override's
    // `max-w-*` replaces the theme's rather than racing it in the stylesheet.
    const themeContent = [
        modalTheme.slots.content,
        modalTheme.variants.fullscreen.false.content,
    ]
        .join(' ')
        .split(' ')
        .filter(candidate => !candidate.startsWith('max-w-'));

    return {
        bodyClass: [
            modalTheme.slots.body,
            modalTheme.variants.scrollable.false.body,
            APP_MODAL_BODY_CLASS,
        ].join(' '),
        contentClass: [
            ...themeContent,
            contentOverride,
        ].join(' '),
    };
}

function printLabelsFor(locale: keyof typeof LOCALE_MESSAGES) {
    const {print} = LOCALE_MESSAGES[locale];
    return {
        headings: [
            print.layoutLabel,
            print.orientationLabel,
        ],
        labelColumns: [
            [
                print.layoutSingle,
                print.layoutFacing,
                print.layoutFacingFirstSingle,
            ],
            [
                print.orientationAuto,
                print.orientationPortrait,
                print.orientationLandscape,
            ],
        ],
    };
}

function buildPageMarkup(appStylesheet: string, shell: {
    bodyClass: string;
    contentClass: string;
}) {
    return `<!doctype html>
<html>
<head><style>${appStylesheet}</style></head>
<body style="margin: 0">
<div class="${shell.contentClass}"><div class="${shell.bodyClass}"><div id="host"></div></div></div>
</body>
</html>`;
}

/**
 * Rebuilds the option columns in Chromium and reports how the option names sit
 * in the width the dialog actually offers them.
 */
function renderAndMeasureColumns(spec: IColumnSpec) {
    const host = document.querySelector('#host');
    if (!(host instanceof HTMLElement)) {
        throw new Error('Layout page lost its host element');
    }

    const grid = document.createElement('div');
    grid.className = spec.gridClass;
    const optionGroups = spec.labelColumns.map((labels, columnIndex) => {
        const column = document.createElement('div');
        column.className = spec.columnClasses[columnIndex] ?? '';
        const heading = document.createElement('p');
        heading.className = 'm-0 text-xs text-muted';
        heading.textContent = spec.headings[columnIndex] ?? '';
        const options = document.createElement('div');
        options.className = 'grid gap-2';
        for (const label of labels) {
            const button = document.createElement('button');
            button.className = spec.buttonClass;
            if (spec.truncatingLabelSlotClass === null) {
                button.textContent = label;
            } else {
                const labelSlot = document.createElement('span');
                labelSlot.className = spec.truncatingLabelSlotClass;
                labelSlot.textContent = label;
                button.append(labelSlot);
            }
            options.append(button);
        }
        column.append(heading, options);
        grid.append(column);
        return options;
    });
    host.replaceChildren(grid);

    const [
        layoutOptions,
        orientationOptions,
    ] = optionGroups;
    if (!layoutOptions || !orientationOptions) {
        throw new Error('Rendered print options are missing one of their two columns');
    }
    const columnButtons = (column: HTMLElement) => [...column.children]
        .filter((child): child is HTMLElement => child instanceof HTMLElement);
    const layoutButtons = columnButtons(layoutOptions);
    // Per-button geometry covers both columns, so a regression that wraps or
    // re-centres an orientation name fails too. Only the overlap measurement
    // stays layout-only: an orientation button is always right of the
    // orientation column's left edge, which would make that number meaningless.
    const buttons = [
        ...layoutButtons,
        ...columnButtons(orientationOptions),
    ];
    const rects = buttons.map(button => button.getBoundingClientRect());
    const rightmostEdgePx = Math.max(...rects.map(rect => rect.right));
    const layoutRightmostEdgePx = Math.max(
        ...layoutButtons.map(button => button.getBoundingClientRect().right),
    );

    // One client rect per line box the button's text occupies, which reports a
    // wrap without depending on a computed `line-height` the theme may leave at
    // `normal`.
    const lineCount = (button: HTMLElement) => {
        const label = button.firstChild;
        if (label === null) {
            throw new Error('Option button rendered without its label');
        }
        const range = document.createRange();
        range.selectNodeContents(label);
        const tops = new Set([...range.getClientRects()].map(rect => Math.round(rect.top)));
        range.detach();
        return Math.max(1, tops.size);
    };

    return {
        buttonHeightsPx: rects.map(rect => rect.height),
        clippedLabels: buttons
            .filter(button => button.scrollWidth > button.clientWidth + 1)
            .map(button => button.textContent ?? ''),
        columnOverlapPx: layoutRightmostEdgePx - orientationOptions.getBoundingClientRect().left,
        escapesGridPx: Math.max(0, rightmostEdgePx - grid.getBoundingClientRect().right),
        gridWidthPx: grid.getBoundingClientRect().width,
        layoutColumnWidthPx: layoutOptions.getBoundingClientRect().width,
        lineCounts: buttons.map(lineCount),
        textAligns: buttons.map(button => globalThis.getComputedStyle(button).textAlign),
        wrappedLabels: buttons
            .filter(button => lineCount(button) > 1)
            .map(button => button.textContent ?? ''),
    };
}

describe('print dialog option columns in Chromium', () => {
    it('fits every locale\'s option names on one line inside its own column', async () => {
        const markup = await readOptionColumnMarkup();
        const shell = buildDialogShellClasses(markup.contentClass);
        // The button geometry Nuxt UI's own theme applies, at the size `UButton`
        // defaults to, plus the `truncate` its label slot carries.
        const {size} = buttonTheme.variants;
        const nuxtUiButtonClass = [
            buttonTheme.slots.base,
            size[buttonTheme.defaultVariants.size].base,
        ].flat().join(' ');
        const labelSlotClass = buttonTheme.slots.label;

        expect(labelSlotClass).toContain('truncate');

        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            const buttonClass = `${nuxtUiButtonClass} ${markup.buttonClass}`;
            await page.setContent(buildPageMarkup(
                await compileAppStylesheet([
                    ...`${buttonClass} ${labelSlotClass} ${markup.columnClasses.join(' ')} ${markup.gridClass}`.split(' '),
                    ...shell.bodyClass.split(' '),
                    ...shell.contentClass.split(' '),
                    'grid',
                    'gap-2',
                    'm-0',
                    'text-xs',
                    'text-muted',
                ]),
                shell,
            ));
            // The app's own font decides whether an option name fits, and a
            // system fallback measures non-Latin names narrower than it does.
            const loadedFontFamilies = await page.evaluate(async () => {
                const probe = document.createElement('span');
                probe.textContent = 'Развороты';
                document.body.append(probe);
                await document.fonts.ready;
                const families = [...document.fonts]
                    .filter(face => face.status === 'loaded')
                    .map(face => face.family);
                probe.remove();
                return families;
            });

            expect(loadedFontFamilies).not.toStrictEqual([]);

            for (const locale of Object.keys(LOCALE_MESSAGES) as Array<keyof typeof LOCALE_MESSAGES>) {
                const geometry = await page.evaluate(renderAndMeasureColumns, {
                    ...markup,
                    ...printLabelsFor(locale),
                    buttonClass,
                    truncatingLabelSlotClass: null,
                });

                // A button that reaches past the orientation column's left edge is
                // the reported defect: the long option names painted over the
                // controls next to them.
                expect({
                    locale,
                    overlaps: geometry.columnOverlapPx > 0,
                }).toStrictEqual({
                    locale,
                    overlaps: false,
                });
                expect({
                    locale,
                    clippedLabels: geometry.clippedLabels,
                    escapesGridPx: geometry.escapesGridPx,
                }).toStrictEqual({
                    locale,
                    clippedLabels: [],
                    escapesGridPx: 0,
                });
                // The dialog is wide enough, and its layout column gets enough of
                // that width, that no shipped option name has to wrap.
                expect({
                    locale,
                    wrappedLabels: geometry.wrappedLabels,
                }).toStrictEqual({
                    locale,
                    wrappedLabels: [],
                });
                // Wrapped option names would read as text, not as centred fragments.
                expect(new Set(geometry.textAligns)).toStrictEqual(new Set(['start']));
                expect(geometry.buttonHeightsPx.every(height => height > 0)).toBe(true);
            }

            // The layout column carries the long names, so the split has to give it
            // more than the even share `grid-cols-2` would.
            const split = await page.evaluate(renderAndMeasureColumns, {
                ...markup,
                ...printLabelsFor('ru'),
                buttonClass,
                truncatingLabelSlotClass: null,
            });
            expect(split.layoutColumnWidthPx).toBeGreaterThan(split.gridWidthPx / 2);

            // A locale is free to name an option with one unbroken compound
            // word, which a grid item's automatic minimum size would otherwise
            // measure in full. None of the shipped locales does yet; the classes
            // have to hold when one does.
            const german = printLabelsFor('de');
            const compoundLabel = 'Doppelseitenmitersterseiteeinzelndargestelltundnummeriert';
            const compound = await page.evaluate(renderAndMeasureColumns, {
                ...markup,
                ...german,
                buttonClass,
                labelColumns: [
                    [
                        ...german.labelColumns[0]!.slice(0, 2),
                        compoundLabel,
                    ],
                    german.labelColumns[1]!,
                ],
                truncatingLabelSlotClass: null,
            });

            // Wrapping stays as the fallback for a name the widened dialog still
            // cannot fit: it breaks inside its own button instead of spilling out
            // of it. `break-words` would leave the text overflowing here, because
            // only `overflow-wrap: anywhere` shrinks a word's min-content width.
            expect(compound.wrappedLabels).toStrictEqual([compoundLabel]);
            expect(compound.clippedLabels).toStrictEqual([]);
            expect(compound.columnOverlapPx).toBeLessThan(0);
            expect(compound.escapesGridPx).toBe(0);

            // The shape this component used before: the theme's truncating label
            // slot, whose `nowrap` makes the button as wide as the whole option
            // name. It still overflows, which is what proves the measurement above
            // would catch a regression rather than passing on anything at all.
            const truncated = await page.evaluate(renderAndMeasureColumns, {
                ...markup,
                ...german,
                buttonClass: `${nuxtUiButtonClass} justify-start`,
                labelColumns: [
                    [
                        ...german.labelColumns[0]!.slice(0, 2),
                        compoundLabel,
                    ],
                    german.labelColumns[1]!,
                ],
                truncatingLabelSlotClass: labelSlotClass,
            });
            expect(truncated.columnOverlapPx).toBeGreaterThan(0);
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);
});
