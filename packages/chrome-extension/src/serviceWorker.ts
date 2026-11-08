import {
    BROWSER_EXTENSION_OPEN_PAGE,
    BROWSER_EXTENSION_VIEWER_PAGE,
    createBrowserExtensionViewerUrl,
    isBrowserExtensionOpenNativelyRequest,
} from '@contracts/browserExtensionLaunch';
import { isRecord } from '@contracts/runtimeGuards';
import {
    createDocumentRedirectRules,
    createOpenNativelyRule,
} from './documentRedirectRules';

// Tabs the viewer handed back to Chrome, by tab id, with the document URL
// Chrome opens there. The entry ends when the tab shows anything else.
const NATIVE_TABS_KEY = 'nativeDocumentTabs';
const LOCAL_DOCUMENT_URL_PATTERN = '(?i)\\.(pdf|djvu?)$';

async function readNativeTabs(): Promise<Record<string, unknown>> {
    const stored: unknown = (await chrome.storage.session.get(NATIVE_TABS_KEY))[NATIVE_TABS_KEY];
    return isRecord(stored) ? stored : {};
}

async function setNativeTab(tabId: number, url: string | null) {
    const tabs = Object.fromEntries(Object.entries(await readNativeTabs()).filter(([id]) => id !== String(tabId)));
    await chrome.storage.session.set({[NATIVE_TABS_KEY]: url === null ? tabs : {
        ...tabs,
        [tabId]: url,
    }});
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
    if (!await chrome.extension.isAllowedFileSchemeAccess() || (await readNativeTabs())[tabId] === url) {
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
    void readNativeTabs().then((tabs) => {
        const url = tabs[details.tabId];
        return url !== undefined && url !== details.url ? setNativeTab(details.tabId, null) : undefined;
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    void readNativeTabs().then(tabs => (tabId in tabs ? setNativeTab(tabId, null) : undefined));
});
