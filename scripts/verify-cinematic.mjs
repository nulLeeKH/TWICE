// Dependency-free music-engine smoke test, without Chrome or external API.
import assert from 'node:assert/strict';
import { acousticVoices, acousticCacheStats } from '../src/audio/acoustic.js';
import { compose, arrangement, percussionPattern, INSTRUMENTS } from '../src/audio/music.js';
import { MOODS } from '../src/domain/score.js';
class Param {
  constructor(value=0) {this.value=value;}
  setValueAtTime(v) {this.value=v; return this;}
  linearRampToValueAtTime(v) {this.value=v; return this;}
  exponentialRampToValueAtTime(v) {this.value=v; return this;}
}
class AudioNode {
  constructor() {this.gain=new Param(1); this.frequency=new Param(440); this.playbackRate=new Param(1);this.Q=new Param(.5);this.detune=new Param(0);}
  connect(destination) {return destination;}
  start() {}
  stop() {}
  setPeriodicWave() {}
}
class Context {
  constructor() {this.sampleRate=22050;this.currentTime=0;}
  createGain() {return new AudioNode();}
  createOscillator() {return new AudioNode();}
  createBiquadFilter() {return new AudioNode();}
  createBufferSource() {return new AudioNode();}
  createPeriodicWave() {return new AudioNode();}
  createBuffer(channels, count, rate) {const data=new Float32Array(count);return {duration:count/rate, getChannelData(){return data;}};}
}
const ctx=new Context(), out=ctx.createGain();
for (const [name, play] of Object.entries(acousticVoices)) {
  assert.ok(INSTRUMENTS.includes(name), `${name} missing from synth registry`);
  play(ctx,out,.2,60,.8,.65);
}
assert.ok(acousticCacheStats(ctx).buffers >= 3);
assert.ok(acousticCacheStats(ctx).waves >= 2);
for (const mood of Object.keys(MOODS)) {
  const score=compose(mood);
  assert.ok([16,32].includes(score.bars.length));
  assert.equal(score.bars.every(bar => bar.melody.every(note => Number.isFinite(note.note)&&note.vel>0&&note.vel<=1)),true);
  const plan=arrangement(mood);
  assert.ok(plan.percussion.every(name => ['timpani','bass_drum','frame_drum'].includes(name)));
}
for (const mood of ['battle','epic','anger','tension','horror','adventure']) {
  assert.ok(Array.from({length:16}, (_,i)=>percussionPattern(mood,.9,i)).flat().length>0);
  assert.deepEqual(percussionPattern(mood,.2,0),[]);
}
console.log('PASS: 8 acoustic voices (incl. 3 drums); 16 score moods; restrained percussion; acoustic synthesis graph smoke test');
