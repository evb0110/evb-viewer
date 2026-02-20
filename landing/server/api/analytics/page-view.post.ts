import { getHeader } from 'h3'
import { getDb } from '~~/server/db'
import { landingPageView } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
    const body = await readBody<{ path?: string, referrer?: string }>(event)

    if (!body?.path || typeof body.path !== 'string') {
        throw createError({ statusCode: 400, statusMessage: 'Missing path' })
    }

    const geo = extractGeo(event)
    const visitorHash = await hashVisitorIdentity(event)
    const userAgent = getHeader(event, 'user-agent') ?? null

    const db = getDb()
    await db.insert(landingPageView).values({
        path: body.path.slice(0, 255),
        referrer: body.referrer?.slice(0, 2000) ?? null,
        country: geo.country,
        city: geo.city,
        region: geo.region,
        visitorHash,
        userAgent,
    })

    return { ok: true }
})
