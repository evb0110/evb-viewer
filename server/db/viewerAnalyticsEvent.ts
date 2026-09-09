import { sql } from 'drizzle-orm';
import {
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    serial,
    text,
    timestamp,
    varchar,
} from 'drizzle-orm/pg-core';
import type { JsonObject } from 'type-fest';
// Drizzle Kit loads this schema outside Nuxt alias resolution.
import { ANALYTICS_GEO_LIMITS } from '../../packages/contracts/analytics';

export const viewerAnalyticsEvent = pgTable(
    'viewer_analytics_event',
    {
        id: serial('id').primaryKey(),
        eventName: varchar('event_name', { length: 80 }).notNull(),
        path: varchar('path', { length: 255 }),
        locale: varchar('locale', { length: 16 }),
        screenCategory: varchar('screen_category', { length: 16 }),
        sessionId: varchar('session_id', { length: 64 }),
        referrer: text('referrer'),
        country: varchar('country', { length: ANALYTICS_GEO_LIMITS.country }),
        city: varchar('city', { length: ANALYTICS_GEO_LIMITS.city }),
        region: varchar('region', { length: ANALYTICS_GEO_LIMITS.region }),
        visitorHash: varchar('visitor_hash', { length: 64 }),
        deploymentHost: varchar('deployment_host', { length: 255 }),
        userAgent: text('user_agent'),
        payload: jsonb('payload').$type<JsonObject>().notNull().default(sql`'{}'::jsonb`),
        clientOccurredAt: timestamp('client_occurred_at', { withTimezone: true }),
        occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    table => [
        index('viewer_analytics_event_name_occurred_at_idx').on(table.eventName, table.occurredAt),
        index('viewer_analytics_event_occurred_at_idx').on(table.occurredAt),
        index('viewer_analytics_event_path_idx').on(table.path),
        index('viewer_analytics_event_session_id_idx').on(table.sessionId),
        index('viewer_analytics_event_visitor_hash_idx').on(table.visitorHash),
    ],
);

export const viewerAnalyticsDedupe = pgTable(
    'viewer_analytics_dedupe',
    {
        dedupeKey: varchar('dedupe_key', {length: 64}).primaryKey(),
        expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
    },
    table => [index('viewer_analytics_dedupe_expires_at_idx').on(table.expiresAt)],
);

export const viewerAnalyticsVisitorQuota = pgTable(
    'viewer_analytics_visitor_quota',
    {
        visitorHash: varchar('visitor_hash', {length: 64}).notNull(),
        bucketStart: timestamp('bucket_start', {withTimezone: true}).notNull(),
        eventCount: integer('event_count').notNull(),
    },
    table => [
        primaryKey({
            name: 'viewer_analytics_visitor_quota_pk',
            columns: [
                table.visitorHash,
                table.bucketStart,
            ],
        }),
        index('viewer_analytics_visitor_quota_bucket_start_idx').on(table.bucketStart),
    ],
);

export const viewerAnalyticsGlobalQuota = pgTable(
    'viewer_analytics_global_quota',
    {
        bucketStart: timestamp('bucket_start', {withTimezone: true}).primaryKey(),
        eventCount: integer('event_count').notNull(),
    },
    table => [index('viewer_analytics_global_quota_bucket_start_idx').on(table.bucketStart)],
);
