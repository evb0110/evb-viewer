import { neon } from '@neondatabase/serverless';
import {
    drizzle,
    type NeonHttpDatabase,
} from 'drizzle-orm/neon-http';

let dbInstance: NeonHttpDatabase | null = null;

export function getDb() {
    if (!dbInstance) {
        const config = useRuntimeConfig();
        const url = config.databaseUrl || process.env.DATABASE_URL;
        const sql = neon(url as string);
        dbInstance = drizzle(sql);
    }
    return dbInstance;
}
