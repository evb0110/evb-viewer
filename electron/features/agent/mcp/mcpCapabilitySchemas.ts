import * as v from 'valibot';
import {
    ANNOTATION_TOOLS,
    DRAWABLE_SHAPE_TOOLS,
} from '@contracts/annotations';
export {AGENT_OCR_RUN_INPUT_SCHEMA as OCR_RUN_INPUT_SCHEMA} from '@contracts/agentOcr';

const TAB_ID_SCHEMA = v.pipe(
    v.string(),
    v.description('Optional tab id. Defaults to the active tab.'),
);
const OBJECT_VALUE_SCHEMA = v.record(v.string(), v.unknown());

export const OBJECT_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: true,
};

export const EMPTY_INPUT_SCHEMA = v.strictObject({});
export const TAB_INPUT_SCHEMA = v.strictObject({tabId: v.optional(TAB_ID_SCHEMA)});
export const PAGE_INPUT_SCHEMA = v.strictObject({
    tabId: v.optional(TAB_ID_SCHEMA),
    page: v.pipe(v.number(), v.description('One-based page number.')),
});
const PAGE_NUMBER_ARRAY_SCHEMA = v.pipe(
    v.array(v.number()),
    v.minLength(1),
    v.description('One-based PDF page numbers.'),
);
const CROP_MARGIN_SCHEMA = v.pipe(
    v.number(),
    v.minValue(0),
    v.description('Crop margin in PDF points.'),
);
export const CROP_PAGES_INPUT_SCHEMA = v.strictObject({
    tabId: v.optional(TAB_ID_SCHEMA),
    pages: PAGE_NUMBER_ARRAY_SCHEMA,
    margins: v.pipe(v.strictObject({
        top: CROP_MARGIN_SCHEMA,
        right: CROP_MARGIN_SCHEMA,
        bottom: CROP_MARGIN_SCHEMA,
        left: CROP_MARGIN_SCHEMA,
    }), v.description('Crop margins in PDF points, matching EVB Viewer crop dialog semantics.')),
});
export const REMOVE_CROP_INPUT_SCHEMA = v.strictObject({
    tabId: v.optional(TAB_ID_SCHEMA),
    pages: PAGE_NUMBER_ARRAY_SCHEMA,
});
export const SEARCH_INPUT_SCHEMA = v.strictObject({
    tabId: v.optional(TAB_ID_SCHEMA),
    query: v.pipe(v.string(), v.description('Text or regex query to search for in the PDF.')),
    maxResults: v.optional(v.pipe(v.number(), v.description('Maximum results to return. Defaults to 25 and is capped at 100.'))),
    pages: v.optional(v.pipe(v.array(v.number()), v.description('Optional one-based pages to search. Use this for bounded probes in large PDFs.'))),
    startPage: v.optional(v.pipe(v.number(), v.description('Optional first page in a one-based inclusive search range.'))),
    endPage: v.optional(v.pipe(v.number(), v.description('Optional last page in a one-based inclusive search range.'))),
    matchCase: v.optional(v.boolean()),
    wholeWord: v.optional(v.boolean()),
    useRegex: v.optional(v.boolean()),
});
export const READ_PAGES_INPUT_SCHEMA = v.strictObject({
    tabId: v.optional(TAB_ID_SCHEMA),
    pages: v.optional(v.pipe(v.array(v.number()), v.description('One-based page numbers to read. If omitted, reads the current page.'))),
    startPage: v.optional(v.pipe(v.number(), v.description('Optional first page in a one-based inclusive range.'))),
    endPage: v.optional(v.pipe(v.number(), v.description('Optional last page in a one-based inclusive range.'))),
    maxCharsPerPage: v.optional(v.pipe(v.number(), v.description('Maximum characters to return per page. Defaults to 6000 and is capped at 30000.'))),
});
export const CAPTURE_PAGE_IMAGE_INPUT_SCHEMA = v.strictObject({
    tabId: v.optional(TAB_ID_SCHEMA),
    page: v.optional(v.pipe(v.number(), v.description('One-based PDF page to capture. Defaults to the current page.'))),
    pageNumber: v.optional(v.pipe(v.number(), v.description('Alias for page.'))),
    region: v.optional(v.pipe(v.picklist([
        'full',
        'top',
        'bottom',
        'left',
        'right',
        'center',
    ]), v.description('Preset page region to capture when normalized crop coordinates are not supplied. Defaults to full.'))),
    x: v.optional(v.pipe(v.number(), v.description('Optional normalized left coordinate from 0 to 1.'))),
    y: v.optional(v.pipe(v.number(), v.description('Optional normalized top coordinate from 0 to 1.'))),
    width: v.optional(v.pipe(v.number(), v.description('Optional normalized crop width from 0 to 1.'))),
    height: v.optional(v.pipe(v.number(), v.description('Optional normalized crop height from 0 to 1.'))),
});
export const OPEN_SIDEBAR_TAB_INPUT_SCHEMA = v.strictObject({tab: v.picklist([
    'annotations',
    'bookmarks',
    'thumbnails',
    'search',
])});
export const ANNOTATION_REF_INPUT_SCHEMA = v.strictObject({
    stableKey: v.optional(v.pipe(v.string(), v.description('Stable annotation key from evb://document/{tabId}/annotations or /notes.'))),
    annotationId: v.optional(v.string()),
    id: v.optional(v.string()),
});
export const ANNOTATION_UPDATE_NOTE_INPUT_SCHEMA = v.strictObject({
    stableKey: v.optional(v.pipe(v.string(), v.description('Stable annotation key from evb://document/{tabId}/annotations or /notes.'))),
    annotationId: v.optional(v.string()),
    id: v.optional(v.string()),
    text: v.pipe(v.string(), v.description('New note text. Use an empty string to clear the note.')),
});
export const ANNOTATION_COLOR_INPUT_SCHEMA = v.strictObject({
    stableKey: v.optional(v.pipe(v.string(), v.description('Stable annotation key from evb://document/{tabId}/annotations or /notes.'))),
    annotationId: v.optional(v.string()),
    id: v.optional(v.string()),
    color: v.pipe(v.string(), v.description('CSS color to apply to a text markup annotation, for example #ffd54f.')),
});
export const ANNOTATION_TOOL_INPUT_SCHEMA = v.strictObject({tool: v.picklist(ANNOTATION_TOOLS)});
export const ANNOTATION_TEXT_MARKUP_INPUT_SCHEMA = v.strictObject({
    page: v.optional(v.pipe(v.number(), v.description('One-based PDF page number containing the text. Defaults to the current page.'))),
    pageNumber: v.optional(v.pipe(v.number(), v.description('Alias for page.'))),
    text: v.pipe(v.string(), v.description('Exact visible page text to mark. Use document.search/read_pages first when uncertain.')),
    query: v.optional(v.pipe(v.string(), v.description('Alias for text.'))),
    occurrence: v.optional(v.pipe(v.number(), v.description('One-based occurrence of text on the page. Defaults to 1.'))),
    markup: v.optional(v.pipe(v.picklist([
        'highlight',
        'underline',
        'strikethrough',
        'squiggly',
    ]), v.description('Text markup to create. Defaults to highlight.'))),
    tool: v.optional(v.pipe(v.picklist([
        'highlight',
        'underline',
        'strikethrough',
        'squiggly',
    ]), v.description('Alias for markup.'))),
    matchCase: v.optional(v.pipe(v.boolean(), v.description('Whether text matching must preserve case exactly.'))),
    caseSensitive: v.optional(v.pipe(v.boolean(), v.description('Alias for matchCase.'))),
    wholeWord: v.optional(v.pipe(v.boolean(), v.description('Only match text on word boundaries.'))),
    withNote: v.optional(v.pipe(v.boolean(), v.description('Open a note on the created text markup, matching the user comment-selection workflow.'))),
    openNote: v.optional(v.pipe(v.boolean(), v.description('Alias for withNote.'))),
});
export const ANNOTATION_POINT_NOTE_INPUT_SCHEMA = v.strictObject({
    page: v.optional(v.pipe(v.number(), v.description('One-based PDF page number. Defaults to the current page.'))),
    pageNumber: v.optional(v.pipe(v.number(), v.description('Alias for page.'))),
    pageX: v.optional(v.pipe(v.number(), v.description('Normalized horizontal page coordinate from 0 to 1.'))),
    pageY: v.optional(v.pipe(v.number(), v.description('Normalized vertical page coordinate from 0 to 1.'))),
    x: v.optional(v.pipe(v.number(), v.description('Alias for pageX.'))),
    y: v.optional(v.pipe(v.number(), v.description('Alias for pageY.'))),
    preferTextAnchor: v.optional(v.pipe(v.boolean(), v.description('Prefer anchoring the note to nearby text when possible. Defaults to true.'))),
});
export const ANNOTATION_SHAPE_INPUT_SCHEMA = v.strictObject({
    page: v.optional(v.pipe(v.number(), v.description('One-based PDF page number. Defaults to the current page.'))),
    pageNumber: v.optional(v.pipe(v.number(), v.description('Alias for page.'))),
    shape: v.pipe(v.picklist(DRAWABLE_SHAPE_TOOLS), v.description('Shape type to create.')),
    tool: v.optional(v.pipe(v.picklist(DRAWABLE_SHAPE_TOOLS), v.description('Alias for shape.'))),
    x: v.optional(v.pipe(v.number(), v.description('Normalized start/left page coordinate from 0 to 1.'))),
    y: v.optional(v.pipe(v.number(), v.description('Normalized start/top page coordinate from 0 to 1.'))),
    width: v.optional(v.pipe(v.number(), v.description('Normalized width for rectangle/circle, or fallback line delta.'))),
    height: v.optional(v.pipe(v.number(), v.description('Normalized height for rectangle/circle, or fallback line delta.'))),
    x2: v.optional(v.pipe(v.number(), v.description('Normalized end/right page coordinate for line/arrow or box corner.'))),
    y2: v.optional(v.pipe(v.number(), v.description('Normalized end/bottom page coordinate for line/arrow or box corner.'))),
    points: v.optional(v.pipe(v.array(OBJECT_VALUE_SCHEMA), v.description('Freehand draw points as normalized {x,y} objects.'))),
    strokes: v.optional(v.pipe(v.array(v.array(OBJECT_VALUE_SCHEMA)), v.description('Freehand draw strokes as arrays of normalized {x,y} objects.'))),
    color: v.optional(v.pipe(v.string(), v.description('CSS stroke color override. Defaults to current viewer annotation settings.'))),
    fillColor: v.optional(v.pipe(v.nullable(v.string()), v.description('CSS fill color override; null or transparent means no fill.'))),
    opacity: v.optional(v.pipe(v.number(), v.description('Opacity from 0 to 1.'))),
    strokeWidth: v.optional(v.pipe(v.number(), v.description('Stroke width in viewer annotation units.'))),
});

const PAGE_LABEL_STYLE_SCHEMA = v.pipe(
    v.nullable(v.picklist([
        'D',
        'R',
        'r',
        'A',
        'a',
        'decimal',
        'roman-upper',
        'roman-lower',
        'letters-upper',
        'letters-lower',
        'literal',
    ])),
    v.description('Numbering style: decimal, roman, letters, or null/literal for prefix-only labels.'),
);
const PAGE_LABEL_PREFIX_SCHEMA = v.pipe(v.string(), v.description('Prefix prepended to generated numbers, or the literal label when style is null.'));
const PAGE_LABEL_START_NUMBER_SCHEMA = v.pipe(v.number(), v.description('First generated number for startPage. Defaults to 1.'));
const PAGE_LABEL_RANGE_SCHEMA = v.strictObject({
    startPage: v.pipe(v.number(), v.description('One-based page where this numbering range starts.')),
    style: v.optional(PAGE_LABEL_STYLE_SCHEMA),
    prefix: v.optional(PAGE_LABEL_PREFIX_SCHEMA),
    startNumber: v.optional(PAGE_LABEL_START_NUMBER_SCHEMA),
});
const PAGE_LABEL_SEGMENT_SCHEMA = v.strictObject({
    startPage: v.pipe(v.number(), v.description('One-based page where this numbering range starts.')),
    style: v.optional(PAGE_LABEL_STYLE_SCHEMA),
    prefix: v.optional(PAGE_LABEL_PREFIX_SCHEMA),
    startNumber: v.optional(PAGE_LABEL_START_NUMBER_SCHEMA),
    endPage: v.optional(v.pipe(v.number(), v.description('One-based inclusive end page for this segment.'))),
    toPage: v.optional(v.pipe(v.number(), v.description('Alias for endPage.'))),
    label: v.optional(v.pipe(v.string(), v.description('Literal label for this segment when style/prefix are omitted.'))),
});
const PAGE_LABEL_UPDATES_SCHEMA = v.pipe(v.array(v.strictObject({
    page: v.optional(v.number()),
    pageNumber: v.optional(v.number()),
    label: v.optional(v.string()),
})), v.description('Batch of explicit per-page label updates.'));
const PAGE_LABEL_LABELS_SCHEMA = v.pipe(v.array(v.string()), v.description('Explicit labels starting at physical page 1; omitted pages keep their current labels.'));
export const PAGE_LABEL_SET_RANGES_INPUT_SCHEMA = v.strictObject({ranges: v.pipe(v.array(PAGE_LABEL_RANGE_SCHEMA), v.description('Complete replacement set of page-label ranges.'))});
export const PAGE_LABEL_APPLY_RANGE_INPUT_SCHEMA = v.strictObject({
    startPage: v.optional(v.number()),
    endPage: v.optional(v.number()),
    page: v.optional(v.pipe(v.number(), v.description('Alias for a single-page startPage.'))),
    pageNumber: v.optional(v.pipe(v.number(), v.description('Alias for page.'))),
    style: v.optional(PAGE_LABEL_STYLE_SCHEMA),
    prefix: v.optional(PAGE_LABEL_PREFIX_SCHEMA),
    startNumber: v.optional(PAGE_LABEL_START_NUMBER_SCHEMA),
});
export const PAGE_LABEL_SET_LABELS_INPUT_SCHEMA = v.strictObject({
    labels: v.optional(PAGE_LABEL_LABELS_SCHEMA),
    updates: v.optional(PAGE_LABEL_UPDATES_SCHEMA),
    page: v.optional(v.number()),
    pageNumber: v.optional(v.number()),
    label: v.optional(v.string()),
});
export const PAGE_LABEL_PLAN_INPUT_SCHEMA = v.strictObject({
    ranges: v.optional(v.pipe(v.array(PAGE_LABEL_RANGE_SCHEMA), v.description('Complete replacement PDF page-label ranges. Use for regular range plans.'))),
    segments: v.optional(v.pipe(v.array(PAGE_LABEL_SEGMENT_SCHEMA), v.description('Inclusive page spans with generated labels; easier for agents than raw PDF ranges because each segment may include endPage.'))),
    labels: v.optional(PAGE_LABEL_LABELS_SCHEMA),
    updates: v.optional(PAGE_LABEL_UPDATES_SCHEMA),
    page: v.optional(v.number()),
    pageNumber: v.optional(v.number()),
    label: v.optional(v.string()),
    startPage: v.optional(v.pipe(v.number(), v.description('Starting page when labels is a partial explicit-label array.'))),
    base: v.optional(v.pipe(v.picklist([
        'current',
        'default',
        'physical',
    ]), v.description('Base labels for segments or explicit updates. Defaults to current labels; default/physical starts from physical decimal pages.'))),
});

const BOOKMARK_PATH_SCHEMA = v.pipe(
    v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
    v.description('Zero-based path in the bookmark tree, for example [0,2] for the third child of the first root bookmark.'),
);
const BOOKMARK_PATH_REQUIRED_SCHEMA = v.pipe(
    v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
    v.minLength(1),
    v.description('Zero-based path in the bookmark tree, for example [0,2] for the third child of the first root bookmark.'),
);
const BOOKMARK_PATH_SELECTOR_SCHEMA = v.pipe(
    v.array(BOOKMARK_PATH_REQUIRED_SCHEMA),
    v.minLength(1),
    v.description('Zero-based bookmark paths to target in one metadata edit.'),
);
const BOOKMARK_PATH_ITEMS_SCHEMA = v.pipe(v.array(v.strictObject({path: BOOKMARK_PATH_REQUIRED_SCHEMA})), v.minLength(1), v.description('Alias for paths using objects returned by bookmarks.read flat entries.'));
const BOOKMARK_PATH_BOOKMARKS_SCHEMA = v.pipe(v.array(v.strictObject({path: BOOKMARK_PATH_REQUIRED_SCHEMA})), v.minLength(1), v.description('Alias for items.'));
const BOOKMARK_PATH_SELECTOR_PROPERTIES = {
    paths: v.optional(BOOKMARK_PATH_SELECTOR_SCHEMA),
    items: v.optional(BOOKMARK_PATH_ITEMS_SCHEMA),
    bookmarks: v.optional(BOOKMARK_PATH_BOOKMARKS_SCHEMA),
    path: v.optional(BOOKMARK_PATH_REQUIRED_SCHEMA),
};
const BOOKMARK_COLOR_SCHEMA = v.nullable(v.string());
const BOOKMARK_ENTRY_PROPERTIES = {
    title: v.optional(v.string()),
    page: v.optional(v.pipe(v.number(), v.description('One-based destination page.'))),
    pageNumber: v.optional(v.pipe(v.number(), v.description('Alias for page.'))),
    pageIndex: v.optional(v.pipe(v.number(), v.description('Zero-based destination page index.'))),
    pageYRatio: v.optional(v.pipe(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))), v.description('Optional vertical destination within the page, where 0 is the top and 1 is the bottom. Use this for subsection anchors that start mid-page.'))),
    namedDest: v.optional(v.string()),
    dest: v.optional(v.pipe(v.string(), v.description('Alias for namedDest.'))),
    bold: v.optional(v.boolean()),
    italic: v.optional(v.boolean()),
    color: v.optional(v.pipe(BOOKMARK_COLOR_SCHEMA, v.description('Hex color such as #336699, or null to clear.'))),
    items: v.optional(v.pipe(v.array(OBJECT_VALUE_SCHEMA), v.description('Nested child bookmarks using the same entry shape.'))),
    children: v.optional(v.pipe(v.array(OBJECT_VALUE_SCHEMA), v.description('Alias for items.'))),
    parentPath: v.optional(BOOKMARK_PATH_SCHEMA),
    index: v.optional(v.pipe(v.number(), v.description('Zero-based insert index within the parent. Defaults to append.'))),
};
const BOOKMARK_ENTRY_SCHEMA = v.strictObject(BOOKMARK_ENTRY_PROPERTIES);
const BOOKMARK_FLAT_ENTRY_SCHEMA = v.strictObject({
    ...BOOKMARK_ENTRY_PROPERTIES,
    level: v.optional(v.pipe(v.number(), v.description('One-based outline level for flat TOC input; level 1 is a root bookmark.'))),
    depth: v.optional(v.pipe(v.number(), v.description('Zero-based outline depth for flat TOC input; depth 0 is a root bookmark.'))),
});
export const BOOKMARK_TREE_INPUT_SCHEMA = v.strictObject({
    bookmarks: v.optional(v.pipe(v.array(BOOKMARK_ENTRY_SCHEMA), v.description('Complete replacement bookmark tree.'))),
    items: v.optional(v.pipe(v.array(BOOKMARK_ENTRY_SCHEMA), v.description('Alias for bookmarks.'))),
    tree: v.optional(v.pipe(v.array(BOOKMARK_ENTRY_SCHEMA), v.description('Alias for bookmarks.'))),
    entries: v.optional(v.pipe(v.array(BOOKMARK_FLAT_ENTRY_SCHEMA), v.description('Flat TOC entries with level/depth values. The renderer converts them into nested bookmarks.'))),
    flat: v.optional(v.pipe(v.array(BOOKMARK_FLAT_ENTRY_SCHEMA), v.description('Alias for entries.'))),
    outline: v.optional(v.pipe(v.array(BOOKMARK_FLAT_ENTRY_SCHEMA), v.description('Alias for entries.'))),
});
export const BOOKMARK_PLAN_INPUT_SCHEMA = BOOKMARK_TREE_INPUT_SCHEMA;
export const BOOKMARK_ADD_INPUT_SCHEMA = v.strictObject({
    ...BOOKMARK_ENTRY_PROPERTIES,
    bookmark: v.optional(BOOKMARK_ENTRY_SCHEMA),
});
export const BOOKMARK_ADD_BATCH_INPUT_SCHEMA = v.strictObject({
    parentPath: v.optional(BOOKMARK_PATH_SCHEMA),
    bookmarks: v.optional(v.array(BOOKMARK_ENTRY_SCHEMA)),
    items: v.optional(v.array(BOOKMARK_ENTRY_SCHEMA)),
});
export const BOOKMARK_UPDATE_INPUT_SCHEMA = v.strictObject({
    path: BOOKMARK_PATH_SCHEMA,
    ...BOOKMARK_ENTRY_PROPERTIES,
    bookmark: v.optional(BOOKMARK_ENTRY_SCHEMA),
});
export const BOOKMARK_DELETE_INPUT_SCHEMA = v.strictObject({path: BOOKMARK_PATH_SCHEMA});
const BOOKMARK_DELETE_BATCH_PROPERTIES = {
    ...BOOKMARK_PATH_SELECTOR_PROPERTIES,
    paths: v.optional(v.pipe(BOOKMARK_PATH_SELECTOR_SCHEMA, v.description('Zero-based bookmark paths to delete in one metadata edit.'))),
};
export const BOOKMARK_DELETE_BATCH_INPUT_SCHEMA = v.intersect([
    v.strictObject(BOOKMARK_DELETE_BATCH_PROPERTIES),
    v.union([
        v.object({paths: v.unknown()}),
        v.object({items: v.unknown()}),
        v.object({bookmarks: v.unknown()}),
        v.object({path: v.unknown()}),
    ]),
]);
const BOOKMARK_SET_STYLE_PROPERTIES = {
    ...BOOKMARK_PATH_SELECTOR_PROPERTIES,
    paths: v.optional(v.pipe(BOOKMARK_PATH_SELECTOR_SCHEMA, v.description('Zero-based bookmark paths to restyle in one metadata edit.'))),
    range: v.optional(v.pipe(v.strictObject({
        from: BOOKMARK_PATH_REQUIRED_SCHEMA,
        to: BOOKMARK_PATH_REQUIRED_SCHEMA,
    }), v.description('Inclusive range of sibling bookmarks; from and to share the same parent and may be given in either order.'))),
    depth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.description('Zero-based outline depth to select; picks every bookmark at that absolute depth, optionally scoped under parentPath.'))),
    level: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description('One-based alias of depth + 1.'))),
    parentPath: v.optional(BOOKMARK_PATH_SCHEMA),
    includeDescendants: v.optional(v.pipe(v.boolean(), v.description('Also style every descendant of each selected bookmark. Defaults to false.'))),
    bold: v.optional(v.boolean()),
    italic: v.optional(v.boolean()),
    color: v.optional(v.pipe(v.nullable(v.string()), v.description('Hex color such as #336699, or null to reset to the default text color.'))),
};
export const BOOKMARK_SET_STYLE_INPUT_SCHEMA = v.intersect(
    [
        v.intersect([
            v.strictObject(BOOKMARK_SET_STYLE_PROPERTIES),
            v.union([
                v.object({paths: v.unknown()}),
                v.object({items: v.unknown()}),
                v.object({bookmarks: v.unknown()}),
                v.object({path: v.unknown()}),
                v.object({range: v.unknown()}),
                v.object({depth: v.unknown()}),
                v.object({level: v.unknown()}),
            ]),
        ]),
        v.union([
            v.object({bold: v.unknown()}),
            v.object({italic: v.unknown()}),
            v.object({color: v.unknown()}),
        ]),
    ],
);
export const VIEW_MODE_INPUT_SCHEMA = v.strictObject({mode: v.picklist([
    'single',
    'facing',
    'facing-first-single',
])});
export const INSERT_PAGES_INPUT_SCHEMA = v.strictObject({afterPage: v.optional(v.pipe(v.number(), v.description('One-based page after which selected files should be inserted. Defaults to the end of the document.')))});
export const ALLOW_INTERNAL_AND_EXTERNAL = {
    internal: 'allow',
    external: 'allow',
} as const;
export const CONFIRM_EXTERNAL = {
    internal: 'allow',
    external: 'confirm',
} as const;
export const CONFIRM_ALL_WRITES = {
    internal: 'confirm',
    external: 'confirm',
} as const;
