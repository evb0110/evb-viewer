import { getHeader } from 'h3'
import { getDb } from '~~/server/db'
import { landingDownload } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
    const body = await readBody<{
        platform?: string
        arch?: string
        version?: string
        fileName?: string
    }>(event)

    if (!body?.platform || !body?.arch || !body?.version || !body?.fileName) {
        throw createError({ statusCode: 400, statusMessage: 'Missing required fields' })
    }

    const geo = extractGeo(event)
    const visitorHash = await hashVisitorIdentity(event)
    const userAgent = getHeader(event, 'user-agent') ?? null

    const db = getDb()
    await db.insert(landingDownload).values({
        platform: body.platform.slice(0, 20),
        arch: body.arch.slice(0, 20),
        version: body.version.slice(0, 50),
        fileName: body.fileName.slice(0, 255),
        country: geo.country,
        city: geo.city,
        region: geo.region,
        visitorHash,
        userAgent,
    })

    return { ok: true }
})
