import {
    BrowserWindow,
    app,
} from 'electron';
import {
    appendFileSync,
    mkdirSync,
} from 'fs';
import {
    dirname,
    join,
} from 'path';

export interface ILogMessage {
    source: string;
    message: string;
    timestamp: string;
}

export interface ILogger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

const LOG_DIR = join(app.getPath('temp'), 'electron-logs');

// Ensure log directory exists
try {
    mkdirSync(LOG_DIR, { recursive: true });
} catch {
    // Ignore if already exists
}

/**
 * Broadcast a log message to all renderer windows
 * Sends via 'debug:log' IPC channel which preload.ts listens for
 */
function broadcastToRenderers(data: ILogMessage) {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
        if (!win.isDestroyed() && win.webContents) {
            win.webContents.send('debug:log', data);
        }
    }
}

/**
 * Create a logger instance for a specific source module
 *
 * All logs are:
 * 1. Written to a file in the temp directory
 * 2. Forwarded to all renderer windows via IPC for console display
 *
 * @param source - Module identifier (e.g., 'ocr-ipc', 'search', 'tesseract')
 */
export function createLogger(source: string): ILogger {
    const logFile = join(LOG_DIR, `${source}.log`);

    // Ensure parent directory exists
    try {
        mkdirSync(dirname(logFile), { recursive: true });
    } catch {
        // Ignore
    }

    function log(level: string, msg: string) {
        const ts = new Date().toISOString();
        const formattedMsg = `[${ts}] [${source}] [${level}] ${msg}`;

        // Write to file
        try {
            appendFileSync(logFile, `${formattedMsg}\n`);
        } catch {
            // Silently fail if file write fails - don't break the app
        }

        // Forward to all renderer consoles
        broadcastToRenderers({
            source,
            message: `[${level}] ${msg}`,
            timestamp: ts,
        });
    }

    return {
        debug: (msg: string) => log('DEBUG', msg),
        info: (msg: string) => log('INFO', msg),
        warn: (msg: string) => log('WARN', msg),
        error: (msg: string) => log('ERROR', msg),
    };
}

/**
 * Get the path to log files directory
 * Useful for debugging or exposing to users
 */
export function getLogDirectory() {
    return LOG_DIR;
}
