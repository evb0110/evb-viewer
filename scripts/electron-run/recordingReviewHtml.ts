/** Self-contained, offline viewer. Input labels remain text, never executable markup. */
export function recordingReviewHtml(manifest: unknown, events: unknown[]) {
    const data = JSON.stringify({
        manifest,
        events,
    }).replaceAll('<', '\\u003c');
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>EVB Viewer recording</title>
<style>body{font:16px system-ui;background:#16191e;color:#eee;margin:24px}video{width:100%;max-height:75vh;background:#000}button,select{font:inherit;padding:6px;margin:4px}main{max-width:1280px;margin:auto}pre{white-space:pre-wrap}.stage{position:relative}.cursor{position:absolute;border:3px solid #ff7f30;border-radius:50%;width:18px;height:18px;pointer-events:none;display:none;transform:translate(-50%,-50%)}#events{max-height:35vh;overflow:auto}#events button{display:block;text-align:left;background:#262c35;color:inherit;border:0}#caption{min-height:2em}a{color:#9acbff}</style>
<main><h1>EVB Viewer recording</h1><pre id="summary"></pre><select id="windows"></select><div class="stage"><video controls></video><div class="cursor"></div></div><p id="caption"></p><p>Orange rings show recorded input coordinates. <span id="scope"></span> <a href="manifest.json">Manifest</a> · <a href="actions.jsonl">Actions</a></p><div id="events"></div></main>
<script>const data=${data};const m=data.manifest;const select=document.querySelector('select');const video=document.querySelector('video');const cursor=document.querySelector('.cursor');const caption=document.querySelector('#caption');let track;
document.querySelector('#summary').textContent=JSON.stringify({status:m.status,session:m.session,platform:m.platform,scope:m.scope,errors:m.errors},null,2);
document.querySelector('#scope').textContent=m.scope==='windows-guest-desktop'?'This video captures the Windows test guest desktop.':'Native menus/dialogs are outside renderer capture.';
for(const t of m.tracks){const o=document.createElement('option');o.value=t.id;o.textContent=t.id+' — '+t.file;select.append(o)}
function choose(id){track=m.tracks.find(t=>t.id===id);if(!track)return;select.value=id;video.src=track.file;cursor.style.display='none'}select.onchange=()=>choose(select.value);if(m.tracks.length)choose(m.tracks[0].id);
for(const e of data.events){if(e.kind==='input'&&e.type==='pointermove')continue;const b=document.createElement('button');b.textContent=(e.atMs/1000).toFixed(2)+'s '+(e.label||e.command||e.action||e.type||e.kind)+(e.phase?' '+e.phase:'')+(e.error?' '+e.error:'');b.onclick=()=>{if(e.trackId&&track?.id!==e.trackId)choose(e.trackId);if(track)video.currentTime=Math.max(0,(e.atMs-track.atMs)/1000);caption.textContent=JSON.stringify(e)};document.querySelector('#events').append(b)}
video.ontimeupdate=()=>{if(!track)return;const ms=track.atMs+video.currentTime*1000;const e=data.events.findLast(e=>e.trackId===track.id&&e.kind==='input'&&e.atMs<=ms);cursor.style.display='none';if(!e)return;caption.textContent=e.type+(e.code?' '+e.code:'');if(ms-e.atMs<800&&typeof e.x==='number'){const box=video.getBoundingClientRect();const scale=Math.min(box.width/1280,box.height/800);const inner=Math.min(1280/e.width,800/e.height);cursor.style.left=((box.width-1280*scale)/2+((1280-e.width*inner)/2+e.x*inner)*scale)+'px';cursor.style.top=((box.height-800*scale)/2+((800-e.height*inner)/2+e.y*inner)*scale)+'px';cursor.style.display='block'}};
</script></html>`;
}
