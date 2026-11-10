# Chrome extension

The extension makes EVB Viewer Chrome's viewer for PDF and DjVu documents. It
packages the browser workspace as an extension page, so every browser feature
(annotations, page editing, OCR, scan cleanup, DjVu conversion) works on a
document opened from a link, without visiting the website.

## Build and load

```sh
pnpm run build:chrome-extension
```

This writes `dist-chrome-extension/unpacked/` and a zip of it for the Chrome Web
Store. `--skip-app-build` repackages the last workspace build when only files in
this package changed.

To try it, open `chrome://extensions`, turn on Developer mode, choose **Load
unpacked** and select `dist-chrome-extension/unpacked`. To open local files,
turn on **Allow access to file URLs** in the extension's details; Chrome gives
no extension that access by itself.

## How a document reaches the viewer

1. The service worker (`src/serviceWorker.ts`) installs redirect rules
   (`src/documentRedirectRules.ts`) that match a top-level GET response by its
   headers: `application/pdf`, a DjVu type, or a generic binary type on a URL
   ending in `.pdf`, `.djvu` or `.djv`. A response sent as an attachment stays
   a download, and a form's POST stays with Chrome, because it cannot be
   fetched again.
2. A matching response is redirected to `open.html` with the document URL as
   its raw query. The open page (`src/openPage.ts`) moves it into the viewer
   page's encoded `file` parameter (`packages/contracts/browserExtensionLaunch.ts`).
3. The viewer page is the workspace build (`EVB_BROWSER_EXTENSION_BUILD=1` in
   `nuxt.config.ts`). `app/platform/browser-api/openBrowserExtensionDocument.ts`
   fetches the document with the site's cookies, checks its signature, and
   opens it as a dropped file would be. The `file` parameter stays readable in
   the address bar, so it shows where the document came from and a bookmark
   opens it again. The page's history entry keeps the stored document, so a
   reload shows it again without fetching it; a window the workspace opens
   leaves the parameter out.
4. When the response is not a PDF or DjVu document, or cannot be fetched, the
   viewer asks the service worker to let Chrome open that URL in the tab.

Local files never reach the network rules: the service worker sends a `file:`
navigation to the viewer page when the user allowed file access.

A stored document has no folder of its own, so the status bar's folder button
saves it to the Downloads folder through Chrome's downloads and shows it there
(`app/platform/browser-api/showBrowserDocumentInDownloads.ts`). Each revision
is saved once; a later click shows the same download.

## Permissions

| Permission | Why |
| --- | --- |
| `declarativeNetRequestWithHostAccess`, host access to all sites | Redirect PDF and DjVu responses from any site, and fetch them again with the site's cookies. |
| `downloads` | Save a document to the Downloads folder and show it there when the status bar's folder button is clicked. |
| `webNavigation` | Send local PDF and DjVu files to the viewer, and end a tab's hand-back to Chrome when it navigates on. |
| `storage` | Remember, for the browser session, which tabs Chrome opens itself. |
| `unlimitedStorage` | Keep opened documents, OCR models and recovery data, as the website does. |

## Extension page rules

Extension pages run only script files packaged with the extension and refuse
any file or folder in the package root whose name starts with `_`. The build
therefore places Nuxt's output under `assets/`, moves each inline script of
`index.html` into its own file, leaves out the import map and the inline head
scripts the client would add again, and fails if either rule is broken.
