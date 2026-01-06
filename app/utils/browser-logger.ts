/**
 * Browser-safe logging utility
 * Logs to console and can be easily grepped in browser devtools
 */

export const BrowserLogger = {
    debug: (section: string, message: string, data?: any) => {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        if (data !== undefined) {
            console.log(`${prefix} ${message}`, data);
        } else {
            console.log(`${prefix} ${message}`);
        }
    },

    info: (section: string, message: string, data?: any) => {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        if (data !== undefined) {
            console.info(`${prefix} ${message}`, data);
        } else {
            console.info(`${prefix} ${message}`);
        }
    },

    warn: (section: string, message: string, data?: any) => {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        if (data !== undefined) {
            console.warn(`${prefix} ${message}`, data);
        } else {
            console.warn(`${prefix} ${message}`);
        }
    },

    error: (section: string, message: string, error?: any) => {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        if (error !== undefined) {
            console.error(`${prefix} ${message}`, error);
        } else {
            console.error(`${prefix} ${message}`);
        }
    },
};

export default BrowserLogger;
