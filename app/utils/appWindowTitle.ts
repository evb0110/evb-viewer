interface IResolveAppWindowTitleOptions {
    appTitle: string;
    webTitle: string;
    fileName?: string | null;
    isBrowserRuntime: boolean;
}

const MAX_WINDOW_TITLE_FILE_NAME_LENGTH = 60;

function formatBrowserPageTitle(options: {
    appName: string;
    fileName?: string | null;
}) {
    const appName = options.appName.trim();
    const fileName = options.fileName?.trim() ?? '';

    if (!fileName) {
        return appName;
    }

    return `${fileName} - ${appName}`;
}

function normalizeTitle(value: string | null | undefined) {
    return value?.trim() ?? '';
}

function truncateWindowTitleFileName(value: string) {
    if (value.length <= MAX_WINDOW_TITLE_FILE_NAME_LENGTH) {
        return value;
    }

    // Whole characters only, so an emoji or accented letter is never cut in half.
    let kept = '';
    for (const {segment} of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(value)) {
        if (kept.length + segment.length > MAX_WINDOW_TITLE_FILE_NAME_LENGTH - 1) break;
        kept += segment;
    }
    return `${kept.trimEnd()}…`;
}

export function resolveAppWindowTitle(options: IResolveAppWindowTitleOptions) {
    const appTitle = normalizeTitle(options.appTitle);
    const webTitle = normalizeTitle(options.webTitle);
    const fileName = truncateWindowTitleFileName(normalizeTitle(options.fileName));

    if (!fileName) {
        return options.isBrowserRuntime ? webTitle : appTitle;
    }

    if (!options.isBrowserRuntime) {
        return fileName;
    }

    return formatBrowserPageTitle({
        appName: webTitle,
        fileName,
    });
}

export function formatWebTitleTemplate(pageTitle: string | null | undefined, appTitle: string) {
    const normalizedPageTitle = normalizeTitle(pageTitle);
    const normalizedAppTitle = normalizeTitle(appTitle);

    if (!normalizedPageTitle || normalizedPageTitle === normalizedAppTitle) {
        return normalizedAppTitle;
    }

    return `${normalizedPageTitle} — ${normalizedAppTitle}`;
}
