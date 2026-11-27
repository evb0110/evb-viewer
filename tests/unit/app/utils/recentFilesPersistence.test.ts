import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseRecentFilesCookieSnapshot, readBrowserRecentFilesSnapshot, RECENT_FILES_COOKIE_KEY} from '@app/utils/recentFilesPersistence';
import {BROWSER_RECENT_FILES_STORAGE_KEY} from '@app/utils/browserRuntimePersistence';

function expectedLegacyRecentFilesCookieExpiry(secure = false) {
    return `${RECENT_FILES_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function stubBrowserStorage(options: {
    cookie?: string;
    protocol?: 'http:' | 'https:';
    storage?: Record<string, string>;
    throwOnSet?: boolean;
}) {
    const storage = options.storage ?? {};
    const cookieWrites: string[] = [];
    vi.stubGlobal('document', {
        get cookie() {
            return options.cookie ?? '';
        },
        set cookie(value: string) {
            cookieWrites.push(value);
        },
    });
    vi.stubGlobal('location', {protocol: options.protocol ?? 'http:'});
    vi.stubGlobal('window', {
        localStorage: {
            getItem: (key: string) => storage[key] ?? null,
            setItem: (key: string, value: string) => {
                if (options.throwOnSet) {
                    throw new Error('storage unavailable');
                }
                storage[key] = value;
            },
        },
    });
    return {
        cookieWrites,
        storage,
    };
}

function compactPayload(
    options: {
        truncated?: boolean;
        path?: string;
    } = {},
) {
    return JSON.stringify({
        v: 1,
        t: options.truncated ?? false,
        f: [[options.path ?? 'browser://documents/example', 'example.pdf', 123, 456, 'browser', 789]],
    });
}

describe('recentFilesPersistence', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('parses the legacy compact cookie snapshot format', () => {
        const snapshot = parseRecentFilesCookieSnapshot(compactPayload({path: '/tmp/example.pdf'}));

        expect(snapshot).toEqual({
            recentFiles: [
                {
                    originalPath: '/tmp/example.pdf',
                    backend: 'browser',
                    fileName: 'example.pdf',
                    timestamp: 123,
                    fileSize: 456,
                    modifiedAt: 789,
                },
            ],
            hasSnapshot: true,
            truncated: false,
        });
    });

    it('keeps legacy compact tuples without a modified-time token compatible', () => {
        const snapshot = parseRecentFilesCookieSnapshot(
            JSON.stringify({
                v: 1,
                t: false,
                f: [['/tmp/legacy.pdf', 'legacy.pdf', 123, 456]],
            }),
        );

        expect(snapshot.recentFiles).toEqual([
            {
                originalPath: '/tmp/legacy.pdf',
                backend: 'electron',
                fileName: 'legacy.pdf',
                timestamp: 123,
                fileSize: 456,
            },
        ]);
    });

    it('prefers a valid legacy cookie over divergent local storage and replaces storage', () => {
        const localFiles = [
            {
                originalPath: 'browser://documents/storage',
                fileName: 'storage.pdf',
                timestamp: 3,
                fileSize: 4,
            },
        ];
        const browser = stubBrowserStorage({
            cookie: `${RECENT_FILES_COOKIE_KEY}=${encodeURIComponent(compactPayload())}`,
            storage: {[BROWSER_RECENT_FILES_STORAGE_KEY]: JSON.stringify(localFiles)},
        });

        const snapshot = readBrowserRecentFilesSnapshot();
        expect(snapshot.recentFiles[0]?.originalPath).toBe('browser://documents/example');
        expect(JSON.parse(browser.storage[BROWSER_RECENT_FILES_STORAGE_KEY] ?? 'null')).toEqual(snapshot.recentFiles);
        expect(browser.cookieWrites).toEqual([expectedLegacyRecentFilesCookieExpiry()]);
    });

    it('does not treat valid JSON with the wrong storage shape as canonical', () => {
        stubBrowserStorage({storage: {[BROWSER_RECENT_FILES_STORAGE_KEY]: JSON.stringify({})}});

        expect(readBrowserRecentFilesSnapshot()).toEqual({
            recentFiles: [],
            hasSnapshot: false,
            truncated: false,
        });
    });

    it('migrates a complete legacy cookie snapshot to local storage and expires it', () => {
        const browser = stubBrowserStorage({cookie: `${RECENT_FILES_COOKIE_KEY}=${encodeURIComponent(compactPayload())}`});

        const snapshot = readBrowserRecentFilesSnapshot();

        expect(snapshot.hasSnapshot).toBe(true);
        expect(snapshot.recentFiles[0]?.originalPath).toBe('browser://documents/example');
        expect(JSON.parse(browser.storage[BROWSER_RECENT_FILES_STORAGE_KEY] ?? 'null')).toEqual(snapshot.recentFiles);
        expect(browser.cookieWrites).toEqual([expectedLegacyRecentFilesCookieExpiry()]);
    });

    it('adds Secure to legacy cookie expiry only over HTTPS', () => {
        const browser = stubBrowserStorage({
            cookie: `${RECENT_FILES_COOKIE_KEY}=${encodeURIComponent(compactPayload())}`,
            protocol: 'https:',
        });

        expect(readBrowserRecentFilesSnapshot().hasSnapshot).toBe(true);
        expect(browser.cookieWrites).toEqual([expectedLegacyRecentFilesCookieExpiry(true)]);
    });

    it('migrates the valid subset of a truncated cookie without marking it complete', () => {
        const browser = stubBrowserStorage({cookie: `${RECENT_FILES_COOKIE_KEY}=${encodeURIComponent(compactPayload({truncated: true}))}`});

        const snapshot = readBrowserRecentFilesSnapshot();
        expect(snapshot.hasSnapshot).toBe(true);
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.recentFiles).toHaveLength(1);
        expect(JSON.parse(browser.storage[BROWSER_RECENT_FILES_STORAGE_KEY] ?? 'null')).toMatchObject({
            truncated: true,
            files: snapshot.recentFiles,
        });
        expect(browser.cookieWrites).toEqual([expectedLegacyRecentFilesCookieExpiry()]);
    });

    it('retains the legacy cookie when local storage migration fails', () => {
        const browser = stubBrowserStorage({
            cookie: `${RECENT_FILES_COOKIE_KEY}=${encodeURIComponent(compactPayload())}`,
            throwOnSet: true,
        });

        expect(readBrowserRecentFilesSnapshot().hasSnapshot).toBe(true);
        expect(browser.cookieWrites).toEqual([]);
    });

    it('keeps only the newest entry for each recent file path', () => {
        const snapshot = parseRecentFilesCookieSnapshot(
            JSON.stringify({
                v: 1,
                t: false,
                f: [
                    ['/tmp/example.pdf', 'example-new.pdf', 3, 456],
                    ['/tmp/other.pdf', 'other.pdf', 2, 123],
                    ['/tmp/example.pdf', 'example-old.pdf', 1, 456],
                ],
            }),
        );

        expect(snapshot.recentFiles.map((file) => file.fileName)).toEqual(['example-new.pdf', 'other.pdf']);
    });

    it('drops legacy recent files whose backend cannot be inferred', () => {
        const snapshot = parseRecentFilesCookieSnapshot(
            JSON.stringify({
                files: [
                    {
                        originalPath: 'relative.pdf',
                        fileName: 'relative.pdf',
                        timestamp: 1,
                    },
                    {
                        originalPath: 'browser://documents/known',
                        fileName: 'known.pdf',
                        timestamp: 2,
                    },
                ],
            }),
        );

        expect(snapshot.recentFiles).toEqual([
            {
                originalPath: 'browser://documents/known',
                backend: 'browser',
                fileName: 'known.pdf',
                timestamp: 2,
            },
        ]);
    });
});
