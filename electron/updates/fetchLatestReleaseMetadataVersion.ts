import {session} from 'electron';
import {decodeLatestReleaseTag} from '@electron/updates/decodeLatestReleaseTag';
import {normalizeVersion} from '@electron/updates/versionCompare';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';

const METADATA_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RELEASE_METADATA_BYTES = 16 * 1024;
const RELEASE_COHORT_COOKIE_NAME = 'evb_release_cohort';
const RELEASE_COHORT_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const RELEASE_COHORT_COOKIE_VALUE_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const RELEASE_COHORT_COOKIE_RETRY_DELAY_MS = 30_000;

let releaseCohortCookie: string | null | undefined;
let releaseCohortCookieLoadPromise: Promise<string | null> | null = null;
let releaseCohortCookieRetryAt = 0;

interface IReleaseMetadataLogger {warn: (message: string) => void;}

interface IResponseHeaders {
    get(name: string): string | null;
    getSetCookie?: () => string[];
}

async function readBoundedResponseBody(response: Response) {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
        const normalizedLength = declaredLength.trim();
        const parsedLength = Number(normalizedLength);
        if (!/^\d+$/u.test(normalizedLength) || !Number.isSafeInteger(parsedLength)) {
            throw new Error('Metadata endpoint returned an invalid Content-Length');
        }
        if (parsedLength > MAX_RELEASE_METADATA_BYTES) {
            throw new Error('Metadata endpoint exceeded the maximum allowed response size');
        }
    }

    if (!response.body) {
        throw new Error('Metadata endpoint returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let body = '';
    let receivedBytes = 0;
    for (;;) {
        const {
            done,
            value,
        } = await reader.read();
        if (done) {
            break;
        }
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_RELEASE_METADATA_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error('Metadata endpoint exceeded the maximum allowed response size');
        }
        body += decoder.decode(value, {stream: true});
    }
    body += decoder.decode();
    return body;
}

function isValidReleaseCohortCookieValue(value: string | undefined): value is string {
    return value !== undefined && RELEASE_COHORT_COOKIE_VALUE_PATTERN.test(value);
}

async function loadReleaseCohortCookie(metadataUrl: string, logger: IReleaseMetadataLogger) {
    if (releaseCohortCookie !== undefined) {
        return releaseCohortCookie ?? null;
    }
    if (Date.now() < releaseCohortCookieRetryAt) {
        return null;
    }
    if (releaseCohortCookieLoadPromise) {
        return releaseCohortCookieLoadPromise;
    }

    releaseCohortCookieLoadPromise = (async () => {
        try {
            const cookies = await session.defaultSession.cookies.get({
                name: RELEASE_COHORT_COOKIE_NAME,
                url: metadataUrl,
            });
            releaseCohortCookie = cookies.find(cookie => isValidReleaseCohortCookieValue(cookie.value))?.value ?? null;
            releaseCohortCookieRetryAt = 0;
        } catch (error) {
            releaseCohortCookie = undefined;
            releaseCohortCookieRetryAt = Date.now() + RELEASE_COHORT_COOKIE_RETRY_DELAY_MS;
            logger.warn(`Unable to load release rollout cookie: ${getErrorMessage(error)}`);
        } finally {
            releaseCohortCookieLoadPromise = null;
        }
        return releaseCohortCookie ?? null;
    })();

    return releaseCohortCookieLoadPromise;
}

function getSetCookieHeaders(response: Response) {
    const headers: IResponseHeaders = response.headers;
    if (headers.getSetCookie) {
        return headers.getSetCookie();
    }
    return [headers.get('set-cookie') ?? ''];
}

function getReleaseCohortCookieValue(response: Response) {
    for (const header of getSetCookieHeaders(response)) {
        const match = new RegExp(`(?:^|[,;\\s])${RELEASE_COHORT_COOKIE_NAME}=([^;,\\s]+)`, 'u').exec(header);
        if (isValidReleaseCohortCookieValue(match?.[1])) {
            return match[1];
        }
    }
    return null;
}

async function persistReleaseCohortCookie(value: string, sourceUrl: string, logger: IReleaseMetadataLogger) {
    releaseCohortCookie = value;
    try {
        await session.defaultSession.cookies.set({
            expirationDate: Math.floor(Date.now() / 1000) + RELEASE_COHORT_COOKIE_MAX_AGE_SECONDS,
            httpOnly: true,
            name: RELEASE_COHORT_COOKIE_NAME,
            path: '/',
            sameSite: 'lax',
            secure: new URL(sourceUrl).protocol === 'https:',
            url: sourceUrl,
            value,
        });
    } catch (error) {
        logger.warn(`Unable to persist release rollout cookie: ${getErrorMessage(error)}`);
    }
}

async function fetchRolloutMetadata(
    url: string,
    init: RequestInit,
    logger: IReleaseMetadataLogger,
) {
    const headers = new Headers(init.headers);
    const cookieValue = await loadReleaseCohortCookie(url, logger);
    if (cookieValue) {
        headers.set('cookie', `${RELEASE_COHORT_COOKIE_NAME}=${cookieValue}`);
    }

    const response = await fetch(url, {
        ...init,
        headers,
    });
    const nextCookieValue = getReleaseCohortCookieValue(response);
    if (nextCookieValue) {
        await persistReleaseCohortCookie(nextCookieValue, url, logger);
    }
    return response;
}

export async function fetchLatestReleaseMetadataVersion(
    metadataUrl: string,
    logger: IReleaseMetadataLogger,
) {
    try {
        const response = await fetchRolloutMetadata(metadataUrl, {
            headers: {accept: 'application/json'},
            signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS),
        }, logger);
        if (!response.ok) {
            throw new Error(`Metadata endpoint responded with ${response.status}`);
        }

        const payload: unknown = JSON.parse(await readBoundedResponseBody(response));
        const latestTag = normalizeVersion(decodeLatestReleaseTag(payload));
        if (!latestTag) {
            throw new Error('Metadata endpoint did not return release.tag');
        }
        return latestTag;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        throw new Error(`Release rollout metadata failed (${metadataUrl}: ${getErrorMessage(error)})`);
    }
}
