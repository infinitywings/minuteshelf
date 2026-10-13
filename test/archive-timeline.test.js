const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { effectiveTimeline } = require('../server/archive-timeline');
const { ArchiveStore, atomicWrite } = require('../server/archive-store');
const { exportPlan } = require('../server/media-export');
const { defaults } = require('../server/archive-config');
const timeline = { schemaVersion:1, clock:'SCK-presentation-time', originPolicy:'earliest-observed-source-PTS', originPTS:{seconds:0} };
const events = [
  {event:'timeline',originPTS:{seconds:261698.232343833},rebased:false},
  {event:'timeline',originPTS:{seconds:0},rebased:true},
  {event:'frame-state',pts:{seconds:0},status:5,usable:false},
  {event:'stopped',clean:true,endPTS:{seconds:261772.089958625}}
];
test('legacy stopped notification repair restores one effective clock without modifying originals', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-repair-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const store = new ArchiveStore(dir), m = store.create({window:{id:1}},defaults.recording,'Timeline fixture'), raw=store.raw(m.id);
  atomicWrite(path.join(raw,'timeline.json'), JSON.stringify(timeline));
  fs.writeFileSync(path.join(raw,'capture_events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'));
  fs.writeFileSync(path.join(raw,'video-000001.mp4'),'synthetic committed bytes');
  atomicWrite(path.join(raw,'video-000001.json'),JSON.stringify({kind:'video',file:'video-000001.mp4',status:'complete',
    startPTS:{seconds:261698.232343833},endPTS:{seconds:261719.281098625}}));
  const before = Object.fromEntries(fs.readdirSync(raw).map(f=>[f,fs.readFileSync(path.join(raw,f))]));
  const repaired=store.refresh(m.id), again=store.refresh(m.id);
  assert(Math.abs(repaired.durationSeconds-73.857614792)<1e-6);
  assert.equal(repaired.timeline.originPTS.seconds,261698.232343833);
  assert.equal(repaired.timeline.correction.originalOriginPTS.seconds,0);
  assert.equal(repaired.timeline.correction.rawUnchanged,true);
  assert.deepEqual(again.timeline,repaired.timeline);
  const plan=exportPlan(store,m.id);
  assert.equal(plan.video[0].startSeconds,0);
  assert.equal(plan.durationSeconds,repaired.durationSeconds);
  for(const [f,b] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(raw,f)),b,f);
});
test('valid zero origins and unrelated corrupt archives are not guessed into new clocks', () => {
  const segments=[{startPTS:{seconds:261698.232343833}}];
  assert.equal(effectiveTimeline(timeline,[{startPTS:{seconds:0}}],events),timeline);
  assert.equal(effectiveTimeline(timeline,segments,[]),timeline);
  assert.equal(effectiveTimeline(timeline,segments,events.filter(e=>e.event!=='frame-state')),timeline);
  assert.equal(effectiveTimeline(timeline,segments,events.map(e=>e.event==='frame-state'?{...e,status:0,usable:true}:e)),timeline);
  assert.equal(effectiveTimeline(timeline,[{startPTS:{seconds:261699}}],events),timeline);
  const modern={...timeline,originPolicy:'earliest-written-source-PTS'};
  assert.equal(effectiveTimeline(modern,segments,events),modern);
});
