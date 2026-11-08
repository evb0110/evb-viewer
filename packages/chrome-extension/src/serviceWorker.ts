import {
    BROWSER_EXTENSION_OPEN_PAGE,
    BROWSER_EXTENSION_VIEWER_PAGE,
    createBrowserExtensionViewerUrl,
    isBrowserExtensionOpenNativelyRequest,
} from '@contracts/browserExtensionLaunch';
import {
    createDocumentRedirectRules,
    createOpenNativelyRule,
} from './documentRedirectRules';

// Tabs the viewer handed back to Chrome, one session entry per tab holding the
// document URL Chrome opens there. The entry ends when the tab shows anything
// else. Separate keys let overlapping events write without reading each other.
const LOCAL_DOCUMENT_URL_PATTERN = '(?i)\\.(pdf|djvu?)$';

function nativeTabKey(tabId: number) {
    return `nativeDocumentTab:${String(tabId)}`;
}

async function readNativeTab(tabId: number) {
    const url: unknown = (await chrome.storage.session.get(nativeTabKey(tabId)))[nativeTabKey(tabId)];
    return typeof url === 'string' ? url : null;
}

async function setNativeTab(tabId: number, url: string | null) {
    await (url === null
        ? chrome.storage.session.remove(nativeTabKey(tabId))
        : chrome.storage.session.set({[nativeTabKey(tabId)]: url}));
    await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [tabId],
        addRules: url !== null && !url.startsWith('file:') ? [createOpenNativelyRule(tabId)] : [],
    });
}

async function installRedirectRules() {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map(rule => rule.id),
        addRules: createDocumentRedirectRules(chrome.runtime.getURL(BROWSER_EXTENSION_OPEN_PAGE)),
    });
}

async function openNatively(tabId: number, url: string) {
    await setNativeTab(tabId, url);
    await chrome.tabs.update(tabId, {url});
}

// A local file never reaches the network rules. Its tab is sent to the viewer
// only when Chrome lets the extension read local files.
async function openLocalDocument(tabId: number, url: string) {
    if (!await chrome.extension.isAllowedFileSchemeAccess() || await readNativeTab(tabId) === url) {
        return;
    }
    await chrome.tabs.update(tabId, {url: createBrowserExtensionViewerUrl(chrome.runtime.getURL(''), url)});
}

chrome.runtime.onInstalled.addListener(() => {
    void installRedirectRules();
});

chrome.action.onClicked.addListener(() => {
    void chrome.tabs.create({url: chrome.runtime.getURL(BROWSER_EXTENSION_VIEWER_PAGE)});
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || tabId === undefined || !isBrowserExtensionOpenNativelyRequest(message)) {
        return false;
    }
    openNatively(tabId, message.url).then(
        () => sendResponse(true),
        () => sendResponse(false),
    );
    return true;
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId === 0) {
        void openLocalDocument(details.tabId, details.url);
    }
}, {url: [{
    schemes: ['file'],
    urlMatches: LOCAL_DOCUMENT_URL_PATTERN,
}]});

chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) {
        return;
    }
    void readNativeTab(details.tabId).then(url => (
        url !== null && url !== details.url ? setNativeTab(details.tabId, null) : undefined
    ));
});

chrome.tabs.onRemoved.addListener((tabId) => {
    void readNativeTab(tabId).then(url => (url !== null ? setNativeTab(tabId, null) : undefined));
});
