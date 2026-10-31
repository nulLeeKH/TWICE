// pnpm test:e2e — the real WXT build, real Chrome extension APIs and real OCR; the AI model is an explicit test double.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Browser, sleep } from './lib/browser.mjs';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const build = path.join(root, '.output/chrome-mv3');
if (!fs.existsSync(path.join(build, 'manifest.json'))) throw new Error('먼저 pnpm build를 실행해 주세요.');
const extension = fs.mkdtempSync(path.join(os.tmpdir(), 'twice-extension-'));
fs.cpSync(build, extension, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
// Test-only permission grant. The distributable retains optional host access.
manifest.host_permissions = ['<all_urls>']; manifest.permissions = [...new Set([...manifest.permissions, 'tabs'])];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const fixtures = path.join(root, 'tests/fixtures');
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://test').pathname);
  if (/^\/(work|other)\/\d+$/.test(url)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(fixtures, 'scroll.html'), 'utf8').replace('<head>', '<head><base href="/">')); }
  const file = path.resolve(fixtures, '.' + url);
  if (!file.startsWith(fixtures + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript' }); fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await new Browser().start().catch(error => { server.close(); fs.rmSync(extension, { recursive: true, force: true }); throw error; });
const results = [];
function check(name, value, detail = '') { results.push({ name, ok: !!value }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }
const stats = `JSON.parse(document.getElementById('debug-output').textContent || '{}')`;
function fakeAi(mode = 'available') {
  return `(() => {
    const mode=${JSON.stringify(mode)};
    Object.defineProperty(navigator,"language",{configurable:true,value:"ko-KR"});
    window.__aiCalls=[]; window.__sessions=0; window.__destroyed=0; window.__modelDelay=250;
    const result=input=>{
      const rows=[...input.split('\\ncurrent_screen:\\n')[1].matchAll(/^\\[(\\d+)\\] (.*)$/gm)].map(m=>({id:Number(m[1]),text:m[2]}));
      const text=rows.map(row=>row.text).join(' '), now=JSON.parse(input.match(/^now: (.*)$/m)?.[1] ?? '{}');
      const mood=/무섭|공포|두근|어둠|소름/.test(text)?'tension':/눈물|슬프|외로/.test(text)?'sad':/사랑|설레/.test(text)?'romance':now.music?.mood ?? 'calm';
      const comment=/독자 리뷰|베스트 댓글/.test(text), effect=rows.find(row=>/똑똑|두드렸/.test(row.text));
      return {action:comment?'non_story':'continue',music_action:'change',mood,intensity:0.5,
        ambience:/빗|비가/.test(text)?[{engine:'particle',variant:'glass',p1:0.3,p2:0.2,p3:0}]:[],sfx:effect?[{p:effect.id,type:'knock',p1:0.5}]:[],reason:'Keep the reading sound continuous; use only visible events.',context_summary:'A letter changes the atmosphere during the walk.'};
    };
    const session={
      clone:async()=>session,destroy(){window.__destroyed++;},
      async *promptStreaming(input,options={}) {
        window.__aiCalls.push(input); if(window.__fail){window.__fail=false;throw new DOMException('model crashed','UnknownError');} await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,window.__modelDelay);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});});
        const {ambience,sfx,reason,context_summary,...music}=result(input);
        yield JSON.stringify(music).slice(0,-1)+',';
        await new Promise(resolve=>setTimeout(resolve,120));yield '"ambience":'+JSON.stringify(ambience)+',';
        await new Promise(resolve=>setTimeout(resolve,120));yield '"sfx":'+JSON.stringify(sfx)+',"reason":'+JSON.stringify(reason)+',"context_summary":'+JSON.stringify(context_summary)+'}';
      },
      prompt:async input=>JSON.stringify(result(input))
    };
    const create=kind=>async options=>{
      window.__sessions++;
      options.monitor?.({addEventListener(_,callback){callback({loaded:0.4});callback({loaded:1});}});
      if(mode==='download-fail' && kind==='lm')throw new DOMException('offline','NetworkError');
      return session;
    };
    Object.defineProperty(self,'LanguageModel',{configurable:true,value:mode==='unsupported'?undefined:{availability:async()=>mode==='unavailable'?'unavailable':mode.startsWith('download')?'downloadable':'available',create:create('lm')}});
  })()`;
}
let panel, reader;
try {
  const { id } = await browser.call('Extensions.loadUnpacked', { path: extension });
  const panelUrl = `chrome-extension://${id}/sidepanel.html`;
  for (const mode of ['unsupported', 'unavailable', 'download-fail', 'download']) {
    panel = await browser.open(panelUrl, fakeAi(mode), false);
    await browser.wait(panel, `(()=>{const kind=document.getElementById('model-card')?.dataset.kind;return !!kind && kind!=='checking'})()`, mode);
    if (mode === 'unsupported' || mode === 'unavailable') {
      check(`${mode}: start is disabled`, await browser.evaluate(panel, `document.getElementById('start').disabled && !document.getElementById('power')`));
      check(`${mode}: no model creation on load`, await browser.evaluate(panel, `window.__sessions===0`));
      check(`${mode}: recovery guidance is present`, await browser.evaluate(panel, `document.getElementById('device-help').textContent.includes('chrome://on-device-internals')`));
      if (mode === 'unsupported') {
        await browser.screenshot(panel, path.join(root, '.output/previews/ai-unavailable.png'));
        await browser.evaluate(panel, `document.getElementById('gear').click();document.getElementById('ui-language').value='en';document.getElementById('ui-language').dispatchEvent(new Event('change',{bubbles:true}))`);
        await browser.wait(panel, `document.documentElement.lang==='en' && document.getElementById('model-title').textContent==='AI unavailable'`, 'English unavailable copy');
        await browser.wait(panel, `(async()=> (await chrome.storage.local.get('uiLanguage')).uiLanguage==='en')()`, 'locale saved');
        check('locale: unavailable model help and labels are English', await browser.evaluate(panel, `document.getElementById('start').textContent==='Start' && document.getElementById('device-help').textContent.includes('supported desktop Chrome') && document.getElementById('gear').getAttribute('aria-label')==='Open settings'`));
        await browser.screenshot(panel, path.join(root, '.output/previews/ai-unavailable-en.png'));
        await browser.call('Page.reload',{},panel.sessionId);
        await browser.wait(panel, `document.documentElement.lang==='en' && document.getElementById('model-card')?.dataset.kind==='unsupported'`, 'locale survives reopen');
        check('locale: stored choice overrides browser language', await browser.evaluate(panel, `navigator.language==='ko-KR' && document.getElementById('settings-title').textContent==='Settings' && __sessions===0`));
        await browser.evaluate(panel, `document.getElementById('ui-language').value='ko';document.getElementById('ui-language').dispatchEvent(new Event('change',{bubbles:true}))`);
        await browser.wait(panel, `(async()=> (await chrome.storage.local.get('uiLanguage')).uiLanguage==='ko' && document.documentElement.lang==='ko')()`, 'restore Korean');
      }
    } else {
      check(`${mode}: no automatic download`, await browser.evaluate(panel, `window.__sessions===0`));
      await browser.evaluate(panel, `document.getElementById('prepare-model').click()`, true);
      await browser.wait(panel, `['ready','error'].includes(document.getElementById('model-card').dataset.kind)`, 'prepare outcome');
      check(`${mode}: explicit preparation has correct outcome`, await browser.evaluate(panel, `document.getElementById('model-card').dataset.kind===${JSON.stringify(mode==='download'?'ready':'error')}`));
      if (mode === 'download-fail') check('download failure: error message is shown', await browser.evaluate(panel, `document.getElementById('model-detail').textContent.includes('저장 공간')`));
      else check('downloaded model: never stuck at 100%', await browser.evaluate(panel, `document.getElementById('model-progress').hidden && !document.getElementById('model-title').textContent.includes('100%')`));
    }
    await browser.close(panel); panel = null;
  }
  reader = await browser.open(`${base}/work/1`);
  panel = await browser.open(panelUrl, fakeAi(), false);
  await browser.wait(panel, `document.getElementById('model-card')?.dataset.kind==='available'`, 'installed AI');
  await browser.call('Target.activateTarget', { targetId: reader.targetId });
  await browser.evaluate(panel, `document.getElementById('debug').open=true; document.getElementById('start').click()`, true);
  await browser.wait(panel, `(${stats}).audio?.started`, 'real OCR and first music', 45000);
  await browser.wait(panel, `!(${stats}).state?.analysisBusy`, 'initial decision completed', 15000);
  check('product: real OCR read Korean', await browser.evaluate(panel, `/[가-힣]{2,}/.test((${stats}).input)`));
  check('product: music starts before ambience and completion', await browser.evaluate(panel, `(()=>{const t=(${stats}).timing;return t.music<t.ambience&&t.ambience<t.nano})()`));
  check('product: installed model created once', await browser.evaluate(panel, `window.__sessions===1`));
  check('product: current paragraph IDs are distinct', await browser.evaluate(panel, `__aiCalls.every(input=>{const ids=[...input.matchAll(/^\\[(\\d+)\\] /gm)].map(m=>m[1]);return ids.length>0 && new Set(ids).size===ids.length;})`));
  const active = await browser.evaluate(panel, `(${stats}).state.tabId`);
  const windowId = await browser.evaluate(panel, `(${stats}).state.windowId`);
  check('product: actual scene is rendered', await browser.evaluate(panel, `!document.getElementById('instrument').textContent.includes('대기') && document.getElementById('mood').textContent.length>0`));
  const beforeLocale = await browser.evaluate(panel, `({calls:__aiCalls.length,context:(${stats}).context,scene:JSON.stringify((${stats}).state.playing)})`);
  await browser.evaluate(panel, `document.getElementById('gear').click();document.getElementById('ui-language').value='en';document.getElementById('ui-language').dispatchEvent(new Event('change',{bubbles:true}))`);
  await browser.wait(panel, `document.documentElement.lang==='en' && /^[A-Za-z ·]+$/.test(document.getElementById('instrument').textContent)`, 'English active scene');
  check('locale: switching UI preserves audio, story and AI sessions', await browser.evaluate(panel, `__sessions===1 && __aiCalls.length===${beforeLocale.calls} && (${stats}).context===${JSON.stringify(beforeLocale.context)} && JSON.stringify((${stats}).state.playing)===${JSON.stringify(beforeLocale.scene)} && (${stats}).audio.context==='running' && (${stats}).audio.started`));
  check('locale: controls, help and diagnostic headings switch together', await browser.evaluate(panel, `document.getElementById('start').textContent==='Pause' && document.getElementById('decision-summary').textContent.includes('Current screen') && document.getElementById('music-status').textContent.includes('Playing') && !/[가-힣]/.test(document.getElementById('model-detail').textContent)`));
  await browser.evaluate(panel, `document.getElementById('gear').click();document.getElementById('debug').open=false;window.scrollTo(0,0)`);
  await browser.screenshot(panel, path.join(root, '.output/previews/reading-en.png'));
  await browser.evaluate(panel, `document.getElementById('debug').open=true;document.getElementById('ui-language').value='ko';document.getElementById('ui-language').dispatchEvent(new Event('change',{bubbles:true}))`);
  await browser.wait(panel, `/[가-힣]/.test(document.getElementById('instrument').textContent)`, 'restore active Korean UI');
  // A slow model must finish while the independent OCR queue merges newer observations.
  await browser.evaluate(panel, `window.__modelDelay=4000`);
  await browser.evaluate(reader, `scrollBy(0,100)`);
  await browser.wait(panel, `(${stats}).stage?.phase.includes('AI') && (${stats}).state.analysisBusy`, 'slow current request');
  const count = await browser.evaluate(panel, `__aiCalls.length`);
  await browser.evaluate(reader, `scrollBy(0,80)`); await sleep(1200);
  await browser.evaluate(reader, `scrollBy(0,450)`); await sleep(1200);
  check('queue: OCR continues during inference', await browser.evaluate(panel, `(${stats}).queue.paragraphs>0 && (${stats}).state.analysisBusy && __aiCalls.length===${count}`));
  await browser.evaluate(panel, `window.__modelDelay=250`);
  await browser.wait(panel, `__aiCalls.length>${count}`, 'merged next request', 12000);
  check('queue: no duplicates after overlapping screenshots', await browser.evaluate(panel, `__aiCalls.every(input=>{const ids=[...input.matchAll(/^\\[(\\d+)\\] /gm)].map(m=>m[1]);return ids.length>0 && new Set(ids).size===ids.length;})`));
  await browser.wait(panel, `!(${stats}).state.analysisBusy && !(${stats}).state.ocrBusy`, 'queues idle', 15000);
  await browser.screenshot(panel, path.join(root, '.output/previews/reading-narrow.png'));
  await browser.screenshot(panel, path.join(root, '.output/previews/reading-wide.png'), 900, 850);
  // Real browser tab events, not synthetic UI flags.
  const away = await browser.evaluate(panel, `(async()=>{const tab=await chrome.tabs.create({windowId:${windowId},url:'about:blank',active:true});return tab.id})()`);
  await browser.wait(panel, `(${stats}).audio?.context==='suspended'`, 'tab away pauses');
  check('tabs: away shows reconnect', await browser.evaluate(panel, `document.getElementById('start').textContent.includes('다시 연결')`));
  await browser.evaluate(panel, `chrome.tabs.update(${active},{active:true})`);
  await browser.wait(panel, `(${stats}).audio?.context==='running'`, 'tab return resumes'); check('tabs: return resumes audio', true);
  await browser.evaluate(panel, `document.querySelector('[data-mute=music]').click()`);
  await sleep(300);
  check('mute: music mutes to zero, keeps the slider and dims the row', await browser.evaluate(panel, `(${stats}).state.muted.music && (${stats}).state.mix.music>0 && document.querySelector('[data-mute=music]').getAttribute('aria-pressed')==='true' && document.querySelector('[data-bus=music]').closest('.slider').classList.contains('muted')`));
  await browser.evaluate(panel, `document.querySelector('[data-mute=music]').click()`);
  await sleep(300);
  check('mute: unmute restores', await browser.evaluate(panel, `!(${stats}).state.muted.music && document.querySelector('[data-mute=music]').getAttribute('aria-pressed')==='false'`));
  check('controls: start button reads pause while playing', await browser.evaluate(panel, `document.getElementById('start').textContent==='멈춤'`));
  await browser.evaluate(panel, `document.getElementById('start').click()`);
  await browser.wait(panel, `(${stats}).audio?.context==='suspended' && document.getElementById('start').textContent==='재개'`, 'manual pause');
  await browser.evaluate(panel, `chrome.tabs.update(${away},{active:true})`); await sleep(150);
  await browser.evaluate(panel, `chrome.tabs.update(${active},{active:true})`); await sleep(250);
  check('tabs: manual pause persists', await browser.evaluate(panel, `(${stats}).state.userPaused && (${stats}).audio.context==='suspended'`));
  await browser.evaluate(panel, `document.getElementById('start').click()`);
  await browser.wait(panel, `(${stats}).audio?.context==='running' && (${stats}).state.tabId!==null`, 'manual resume');
  await browser.evaluate(panel, `chrome.tabs.update(${active},{url:${JSON.stringify(base+'/work/2')}})`);
  await browser.wait(panel, `(${stats}).state.url.endsWith('/work/2') && (${stats}).audio?.started`, 'next episode', 15000);
  check('URI: next episode preserves music and context', await browser.evaluate(panel, `(${stats}).context.length>0 && (${stats}).audio.context==='running'`));
  await browser.wait(panel, `!(${stats}).state.analysisBusy && !(${stats}).state.ocrBusy && (${stats}).state.ocrCount>0`, 'next episode ready', 20000);
  await browser.call('Page.reload', {}, reader.sessionId);
  await browser.wait(reader, `document.readyState==='complete'`, 'reader reloaded');
  await browser.wait(panel, `(${stats}).events.some(event=>event.includes('판단 완료')) && (${stats}).audio?.context==='running'`, 'same URL reload');
  check('reload: same URL preserves the active audio graph', await browser.evaluate(panel, `(${stats}).state.tabId===${active} && (${stats}).audio.started`));
  await sleep(1500);
  const reads = await browser.evaluate(panel, `(${stats}).state.ocrCount`);
  const skips = await browser.evaluate(panel, `(${stats}).state.ocrSkipped`);
  await browser.evaluate(panel, `chrome.scripting.executeScript({target:{tabId:${active}},func:()=>window.__twice.restart()})`);
  await browser.wait(panel, `(${stats}).state.ocrSkipped>${skips}`, 'same-screen OCR reuse');
  check('OCR: identical screen reuses recognition', await browser.evaluate(panel, `(${stats}).state.ocrCount===${reads}`));
  await browser.evaluate(reader, `document.getElementById('comments').scrollIntoView()`);
  await browser.wait(panel, `(${stats}).state.hush==='non_story'`, 'comments fade', 20000);
  check('comments: non-story fades and excludes effects', await browser.evaluate(panel, `(${stats}).application.includes('3초') && (${stats}).effects.includes('제외')`));
  // Leaving comments must not wait for the model: with a 4 s model, the hush lifts on OCR alone.
  await browser.evaluate(panel, `window.__modelDelay=4000`);
  const beforeReturn = await browser.evaluate(panel, `__aiCalls.length`), returnStart = Date.now();
  await browser.evaluate(reader, `scrollTo(0,0)`);
  await browser.wait(panel, `(${stats}).state.hush===null`, 'story return unhush', 6000);
  check('comments: returning to story lifts the hush before the model answers', Date.now() - returnStart < 4000 || await browser.evaluate(panel, `__aiCalls.length<=${beforeReturn}+1 && (${stats}).state.analysisBusy`));
  await browser.evaluate(panel, `window.__modelDelay=250`);
  await browser.wait(panel, `!(${stats}).state.analysisBusy && !(${stats}).state.ocrBusy`, 'queues idle after return', 15000);
  // A failed request warns with a retry; retrying clears the warning once a decision lands.
  await browser.evaluate(panel, `window.__fail=true`);
  await browser.evaluate(reader, `scrollBy(0,140)`);
  await browser.wait(panel, `!document.getElementById('alert').hidden`, 'failure warning', 15000);
  check('alerts: a failed analysis shows a warning with retry', await browser.evaluate(panel, `document.getElementById('alert-text').textContent.includes('model crashed') && !document.getElementById('alert-retry').hidden && document.getElementById('alert-settings').hidden`));
  await browser.evaluate(panel, `document.getElementById('alert-retry').click()`, true);
  await browser.wait(panel, `document.getElementById('alert').hidden && !(${stats}).state.analysisBusy`, 'retry clears warning', 15000);
  check('alerts: retry analyzes again and clears the warning', await browser.evaluate(panel, `(${stats}).state.alert===null`));
  await browser.evaluate(panel, `chrome.tabs.update(${active},{url:${JSON.stringify(base+'/other/1')}})`);
  await browser.wait(panel, `(${stats}).state.userPaused && (${stats}).audio?.context==='suspended'`, 'work exit pause');
  check('URI: work exit pauses and clears story context', await browser.evaluate(panel, `(${stats}).context==='' && (${stats}).state.userPaused`));
  await browser.evaluate(panel, `chrome.tabs.remove(${away})`);
  for (const fixture of ['paged.html','canvas.html','canvas.html?layout=kakao','english.html']) {
    await browser.call('Page.navigate', {url:base+'/'+fixture}, reader.sessionId);
    await browser.call('Target.activateTarget', { targetId: reader.targetId });
    await browser.wait(reader, `document.readyState==='complete' && !!document.querySelector('article,canvas')`, fixture+' loaded');
    const calls = await browser.evaluate(panel, `__aiCalls.length`);
    await browser.evaluate(panel, `document.getElementById('start').click()`, true);
    await browser.wait(panel, `__aiCalls.length>${calls} && (${stats}).audio?.started && !(${stats}).state.analysisBusy`, fixture+' OCR', 45000);
    check(fixture+': real OCR produces a scene', await browser.evaluate(panel, `${fixture==='english.html' ? '/letter|window|garden|quiet/i' : '/[가-힣]{2,}/'}.test((${stats}).input) && (${stats}).state.playing!==null`));
    if (fixture==='english.html') {
      console.log('English OCR:', await browser.evaluate(panel, `(${stats}).input.slice(0,220)`));
    }
    if (fixture==='paged.html') {
      const previous = await browser.evaluate(panel, `(${stats}).input`);
      await browser.evaluate(reader, `document.getElementById('next').click()`);
      await browser.wait(panel, `(${stats}).input!==${JSON.stringify(previous)} && !(${stats}).state.analysisBusy`, 'page turn scene', 20000);
      check('page turn: detects the new page', await browser.evaluate(panel, `(${stats}).state.position.startsWith('페이지')`));
    }
    await browser.evaluate(panel, `document.getElementById('stop').click()`);
    await browser.wait(panel, `(${stats}).state.tabId===null`, 'fixture cleanup');
  }
  const before = browser.errors.filter(item => /Extension context invalidated/.test(item.message)).length;
  await browser.evaluate(panel, `setTimeout(()=>chrome.runtime.reload(),10);true`); await sleep(1000);
  await browser.evaluate(reader, `scrollBy(0,30);dispatchEvent(new Event('resize'))`); await sleep(700);
  check('reload: no invalidated-context exceptions', browser.errors.filter(item => /Extension context invalidated/.test(item.message)).length===before);
  check('product: no uncaught runtime errors', browser.errors.length===0, browser.errors.map(item=>item.message).join('; ').slice(0,500));
} catch (error) {
  console.error('ERROR', error); console.error('RUNTIME', browser.errors);
  if (panel) {
    console.error(await browser.evaluate(panel, `({model:document.getElementById('model-card')?.dataset.kind,status:document.getElementById('status')?.textContent,debug:document.getElementById('debug-output')?.textContent})`).catch(String));
    await browser.screenshot(panel, path.join(root, '.output/previews/failure.png')).catch(()=>{});
  }
  results.push({ name: 'run', ok: false });
} finally { await browser.dispose(); server.close(); fs.rmSync(extension,{recursive:true,force:true}); }
const failed=results.filter(item=>!item.ok);
console.log(`\n${results.length-failed.length}/${results.length} passed`);
process.exitCode=failed.length ? 1 : 0;
