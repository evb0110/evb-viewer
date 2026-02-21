import {
    index,
    pgTable,
    serial,
    text,
    timestamp,
    varchar,
} from 'drizzle-orm/pg-core';

export const landingPageView = pgTable(
    'landing_page_view',
    {
        id: serial('id').primaryKey(),
        path: varchar('path', { length: 255 }).notNull(),
        referrer: text('referrer'),
        country: varchar('country', { length: 2 }),
        city: varchar('city', { length: 255 }),
        region: varchar('region', { length: 10 }),
        visitorHash: varchar('visitor_hash', { length: 64 }),
        userAgent: text('user_agent'),
        createdAt: timestamp('created_at').defaultNow().notNull(),
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
        region: varchar('region', { length: 10 }),
        visitorHash: varchar('visitor_hash', { length: 64 }),
        userAgent: text('user_agent'),
        createdAt: timestamp('created_at').defaultNow().notNull(),
    },
    table => [
        index('landing_dl_platform_idx').on(table.platform),
        index('landing_dl_version_idx').on(table.version),
        index('landing_dl_created_at_idx').on(table.createdAt),
        index('landing_dl_country_idx').on(table.country),
    ],
);
