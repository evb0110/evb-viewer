type TRule = chrome.declarativeNetRequest.Rule;
type THeaderInfo = chrome.declarativeNetRequest.HeaderInfo;

// Chrome downloads a response it was told to download, so the viewer leaves
// those alone, as Chrome's own PDF viewer does.
const NOT_AN_ATTACHMENT: THeaderInfo[] = [{
    header: 'content-disposition',
    values: ['attachment*'],
}];

function contentTypes(...types: string[]): THeaderInfo[] {
    return [{
        header: 'content-type',
        // Matching is case-insensitive; `*` admits parameters such as a charset.
        values: types.flatMap(type => [
            type,
            `${type};*`,
            `${type} *`,
        ]),
    }];
}

function redirectRule(id: number, openPageUrl: string, condition: Partial<chrome.declarativeNetRequest.RuleCondition>): TRule {
    return {
        id,
        priority: 1,
        action: {
            type: 'redirect',
            redirect: {regexSubstitution: `${openPageUrl}?\\0`},
        },
        condition: {
            regexFilter: '^https?://.*$',
            resourceTypes: ['main_frame'],
            // A form's POST cannot be fetched again, so it stays with Chrome.
            requestMethods: ['get'],
            excludedResponseHeaders: NOT_AN_ATTACHMENT,
            ...condition,
        },
    };
}

/**
 * The rules that send a top-level PDF or DjVu response to the open page,
 * which appends the document's URL unencoded. A generic binary type counts
 * when the URL's path names a PDF or DjVu file.
 */
export function createDocumentRedirectRules(openPageUrl: string): TRule[] {
    return [
        redirectRule(1, openPageUrl, {responseHeaders: contentTypes('application/pdf', 'application/x-pdf')}),
        redirectRule(2, openPageUrl, {responseHeaders: contentTypes('image/vnd.djvu', 'image/x-djvu', 'image/djvu')}),
        redirectRule(3, openPageUrl, {
            regexFilter: '^https?://[^?#]*\\.(pdf|djvu?)([?#].*)?$',
            isUrlFilterCaseSensitive: false,
            responseHeaders: contentTypes('application/octet-stream', 'binary/octet-stream'),
        }),
    ];
}

/** Lets Chrome itself open the next document in one tab. */
export function createOpenNativelyRule(tabId: number): TRule {
    return {
        id: tabId,
        priority: 2,
        action: {type: 'allow'},
        condition: {
            tabIds: [tabId],
            resourceTypes: ['main_frame'],
        },
    };
}
