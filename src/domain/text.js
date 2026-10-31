// Text helpers for the reader app: OCR line filtering and paragraph rebuilding, overlap merging, navigation, cache keys.

/** FNV-1a, for cache keys. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function splitTwoPageSpread(ok, lh, width = 0) {
  if (ok.length < 2) return [ok];
  const minX = Math.min(...ok.map((l) => l.bbox.x0 ?? 0));
  const maxX = Math.max(...ok.map((l) => l.bbox.x1 ?? 0));
  const spanW = maxX - minX;
  if (spanW < Math.max(160, lh * 8)) return [ok];
  const center = width > 0 && width * 0.5 > minX + spanW * 0.25 && width * 0.5 < maxX - spanW * 0.25
    ? width * 0.5
    : (minX + maxX) * 0.5;
  const tol = lh * 1.2;
  const leftPure = ok.filter((l) => (l.bbox.x1 ?? 0) <= center + tol);
  const rightPure = ok.filter((l) => (l.bbox.x0 ?? 0) >= center - tol);
  const spanning = ok.filter((l) => (l.bbox.x0 ?? 0) < center - tol && (l.bbox.x1 ?? 0) > center + tol);
  if (!leftPure.length || !rightPure.length || spanning.length > Math.floor(ok.length * 0.1)) return [ok];
  const leftMaxX = Math.max(...leftPure.map((l) => l.bbox.x1 ?? 0));
  const rightMinX = Math.min(...rightPure.map((l) => l.bbox.x0 ?? 0));
  if (rightMinX - leftMaxX < Math.max(12, lh * 0.6)) return [ok];
  const leftMinY = Math.min(...leftPure.map((l) => l.bbox.y0 ?? 0));
  const leftMaxY = Math.max(...leftPure.map((l) => l.bbox.y1 ?? 0));
  const rightMinY = Math.min(...rightPure.map((l) => l.bbox.y0 ?? 0));
  const rightMaxY = Math.max(...rightPure.map((l) => l.bbox.y1 ?? 0));
  const yOverlap = Math.min(leftMaxY, rightMaxY) > Math.max(leftMinY, rightMinY) - lh * 2;
  if (!yOverlap && (leftPure.length < 2 || rightPure.length < 2)) return [ok];
  const gutterMid = (leftMaxX + rightMinX) * 0.5;
  const leftCol = [];
  const rightCol = [];
  for (const l of ok) {
    const cx = ((l.bbox.x0 ?? 0) + (l.bbox.x1 ?? 0)) * 0.5;
    if (cx < gutterMid) leftCol.push(l);
    else rightCol.push(l);
  }
  return leftCol.length && rightCol.length ? [leftCol, rightCol] : [ok];
}

function columnToParagraphs(colLines, height, lh, yOffset = 0) {
  const sorted = [...colLines].sort((a, b) => a.bbox.y0 - b.bbox.y0 || (a.bbox.x0 ?? 0) - (b.bbox.x0 ?? 0));
  if (!sorted.length) return [];
  const gaps = sorted.slice(1).map((l, i) => l.bbox.y0 - sorted[i].bbox.y1);
  const tight = gaps.length ? Math.min(...gaps.filter((g) => g > 0), Infinity) : lh;
  const right = Math.max(...sorted.map((l) => l.bbox.x1 ?? 0));
  const left = Math.min(...sorted.map((l) => l.bbox.x0 ?? 0));
  const groups = [];
  sorted.forEach((l, i) => {
    const prev = sorted[i - 1];
    const split =
      !prev ||
      l.bbox.y0 - prev.bbox.y1 > Math.max(tight * 1.5, lh * 0.5) ||
      (prev.bbox.x1 ?? right) < right - lh * 2 ||
      (l.bbox.x0 ?? left) > left + lh * 0.6;
    if (split) groups.push({ lines: [], y0: l.bbox.y0, y1: l.bbox.y1 });
    const gr = groups.at(-1);
    gr.lines.push(l.text.trim());
    gr.y1 = l.bbox.y1;
  });
  const margin = Math.max(6, lh * 0.6);
  return groups
    .filter((gr, i) => groups.length === 1 || (!(i === 0 && gr.y0 < margin) && !(i === groups.length - 1 && gr.y1 > height - margin)))
    .map((gr) => ({ text: gr.lines.join(" ").replace(/\s+/g, " ").trim(), y0: gr.y0 + yOffset }))
    .filter((p) => p.text.length >= 4);
}

/**
 * Tesseract often lumps a whole screen of evenly spaced prose into one "paragraph" that touches both edges, so
 * paragraphs are rebuilt from lines. On a two-page spread (left page + right page side-by-side), lines are partitioned
 * across the central gutter so the left page is read top-to-bottom first, followed by the right page top-to-bottom.
 * Pure: lines are [{text, bbox: {x0, y0, x1, y1}, confidence}].
 */
export function linesToParagraphs(lines, height, width = 0) {
  const ok = lines.filter((l) => (l.confidence ?? 100) >= 30 && (l.text ?? "").trim().length >= 2);
  if (!ok.length) return [];
  const mid = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const lh = Math.max(8, mid(ok.map((l) => (l.bbox.y1 ?? 0) - (l.bbox.y0 ?? 0))));
  const columns = splitTwoPageSpread(ok, lh, width);
  return columns.flatMap((col, idx) => columnToParagraphs(col, height, lh, idx * Math.max(height || 0, 1000)));
}

/** First-stage OCR filter. Narrative without UI markers is left to the model's non_story decision. */
export function filterOcrLines(lines) {
  const kept = [];
  let cutoff = null, removed = 0;
  for (const line of [...lines].sort((a,b) => a.bbox.y0-b.bbox.y0)) {
    const t = (line.text ?? "").trim();
    if (/^(?:베스트\s*댓글|전체\s*댓글|댓글|BEST\s*(?:댓글|COMMENTS?)|COMMENTS?)(?:\s*[\d,]+|\s*\([\d,]+\))?\s*$/i.test(t)) { cutoff=line.bbox.y0; break; }
    const metadata = /^(?:\d{4}[.\/-]\s*\d{1,2}[.\/-]\s*\d{1,2}.*|\d+\s*(?:초|분|시간|일|주|개월|년)\s*전|(?:좋아요|답글|추천|신고)\s*\d*|[♡♥👍]\s*\d+)\s*$/.test(t);
    const ui = /^(?:이전|다음|목록|메뉴|설정|공유|로그인|등록|최신순|인기순|\d+\s*\/\s*\d+|[-–—]?\s*\d{1,4}\s*(?:p|쪽|페이지)?\s*[-–—]?|[←→]\s*(?:이전|다음)|(?:이전|다음)\s*[←→])$/i.test(t);
    if (metadata || ui || t.replace(/\s/g, "").length < 3) { removed++; continue; }
    kept.push(line);
  }
  return { lines: kept, cutoff, removed };
}

/** Combine overlapping OCR fragments without repeating their shared text. Null means unrelated paragraphs. */
export function mergeOcrText(a, b) {
  const x=a.replace(/\s/g,""), y=b.replace(/\s/g,"");
  if (!x) return b;
  if (!y) return a;
  if (x.includes(y)) return a;
  if (y.includes(x)) return b;
  const join=(left,right,l,r)=>{
    for (let n=Math.min(l.length,r.length);n>=8;n--) {
      if (!l.endsWith(r.slice(0,n))) continue;
      let count=0, at=0;
      while (at<right.length && count<n) { if (!/\s/.test(right[at])) count++; at++; }
      return `${left.trimEnd()} ${right.slice(at).trimStart()}`.trim();
    }
    return null;
  };
  return join(a,b,x,y) ?? join(b,a,y,x) ?? (x.slice(0,12)===y.slice(0,12) && x.length>=12 ? (x.length>=y.length ? a : b) : null);
}

/** Last path component changes are episode turns; a different work/origin ends the reader session. */
export function navigationKind(before, after) {
  try {
    const a=new URL(before), b=new URL(after);
    if (a.origin!==b.origin) return "leave";
    if (a.pathname===b.pathname) return "same";
    const x=a.pathname.split("/").filter(Boolean), y=b.pathname.split("/").filter(Boolean);
    return x.length>=2 && x.length===y.length && x.slice(0,-1).every((v,i)=>v===y[i]) ? "episode" : "leave";
  } catch { return "leave"; }
}
