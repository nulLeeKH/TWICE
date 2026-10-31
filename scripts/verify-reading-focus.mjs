// Dependency-free regression check for the viewport reading-position heuristic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../public/reader.js', import.meta.url), 'utf8');
const from = source.indexOf('  function readingParagraphIndex(blocks) {');
const until = source.indexOf('  function reportPosition() {', from);
assert.ok(from >= 0 && until > from, 'readingParagraphIndex function exists');
const innerHeight = 800;
const scrollTop = 1200;
const readingParagraphIndex = runInNewContext(
  `${source.slice(from, until)}\nreadingParagraphIndex;`,
  { innerHeight, toY: y => scrollTop + y },
);
const blocks = Array.from({ length: 80 }, (_, i) => ({ text: `paragraph ${i}`, y: i * 80 }));
const index = readingParagraphIndex(blocks);
assert.ok(blocks[index].y >= scrollTop + 0.25 * innerHeight && blocks[index].y <= scrollTop + 0.75 * innerHeight, 'active block in quarters 2 and 3');
assert.ok(Math.abs(blocks[index].y - (scrollTop + innerHeight * 0.5)) <= 80, 'position near screen center');
const bottom = readingParagraphIndex([{ text: 'single', y: 100 }]);
assert.equal(bottom, 0, 'single paragraph fallback');
console.log('PASS: quarter 2/3 reading focus and boundary fallback');
