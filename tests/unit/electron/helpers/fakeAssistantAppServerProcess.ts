import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {vi} from 'vitest';

interface IFakeAssistantAppServerStdin extends EventEmitter {
    write: ReturnType<typeof vi.fn>;
}

export class FakeAssistantAppServerProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin = new EventEmitter() as IFakeAssistantAppServerStdin;
    constructor(write: (line: string, callback?: (error?: Error | null) => void) => boolean) {
        super();
        this.stdin.write = vi.fn(write);
    }

    emitJson(value: unknown, splitAt?: number) {
        const line = `${JSON.stringify(value)}\n`;
        if (splitAt === undefined) {
            this.stdout.write(line);
            return;
        }
        this.stdout.write(line.slice(0, splitAt));
        this.stdout.write(line.slice(splitAt));
    }
}
