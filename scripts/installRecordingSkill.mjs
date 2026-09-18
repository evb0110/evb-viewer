import { homedir } from 'node:os';
import {
    dirname,
    join,
    relative,
    resolve,
} from 'node:path';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.EVB_SKILL_INSTALL_HOME ?? homedir();
const name = 'evb-viewer-recording';
const canonical = join(home, '.agents', 'skills', name);
const marker = '<!-- Managed by EVB Viewer installRecordingSkill.mjs -->';
const content = `---
name: ${name}
description: Record and visually review EVB Viewer agent UI interactions without taking over the host desktop. Use for app automation, video proofs, contact sheets, full-resolution video frames, and interrupted recording recovery on macOS, Linux or Windows.
---

# EVB Viewer recorded automation

${marker}

Use the shell-based shared runner regardless of model provider. Prefer the current
task's EVB Viewer checkout when it contains the recording commands. Otherwise read
\`references/repository.txt\` in this skill for the deployed checkout path. Read
\`docs/internal/agents/recorded-automation.md\` in that checkout before operating
the app. Follow its hidden-launch and session ownership rules.

Start agent-owned UI sessions with \`pnpm electron:run -s <unique-task-name> record\`.
On the VPS use its existing \`DISPLAY=:1\`. Use the session's click/type/run-file
commands, with readiness assertions. Record markers for scenario steps.
Stop only your session, then run \`pnpm electron:run -s <name> recording\`.
Before presenting video as proof, run \`pnpm electron:run -s <name> recording review\`.
Open the generated contact sheets with your image-reading tool, then inspect
full-resolution frames for each expected outcome. Use \`recording review <path>
--track <id> --at 12.3,18.7\` for more timestamps, or \`--from 10 --to 13 --step 0.1\`
for dense intervals. Sources remain intact; each extraction has its own directory.
Compare what the pixels show with the requested behavior and action log. Save
\`assessment.md\` beside \`review.json\` with pass/fail/inconclusive per expected
outcome, track/timestamps/frame paths inspected, observations, and coverage gaps.
Successful extraction or command execution alone is not a visual pass. If your
model cannot inspect images, report visual review as inconclusive. Review motion
with dense frames or video playback, and verify saved files separately when needed.
Return the assessment and video paths. Verify the actual delivered viewer renders
and its videos play and seek; T3 file links may display HTML source instead. Use
\`recording serve <review-directory>\` and open its URL in the thread browser
preview, or return direct MP4 links. The server is local to its host; use the
thread preview for remote clients and stop only your server when no longer needed.
Native dialogs require the Windows guest/native
workflow described in the document. A renderer recording covers rendered app
content; an app API call does not establish that its UI control works.
`;
const path = join(canonical, 'SKILL.md');
if (existsSync(path) && !readFileSync(path, 'utf8').includes(marker)) {
    throw new Error(`Refusing to replace an unmanaged skill: ${path}`);
}
mkdirSync(canonical, { recursive: true });
writeFileSync(path, content);
mkdirSync(join(canonical, 'references'), { recursive: true });
writeFileSync(join(canonical, 'references', 'repository.txt'), repo + '\n');
const loaders = [
    '.codex/skills',
    '.claude/skills',
    '.pi/agent/skills',
    '.config/opencode/skills',
    '.gemini/skills',
];
const paths = [canonical];
for (const loader of loaders) {
    const destination = join(home, loader, name);
    mkdirSync(dirname(destination), { recursive: true });
    let present = false;
    try { lstatSync(destination); present = true; } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') { throw error; }
    }
    if (present) {
        if (realpathSync(destination) !== realpathSync(canonical)) {
            throw new Error(`Refusing to replace an unrelated skill path: ${destination}`);
        }
    } else {
        symlinkSync(relative(dirname(destination), canonical), destination, 'dir');
    }
    paths.push(destination);
}
// Older Gemini releases predate skills but read global GEMINI.md instructions.
const geminiInstructions = join(home, '.gemini', 'GEMINI.md');
const geminiText = existsSync(geminiInstructions) ? readFileSync(geminiInstructions, 'utf8') : '';
if (!geminiText.includes(marker)) {
    writeFileSync(geminiInstructions, geminiText + `\n${marker}\nFor EVB Viewer UI automation, read ~/.agents/skills/${name}/SKILL.md and use its recorded runner.\n`);
}
console.log(JSON.stringify({
    repo,
    paths,
    sha256: createHash('sha256').update(content).digest('hex'),
}, null, 2));
