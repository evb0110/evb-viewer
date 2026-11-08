import {
    BROWSER_EXTENSION_VIEWER_PAGE,
    createBrowserExtensionViewerUrl,
    readBrowserExtensionOpenPageDocumentUrl,
} from '@contracts/browserExtensionLaunch';

// The redirect rule lands here with the document URL as the raw query. The
// viewer page takes it as an encoded parameter, so the URL's own query and
// fragment survive the workspace's later URL edits.
const documentUrl = readBrowserExtensionOpenPageDocumentUrl(location.href);
location.replace(documentUrl
    ? createBrowserExtensionViewerUrl(location.href, documentUrl)
    : new URL(BROWSER_EXTENSION_VIEWER_PAGE, location.href).href);
