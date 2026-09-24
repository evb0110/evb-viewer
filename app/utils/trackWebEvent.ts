import { track } from '@vercel/analytics';

/** Sends a custom event only when the browser build injected Vercel Web Analytics. */
export function trackWebEvent(name: string, properties: Record<string, string | null>) {
    if (typeof window !== 'undefined' && window.va) {
        track(name, properties);
    }
}
