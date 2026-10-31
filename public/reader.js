// OCR only. The DOM supplies geometry and navigation signals, never story text.
(() => {
  const VERSION="0.1.0";
  try {
    if (window.__twice?.alive && window.__twice?.version === VERSION) return window.__twice.restart();
    window.__twice?.destroy?.();
  } catch {}

  const listeners = new AbortController();
  const se = document.scrollingElement;
  let alive = true, view = 0, scroller = se, mode = "scroll", lastScroll = 0, lastMoving = 0;
  let settleTimer, turnTimer, shotTimer, reconnectTimer, observer, port, lastShotAt = 0, lastShotTop = -Infinity;
  const lastY = new WeakMap();
  const listen = (type, handler, opts = {}) => addEventListener(type, handler, {...opts, signal:listeners.signal});
  function destroy() {
    alive = false;
    clearTimeout(settleTimer); clearTimeout(turnTimer); clearTimeout(shotTimer); clearTimeout(reconnectTimer);
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
  function requestShot(paged) {
    if (!alive) return;
    clearTimeout(shotTimer);
    const wait = 650-(Date.now()-lastShotAt);
    if (wait > 0) return void (shotTimer = setTimeout(()=>requestShot(paged),wait));
    lastShotAt = Date.now(); lastShotTop = scroller.scrollTop;
    const rect = contentRect();
    send({type:"twice:shot",paged,top:toY(rect.y),rect,vh:innerHeight,range:range(),at:Date.now(),view});
  }
  function settle(reason) {
    if (!alive) return;
    send({type:"twice:settle",reason,mode,range:range(),view});
    requestShot(mode === "paged");
  }
  function maybeTurn(force = false) {
    if (!force && scroller.scrollHeight > scroller.clientHeight+8) return;
    clearTimeout(turnTimer);
    turnTimer = setTimeout(()=>{
      if (Date.now()-lastScroll < 260) return;
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
    clearTimeout(settleTimer); settleTimer = setTimeout(()=>settle("scroll"),260);
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
    if (storyChanged) maybeTurn(true);
  });
  observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["src"]});
  listen("resize",()=>{ clearTimeout(settleTimer); settleTimer = setTimeout(()=>{view++; settle("resize");},400); });
  document.addEventListener("visibilitychange",()=>send({type:"twice:vis",hidden:document.hidden}),{signal:listeners.signal});
  function restart() {
    if (!alive) return;
    clearTimeout(settleTimer); clearTimeout(turnTimer); clearTimeout(shotTimer);
    view++; scroller = se; lastScroll = 0; lastShotAt = 0; lastShotTop = -Infinity;
    mode = se.scrollHeight <= se.clientHeight+8 ? "paged" : "scroll";
    settle("start");
  }
  listen("pagehide",e=>{if (!e.persisted) destroy();});
  window.__twice = {version:VERSION,restart,destroy,get alive(){try{return alive && !!chrome.runtime?.id;}catch{return false;}},get state(){return {mode,view,range:range()};}};
  connectLifetime();
  restart();
})();
