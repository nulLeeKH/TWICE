// Dependency-free smoke test. Run from project root:
// node scripts/verify-fast-acoustic.mjs
import assert from 'node:assert/strict';
import { SFX_TYPES } from '@twice/sound';
import { MOODS, SFX, SFX_GAP_S, MUSIC_HOLD_S, FAMILY_HOLD_S, normalizeSegment, shouldChangeMusic } from '../src/domain/score.js';
import { arrangement, percussionPattern, compose } from '@twice/sound';
const acoustic = new Set(['strings', 'cello', 'harp', 'piano', 'marimba', 'timpani', 'bass_drum', 'frame_drum']);
assert.equal(MUSIC_HOLD_S, 6);
assert.equal(FAMILY_HOLD_S, 10);
assert.equal(SFX_GAP_S, 8);
let compositions = 0;
for (const [mood, preset] of Object.entries(MOODS)) {
  assert.ok(acoustic.has(preset.lead), `${mood} has disallowed lead`);
  for (const voice of preset.support) assert.ok(acoustic.has(voice), `${mood} has disallowed support`);
  const plan = arrangement(mood);
  for (const voice of [plan.bed, plan.lead, ...plan.parts.map(p => p.instrument), ...plan.percussion].filter(Boolean))
    assert.ok(acoustic.has(voice), `${mood} has disallowed arrangement voice ${voice}`);
  for (let i = 0; i < 100; i++) {
    const piece = compose(mood);
    compositions++;
    const secondsPerBar = 240 / piece.bpm;
    for (let j = 0; j < piece.bars.length; j++) for (let k = j - 1; k >= 0 && (j-k)*secondsPerBar < 8; k--)
      assert.notEqual(JSON.stringify(piece.bars[j].melody), JSON.stringify(piece.bars[k].melody), `${mood}: identical melody bar within 8s`);
  }
}
assert.deepEqual([...SFX].sort(), [...SFX_TYPES].sort(), 'schema matches supported sound effects');
const calm = normalizeSegment({mood: 'calm'});
const to = mood => normalizeSegment({mood, music_action: 'change'});
assert.equal(shouldChangeMusic(calm, to('sad'), 5), false);
assert.equal(shouldChangeMusic(calm, to('sad'), 6), true);
assert.equal(shouldChangeMusic(calm, to('romance'), 9), false);
assert.equal(shouldChangeMusic(calm, to('romance'), 10), true);
assert.equal(shouldChangeMusic(calm, to('battle'), 0), true);
console.log(`PASS: ${Object.keys(MOODS).length} moods, ${SFX.length} SFX types, ${compositions} compositions; acoustic music palette, SFX coverage and minimum holds verified.`);

for (const mood of ['calm', 'sad', 'romance', 'mystic', 'comedy'])
  for (let i = 0; i < 16; i++) assert.deepEqual(percussionPattern(mood, 1, i), []);
for (const mood of ['battle', 'epic', 'anger', 'tension', 'horror', 'adventure']) {
  const hits = Array.from({length:16}, (_, i) => percussionPattern(mood, .9, i));
  assert.ok(hits.some(b => b.length > 0), `${mood}: no percussion`);
  assert.ok(hits.some(b => b.length === 0), `${mood}: constant percussion not natural`);
  for (const bar of hits) for (const note of bar)
    assert.ok(['timpani', 'bass_drum', 'frame_drum'].includes(note.instrument));
}
console.log('PASS: restrained acoustic orchestral percussion policies.');
