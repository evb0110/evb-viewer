import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export const projectRoot = join(__dirname, '..', '..');
