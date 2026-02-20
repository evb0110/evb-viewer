import { type H3Event, getHeader, getRequestIP } from 'h3'

interface IGeoData {
    country: string | null
    city: string | null
    region: string | null
}

export function extractGeo(event: H3Event): IGeoData {
    return {
        country: getHeader(event, 'x-vercel-ip-country') ?? null,
        city: getHeader(event, 'x-vercel-ip-city') ?? null,
        region: getHeader(event, 'x-vercel-ip-country-region') ?? null,
    }
}

export async function hashVisitorIdentity(event: H3Event) {
    const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
    const ua = getHeader(event, 'user-agent') ?? ''
    const dailySalt = new Date().toISOString().slice(0, 10)

    const raw = `${ip}:${ua}:${dailySalt}`
    const data = new TextEncoder().encode(raw)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}
