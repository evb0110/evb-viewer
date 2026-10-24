import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';
import { RECENT_FILES_LIMIT } from '@app/utils/recentFilesPersistence';

/**
 * The prerendered Start page cannot know the browser's recent files, so this
 * head script tells it how many there are before the first paint: Start then
 * shows that many placeholder rows (or the empty list) and the real rows take
 * their place without moving anything. Electron reads its list from main.
 */
export const RECENT_FILES_PREPAINT_SCRIPT = '(()=>{try{if(location.pathname.startsWith(\'/electron\'))return;'
    + `const raw=localStorage.getItem(${JSON.stringify(BROWSER_RECENT_FILES_STORAGE_KEY)});`
    + 'const parsed=raw?JSON.parse(raw):[];'
    + 'const files=Array.isArray(parsed)?parsed:Array.isArray(parsed&&parsed.files)?parsed.files:[];'
    // Count what the list will show: one row per stored path, as the reader
    // does (parseRecentFilesPayload), up to its limit.
    + 'const paths=new Set(files.map(file=>Array.isArray(file)?file[0]:file&&file.originalPath).filter(path=>typeof path===\'string\'));'
    + `document.documentElement.dataset.recentCount=String(Math.min(paths.size,${RECENT_FILES_LIMIT}))}catch{}})();`;
