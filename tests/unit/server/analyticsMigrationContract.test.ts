import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { ANALYTICS_GEO_LIMITS } from '@contracts/analytics';

const rootMigration = readFileSync(
    resolve(process.cwd(), 'drizzle/0002_analytics_admission.sql'),
    'utf8',
);
const landingMigration = readFileSync(
    resolve(process.cwd(), 'landing/drizzle/0002_analytics_admission.sql'),
    'utf8',
);
const landingSchemaMigration = readFileSync(
    resolve(process.cwd(), 'landing/drizzle/0001_sparkling_gauntlet.sql'),
    'utf8',
);
const rootAnalyticsSchema = readFileSync(
    resolve(process.cwd(), 'server/db/viewerAnalyticsEvent.ts'),
    'utf8',
);
const landingAnalyticsSchema = readFileSync(
    resolve(process.cwd(), 'landing/server/db/schema.ts'),
    'utf8',
);
const rootRetentionMigration = readFileSync(
    resolve(process.cwd(), 'drizzle/0003_analytics_event_retention.sql'),
    'utf8',
);
const landingRetentionMigration = readFileSync(
    resolve(process.cwd(), 'landing/drizzle/0003_analytics_event_retention.sql'),
    'utf8',
);
const landingRegionMigration = readFileSync(
    resolve(process.cwd(), 'landing/drizzle/0004_widen_analytics_region.sql'),
    'utf8',
);
const landingRegionSnapshot = JSON.parse(readFileSync(
    resolve(process.cwd(), 'landing/drizzle/meta/0004_snapshot.json'),
    'utf8',
)) as {tables: Record<string, {columns: Record<string, {type: string}>}>};
const rootRetentionEndpoint = readFileSync(
    resolve(process.cwd(), 'server/api/maintenance/analyticsRetention.get.ts'),
    'utf8',
);
const landingRetentionEndpoint = readFileSync(
    resolve(process.cwd(), 'landing/server/api/maintenance/analyticsRetention.get.ts'),
    'utf8',
);

function expectOrdered(source: string, fragments: string[]) {
    let previousIndex = -1;
    for (const fragment of fragments) {
        const nextIndex = source.indexOf(fragment);
        expect(nextIndex, fragment).toBeGreaterThan(previousIndex);
        previousIndex = nextIndex;
    }
}

describe('analytics SQL admission migrations', () => {
    it.each([
        [
            'root',
            rootMigration,
        ],
        [
            'landing',
            landingMigration,
        ],
    ])('%s uses rollback rejection without privileged or caught execution', (_name, migration) => {
        expect(migration).toContain('ERRCODE = \'EVB01\'');
        expect(migration).toContain('SET search_path = pg_catalog, public');
        expect(migration).not.toMatch(/SECURITY\s+DEFINER/iu);
        expect(migration).not.toMatch(/EXCEPTION\s+WHEN/iu);
    });

    it('locks root admission in dedupe, visitor, global, event order', () => {
        expectOrdered(rootMigration, [
            'INSERT INTO public.viewer_analytics_dedupe',
            'INSERT INTO public.viewer_analytics_visitor_quota',
            'INSERT INTO public.viewer_analytics_global_quota',
            'INSERT INTO public.viewer_analytics_event',
        ]);
        expect(rootMigration).toContain('WHERE v_requested <= p_visitor_limit');
        expect(rootMigration).toContain('WHERE v_requested <= p_global_limit');
        expect(rootMigration).toContain('client_occurred_at');
        expect(rootMigration).toMatch(/client_occurred_at,[\s\S]+occurred_at,[\s\S]+v_now,[\s\S]+v_now/iu);
    });

    it('locks landing admission in dedupe, visitor, global, event order', () => {
        expectOrdered(landingMigration, [
            'INSERT INTO public.landing_analytics_dedupe',
            'INSERT INTO public.landing_analytics_visitor_quota',
            'INSERT INTO public.landing_analytics_global_quota',
            'IF p_surface = \'page_view\' THEN',
        ]);
        expect(landingMigration).toContain('WHERE 1 <= p_visitor_limit');
        expect(landingMigration).toContain('WHERE 1 <= p_global_limit');
        expect(landingMigration).toContain('v_now');
    });

    it('preserves historical UTC timestamps during landing timestamptz conversion', () => {
        expect(landingSchemaMigration).toContain(
            'ALTER TABLE "landing_download" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE \'UTC\'',
        );
        expect(landingSchemaMigration).toContain(
            'ALTER TABLE "landing_page_view" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE \'UTC\'',
        );
    });

    it('keeps landing region storage aligned with the shared analytics contract', () => {
        expect(landingAnalyticsSchema).toContain(
            'import { ANALYTICS_GEO_LIMITS } from \'@contracts/analytics\'',
        );
        expect(
            landingAnalyticsSchema.match(/length: ANALYTICS_GEO_LIMITS\.region/gu),
        ).toHaveLength(2);
        expect(landingRegionMigration).toContain(
            `ALTER TABLE "landing_download" ALTER COLUMN "region" SET DATA TYPE varchar(${ANALYTICS_GEO_LIMITS.region})`,
        );
        expect(landingRegionMigration).toContain(
            `ALTER TABLE "landing_page_view" ALTER COLUMN "region" SET DATA TYPE varchar(${ANALYTICS_GEO_LIMITS.region})`,
        );
        expect(landingRegionSnapshot.tables['public.landing_download']?.columns.region?.type)
            .toBe(`varchar(${ANALYTICS_GEO_LIMITS.region})`);
        expect(landingRegionSnapshot.tables['public.landing_page_view']?.columns.region?.type)
            .toBe(`varchar(${ANALYTICS_GEO_LIMITS.region})`);
    });

    it.each([
        [
            'root',
            rootRetentionMigration,
        ],
        [
            'landing',
            landingRetentionMigration,
        ],
    ])('%s defines scheduled retention without deployment-time deletion', (_name, migration) => {
        expect(migration).toContain('interval \'90 days\'');
        expect(migration).not.toContain('prune_viewer_analytics_events_on_insert');
        expect(migration).not.toContain('prune_landing_analytics_events_on_insert');
        expect(migration).not.toMatch(/^SELECT public\.purge_(?:viewer|landing)_analytics_retention\(\);$/mu);
        expect(migration).toContain('SET search_path = pg_catalog, public');
        expect(migration).not.toMatch(/SECURITY\s+DEFINER/iu);
        expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    });

    it('bounds each retention delete so one cron run cannot create an unbounded transaction', () => {
        expect(rootRetentionMigration.match(/LIMIT 5000/gu)).toHaveLength(4);
        expect(landingRetentionMigration.match(/LIMIT 5000/gu)).toHaveLength(5);
    });

    it('caps daily admissions below one scheduled drain capacity', () => {
        expect(rootRetentionMigration).toContain('event_count + 1 <= 40000');
        expect(rootRetentionMigration).toContain('enforce_viewer_analytics_daily_cap_on_insert');
        expect(landingRetentionMigration).toContain('event_count + 1 <= 20000');
        expect(landingRetentionMigration).toContain('enforce_landing_page_view_daily_cap_on_insert');
        expect(landingRetentionMigration).toContain('enforce_landing_download_daily_cap_on_insert');
        for (const migration of [
            rootRetentionMigration,
            landingRetentionMigration,
        ]) {
            expect(migration).toContain('date_trunc(\'day\', clock_timestamp()) - interval \'1 microsecond\'');
            expect(migration).toContain('ERRCODE = \'EVB01\'');
        }
    });

    it('seeds migration-day caps from events admitted before trigger installation', () => {
        expect(rootRetentionMigration).toContain(
            'least(count(public.viewer_analytics_event.id), 40000)::integer',
        );
        expect(rootRetentionMigration).toContain(
            'public.viewer_analytics_event.occurred_at >= migration_clock.day_start',
        );
        expect(landingRetentionMigration).toContain(
            'least(count(public.landing_page_view.id), 20000)::integer',
        );
        expect(landingRetentionMigration).toContain(
            'least(count(public.landing_download.id), 20000)::integer',
        );
        for (const migration of [
            rootRetentionMigration,
            landingRetentionMigration,
        ]) {
            expect(migration).toContain('SET event_count = greatest(');
            expect(migration).toContain('EXCLUDED.event_count');
        }
    });

    it('purges event and admission identity tables independently of future writes', () => {
        for (const migration of [
            rootRetentionMigration,
            landingRetentionMigration,
        ]) {
            expect(migration).toContain('analytics_dedupe');
            expect(migration).toContain('analytics_visitor_quota');
            expect(migration).toContain('analytics_global_quota');
            expect(migration).toContain('interval \'1 day\'');
        }
        expect(rootRetentionMigration).toContain('WHERE occurred_at <');
        expect(rootAnalyticsSchema).toContain('index(\'viewer_analytics_event_occurred_at_idx\').on(table.occurredAt)');
        expect(landingAnalyticsSchema).toContain('index(\'landing_pv_created_at_idx\').on(table.createdAt)');
        expect(landingAnalyticsSchema).toContain('index(\'landing_dl_created_at_idx\').on(table.createdAt)');
    });

    it('registers authenticated daily retention jobs for both deployments', () => {
        const cronConfigs = [
            {
                filePath: 'vercel.json',
                schedule: '17 3 * * *',
            },
            {
                filePath: 'landing/vercel.json',
                schedule: '43 3 * * *',
            },
        ];
        for (const cronConfig of cronConfigs) {
            const config = JSON.parse(readFileSync(
                resolve(process.cwd(), cronConfig.filePath),
                'utf8',
            )) as {crons?: Array<{
                path?: string;
                schedule?: string
            }>};
            expect(config.crons).toEqual([{
                path: '/api/maintenance/analyticsRetention',
                schedule: cronConfig.schedule,
            }]);
        }
    });

    it('bounds both scheduled purge calls and returns observable JSON-safe counts', () => {
        for (const endpoint of [
            rootRetentionEndpoint,
            landingRetentionEndpoint,
        ]) {
            expectOrdered(endpoint, [
                'set local lock_timeout = \'2s\'',
                'set local statement_timeout = \'4s\'',
                'deleted_rows::text as "deletedRows"',
            ]);
            expect(endpoint).toContain('db.batch([');
            expect(endpoint).toContain('while (hasMore && batches < ANALYTICS_RETENTION_MAX_BATCHES)');
            expect(endpoint).toContain('retention backlog remains after the bounded drain');
        }
    });

    it.each([
        {
            directory: 'drizzle',
            idx: 3,
            tag: '0003_analytics_event_retention',
        },
        {
            directory: 'landing/drizzle',
            idx: 4,
            tag: '0004_widen_analytics_region',
        },
    ])('keeps $directory migration journal and snapshots aligned', ({
        directory,
        idx,
        tag,
    }) => {
        const journal = JSON.parse(readFileSync(
            resolve(process.cwd(), directory, 'meta/_journal.json'),
            'utf8',
        )) as {entries: Array<{
            idx: number;
            tag: string
        }>};
        expect(journal.entries.at(-1)).toEqual(expect.objectContaining({
            idx,
            tag,
        }));
        expect(() => readFileSync(
            resolve(
                process.cwd(),
                directory,
                `meta/${String(idx).padStart(4, '0')}_snapshot.json`,
            ),
            'utf8',
        )).not.toThrow();
    });
});
