import {
    BROWSER_EXTENSION_VIEWER_PAGE,
    createBrowserExtensionViewerUrl,
    readBrowserExtensionOpenPageDocumentUrl,
} from '@contracts/browserExtensionLaunch';

// The redirect rule lands here with the document URL as the raw query. The
// viewer page takes it as its last parameter, with only its fragment mark
// escaped, so the URL's own query and fragment survive the workspace's
// fragment routing.
const documentUrl = readBrowserExtensionOpenPageDocumentUrl(location.href);
location.replace(documentUrl
    ? createBrowserExtensionViewerUrl(location.href, documentUrl)
    : new URL(BROWSER_EXTENSION_VIEWER_PAGE, location.href).href);
