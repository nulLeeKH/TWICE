// OCR only. The DOM supplies geometry and navigation signals, never story text.
(() => {
  const VERSION="0.1.1-fast-start-reader-position";
  try {
    if (window.__twice?.alive && window.__twice?.version === VERSION) return window.__twice.restart();
    window.__twice?.destroy?.();
  } catch {}

  const listeners = new AbortController();
  const se = document.scrollingElement;
  let alive = true, view = 0, scroller = se, mode = "scroll", lastScroll = 0, lastMoving = 0;
  let settleTimer, turnTimer, shotTimer, reconnectTimer, chapterTimer, observer, port, lastShotAt = 0, lastShotTop = -Infinity;
  let chapter = null, chapterCheckedAt = 0, chapterFingerprint = "", lastPosition = -1;
  const lastY = new WeakMap();
  const listen = (type, handler, opts = {}) => addEventListener(type, handler, {...opts, signal:listeners.signal});
  function destroy() {
    alive = false;
    clearTimeout(settleTimer); clearTimeout(turnTimer); clearTimeout(shotTimer); clearTimeout(reconnectTimer); clearTimeout(chapterTimer);
    observer?.disconnect(); listeners.abort();
    try {port?.disconnect();} catch {}
  }
  function connectLifetime() {
    if (!alive) return;
    try {
      if (!chrome.runtime?.id) return destroy();
      port=chrome.runtime.connect({name:"twice-reader"});
      port.onDisconnect.addListener(()=>{
        if (!alive) return;
        try {
          const error=chrome.runtime.lastError?.message ?? "";
          if (!chrome.runtime.id || /invalidated|extension.*(unload|reload)/i.test(error)) return destroy();
          reconnectTimer=setTimeout(connectLifetime,500); // service-worker sleep is not a reader failure
        } catch { destroy(); }
      });
    } catch { destroy(); }
  }
  function send(message) {
    if (!alive) return;
    try {
      if (!chrome.runtime?.id) return destroy();
      Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {
        try { if (!chrome.runtime?.id) destroy(); } catch { destroy(); }
      });
    } catch { destroy(); } // extension reload can throw synchronously, before a Promise exists
  }
  const toY = y => scroller.scrollTop + y - (scroller === se ? 0 : scroller.getBoundingClientRect().top);
  const range = () => [toY(0), toY(innerHeight)];
  const onScreen = r => r.width >= 200 && r.height >= 100 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  function contentRect() {
    let boxes = [...document.querySelectorAll("img,canvas")].map(e => e.getBoundingClientRect()).filter(onScreen);
    if (!boxes.length) {
      const articles = [...document.querySelectorAll("article")].map(e => e.getBoundingClientRect()).filter(onScreen);
      if (articles.length) boxes = articles;
      else {
        const mains = [...document.querySelectorAll("main,[role=main]")].map(e => e.getBoundingClientRect()).filter(onScreen);
        if (mains.length) boxes = mains;
      }
    }
    const x = Math.max(0,Math.min(...boxes.map(r=>r.left))), y = Math.max(0,Math.min(...boxes.map(r=>r.top)));
    const right = Math.min(innerWidth,Math.max(...boxes.map(r=>r.right))), bottom = Math.min(innerHeight,Math.max(...boxes.map(r=>r.bottom)));
    return boxes.length && right-x >= 200 && bottom-y >= 100 ? {x,y,w:right-x,h:bottom-y} : {x:0,y:0,w:innerWidth,h:innerHeight};
  }
  // Opt-in occurs when the user starts TWICE. Only inspect accessible, rendered DOM;
  // never fetch paywalled endpoints, hidden pages, or scripts. Reject likely virtualized chapters.
  const excluded = "nav,header,footer,aside,button,input,textarea,[role=navigation]," +
    "[class*=comment],[id*=comment],[class*=reply],[class*=toolbar],[class*=control]," +
    "[aria-hidden=true],a,script,style,noscript";
  function visible(node) {
    if (node.closest(excluded)) return false;
    const css = getComputedStyle(node);
    return css.display !== "none" && css.visibility !== "hidden" && node.getClientRects().length > 0;
  }
  function storyBlocks(root) {
    const nodes = [...root.querySelectorAll("p,pre,div,[class*=paragraph],[class*=line]")].slice(0, 2000);
    const blocks = [];
    for (const el of nodes) {
      if (!visible(el)) continue;
      // The deepest meaningful container wins; avoid duplicating ancestor text.
      if (el.querySelector("p,pre,div,[class*=paragraph],[class*=line]")) continue;
      const text = (el.innerText || "").trim();
      if (text.length < 8 || text.length > 8000) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 120 || box.height < 5) continue;
      const segments = text.split(/\n+/).map(t => t.trim()).filter(t => t.length >= 8);
      for (const [i, segment] of segments.entries()) {
        // Long DOM blocks get approximate vertical positions, with no duplicate text.
        const pieces = segment.match(/[\s\S]{1,450}/g) || [];
        for (const [j, piece] of pieces.entries()) {
          blocks.push({ text: piece, y: toY(box.top + box.height * (i + j / Math.max(1,pieces.length)) / Math.max(1,segments.length)) });
        }
      }
    }
    return blocks.slice(0, 1201);
  }
  function tryChapter() {
    if (!alive || Date.now() - chapterCheckedAt < 1200) return;
    chapterCheckedAt = Date.now();
    if (mode === "paged") return; // Page-flip geometry is not a reliable scroll-position anchor.
    const roots = [...document.querySelectorAll(
      "article,main,[role=main],[class*=novel],[class*=reader],[class*=viewer],[class*=episode],[id*=novel],[id*=reader],[id*=viewer]"
    )].filter(visible).slice(0, 45);
    // Avoid a document.body fallback: navigation, recommendations and comments can mimic a chapter.
    let candidate = null, best = 0;
    for (const root of roots) {
      const blocks = storyBlocks(root);
      const total = blocks.reduce((n,b) => n + b.text.length,0);
      const weight = root.matches("article,[class*=novel],[class*=reader],[class*=viewer],[class*=episode]") ? 1.55 : 1;
      if (total * weight > best) { best = total * weight; candidate = blocks; }
    }
    if (!candidate) return;
    candidate.sort((a,b) => a.y - b.y);
    const bottom = Math.max(...candidate.map(b => b.y));
    const pageHeight = Math.max(scroller.scrollHeight, se.scrollHeight);
    const total = candidate.reduce((n,b) => n + b.text.length,0);
    if (candidate.length < 8 || total < 1000 || total > 90000 || candidate.length > 1200 ||
        (pageHeight > innerHeight * 2.5 && pageHeight - bottom > Math.max(innerHeight * 2.5, pageHeight * 0.35))) return;
    let h = 2166136261;
    for (const b of candidate) for (let i=0;i<b.text.length;i++) h=Math.imul(h ^ b.text.charCodeAt(i), 16777619);
    const fingerprint = `${location.pathname}:${candidate.length}:${h>>>0}`;
    const initialIndex = readingParagraphIndex(candidate);
    chapter = {fingerprint,blocks:candidate};
    if (chapterFingerprint !== fingerprint) {
      chapterFingerprint = fingerprint;
      // Send the position atomically with the chapter. Otherwise the first
      // network chunk may begin at paragraph zero even if the user opened mid-story.
      send({type:"twice:chapter",fingerprint,blocks:candidate,initialIndex});
    }
    reportPosition();
  }
  function readingParagraphIndex(blocks) {
    if (!blocks?.length) return 0;
    // Estimated reading location: middle 50% (screen quarters 2 and 3).
    const upper = toY(innerHeight * 0.25), lower = toY(innerHeight * 0.75);
    const position = (upper + lower) / 2;
    let lo = 0, hi = blocks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (blocks[mid].y <= position) lo = mid + 1; else hi = mid; }
    let index = Math.max(0, Math.min(blocks.length - 1, lo - 1));
    // Prefer paragraph anchors in the middle two quarters; handle gaps and page ends.
    const contenders = [index, index + 1].filter(i => i >= 0 && i < blocks.length &&
      blocks[i].y >= upper && blocks[i].y <= lower);
    if (contenders.length) index = contenders.sort((a,b) =>
      Math.abs(blocks[a].y - position) - Math.abs(blocks[b].y - position))[0];
    return index;
  }
  function reportPosition() {
    if (!chapter) return;
    const index = readingParagraphIndex(chapter.blocks);
    if (index !== lastPosition) {
      lastPosition = index;
      send({type:"twice:position",fingerprint:chapter.fingerprint,index});
    }
  }
  function requestShot(paged) {
    if (!alive) return;
    clearTimeout(shotTimer);
    const wait = 400-(Date.now()-lastShotAt);
    if (wait > 0) return void (shotTimer = setTimeout(()=>requestShot(paged),wait));
    lastShotAt = Date.now(); lastShotTop = scroller.scrollTop;
    const rect = contentRect();
    send({type:"twice:shot",paged,top:toY(rect.y),rect,vh:innerHeight,range:range(),at:Date.now(),view});
  }
  function settle(reason) {
    if (!alive) return;
    send({type:"twice:settle",reason,mode,range:range(),view});
    reportPosition();
    requestShot(mode === "paged");
  }
  function maybeTurn(force = false) {
    if (!force && scroller.scrollHeight > scroller.clientHeight+8) return;
    clearTimeout(turnTimer);
    turnTimer = setTimeout(()=>{
      if (Date.now()-lastScroll < 160) return;
      view++; mode = "paged"; settle("page");
    },180);
  }
  listen("scroll", e => {
    const t = e.target === document ? se : e.target;
    if (!(t instanceof Element)) return;
    const y = t.scrollTop, previous = lastY.get(t) ?? 0;
    lastY.set(t,y);
    if (y === previous) return maybeTurn(true); // horizontal page flip
    view++; scroller = t; mode = "scroll"; lastScroll = Date.now();
    if (Date.now()-lastMoving > 150) { lastMoving = Date.now(); send({type:"twice:moving",range:range(),view}); }
    if (Math.abs(y-lastShotTop) >= innerHeight*0.4) requestShot(false);
    reportPosition();
    clearTimeout(settleTimer); settleTimer = setTimeout(()=>settle("scroll"),160);
  },{capture:true,passive:true});
  listen("keydown", e => {
    if (/^Arrow(Left|Right)$/.test(e.key)) maybeTurn(true);
    else if (/^(Arrow(Down|Up)|PageDown|PageUp| )$/.test(e.key)) maybeTurn(false);
  },{capture:true});
  listen("click", e => maybeTurn(!!e.target.closest?.("[id*=next],[id*=prev],[class*=next],[class*=prev]")),{capture:true,passive:true});
  for (const event of ["wheel","touchend"]) listen(event,()=>maybeTurn(false),{capture:true,passive:true});

  // Clocks, toolbars, ads and progress counters are not page turns. Observe story-shaped changes only.
  const ui = "nav,header,footer,aside,button,input,select,[role=button],[role=navigation],[role=progressbar],.toolbar,.viewer-controls";
  observer = new MutationObserver(records => {
    const storyChanged = records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || target.closest(ui)) return false;
      if (record.type === "attributes") return target.matches("img,canvas");
      if (target.matches("p,article,blockquote")) return true;
      if (record.type === "characterData") return !!target.closest("p,article,blockquote");
      return [...record.addedNodes,...record.removedNodes].some(n => n instanceof Element && (n.matches("p,article,canvas,img") || n.querySelector("p,article,canvas,img")));
    });
    if (storyChanged) { maybeTurn(true); clearTimeout(chapterTimer); chapterTimer = setTimeout(tryChapter, 600); }
  });
  observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["src"]});
  listen("resize",()=>{ clearTimeout(settleTimer); settleTimer = setTimeout(()=>{view++; settle("resize");},400); });
  document.addEventListener("visibilitychange",()=>send({type:"twice:vis",hidden:document.hidden}),{signal:listeners.signal});
  function restart() {
    if (!alive) return;
    clearTimeout(settleTimer); clearTimeout(turnTimer); clearTimeout(shotTimer);
    view++; scroller = se; lastScroll = 0; lastShotAt = 0; lastShotTop = -Infinity;
    mode = se.scrollHeight <= se.clientHeight+8 ? "paged" : "scroll";
    chapter = null; chapterFingerprint = ""; lastPosition = -1; chapterCheckedAt = 0;
    settle("start");
    chapterTimer = setTimeout(tryChapter, 500);
  }
  listen("pagehide",e=>{if (!e.persisted) destroy();});
  window.__twice = {version:VERSION,restart,destroy,get alive(){try{return alive && !!chrome.runtime?.id;}catch{return false;}},get state(){return {mode,view,range:range()};}};
  connectLifetime();
  restart();
})();
