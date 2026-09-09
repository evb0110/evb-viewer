import {
    index,
    integer,
    pgTable,
    primaryKey,
    serial,
    text,
    timestamp,
    varchar,
} from 'drizzle-orm/pg-core';
import { ANALYTICS_GEO_LIMITS } from '@contracts/analytics';

export const landingPageView = pgTable(
    'landing_page_view',
    {
        id: serial('id').primaryKey(),
        path: varchar('path', { length: 255 }).notNull(),
        referrer: text('referrer'),
        country: varchar('country', { length: 2 }),
        city: varchar('city', { length: 255 }),
        region: varchar('region', { length: ANALYTICS_GEO_LIMITS.region }),
        visitorHash: varchar('visitor_hash', { length: 64 }),
        userAgent: text('user_agent'),
        createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    },
    table => [
        index('landing_pv_path_idx').on(table.path),
        index('landing_pv_created_at_idx').on(table.createdAt),
        index('landing_pv_country_idx').on(table.country),
        index('landing_pv_visitor_hash_idx').on(table.visitorHash),
    ],
);

export const landingDownload = pgTable(
    'landing_download',
    {
        id: serial('id').primaryKey(),
        platform: varchar('platform', { length: 20 }).notNull(),
        arch: varchar('arch', { length: 20 }).notNull(),
        version: varchar('version', { length: 50 }).notNull(),
        fileName: varchar('file_name', { length: 255 }).notNull(),
        country: varchar('country', { length: 2 }),
        city: varchar('city', { length: 255 }),
        region: varchar('region', { length: ANALYTICS_GEO_LIMITS.region }),
        visitorHash: varchar('visitor_hash', { length: 64 }),
        userAgent: text('user_agent'),
        createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    },
    table => [
        index('landing_dl_platform_idx').on(table.platform),
        index('landing_dl_version_idx').on(table.version),
        index('landing_dl_created_at_idx').on(table.createdAt),
        index('landing_dl_country_idx').on(table.country),
    ],
);

export const landingAnalyticsDedupe = pgTable(
    'landing_analytics_dedupe',
    {
        surface: varchar('surface', {length: 32}).notNull(),
        dedupeKey: varchar('dedupe_key', {length: 64}).notNull(),
        expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
    },
    table => [
        primaryKey({
            name: 'landing_analytics_dedupe_pk',
            columns: [
                table.surface,
                table.dedupeKey,
            ],
        }),
        index('landing_analytics_dedupe_expires_at_idx').on(table.expiresAt),
    ],
);

export const landingAnalyticsVisitorQuota = pgTable(
    'landing_analytics_visitor_quota',
    {
        surface: varchar('surface', {length: 32}).notNull(),
        visitorHash: varchar('visitor_hash', {length: 64}).notNull(),
        bucketStart: timestamp('bucket_start', {withTimezone: true}).notNull(),
        eventCount: integer('event_count').notNull(),
    },
    table => [
        primaryKey({
            name: 'landing_analytics_visitor_quota_pk',
            columns: [
                table.surface,
                table.visitorHash,
                table.bucketStart,
            ],
        }),
        index('landing_analytics_visitor_quota_bucket_start_idx').on(table.bucketStart),
    ],
);

export const landingAnalyticsGlobalQuota = pgTable(
    'landing_analytics_global_quota',
    {
        surface: varchar('surface', {length: 32}).notNull(),
        bucketStart: timestamp('bucket_start', {withTimezone: true}).notNull(),
        eventCount: integer('event_count').notNull(),
    },
    table => [
        primaryKey({
            name: 'landing_analytics_global_quota_pk',
            columns: [
                table.surface,
                table.bucketStart,
            ],
        }),
        index('landing_analytics_global_quota_bucket_start_idx').on(table.bucketStart),
    ],
);
