const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(id, ownerDocument) {
    Object.assign(this, { id, ownerDocument, value:'', checked:false, disabled:false, hidden:false, open:false, dataset:{}, style:{}, children:[], attrs:{}, paused:true, currentTime:0, scrollHeight:10, scrollTop:0, scrollLeft:0, playCount:0, parentNode:null, ownText:'' });
    const classes = new Set();
    this.classList = {
      add(...values) { for (const value of values) classes.add(value); },
      remove(...values) { for (const value of values) classes.delete(value); },
      contains(value) { return classes.has(value); },
      toggle(value, force) { const enabled = force === undefined ? !classes.has(value) : !!force; if (enabled) classes.add(value); else classes.delete(value); return enabled; }
    };
  }
  [Symbol.for('nodejs.util.inspect.custom')]() { return `Element#${this.id}${this.dataset.focusKey ? `[${this.dataset.focusKey}]` : ''}`; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent || '').join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
  get isConnected() { return this === this.ownerDocument?.body || !!this.parentNode?.isConnected; }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  pause() { const playing = !this.paused; this.paused = true; if (playing) this.onpause?.(); }
  async play() { this.paused = false; this.playCount++; await this.onplay?.(); }
  load() { this.onloadedmetadata?.(); }
  removeAttribute(key) { delete this.attrs[key]; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  replaceChildren(...children) {
    if (this.children.some(child => child.contains?.(this.ownerDocument?.activeElement))) this.ownerDocument.activeElement = this.ownerDocument.body;
    for (const child of this.children) child.parentNode = null;
    this.children = []; this.ownText = ''; this.append(...children);
  }
  append(...children) {
    for (const child of children) { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(node => node !== child); child.parentNode = this; child.ownerDocument = this.ownerDocument; this.children.push(child); }
  }
  focus() { if (!this.disabled && this.isConnected) this.ownerDocument.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (selector === '[data-focus-key]' && child.dataset?.focusKey !== undefined) result.push(child);
      if (selector === 'input:checked' && child.checked) result.push(child);
      result.push(...(child.querySelectorAll?.(selector) || []));
    }
    return result;
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (selector === '[hidden]' && node.hidden) return node; return null; }
  showModal() { this.open = true; this.ownerDocument.getElementById('settings-close').focus(); }
  close() { this.open = false; this.onclose?.(); }
  click() { return this.onclick?.(); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function meeting(id, notes = `Notes ${id}`, title = id) {
  return { notes, projectId:null, manifest:{ id, title, status:'recorded', createdAt:'2026-10-04T12:00:00Z', durationSeconds:5, bytes:0,
    selection:{ window:{ app:'Test', title:'Test' }, systemAudio:false }, preset:{ fps:15 }, capture:{}, timeline:{ originPTS:{ seconds:0 } },
    segments:[], recovered:[], gaps:[], interruptedTail:[], bookmarks:[] } };
}
function harness(handler = () => { throw new Error('Unexpected request'); }, { native = false, trash = () => [], playback = () => ({ status:'ready',path:'exports/prepared/recording.m4a' }) } = {}) {
  const elements = new Map(), timers = new Map(), listeners = new Map(); let timerId = 0, clock = 0;
  const document = {};
  document.body = new Element('body', document); document.activeElement = document.body;
  const get = id => { if (!elements.has(id)) { const element = new Element(id, document); elements.set(id, element); document.body.append(element); } return elements.get(id); };
  Object.assign(document, { getElementById:get, querySelector:get, createElement:tag => new Element(tag, document), createTextNode:text => { const node = new Element('#text', document); node.textContent = text; return node; } });
  const window = { addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); } };
  const nativeMessages = [];
  if (native) window.webkit = { messageHandlers:{ meetingArchiveState:{ postMessage(value) { nativeMessages.push(JSON.parse(JSON.stringify(value))); } } } };
  const context = vm.createContext({
    document, window, console, URLSearchParams, Option:function(label, value) { const option = new Element('option', document); option.textContent = label; option.value = value; return option; },
    getComputedStyle:() => ({ minHeight:'0' }), setInterval() {}, performance:{ now:() => clock },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    location:{ hash:'', pathname:'/' }, history:{ replaceState() {} },
    fetch:async (url, options = {}) => {
      let data;
      if (url === '/api/trash') data = trash();
      else if (url.endsWith('/rka-context')) data = { connection:{ enabled:false, projectId:null, query:'', angleQueries:[], selectedIds:[] }, snapshot:null };
      else if (url.endsWith('/artifacts')) data = { folder:'/test', documents:[], entries:[], exports:[], generatedContentAvailable:false };
      else if (url.endsWith('/playback')) data = await playback(url, options);
      else data = await handler(url, options);
      return { ok:true, json:async () => data };
    }
  });
  const source = fs.readFileSync(path.join(__dirname, '../web/recorder.js'), 'utf8');
  // Run the actual controller and event handlers, excluding its network bootstrap.
  vm.runInContext(source.slice(0, source.lastIndexOf('(async () =>')), context);
  const run = code => vm.runInContext(code, context);
  return { get, run, timers, document, window, nativeMessages, advance(ms) { clock += ms; const audio = get('meeting-audio'); if (!audio.paused && !audio.stalled) audio.currentTime += ms/1000; }, dispatch(name, event) { for (const handler of listeners.get(name) || []) handler(event); }, load(value) { context.fixture = value; run('selected = fixture.manifest.id; renderMeeting(fixture, true); setMeetingLoading(false);'); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('playback has one combined audio element and no segment or source controls', () => {
  const html = fs.readFileSync(path.join(__dirname,'../web/recorder.html'),'utf8');
  assert.match(html, /id="meeting-audio"/);
  for (const id of ['segments','listen-system','listen-mic','standalone-audio','audio-source','audio-clip','merged-video','export-system','export-mic']) assert(!html.includes(`id="${id}"`), id);
  assert.match(html, /<video id="video"[^>]* muted/);
});

test('first playback preparation is deduplicated, visibly pending, and never autoplays on completion', async () => {
  const calls = []; let state = 'missing';
  const ui = harness(undefined,{playback:(url,options) => {
    calls.push(options.method || 'GET');
    if (options.method === 'POST') state = 'preparing';
    return {status:state,progress:.4,path:'exports/cache/recording.m4a'};
  }});
  sessionPlaybackMeeting(ui);
  await Promise.all([ui.run('ensureMeetingPlayback(true)'),ui.run('ensureMeetingPlayback(true)')]);
  assert.deepEqual(calls,['GET','POST']); assert.equal(ui.get('play-session').disabled,true);
  assert.match(ui.get('playback-state').textContent,/Preparing continuous meeting audio/);
  state = 'ready'; await ui.run('ensureMeetingPlayback(false)');
  assert.equal(ui.get('play-session').disabled,false); assert.equal(ui.get('meeting-audio').playCount,0);
});

test('audio owns the clock during buffering and is never repeatedly sought by playback polling', async () => {
  const ui = harness(); sessionPlaybackMeeting(ui); await ui.run('seek(2,true)');
  const audio = ui.get('meeting-audio'); let at = 2, seeks = 0;
  Object.defineProperty(audio,'currentTime',{get:()=>at,set:value=>{seeks++;at=value;},configurable:true});
  audio.stalled = true;
  for (let i=0;i<20;i++) { ui.advance(150); await ui.run('updateSessionPlayback()'); }
  assert.equal(seeks,0); assert.equal(Number(ui.get('timeline').value),2);
  audio.stalled = false; ui.advance(500); const before=seeks; await ui.run('updateSessionPlayback()');
  assert.equal(seeks,before); assert.equal(Number(ui.get('timeline').value),2.5);
});

test('video decoding failure does not stop the continuous audio track', async () => {
  const ui = harness(); sessionPlaybackMeeting(ui); await ui.run('seek(1,true)');
  const audio=ui.get('meeting-audio'), url=audio.src, plays=audio.playCount;
  ui.get('video').onerror(); ui.advance(500); await ui.run('updateSessionPlayback()');
  assert.equal(audio.paused,false); assert.equal(audio.src,url); assert.equal(audio.playCount,plays);
  assert.equal(Number(ui.get('timeline').value),1.5); assert.equal(ui.get('video').hidden,true);
});

test('late audio metadata cannot restart or report a stale error after changing meetings', async () => {
  const ui=harness();sessionPlaybackMeeting(ui);ui.get('meeting-audio').load=()=>{};
  const playing=ui.run('seek(3,true)');await tick();const metadata=ui.get('meeting-audio').onloadedmetadata;
  ui.load(meeting('other'));metadata();await playing;
  assert.equal(ui.get('meeting-audio').playCount,0);assert.equal(ui.run('selected'),'other');
  assert.equal(ui.get('message').textContent,'');
});

test('pending meeting navigation flushes old notes to their owner and disables the editor', async () => {
  const saved = deferred(), loaded = deferred(), writes = [];
  const ui = harness((url, options) => {
    if (url.endsWith('/notes')) { writes.push({ url, notes:JSON.parse(options.body).notes }); return writes.length === 1 ? saved.promise : {}; }
    if (url === '/api/meetings/B') return loaded.promise;
    throw new Error(url);
  });
  ui.load(meeting('A')); ui.get('notes').value = 'Changed A'; ui.get('notes').oninput();
  const opening = ui.run("openMeeting('B')");
  assert.equal(ui.get('notes').disabled, true); assert.equal(ui.get('save-notes').disabled, true);
  assert.deepEqual(writes, [{ url:'/api/meetings/A/notes', notes:'Changed A' }]);
  saved.resolve({}); await tick();
  assert.equal(ui.run('selected'), 'A'); assert.equal(ui.get('notes').value, 'Changed A');
  await ui.run('saveNotes()'); assert.equal(writes.length, 1);
  loaded.resolve(meeting('B')); await opening;
  assert.equal(ui.run('selected'), 'B'); assert.equal(ui.get('notes').value, 'Notes B'); assert.equal(ui.get('notes').disabled, false);
  ui.get('notes').value = 'Changed B'; ui.get('notes').oninput(); await ui.get('save-notes').click();
  assert.deepEqual(writes[1], { url:'/api/meetings/B/notes', notes:'Changed B' });
});

test('failed meeting navigation leaves the previous editor usable with the same owner', async () => {
  const loaded = deferred(), writes = [];
  const ui = harness((url, options) => {
    if (url === '/api/meetings/B') return loaded.promise;
    writes.push({ url, notes:JSON.parse(options.body).notes }); return {};
  });
  ui.load(meeting('A')); const opening = ui.run("openMeeting('B')");
  loaded.reject(new Error('Unavailable')); await assert.rejects(opening, /Unavailable/);
  assert.equal(ui.run('selected'), 'A'); assert.equal(ui.get('notes').value, 'Notes A'); assert.equal(ui.get('notes').disabled, false);
  ui.get('notes').value = 'A after failed navigation'; ui.get('notes').oninput();
  await [...ui.timers.values()][0]();
  assert.deepEqual(writes, [{ url:'/api/meetings/A/notes', notes:'A after failed navigation' }]);
});

test('A to B to A navigation discards stale responses even when IDs match', async () => {
  const firstA = deferred(), b = deferred(), latestA = deferred(); let aCalls = 0;
  const ui = harness(url => url === '/api/meetings/A' ? (++aCalls === 1 ? firstA.promise : latestA.promise) : b.promise);
  ui.load(meeting('A', 'Initial'));
  const opening1 = ui.run("openMeeting('A')"), opening2 = ui.run("openMeeting('B')"), opening3 = ui.run("openMeeting('A')");
  latestA.resolve(meeting('A', 'Latest', 'Latest A')); await opening3;
  b.resolve(meeting('B')); await opening2; firstA.resolve(meeting('A', 'Stale', 'Stale A')); await opening1;
  assert.equal(ui.get('notes').value, 'Latest'); assert.equal(ui.get('heading').textContent, 'Latest A');
  assert.equal(ui.get('notes').disabled, false);
});

test('a stale periodic refresh cannot overwrite a newly loaded meeting with the same ID', async () => {
  const stale = deferred(); let aCalls = 0;
  const ui = harness(url => {
    if (url === '/api/status') return { active:[], freeBytes:100, nativeBuilt:true, archivePath:'/test' };
    if (url === '/api/meetings' || url === '/api/projects') return [];
    if (url === '/api/meetings/A') return ++aCalls === 1 ? stale.promise : meeting('A', 'Newest', 'Newest A');
    if (url === '/api/meetings/B') return meeting('B');
    throw new Error(url);
  });
  ui.load(meeting('A')); const refreshing = ui.run('refresh()'); await tick();
  await ui.run("openMeeting('B')"); await ui.run("openMeeting('A')");
  stale.resolve(meeting('A', 'Old', 'Old A')); await refreshing;
  assert.equal(ui.get('heading').textContent, 'Newest A'); assert.equal(ui.get('notes').value, 'Newest');
});

test('leaving the meeting view invalidates an outstanding meeting load', async () => {
  const loaded = deferred(), ui = harness(() => loaded.promise);
  ui.load(meeting('A')); const opening = ui.run("openMeeting('B')");
  ui.run("clearPlayback(); showView('home');"); loaded.resolve(meeting('B')); await opening;
  assert.equal(ui.run('selected'), null); assert.equal(ui.run('view'), 'home');
});

test('an unavailable archive is explained without replacing or saving the current notes', async () => {
  let requests = 0;
  const ui = harness(() => { requests++; throw new Error('Must not open unavailable archive'); });
  ui.load(meeting('A')); ui.get('notes').value = 'Unsaved A'; ui.get('notes').oninput();
  ui.run("meetingCatalog = [{ id:'broken', status:'unavailable', archiveError:{ message:'Invalid manifest' } }];");
  await ui.run("openMeeting('broken')");
  assert.equal(requests, 0); assert.equal(ui.run('selected'), 'A'); assert.equal(ui.get('notes').value, 'Unsaved A');
  assert.match(ui.get('message').textContent, /Invalid manifest/); assert.equal(ui.run('notesDirty'), true);
});

function sourceEvidenceMeeting(ui, { video = false, microphone = true, system = true } = {}) {
  const value = meeting('A'); value.manifest.durationSeconds = 30; value.manifest.timeline.originPTS.seconds = 100;
  value.manifest.segments = [
    ...(microphone ? [{ kind:'microphone', file:'microphone-000001.wav', startPTS:{ seconds:100 }, endPTS:{ seconds:130 }, sampleRate:1000 }] : []),
    ...(system ? [{ kind:'system', file:'system-000001.wav', startPTS:{ seconds:100 }, endPTS:{ seconds:130 }, sampleRate:1000 }] : []),
    ...(video ? [{ kind:'video', file:'video-000001.mp4', startPTS:{ seconds:100 }, endPTS:{ seconds:130 } }] : [])
  ];
  ui.load(value);
}

test('microphone evidence validates its source then positions combined playback without autoplay', async () => {
  const calls = [], ui = harness(url => { calls.push(url); return [{ pts:{ seconds:100 }, frames:30000, frameOffset:0 }]; });
  sourceEvidenceMeeting(ui, { video:true });
  await ui.run("jumpToSource({source:'microphone',startMs:7000})");
  assert.deepEqual(calls, ['/api/meetings/A/index/microphone-000001.wav']);
  assert.match(ui.get('meeting-audio').src, /recording.m4a/);
  assert.equal(ui.get('video').currentTime, 5); assert.equal(ui.get('video').paused, true);
  assert.equal(ui.get('meeting-audio').playCount, 0);
});

test('evidence validates original PTS but seeks the gap-preserving combined track', async () => {
  const ui = harness(() => [{ pts:{ seconds:100 }, frames:5000, frameOffset:0 }, { pts:{ seconds:110 }, frames:10000, frameOffset:5000 }]);
  sourceEvidenceMeeting(ui); await ui.run("jumpToSource({source:'microphone',startMs:12000})");
  assert.match(ui.get('meeting-audio').src, /recording.m4a/);

  assert.equal(ui.get('meeting-audio').currentTime, 10); // The prepared track retains the 5-second PTS gap.
  assert.equal(ui.get('meeting-audio').paused, true);
  assert.equal(Number(ui.get('timeline').value), 10);
});

test('evidence lead-in stops at an audio gap and refuses a missing source', async () => {
  const ui = harness(() => [{ pts:{ seconds:100 }, frames:5000, frameOffset:0 }, { pts:{ seconds:110 }, frames:10000, frameOffset:5000 }]);
  sourceEvidenceMeeting(ui); await ui.run("jumpToSource({source:'system',startMs:11000})");
  assert.equal(ui.get('meeting-audio').currentTime, 10); assert.equal(Number(ui.get('timeline').value), 10);
  await assert.rejects(ui.run("jumpToSource({source:'system',startMs:7000})"), /audio gap/);
  sourceEvidenceMeeting(ui, { microphone:false });
  await assert.rejects(ui.run("jumpToSource({source:'microphone',startMs:11000})"), /Other sources were not substituted/);
  assert.equal(ui.get('meeting-audio').playCount, 0);
});

test('audio evidence uses the same combined track across a video gap', async () => {
  const ui = harness(() => [{ pts:{ seconds:100 }, frames:30000, frameOffset:0 }]);
  sourceEvidenceMeeting(ui, { video:true }); ui.run('current.manifest.segments.find(c=>c.kind===\'video\').endPTS.seconds=105;');
  await ui.run("jumpToSource({source:'system',startMs:12000})");
  assert.equal(ui.get('meeting-audio').currentTime, 10); assert.equal(ui.get('meeting-audio').hidden, false);
  assert.equal(ui.get('video').paused, true);
  await ui.run('updateSessionPlayback()');
  assert.equal(Number(ui.get('timeline').value), 10, 'A paused old video must not overwrite the standalone evidence time');
});

test('late audio evidence index cannot overwrite a newer jump or different meeting', async () => {
  const pending = deferred(), ui = harness(url => url.includes('microphone') ? pending.promise : [{ pts:{ seconds:100 }, frames:30000, frameOffset:0 }]);
  sourceEvidenceMeeting(ui); const old = ui.run("jumpToSource({source:'microphone',startMs:7000})");
  await ui.run("jumpToSource({source:'system',startMs:12000})");
  pending.resolve([{ pts:{ seconds:100 }, frames:30000, frameOffset:0 }]); await old;
  assert.match(ui.get('meeting-audio').dataset.clip, /recording.m4a/); assert.equal(ui.get('meeting-audio').currentTime, 10);
  const late = deferred(), other = harness(() => late.promise); sourceEvidenceMeeting(other);
  const jumping = other.run("jumpToSource({source:'microphone',startMs:7000})");
  other.load(meeting('B')); late.resolve([{ pts:{ seconds:100 }, frames:30000, frameOffset:0 }]); await jumping;
  assert.equal(other.get('meeting-audio').src, undefined);
});

test('failed evidence index can be retried and late failures do not disturb another meeting', async () => {
  let attempts = 0;
  const ui = harness(() => { if (++attempts === 1) throw new Error('Index unavailable'); return [{ pts:{ seconds:100 }, frames:30000, frameOffset:0 }]; });
  sourceEvidenceMeeting(ui);
  await assert.rejects(ui.run("jumpToSource({source:'microphone',startMs:7000})"), /Index unavailable/);
  await ui.run("jumpToSource({source:'microphone',startMs:7000})"); assert.equal(attempts, 2); assert.equal(ui.get('meeting-audio').currentTime, 5);
  const late = deferred(), other = harness(() => late.promise); sourceEvidenceMeeting(other);
  const jumping = other.run("jumpToSource({source:'microphone',startMs:7000})"); other.load(meeting('B'));
  late.reject(new Error('Stale A failure')); await jumping;
  assert.equal(other.get('message').textContent.includes('Stale A'), false);
});

test('selecting sources proactively requests screen permission without microphone access', async () => {
  const requests = [], ui = harness((url, options) => {
    if (url === '/api/permissions') return { screenRecording:'not-granted', microphone:'not-determined' };
    if (url === '/api/permissions/request') { requests.push(JSON.parse(options.body)); return { screenRecording:'granted', microphone:'not-determined' }; }
    if (url === '/api/sources') return { windows:[{ id:1, app:'Test', title:'Fixture' }], microphones:[{ id:'mic1', name:'Test microphone' }] };
    throw new Error(url);
  });
  await ui.get('sources').click();
  assert.deepEqual(requests, [{ screen:true, microphone:false }]);
  assert.equal(ui.get('window').children.length, 2); assert.equal(ui.get('permission-screen').textContent, 'Allowed');
  assert.equal(ui.get('mic').checked, false); assert.equal(ui.get('permission-microphone-request').hidden, true);
});

test('enabling microphone requests it and denied access keeps recording disabled until recheck', async () => {
  let microphone = 'not-determined'; const requests = [];
  const ui = harness((url, options) => {
    if (url === '/api/permissions') return { screenRecording:'granted', microphone };
    if (url === '/api/permissions/request') { requests.push(JSON.parse(options.body)); microphone = 'denied'; return { screenRecording:'granted', microphone }; }
    throw new Error(url);
  });
  ui.run("previewID='preview'; $('confirmed').checked=true; $('mic-device').value='mic1';");
  ui.get('mic').checked = true; await ui.get('mic').onchange();
  assert.deepEqual(requests, [{ screen:false, microphone:true }]);
  assert.equal(ui.get('start').disabled, true); assert.equal(ui.get('permission-microphone-settings').hidden, false);
  microphone = 'granted'; await ui.get('permissions-refresh').click();
  assert.equal(requests.length, 1); assert.equal(ui.get('start').disabled, false);
  assert.equal(ui.get('permission-microphone-settings').hidden, true);
});

test('permission dialogs serialize screen and later microphone requests', async () => {
  const grantedScreen = deferred(), requests = []; let state = { screenRecording:'not-granted', microphone:'not-determined' };
  const ui = harness(async (url, options) => {
    if (url === '/api/permissions') return state;
    const scope = JSON.parse(options.body); requests.push(scope);
    if (scope.screen) { await grantedScreen.promise; state = { ...state, screenRecording:'granted' }; }
    if (scope.microphone) state = { ...state, microphone:'granted' };
    return state;
  });
  const screen = ui.run('updatePermissions({screen:true})'); await tick();
  ui.get('mic').checked = true;
  const mic = ui.run('updatePermissions({microphone:true})'); await tick();
  assert.equal(requests.length, 1); assert.equal(ui.get('permissions-refresh').disabled, true);
  grantedScreen.resolve(); await Promise.all([screen, mic]);
  assert.deepEqual(requests, [{ screen:true, microphone:false }, { screen:false, microphone:true }]);
  assert.equal(ui.get('permissions-refresh').disabled, false);
});

test('denied screen access never enumerates windows and offers settings', async () => {
  const ui = harness(url => {
    if (url.startsWith('/api/permissions')) return { screenRecording:'not-granted', microphone:'denied' };
    throw new Error('Must not enumerate without permission');
  });
  await ui.get('sources').click();
  assert.equal(ui.get('start').disabled, true); assert.equal(ui.get('permission-screen-settings').hidden, false);
  assert.match(ui.get('permission-hint').textContent, /System Settings/);
});

test('unchecking microphone cancels its queued permission request', async () => {
  const grantedScreen = deferred(), requests = []; let state = { screenRecording:'not-granted', microphone:'not-determined' };
  const ui = harness(async (url, options) => {
    if (url === '/api/permissions') return state;
    requests.push(JSON.parse(options.body)); await grantedScreen.promise;
    return state = { ...state, screenRecording:'granted' };
  });
  const screen = ui.run('updatePermissions({screen:true})'); await tick();
  ui.get('mic').checked = true; const mic = ui.get('mic').onchange();
  ui.get('mic').checked = false; await ui.get('mic').onchange();
  grantedScreen.resolve(); await Promise.all([screen, mic]);
  assert.deepEqual(requests, [{ screen:true, microphone:false }]);
});

const statusFixture = { active:[], freeBytes:1e9, nativeBuilt:true, archivePath:'/local/Meeting Archive' };
function catalogMeeting(id) { return { id, title:`Meeting ${id}`, status:'recorded', createdAt:'2026-10-04T12:00:00Z', durationSeconds:5, notesPreview:`Note ${id}` }; }
function keyEvent(key, extra = {}) {
  return { key, code:key === ',' ? 'Comma' : `Key${key.toUpperCase()}`, metaKey:true, ctrlKey:false, altKey:false, shiftKey:false, defaultPrevented:false,
    preventDefault() { this.defaultPrevented = true; }, ...extra };
}

test('polling preserves meeting/library/project nodes and restores focused IDs after updates or deletion', async () => {
  let meetings = [catalogMeeting('A'), catalogMeeting('B')], projects = [{ id:'P', name:'Research', meetingCount:2 }];
  const ui = harness(url => url === '/api/status' ? statusFixture : url === '/api/meetings' ? meetings : url === '/api/projects' ? projects : Promise.reject(new Error(url)));
  await ui.run('refresh()');
  const meetingButton = ui.get('meetings').children[0], libraryButton = ui.get('library-list').children[0], projectButton = ui.get('projects').children[0];
  meetingButton.focus(); ui.get('meetings').scrollTop = 45;
  await ui.run('refresh()');
  assert.equal(ui.document.activeElement, meetingButton); assert.equal(ui.get('library-list').children[0], libraryButton); assert.equal(ui.get('projects').children[0], projectButton);
  meetings = [{ ...meetings[0], title:'Updated A' }, meetings[1]]; await ui.run('refresh()');
  assert.equal(ui.document.activeElement.dataset.focusKey, 'A'); assert.match(ui.document.activeElement.textContent, /Updated A/); assert.equal(ui.get('meetings').scrollTop, 45);
  meetings = [meetings[1]]; await ui.run('refresh()'); assert.equal(ui.document.activeElement.dataset.focusKey, 'B');
  meetings = []; await ui.run('refresh()'); assert.equal(ui.document.activeElement, ui.get('all-meetings'));
  ui.get('projects').children[0].focus(); projects = []; await ui.run('refresh()'); assert.equal(ui.document.activeElement, ui.get('project-new'));
});

test('library and project timeline retain logical focus and choose useful empty-list fallbacks', () => {
  const ui = harness(), a = catalogMeeting('A'), b = catalogMeeting('B');
  ui.run(`meetingCatalog = ${JSON.stringify([a, b])}; renderLibrary();`);
  const libraryA = ui.get('library-list').children[0]; libraryA.focus();
  ui.run('renderLibrary()'); assert.equal(ui.document.activeElement, libraryA);
  ui.run(`meetingCatalog = ${JSON.stringify([{ ...a, notesPreview:'Updated notes' }, b])}; renderLibrary();`);
  assert.equal(ui.document.activeElement.dataset.focusKey, 'A');
  ui.run('meetingCatalog = []; renderLibrary();'); assert.equal(ui.document.activeElement, ui.get('meeting-search'));
  const timeline = { meetings:[a, b], durationSeconds:10 };
  ui.run(`projectViewId='P'; renderProjectTimeline(${JSON.stringify(timeline)});`);
  const timelineB = ui.get('project-timeline').children[0].children[0]; timelineB.focus();
  ui.run(`renderProjectTimeline(${JSON.stringify(timeline)});`); assert.equal(ui.document.activeElement, timelineB);
  ui.run(`renderProjectTimeline(${JSON.stringify({ ...timeline, meetings:[a] })});`); assert.equal(ui.document.activeElement.dataset.focusKey, 'A');
  ui.run("renderProjectTimeline({meetings:[],durationSeconds:0});"); assert.equal(ui.document.activeElement, ui.get('heading'));
});

test('polling keeps select options and in-progress project selection intact', () => {
  const ui = harness();
  ui.run("localProjects=[{id:'P',name:'Project P',meetingCount:1}]; renderProjectNavigation();");
  const option = ui.get('meeting-project').children[1]; ui.get('meeting-project').value = 'P'; ui.get('meeting-project').focus();
  ui.run('renderProjectNavigation()');
  assert.equal(ui.get('meeting-project').children[1], option); assert.equal(ui.get('meeting-project').value, 'P'); assert.equal(ui.document.activeElement, ui.get('meeting-project'));
});

test('bookmark and segment polling retain focus and use stable controls when files disappear', () => {
  const ui = harness(), data = meeting('A');
  data.manifest.bookmarks = [{ id:'mark1', pts:{ seconds:1 }, text:'Important' }];
  data.manifest.segments = [{ kind:'video', file:'video.mp4', startPTS:{ seconds:0 }, endPTS:{ seconds:5 } }];
  ui.load(data); const mark = ui.get('bookmarks').children[0]; mark.focus(); ui.load(data); assert.equal(ui.document.activeElement, mark);
  data.manifest.bookmarks[0].text = 'Updated'; ui.load(data); assert.equal(ui.document.activeElement.dataset.focusKey, 'mark1');
  data.manifest.bookmarks = []; ui.load(data); assert.equal(ui.document.activeElement, ui.get('bookmark-text'));
  const timeline = ui.get('timeline'); timeline.focus(); ui.load(data); assert.equal(ui.document.activeElement, timeline);
  assert.equal(ui.get('segments').children.length, 0);
});

test('export progress does not recreate links and removed exports return focus to export control', () => {
  const ui = harness(), job = { id:'export1', status:'ready', createdAt:'2026-10-04T12:00:00Z', files:[{ path:'exports/meeting.mp4' }] };
  ui.load(meeting('A')); ui.run("artifactState={entries:[{path:'exports/meeting.mp4'}],exports:[]};");
  ui.run(`renderExports(${JSON.stringify([job])});`);
  const link = ui.get('export-files').children[0]; link.focus();
  ui.run(`renderExports(${JSON.stringify([job, { id:'export2', status:'processing', progress:0.5 }])});`);
  assert.equal(ui.document.activeElement, link);
  ui.run('renderExports([]);'); assert.equal(ui.document.activeElement, ui.get('export-media'));
});

test('sidebar exposes current page and explicit navigation focuses the new heading', async () => {
  const ui = harness(url => {
    if (url === '/api/status') return statusFixture;
    if (url === '/api/meetings') return [catalogMeeting('A')];
    if (url === '/api/projects') return [{ id:'P', name:'Project P', meetingCount:1 }];
    if (url === '/api/meetings/A') return meeting('A');
    if (url === '/api/projects/P') return { project:{ name:'Project P', description:'', rkaProjectId:null }, meetings:[], durationSeconds:0 };
    throw new Error(url);
  });
  await ui.run('refresh()'); assert.equal(ui.get('all-meetings').getAttribute('aria-current'), 'page');
  await ui.run("openMeeting('A')"); assert.equal(ui.get('meetings').children[0].getAttribute('aria-current'), 'page'); assert.equal(ui.get('all-meetings').getAttribute('aria-current'), null); assert.equal(ui.document.activeElement, ui.get('heading'));
  await ui.run("openProject('P')"); assert.equal(ui.get('projects').children[0].getAttribute('aria-current'), 'page'); assert.equal(ui.get('meetings').children[0].getAttribute('aria-current'), null);
});

test('switching panels from inside a panel moves focus to the destination tab', () => {
  const ui = harness(); ui.get('panel-notes').append(ui.get('bookmark')); ui.get('bookmark').focus();
  ui.run("selectMeetingTab('playback');"); assert.equal(ui.document.activeElement, ui.get('tab-playback'));
  assert.equal(ui.get('tab-playback').getAttribute('aria-selected'), 'true'); assert.equal(ui.get('panel-notes').hidden, true);
});

test('settings shortcut opens a modal using read-only checks and Escape restores focus', async () => {
  const requests = [], ui = harness((url, options) => {
    requests.push([url, options.method || 'GET']);
    if (url === '/api/status') return statusFixture;
    if (url === '/api/permissions') return { screenRecording:'granted', microphone:'not-determined' };
    throw new Error(url);
  });
  ui.get('settings-open').focus(); const shortcut = keyEvent(','); ui.dispatch('keydown', shortcut); await tick();
  assert.equal(shortcut.defaultPrevented, true); assert.equal(ui.get('settings-dialog').open, true); assert.equal(ui.document.activeElement, ui.get('settings-close'));
  assert.equal(ui.get('settings-archive-path').textContent, statusFixture.archivePath); assert.match(ui.get('settings-permission-status').textContent, /Not requested/);
  assert.deepEqual(requests, [['/api/status','GET'], ['/api/permissions','GET']]);
  const escape = keyEvent('Escape', { metaKey:false }); ui.dispatch('keydown', escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(ui.get('settings-dialog').open, false); assert.equal(ui.document.activeElement, ui.get('settings-open'));
});

test('desktop commands save notes and search the library without starting recording', async () => {
  const requests = [], ui = harness((url, options) => {
    requests.push([url, options.method || 'GET', options.body]);
    if (url.endsWith('/notes')) return {};
    if (url === '/api/status') return statusFixture;
    if (url === '/api/meetings' || url === '/api/projects') return [];
    if (url === '/api/permissions') return { screenRecording:'granted', microphone:'denied' };
    if (url === '/api/sources') return { windows:[], microphones:[] };
    throw new Error(url);
  });
  ui.load(meeting('A')); ui.get('notes').value = 'Saved by shortcut'; ui.get('notes').oninput();
  const save = keyEvent('s'); ui.dispatch('keydown', save); await tick();
  assert.equal(save.defaultPrevented, true); assert.equal(ui.run('notesDirty'), false); assert.deepEqual(requests[0].slice(0,2), ['/api/meetings/A/notes','PUT']);
  const search = keyEvent('f'); ui.dispatch('keydown', search); await tick();
  assert.equal(search.defaultPrevented, true); assert.equal(ui.run('view'), 'home'); assert.equal(ui.document.activeElement, ui.get('meeting-search'));
  const create = keyEvent('n'); ui.dispatch('keydown', create); await tick();
  assert.equal(create.defaultPrevented, true); assert.equal(ui.run('view'), 'setup'); assert.equal(ui.document.activeElement, ui.get('title'));
  assert.equal(requests.some(([url]) => url === '/api/record/start'), false);
});

test('shortcuts preserve standard editing, IME composition and disallow arbitrary desktop actions', async () => {
  let requests = 0; const ui = harness(() => { requests++; throw new Error('Unexpected request'); });
  for (const event of [keyEvent('a'), keyEvent('c'), keyEvent('v'), keyEvent('z'), keyEvent('n', { isComposing:true }), keyEvent('f', { keyCode:229 }), keyEvent('n', { ctrlKey:true }), keyEvent('s', { altKey:true }), keyEvent('n', { defaultPrevented:true })]) {
    const before = event.defaultPrevented; ui.dispatch('keydown', event); assert.equal(event.defaultPrevented, before);
  }
  assert.equal(await ui.window.MeetingArchiveDesktop.perform('https://example.com'), false);
  assert.equal(await ui.window.MeetingArchiveDesktop.perform({ action:'new' }), false); assert.equal(requests, 0);
});

test('desktop close refuses on save failure and never sends capture commands', async () => {
  const requests = [], ui = harness((url, options) => { requests.push(url); throw new Error('Disk unavailable'); });
  ui.load(meeting('A')); ui.get('notes').value = 'Must remain'; ui.get('notes').oninput();
  assert.equal(await ui.window.MeetingArchiveDesktop.prepareToClose(), false);
  assert.equal(ui.run('notesDirty'), true); assert.equal(ui.get('notes').value, 'Must remain');
  assert.match(ui.get('message').textContent, /window is still open/); assert.deepEqual(requests, ['/api/meetings/A/notes']);
});

test('desktop close waits for edits made during save and concurrent close calls share the same work', async () => {
  const first = deferred(), second = deferred(), writes = [];
  const ui = harness((url, options) => { assert.match(url, /\/notes$/); writes.push(JSON.parse(options.body).notes); return writes.length === 1 ? first.promise : second.promise; });
  ui.load(meeting('A')); ui.get('notes').value = 'First'; ui.get('notes').oninput();
  const closing = ui.window.MeetingArchiveDesktop.prepareToClose(); assert.equal(ui.window.MeetingArchiveDesktop.prepareToClose(), closing); await tick();
  ui.get('notes').value = 'Latest'; ui.get('notes').oninput(); first.resolve({}); await tick();
  assert.deepEqual(writes, ['First','Latest']); assert.equal(ui.run('notesDirty'), true);
  second.resolve({}); assert.equal(await closing, true); assert.equal(ui.run('notesDirty'), false);
});

test('concurrent manual/automatic saves serialize a newer notes revision instead of duplicating writes', async () => {
  const first = deferred(), second = deferred(), writes = [];
  const ui = harness((url, options) => { writes.push(JSON.parse(options.body).notes); return writes.length === 1 ? first.promise : second.promise; });
  ui.load(meeting('A')); ui.get('notes').value = 'First'; ui.get('notes').oninput(); const initial = ui.run('saveNotes()');
  ui.get('notes').value = 'Next'; ui.get('notes').oninput(); const manual = ui.run('saveNotes()'), automatic = ui.run('saveNotes()');
  first.resolve({}); await tick(); assert.deepEqual(writes, ['First','Next']);
  second.resolve({}); await Promise.all([initial, manual, automatic]); assert.equal(ui.run('notesDirty'), false);
});

test('native desktop actions and close do not interrupt an active IME composition', async () => {
  let requests = 0; const ui = harness(() => { requests++; throw new Error('Must not request while composing'); });
  ui.dispatch('compositionstart', {});
  assert.equal(await ui.window.MeetingArchiveDesktop.perform('new'), false);
  assert.equal(await ui.window.MeetingArchiveDesktop.prepareToClose(), false);
  const shortcut = keyEvent(','); ui.dispatch('keydown', shortcut); assert.equal(shortcut.defaultPrevented, false); assert.equal(requests, 0);
  ui.dispatch('compositionend', {}); assert.equal(await ui.window.MeetingArchiveDesktop.prepareToClose(), true);
});

test('a filtered empty library updates its empty-result explanation when the catalog changes', () => {
  const ui = harness(); ui.get('meeting-search').value = 'Missing'; ui.run('renderLibrary()');
  assert.equal(ui.get('library-list').textContent, '');
  ui.run(`meetingCatalog=${JSON.stringify([catalogMeeting('A')])}; renderLibrary();`);
  assert.match(ui.get('library-list').textContent, /No matching meetings/); assert.equal(ui.get('library-empty').hidden, true);
});

test('English interface preserves Chinese meeting notes, titles, project names and RKA records', async () => {
  const writes = [], ui = harness((url, options) => { writes.push({ url, body:JSON.parse(options.body) }); return {}; });
  const data = meeting('A', '预算讨论：α=0.81，参会人张三。', '项目周会 · 研究甲'); data.projectId = 'P';
  ui.run("localProjects=[{id:'P',name:'边缘安全研究'}];"); ui.load(data);
  assert.equal(ui.get('heading').textContent, '项目周会 · 研究甲'); assert.equal(ui.get('notes').value, '预算讨论：α=0.81，参会人张三。');
  assert.equal(ui.get('project-quick').textContent, '边缘安全研究'); assert.equal(ui.get('state').textContent, 'Saved');
  ui.run(`renderRka(${JSON.stringify({ connection:{ enabled:true, projectId:'P', query:'上次实验有哪些问题？', angleQueries:['中文专有名词'], selectedIds:['r1'] }, snapshot:{ fetchedAt:'2026-10-04T12:00:00Z', retrieval:{ truncated:false }, records:[{ id:'r1', title:'研究进展记录', available:true, type:'notes', useAs:'current_background', record:{ status:'研究进行中', body:'新结果尚未验证。' } }] } })});`);
  assert.equal(ui.get('rka-query').value, '上次实验有哪些问题？'); assert.equal(ui.get('rka-angles').value, '中文专有名词');
  assert.match(ui.get('rka-records').textContent, /研究进展记录/); assert.match(ui.get('rka-records').textContent, /新结果尚未验证。/);
  ui.get('notes').value = '下一步：核对负号、小数点和中文姓名。'; ui.get('notes').oninput(); await ui.run('saveNotes()');
  assert.deepEqual(writes, [{ url:'/api/meetings/A/notes', body:{ notes:'下一步：核对负号、小数点和中文姓名。' } }]);
});

test('native shell activates only with its WK handler and exposes detached metadata without note or document contents', async () => {
  const browser = harness();
  assert.equal(browser.window.MeetingArchiveDesktop.enableNativeShell(), false);
  assert.equal(browser.document.body.classList.contains('native-shell'), false);
  const ui = harness(() => { throw new Error('Snapshot must not request or change permissions'); }, { native:true });
  ui.load(meeting('A', 'PRIVATE FULL NOTES', '讨论 · 项目甲'));
  ui.run(`meetingCatalog=${JSON.stringify([catalogMeeting('A')])}; localProjects=[{id:'P',name:'项目甲',meetingCount:1}]; artifactState={documents:[{content:'PRIVATE DOCUMENT'}],exports:[]}; rkaState={secret:'PRIVATE RKA RECORD'};`);
  assert.equal(ui.window.MeetingArchiveDesktop.enableNativeShell(), true);
  assert.equal(ui.document.body.classList.contains('native-shell'), true);
  assert.ok(ui.nativeMessages.length > 0);
  const snapshot = ui.window.MeetingArchiveDesktop.snapshot();
  assert.equal(snapshot.version, 1); assert.equal(snapshot.nativeShell, true);
  assert.equal(snapshot.projects[0].name, '项目甲'); assert.equal(snapshot.meetings[0].id, 'A');
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE FULL NOTES|PRIVATE DOCUMENT|PRIVATE RKA RECORD/);
  snapshot.meetings[0].title = 'Injected'; snapshot.projects.splice(0);
  const again = ui.window.MeetingArchiveDesktop.snapshot();
  assert.equal(again.meetings[0].title, 'Meeting A'); assert.equal(again.projects[0].name, '项目甲');
  assert.equal(ui.get('notes').value, 'PRIVATE FULL NOTES');
});

test('native dispatch rejects unknown actions, unexpected payload keys and unsafe IDs without requests', async () => {
  let requests = 0; const ui = harness(() => { requests++; throw new Error('No request allowed'); });
  ui.run('connected=true;');
  const invalid = [
    ['https://example.com', {}], [{ action:'new' }, {}], ['library', { id:'A' }], ['settings-refresh', { screen:true }],
    ['meeting', {}], ['meeting', { id:'../A' }], ['meeting', { id:'A/stop' }], ['meeting', { id:'A', extra:true }],
    ['project', { id:'' }], ['stop', { id:'A?other=B' }], ['mic', { id:'A' }], ['mic', { id:'A', enabled:'false' }],
    ['pause', { id:'A', enabled:false }], ['save', []], ['search', null],
    ['settings-request-permission', {}], ['settings-request-permission', { permission:'accessibility' }],
    ['settings-open-permission', { permission:'screen', url:'https://example.com' }],
    ['settings-open-permission', { permission:['microphone'] }]
  ];
  for (const [action, payload] of invalid) assert.equal(await ui.window.MeetingArchiveDesktop.dispatch(action, payload), false, JSON.stringify([action, payload]));
  assert.equal(requests, 0);
});

test('native meeting navigation serializes behind the original notes save without changing its owner', async () => {
  const saved = deferred(), loadedB = deferred(), loadedC = deferred(), requests = [];
  const ui = harness((url, options) => {
    requests.push([url, options.method || 'GET', options.body]);
    if (url === '/api/meetings/A/notes') return saved.promise;
    if (url === '/api/meetings/B') return loadedB.promise;
    if (url === '/api/meetings/C') return loadedC.promise;
    throw new Error(url);
  }, { native:true });
  ui.run('connected=true;'); ui.load(meeting('A')); ui.get('notes').value = 'Original owner A'; ui.get('notes').oninput();
  const openingB = ui.window.MeetingArchiveDesktop.dispatch('meeting', { id:'B' });
  const openingC = ui.window.MeetingArchiveDesktop.dispatch('meeting', { id:'C' });
  await tick();
  assert.deepEqual(requests, [['/api/meetings/A/notes','PUT',JSON.stringify({ notes:'Original owner A' })]]);
  assert.equal(ui.run('selected'), 'A');
  saved.resolve({}); await tick();
  assert.equal(requests.filter(([url]) => url === '/api/meetings/C').length, 0);
  loadedB.resolve(meeting('B')); assert.equal(await openingB, true); await tick();
  assert.equal(ui.run('selected'), 'B');
  loadedC.resolve(meeting('C')); assert.equal(await openingC, true);
  assert.equal(ui.run('selected'), 'C'); assert.equal(ui.get('notes').value, 'Notes C');
});

test('a failed native navigation preserves unsaved notes and does not poison the next command', async () => {
  let saves = 0; const requests = [];
  const ui = harness((url, options) => {
    requests.push(url);
    if (url.endsWith('/notes')) { assert.equal(JSON.parse(options.body).notes, 'Recoverable A'); if (++saves === 1) throw new Error('Disk temporarily unavailable'); return {}; }
    if (url === '/api/meetings/C') return meeting('C');
    throw new Error(url);
  });
  ui.run('connected=true;'); ui.load(meeting('A')); ui.get('notes').value = 'Recoverable A'; ui.get('notes').oninput();
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('meeting', { id:'B' }), false);
  assert.equal(ui.run('selected'), 'A'); assert.equal(ui.run('notesDirty'), true); assert.equal(ui.get('notes').value, 'Recoverable A');
  assert.equal(requests.includes('/api/meetings/B'), false);
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('meeting', { id:'C' }), true);
  assert.equal(ui.run('selected'), 'C'); assert.equal(saves, 2);
});

test('native queued navigation rechecks IME composition and quit locking before execution', async () => {
  for (const block of ['composition','inert']) {
    const saved = deferred(), requests = [];
    const ui = harness(url => { requests.push(url); if (url === '/api/meetings/A/notes') return saved.promise; throw new Error(url); });
    ui.run('connected=true;'); ui.load(meeting('A')); ui.get('notes').value = 'Saved first'; ui.get('notes').oninput();
    const saving = ui.window.MeetingArchiveDesktop.dispatch('save');
    const navigating = ui.window.MeetingArchiveDesktop.dispatch('meeting', { id:'B' });
    await tick();
    if (block === 'composition') ui.dispatch('compositionstart', {}); else ui.document.body.inert = true;
    saved.resolve({}); assert.equal(await saving, true); assert.equal(await navigating, false);
    assert.equal(ui.run('selected'), 'A'); assert.deepEqual(requests, ['/api/meetings/A/notes']);
  }
});

test('native keyboard save uses the same queue as sidebar navigation', async () => {
  const loaded = deferred(), ui = harness(url => { if (url === '/api/meetings/B') return loaded.promise; throw new Error(url); }, { native:true });
  ui.run('connected=true;'); ui.load(meeting('A')); ui.window.MeetingArchiveDesktop.enableNativeShell();
  const navigation = ui.window.MeetingArchiveDesktop.dispatch('meeting', { id:'B' }); await tick();
  let settled = false;
  const saving = ui.window.MeetingArchiveDesktop.perform('save').then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false);
  loaded.resolve(meeting('B')); assert.equal(await navigation, true); assert.equal(await saving, true);
  assert.equal(ui.run('selected'), 'B'); assert.equal(ui.get('notes').value, 'Notes B');
});

test('native close rechecks composition that begins while queued work is finishing', async () => {
  const saved = deferred(), ui = harness(url => { if (url === '/api/meetings/A/notes') return saved.promise; throw new Error(url); });
  ui.run('connected=true;'); ui.load(meeting('A')); ui.get('notes').value = 'First revision'; ui.get('notes').oninput();
  const saving = ui.window.MeetingArchiveDesktop.dispatch('save'); await tick();
  const closing = ui.window.MeetingArchiveDesktop.prepareToClose(); await tick();
  ui.dispatch('compositionstart', {}); saved.resolve({});
  assert.equal(await saving, true); assert.equal(await closing, false);
  assert.match(ui.get('message').textContent, /text input/);
  ui.dispatch('compositionend', {}); assert.equal(await ui.window.MeetingArchiveDesktop.prepareToClose(), true);
});

test('native settings refresh is read-only and leaves the meeting draft and selection intact', async () => {
  const requests = [], ui = harness((url, options) => {
    requests.push([url, options.method || 'GET']);
    if (url === '/api/status') return statusFixture;
    if (url === '/api/permissions') return { screenRecording:'not-granted', microphone:'not-determined' };
    throw new Error(url);
  }, { native:true });
  ui.run('connected=true;'); ui.load(meeting('A')); ui.get('notes').value = 'Still drafting'; ui.get('notes').oninput();
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('settings-refresh'), true);
  assert.deepEqual(requests, [['/api/status','GET'], ['/api/permissions','GET']]);
  assert.equal(ui.run('selected'), 'A'); assert.equal(ui.run('notesDirty'), true); assert.equal(ui.get('notes').value, 'Still drafting');
  assert.equal(ui.get('settings-dialog').open, false);
  const snapshot = ui.window.MeetingArchiveDesktop.snapshot();
  assert.equal(snapshot.archivePath, statusFixture.archivePath); assert.equal(snapshot.settings.checking, false);
});

test('native Settings requests only its explicit permission independently of capture selection', async () => {
  for (const permission of ['screen','microphone']) {
    const requests = [], ui = harness((url, options) => {
      requests.push([url, options.method || 'GET', options.body && JSON.parse(options.body)]);
      if (url === '/api/permissions') return { screenRecording:'not-granted', microphone:'not-determined' };
      if (url === '/api/permissions/request') return { screenRecording:permission === 'screen' ? 'granted' : 'not-granted', microphone:permission === 'microphone' ? 'granted' : 'not-determined' };
      throw new Error(url);
    }, { native:true });
    ui.run('connected=true;'); ui.load(meeting('A'));
    ui.get('notes').value = 'Unfinished draft'; ui.get('notes').oninput();
    assert.equal(ui.get('mic').checked, false);
    assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('settings-request-permission', { permission }), true);
    assert.deepEqual(requests, [
      ['/api/permissions','GET',undefined],
      ['/api/permissions/request','POST',{ screen:permission === 'screen', microphone:permission === 'microphone' }]
    ]);
    assert.equal(ui.get('mic').checked, false); assert.equal(ui.run('selected'), 'A');
    assert.equal(ui.get('notes').value, 'Unfinished draft'); assert.equal(ui.run('notesDirty'), true);
    assert.equal(ui.window.MeetingArchiveDesktop.snapshot().settings.checking, false);
  }
});

test('native Settings blocks duplicate actions and refresh while a permission page is opening', async () => {
  const opened = deferred(), requests = [], ui = harness((url, options) => {
    requests.push([url, options.method || 'GET', options.body && JSON.parse(options.body)]);
    if (url === '/api/permissions/settings') return opened.promise;
    if (url === '/api/permissions') return { screenRecording:'not-granted', microphone:'denied' };
    throw new Error(url);
  }, { native:true });
  ui.run('connected=true;'); ui.window.MeetingArchiveDesktop.enableNativeShell();
  const opening = ui.window.MeetingArchiveDesktop.dispatch('settings-open-permission', { permission:'microphone' });
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('settings-open-permission', { permission:'microphone' }), false);
  await tick();
  assert.equal(ui.window.MeetingArchiveDesktop.snapshot().settings.checking, true);
  assert.equal(ui.get('settings-permission-screen-request').disabled, true);
  assert.equal(ui.get('settings-permission-microphone-settings').disabled, true);
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('settings-request-permission', { permission:'screen' }), false);
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('settings-refresh'), false);
  assert.deepEqual(requests, [['/api/permissions/settings','POST',{ permission:'microphone' }]]);
  opened.resolve({ opened:true }); assert.equal(await opening, true);
  assert.deepEqual(requests[1], ['/api/permissions','GET',undefined]);
  assert.equal(ui.window.MeetingArchiveDesktop.snapshot().settings.checking, false);
  assert.equal(ui.get('settings-permission-microphone-request').disabled, true);
  assert.equal(ui.get('settings-permission-microphone-settings').disabled, false);
});

test('permission command failures appear in native Settings and a retry clears them', async () => {
  let fail = true;
  const ui = harness(url => {
    if (url === '/api/permissions/settings') { if (fail) throw new Error('macOS could not open the privacy page'); return { opened:true }; }
    if (url === '/api/permissions') return { screenRecording:'granted', microphone:'not-determined' };
    throw new Error(url);
  });
  ui.run('connected=true;');
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('settings-open-permission', { permission:'screen' }), false);
  assert.match(ui.window.MeetingArchiveDesktop.snapshot().settings.error, /Could not open System Settings: macOS could not open/);
  assert.equal(ui.window.MeetingArchiveDesktop.snapshot().settings.checking, false);
  fail = false;
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('settings-open-permission', { permission:'screen' }), true);
  assert.equal(ui.window.MeetingArchiveDesktop.snapshot().settings.error, null);
  assert.equal(ui.window.MeetingArchiveDesktop.snapshot().settings.permissions.screenCapture, 'granted');
});

test('browser Settings provides explicit mic access and checks permission without prompting on return', async () => {
  const requests = [], ui = harness((url, options) => {
    requests.push([url, options.method || 'GET', options.body && JSON.parse(options.body)]);
    if (url === '/api/permissions') return { screenRecording:'not-granted', microphone:'not-determined' };
    if (url === '/api/permissions/request') return { screenRecording:'not-granted', microphone:'granted' };
    throw new Error(url);
  });
  ui.run('connected=true;'); ui.get('settings-dialog').showModal();
  await ui.get('settings-permission-microphone-request').click();
  assert.deepEqual(requests.at(-1), ['/api/permissions/request','POST',{ screen:false, microphone:true }]);
  assert.equal(ui.get('mic').checked, false);
  assert.equal(ui.get('settings-permission-microphone-request').disabled, true);
  ui.dispatch('focus', {}); await tick();
  assert.deepEqual(requests.at(-1), ['/api/permissions','GET',undefined]);
  assert.equal(requests.filter(([url]) => url === '/api/permissions/request').length, 1);
});

function liveRecording(id, status = 'recording', microphone = true) {
  const value = meeting(id).manifest;
  return { ...value, status, selection:{ ...value.selection, microphone }, capture:{ micAuthorized:microphone, micEnabled:microphone } };
}

test('native capture commands reject stale IDs, wrong states and unauthorized microphone without mutations', async () => {
  for (const [action, payload, active] of [
    ['stop', { id:'A' }, [liveRecording('B')]],
    ['pause', { id:'A' }, [liveRecording('A','paused')]],
    ['resume', { id:'A' }, [liveRecording('A','recording')]],
    ['stop', { id:'A' }, [liveRecording('A','finalizing')]],
    ['mic', { id:'A', enabled:true }, [liveRecording('A','recording',false)]]
  ]) {
    const requests = [], ui = harness((url, options) => {
      requests.push([url, options.method || 'GET']);
      if (url === '/api/status') return { ...statusFixture, active };
      if (url.startsWith('/api/meetings/')) return { ...meeting('A'), manifest:active[0] };
      throw new Error(url);
    });
    ui.run('connected=true;'); ui.load({ ...meeting('A'), manifest:liveRecording('A') });
    assert.equal(await ui.window.MeetingArchiveDesktop.dispatch(action, payload), false, `${action}: ${active[0].id}/${active[0].status}`);
    assert.equal(requests.some(([, method]) => method !== 'GET'), false);
  }
});

test('native recording commands keep their explicit target when another meeting is selected', async () => {
  for (const [action, payload] of [['pause',{ id:'A' }], ['mic',{ id:'A', enabled:false }]]) {
    const requests = [], active = liveRecording('A');
    const ui = harness((url, options) => {
      requests.push([url, options.method || 'GET', options.body]);
      if (url === '/api/status') return { ...statusFixture, active:[active] };
      if (url === '/api/meetings') return [catalogMeeting('A'),catalogMeeting('B')];
      if (url === '/api/projects') return [];
      if (url === '/api/meetings/B') return meeting('B');
      if (url === '/api/meetings/A') return { ...meeting('A'), manifest:active };
      if (url === `/api/meetings/A/${action}` && options.method === 'POST') return {};
      throw new Error(url);
    });
    ui.run('connected=true;'); ui.load(meeting('B'));
    assert.equal(await ui.window.MeetingArchiveDesktop.dispatch(action, payload), true);
    const mutations = requests.filter(([, method]) => method !== 'GET');
    assert.equal(mutations.length, 1); assert.equal(mutations[0][0], `/api/meetings/A/${action}`);
    if (action === 'mic') assert.deepEqual(JSON.parse(mutations[0][2]), { enabled:false });
    assert.equal(ui.run('selected'), 'B');
  }
});

test('native microphone shortcut targets the active recording while an older meeting is open', async () => {
  const requests = [], active = liveRecording('A');
  const ui = harness((url, options) => {
    requests.push([url, options.method || 'GET', options.body]);
    if (url === '/api/status') return { ...statusFixture, active:[active] };
    if (url === '/api/meetings') return [catalogMeeting('A'),catalogMeeting('B')];
    if (url === '/api/projects') return [];
    if (url === '/api/meetings/B') return meeting('B');
    if (url === '/api/meetings/A/mic' && options.method === 'POST') return {};
    throw new Error(url);
  }, { native:true });
  ui.run(`connected=true; desktopStatus=${JSON.stringify({ ...statusFixture, active:[active] })};`);
  ui.load(meeting('B')); ui.window.MeetingArchiveDesktop.enableNativeShell();
  assert.equal(ui.get('mic-toggle').hidden, true);
  const shortcut = keyEvent('m', { metaKey:false, altKey:true, shiftKey:true }); ui.dispatch('keydown', shortcut); await tick();
  assert.equal(shortcut.defaultPrevented, true);
  const mutations = requests.filter(([, method]) => method !== 'GET');
  assert.deepEqual(mutations, [['/api/meetings/A/mic','POST',JSON.stringify({ enabled:false })]]);
  assert.equal(requests[0][0], '/api/status'); assert.equal(ui.run('selected'), 'B');
});

test('failed native project navigation retains the prior form and saves only to its original project', async () => {
  const writes = [], ui = harness((url, options) => {
    if (url === '/api/projects/A' && options.method === 'PUT') { const body = JSON.parse(options.body); writes.push({ url, body }); return { id:'A', ...body }; }
    if (url === '/api/projects/A') return { project:{ id:'A', name:'Project A', description:'Original A', rkaProjectId:null }, meetings:[], durationSeconds:0 };
    if (url === '/api/projects/B') throw new Error('Project B unavailable');
    if (url === '/api/status') return statusFixture;
    if (url === '/api/projects') return [{ id:'A', name:'Project A', meetingCount:0 }];
    if (url === '/api/meetings') return [];
    throw new Error(url);
  });
  ui.run('connected=true;');
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('project', { id:'A' }), true);
  ui.get('project-name').value = 'Edited project A'; ui.get('project-description').value = 'Unsaved draft for A';
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('project', { id:'B' }), false);
  assert.equal(ui.run('projectViewId'), 'A'); assert.equal(ui.run('view'), 'project');
  assert.equal(ui.get('heading').textContent, 'Project A'); assert.equal(ui.get('project-name').value, 'Edited project A');
  assert.equal(ui.get('project-description').value, 'Unsaved draft for A');
  ui.get('project-form').onsubmit({ preventDefault() {} }); await tick();
  assert.deepEqual(writes, [{ url:'/api/projects/A', body:{ name:'Edited project A', description:'Unsaved draft for A', rkaProjectId:null } }]);
});

test('late project response cannot replace a newer meeting navigation', async () => {
  const loaded = deferred(), ui = harness(url => {
    if (url === '/api/projects/P') return loaded.promise;
    if (url === '/api/meetings/B') return meeting('B');
    throw new Error(url);
  });
  ui.load(meeting('A')); const opening = ui.run("openProject('P')"); await tick();
  await ui.run("openMeeting('B')");
  loaded.resolve({ project:{ id:'P', name:'Late project P', description:'', rkaProjectId:null }, meetings:[], durationSeconds:0 }); await opening;
  assert.equal(ui.run('view'), 'meeting'); assert.equal(ui.run('selected'), 'B');
  assert.equal(ui.get('heading').textContent, 'B'); assert.equal(ui.get('notes').value, 'Notes B');
});

test('native library and search navigation leave focus ownership with the native toolbar', async () => {
  for (const action of ['library','search']) {
    const ui = harness(url => {
      if (url === '/api/status') return statusFixture;
      if (url === '/api/meetings') return [catalogMeeting('A')];
      if (url === '/api/projects') return [];
      throw new Error(url);
    }, { native:true });
    ui.run('connected=true;'); ui.load(meeting('A')); ui.window.MeetingArchiveDesktop.enableNativeShell();
    ui.document.body.focus();
    const focused = [];
    for (const id of ['heading','meeting-search']) {
      const element = ui.get(id), originalFocus = element.focus.bind(element);
      element.focus = () => { focused.push(id); originalFocus(); };
    }
    assert.equal(await ui.window.MeetingArchiveDesktop.dispatch(action), true);
    assert.equal(ui.run('view'), 'home'); assert.equal(ui.run('selected'), null);
    assert.deepEqual(focused, [], `${action} must not focus controls inside the hidden Web library`);
    assert.equal(ui.document.activeElement, ui.document.body);
  }
});

test('recording setup explains the missing microphone and keeps multiple inputs an explicit choice', async () => {
  const microphones = [{ id:'builtin', name:'MacBook Microphone' }, { id:'headset', name:'Headset Microphone' }];
  const ui = harness(url => {
    if (url === '/api/permissions') return { screenRecording:'granted', microphone:'granted' };
    if (url === '/api/sources') return { windows:[{ id:7, app:'Meeting', title:'Call' }], microphones };
    throw new Error(url);
  });
  await ui.get('sources').click();
  assert.equal(ui.get('mic-device').value, '', 'Do not select an arbitrary microphone when several are available');
  ui.run("previewID='preview'; $('confirmed').checked=true; $('mic').checked=true; setStart();");
  assert.equal(ui.get('start').disabled, true);
  assert.match(ui.get('start-status').textContent, /Choose a microphone/);
  ui.get('mic-device').value = 'headset'; ui.get('mic-device').onchange();
  assert.equal(ui.get('start').disabled, false); assert.equal(ui.get('start-status').textContent, 'Ready to record.');
  ui.get('mic-device').value = ''; ui.get('mic-device').onchange();
  assert.equal(ui.get('start').disabled, true);
  ui.get('mic').checked = false; await ui.get('mic').onchange();
  assert.equal(ui.get('start').disabled, false, 'A disabled microphone does not require a selected device');
});

test('recording setup updates its next step for permission checks, preview resets and confirmation', () => {
  const ui = harness();
  ui.run('setStart()'); assert.match(ui.get('start-status').textContent, /Check recording permissions/);
  ui.run("permissionState={screenRecording:'not-granted',microphone:'granted'}; setStart();");
  assert.equal(ui.get('start').disabled, true); assert.match(ui.get('start-status').textContent, /Allow Screen/);
  ui.run("permissionState.screenRecording='granted'; setStart();");
  assert.match(ui.get('start-status').textContent, /Choose a window/);
  ui.get('window').value = '7'; ui.run('setStart()'); assert.match(ui.get('start-status').textContent, /Preview the selected window/);
  ui.run("previewID='preview'; setStart();"); assert.match(ui.get('start-status').textContent, /Confirm that the preview/);
  ui.get('confirmed').checked = true; ui.get('confirmed').onchange();
  assert.equal(ui.get('start').disabled, false);
  ui.run('permissionTask=Promise.resolve(); setStart();');
  assert.equal(ui.get('start').disabled, true); assert.match(ui.get('start-status').textContent, /Checking permissions/);
  ui.run('permissionTask=null; resetPreview();');
  assert.equal(ui.get('start').disabled, true); assert.match(ui.get('start-status').textContent, /Preview the selected window/);
  assert.equal(ui.get('confirmed').checked, false);
});

test('changing window to entire display resets consent and discards a late window preview with the same ID', async () => {
  const pending = deferred(), requests = [], ui = harness((url, options) => {
    if (url === '/api/permissions') return { screenRecording:'granted', microphone:'granted' };
    if (url === '/api/sources') return { windows:[{ id:7, app:'Meeting', title:'Call' }], displays:[{ id:7, name:'Test display', widthPixels:1920, heightPixels:1080 }], microphones:[] };
    if (url === '/api/preview') { requests.push(JSON.parse(options.body)); return requests.length === 1 ? pending.promise : { previewID:'display-preview', jpeg:'fixture' }; }
    throw new Error(url);
  });
  ui.run("view='setup';"); await ui.get('sources').click();
  ui.get('window').value = '7'; const windowPreview = ui.get('preview').click();
  await tick(); assert.equal(requests[0].target.kind, 'window');
  ui.get('capture-kind').value = 'display'; ui.get('capture-kind').onchange();
  assert.equal(ui.get('window').value, ''); assert.equal(ui.get('confirmed').checked, false);
  assert.equal(ui.get('confirmed').disabled, true); assert.equal(ui.get('start').disabled, true);
  assert.match(ui.get('confirmed-label').textContent, /entire display.*notifications/);
  ui.get('window').value = '7'; pending.resolve({ previewID:'window-preview', jpeg:'old' }); await windowPreview;
  assert.equal(ui.run('previewID'), null); assert.equal(ui.get('preview-image').hidden, true);
  await ui.get('preview').click(); assert.equal(requests[1].target.kind, 'display');
  assert.equal(ui.get('confirmed').disabled, false); assert.equal(ui.get('start').disabled, true);
  ui.get('confirmed').checked = true; ui.get('confirmed').onchange();
  assert.equal(ui.get('start').disabled, false);
  ui.get('capture-kind').value = 'window'; ui.get('capture-kind').onchange();
  assert.equal(ui.run('previewID'), null); assert.equal(ui.get('confirmed').disabled, true);
});

test('a video-only display archive labels its source and never claims audio is recording or playing', () => {
  const ui = harness(), value = meeting('display');
  value.manifest.selection = { target:{ kind:'display', id:7 }, display:{ id:7, name:'Test display' }, microphone:false, systemAudio:false };
  value.manifest.status = 'recording'; value.manifest.capture = { videoAvailable:false, micEnabled:false };
  ui.load(value);
  ui.run('desktopStatus={active:[current.manifest]};');
  assert.match(ui.get('target').textContent, /Entire display.*Test display/);
  assert.match(ui.get('capture-warning').textContent, /No audio source is recording/);
  assert.match(ui.window.MeetingArchiveDesktop.snapshot().activeRecording.warning, /No audio source is recording/);
  assert.match(ui.get('video-gap').textContent, /No audio was saved/);
  assert.doesNotMatch(ui.get('write-health').textContent, /audio continues/i);
});

function sessionPlaybackMeeting(ui, { videoRanges = [[0, 2], [2, 4], [10, 12]], duration = 50.856 } = {}) {
  const value = meeting('session'); value.manifest.durationSeconds = duration; value.manifest.timeline.originPTS.seconds = 100;
  value.manifest.segments = [
    { kind:'system', file:'system.wav', sampleRate:1000, startPTS:{ seconds:100 }, endPTS:{ seconds:100 + duration } },
    ...videoRanges.map(([start, end], index) => ({ kind:'video', file:`video-${index}.mp4`, startPTS:{ seconds:100 + start }, endPTS:{ seconds:100 + end } }))
  ];
  ui.get('video').duration = 2; ui.load(value); return value;
}
const fullSessionAudio = [{ pts:{ seconds:100 }, frames:50856, frameOffset:0 }];

test('meeting playback shows full duration and traverses video fragments without restarting its clock', async () => {
  const ui = harness(() => fullSessionAudio); sessionPlaybackMeeting(ui);
  assert.equal(ui.get('playback-duration').textContent, '00:50'); assert.equal(ui.get('timeline').max, 50.856);
  assert.equal(ui.get('video').duration, 2); assert.equal(ui.get('video').playCount, 0);
  await ui.get('play-session').click(); ui.advance(2500); await ui.run('updateSessionPlayback()');
  assert.equal(ui.get('video').src, '/api/meetings/session/media/video-1.mp4');
  assert.equal(ui.get('video').currentTime, .5); assert.equal(Number(ui.get('timeline').value), 2.5);
  assert.equal(ui.get('meeting-audio').currentTime, 2.5); assert.equal(ui.get('play-session').textContent, 'Pause');
});

test('middle and trailing video gaps preserve session time and audio instead of skipping or freezing a picture', async () => {
  const ui = harness(() => fullSessionAudio); sessionPlaybackMeeting(ui);
  await ui.get('play-session').click(); ui.advance(6000); await ui.run('updateSessionPlayback()');
  assert.equal(ui.get('video').hidden, true); assert.equal(ui.get('video-gap').hidden, false);
  assert.match(ui.get('video-gap').textContent, /next saved picture starts at 00:10/);
  assert.equal(Number(ui.get('timeline').value), 6); assert.equal(ui.get('meeting-audio').currentTime, 6); assert.equal(ui.get('meeting-audio').paused, false);
  ui.advance(4500); await ui.run('updateSessionPlayback()');
  assert.equal(ui.get('video').hidden, false); assert.equal(ui.get('video').currentTime, .5); assert.equal(Number(ui.get('timeline').value), 10.5);
  ui.advance(34500); await ui.run('updateSessionPlayback()');
  assert.equal(ui.get('video').hidden, true); assert.equal(ui.get('meeting-audio').currentTime, 45); assert.equal(Number(ui.get('timeline').value), 45);
  ui.advance(10000); await ui.run('updateSessionPlayback()');
  assert.equal(Number(ui.get('timeline').value), 50.856); assert.equal(ui.get('meeting-audio').paused, true); assert.equal(ui.get('play-session').textContent, 'Replay');
});

test('audio-only session supports play, pause, resume and seeking inside video gaps', async () => {
  const ui = harness(() => fullSessionAudio); sessionPlaybackMeeting(ui, { videoRanges:[] });
  await ui.get('play-session').click(); ui.advance(5000); await ui.run('updateSessionPlayback()');
  await ui.get('play-session').click(); ui.advance(10000); await ui.run('updateSessionPlayback()');
  assert.equal(Number(ui.get('timeline').value), 5); assert.equal(ui.get('meeting-audio').paused, true);
  ui.get('timeline').value = 20; await ui.get('timeline').onchange(); assert.equal(Number(ui.get('timeline').value), 20); assert.equal(ui.get('meeting-audio').paused, true);
  await ui.get('play-session').click(); ui.advance(1000); await ui.run('updateSessionPlayback()');
  assert.equal(Number(ui.get('timeline').value), 21); assert.equal(ui.get('meeting-audio').currentTime, 21); assert.equal(ui.get('video').hidden, true);
  ui.run("selectMeetingTab('notes')"); ui.advance(5000); await ui.run('updateSessionPlayback()');
  assert.equal(Number(ui.get('timeline').value), 21); assert.equal(ui.get('meeting-audio').paused, true);
});

test('late playback preparation cannot rewind a newer seek or resume after pause', async () => {
  const pending = deferred(), ui = harness(undefined, { playback:() => pending.promise }); sessionPlaybackMeeting(ui, { videoRanges:[] });
  const starting = ui.get('play-session').click(); ui.advance(1000);
  const seeking = ui.run('seek(20, true)'); pending.resolve({status:'ready',path:'exports/prepared/recording.m4a'}); await Promise.all([starting, seeking]);
  assert.equal(ui.get('meeting-audio').currentTime, 20); assert.equal(Number(ui.get('timeline').value), 20);
  const late = deferred(), other = harness(undefined, {playback:() => late.promise}); sessionPlaybackMeeting(other, { videoRanges:[] });
  const waiting = other.get('play-session').click(); other.run('pauseRawPlayback()'); late.resolve({status:'ready',path:'exports/prepared/recording.m4a'}); await waiting;
  assert.equal(other.get('meeting-audio').playCount, 0); assert.equal(other.get('play-session').textContent, 'Play');
});

test('late video metadata cannot autoplay after pause or replace a different meeting', async () => {
  const ui = harness(() => fullSessionAudio); ui.get('video').load = () => {};
  sessionPlaybackMeeting(ui); await ui.get('play-session').click();
  const metadata = ui.get('video').onloadedmetadata; ui.run('pauseRawPlayback()'); metadata();
  assert.equal(ui.get('video').playCount, 0); assert.equal(ui.run('rawPlaying'), false);
  ui.load(meeting('other')); ui.get('video').currentTime = 0; metadata();
  assert.equal(ui.get('video').currentTime, 0); assert.equal(ui.get('video').playCount, 0);
});

test('paused seek and delayed audio metadata use the latest session position', async () => {
  const ui = harness(() => fullSessionAudio); ui.get('video').load = () => {};
  sessionPlaybackMeeting(ui); const metadata = ui.get('video').onloadedmetadata;
  await ui.run('seek(1.2, false)'); metadata();
  assert.ok(Math.abs(ui.get('video').currentTime - 1.2) < .00001); assert.equal(ui.get('video').paused, true);
  ui.run('resetMeetingAudio()'); ui.get('meeting-audio').load = () => {}; const starting = ui.get('play-session').click(); await tick();
  const audioMetadata = ui.get('meeting-audio').onloadedmetadata; ui.advance(4000); audioMetadata(); await starting;
  assert.ok(Math.abs(ui.get('meeting-audio').currentTime - 1.2) < .00001);
});

test('range drag survives playback polling and manifest refresh before committing once', async () => {
  const ui = harness(() => fullSessionAudio), value = sessionPlaybackMeeting(ui);
  await ui.run('seek(4.7, false)');
  const range = ui.get('timeline'); range.onpointerdown(); range.value = 30; range.oninput();
  ui.advance(500); await ui.run('updateSessionPlayback()');
  ui.run(`renderMeeting(${JSON.stringify(value)}, false)`);
  assert.equal(Number(range.value), 30); assert.equal(ui.get('position').textContent, '00:30');
  assert.equal(ui.run('rawPosition'), 4.7, 'preview must not seek before commit');
  await range.onpointerup();
  const revision = ui.run('playbackRevision'); await range.onchange();
  assert.equal(ui.run('playbackRevision'), revision, 'pointerup and change must not seek twice');
  assert.equal(ui.run('rawPosition'), 30); assert.equal(ui.run('rawPlaying'), false);
  ui.advance(1000); await ui.run('updateSessionPlayback()'); assert.equal(Number(range.value), 30);
});

test('canceling a playing range drag preserves the advancing session and ignores its late change', async () => {
  const ui = harness(() => fullSessionAudio); sessionPlaybackMeeting(ui);
  await ui.get('play-session').click(); ui.advance(5000); await ui.run('updateSessionPlayback()');
  const range = ui.get('timeline'); range.onpointerdown(); range.value = 30; range.oninput();
  ui.advance(2000); await ui.run('updateSessionPlayback()');
  assert.equal(Number(range.value), 30); assert.equal(ui.get('meeting-audio').currentTime, 7);
  range.onpointercancel(); await range.onchange();
  assert.equal(Number(range.value), 7); assert.equal(ui.run('rawPlaying'), true);
  ui.advance(1000); await ui.run('updateSessionPlayback()'); assert.equal(Number(range.value), 8);
});

test('keyboard and accessibility range input retain their value until change or key release', async () => {
  const ui = harness(() => fullSessionAudio); sessionPlaybackMeeting(ui);
  const range = ui.get('timeline'); range.onkeydown({ key:'End' }); range.value = 40; range.oninput();
  await ui.run('updateSessionPlayback()'); assert.equal(Number(range.value), 40);
  await range.onkeyup({ key:'End' }); await range.onchange();
  assert.equal(ui.run('rawPosition'), 40);
  range.value = 12; range.oninput(); await ui.run('updateSessionPlayback()'); await range.onchange();
  assert.equal(ui.run('rawPosition'), 12, 'accessibility input need not start with pointerdown');
  range.onkeydown({ key:'ArrowRight' }); range.value = 13; range.oninput();
  let prevented = false; range.onkeydown({ key:'Escape', preventDefault() { prevented = true; } }); await range.onchange();
  assert.equal(prevented, true); assert.equal(ui.run('rawPosition'), 12);
});

test('an unfinished seek gesture cannot seek another meeting or restart playback after navigation', async () => {
  const ui = harness(() => fullSessionAudio); sessionPlaybackMeeting(ui);
  const range = ui.get('timeline'); range.onpointerdown(); range.value = 30; range.oninput();
  const other = meeting('other'); other.manifest.durationSeconds = 45; ui.load(other);
  const revision = ui.run('playbackRevision'); await range.onpointerup(); await range.onchange();
  assert.equal(ui.run('playbackRevision'), revision); assert.equal(ui.run('rawPosition'), 0); assert.equal(ui.run('rawPlaying'), false);
  range.onpointerdown(); range.value = 10; range.oninput(); await range.onchange();
  assert.equal(ui.run('rawPosition'), 10, 'the new meeting accepts a fresh gesture');
});

test('a delayed raw-video play event cannot resurrect a paused session or its source audio', async () => {
  const ui = harness(() => fullSessionAudio); sessionPlaybackMeeting(ui);
  await ui.get('play-session').click(); ui.advance(2500); await ui.run('updateSessionPlayback()');
  await ui.get('play-session').click();
  const pausedAt = Number(ui.get('timeline').value), audioPlays = ui.get('meeting-audio').playCount;
  // WebKit can deliver the queued play event after the controller's pause.
  ui.get('video').paused = false; await ui.get('video').onplay();
  ui.advance(5000); await ui.run('updateSessionPlayback()');
  assert.equal(ui.run('rawPlaying'), false); assert.equal(ui.get('video').paused, true);
  assert.equal(ui.get('meeting-audio').paused, true); assert.equal(ui.get('meeting-audio').playCount, audioPlays);
  assert.equal(Number(ui.get('timeline').value), pausedAt); assert.equal(ui.get('play-session').textContent, 'Play');
  // The audio timer must also obey session state before the media event arrives.
  ui.get('video').paused = false; await ui.run('updateSessionPlayback()');
  assert.equal(ui.get('meeting-audio').playCount, audioPlays); assert.equal(ui.run('rawPlaying'), false);
});

test('video load failure stops once and requires an explicit retry', async () => {
  const ui = harness(() => fullSessionAudio); let loads = 0; ui.get('video').load = () => { loads++; };
  sessionPlaybackMeeting(ui); ui.get('video').onerror(); const before = loads;
  await ui.run('updateSessionPlayback()'); await ui.run('updateSessionPlayback()');
  assert.equal(loads, before); assert.match(ui.get('video-gap').textContent, /Press Play to retry/);
  await ui.get('play-session').click(); assert.equal(loads, before + 1);
});

test('session Play resumes the audio-only evidence time shown on the meeting timeline', async () => {
  const ui = harness(() => [{ pts:{ seconds:100 }, frames:5000, frameOffset:0 }, { pts:{ seconds:110 }, frames:10000, frameOffset:5000 }]);
  sourceEvidenceMeeting(ui); await ui.run("jumpToSource({source:'microphone',startMs:12000})");
  await ui.get('play-session').click();
  assert.equal(Number(ui.get('timeline').value), 10); assert.equal(ui.get('meeting-audio').currentTime, 10);
  assert.equal(ui.get('meeting-audio').paused, false);
});

test('rejected session audio play pauses with an actionable error and clears only after a successful retry', async () => {
  const ui = harness(() => fullSessionAudio); sessionPlaybackMeeting(ui, { videoRanges:[] });
  const audio = ui.get('meeting-audio'), originalPlay = audio.play.bind(audio); let attempts = 0;
  audio.play = () => ++attempts === 1 ? Promise.reject(new Error('User gesture required')) : originalPlay();
  await ui.get('play-session').click(); await tick();
  assert.equal(ui.run('rawPlaying'), false); assert.equal(ui.get('play-session').textContent, 'Play');
  assert.match(ui.get('message').textContent, /Meeting audio could not start: User gesture required.*Press Play to retry/);
  await ui.get('play-session').click(); await tick();
  assert.equal(ui.run('rawPlaying'), true); assert.equal(audio.paused, false); assert.equal(ui.get('message').hidden, true);
});

test('a stale rejected audio play cannot pause or show an error in a newer meeting', async () => {
  const pending = deferred(), ui = harness(() => fullSessionAudio); sessionPlaybackMeeting(ui, { videoRanges:[] });
  ui.get('meeting-audio').play = () => pending.promise; const starting = ui.get('play-session').click(); await tick();
  const newer = meeting('newer'); newer.manifest.durationSeconds = 30; ui.load(newer); await ui.get('play-session').click();
  pending.reject(new Error('Old blocked audio')); await starting; await tick();
  assert.equal(ui.run('rawPlaying'), true); assert.equal(ui.get('message').textContent.includes('Old blocked audio'), false);
});


test('native context actions retain right-click target, save edits, refresh titles and restore deleted meetings', async () => {
  const records = { A:meeting('A'), B:meeting('B') }, removed = {}, calls = [];
  const ui = harness((url, options) => {
    calls.push([url, options.method || 'GET']);
    if (url === '/api/status') return { active:[], freeBytes:1e9, archivePath:'/test', nativeBuilt:true };
    if (url === '/api/projects') return [];
    if (url === '/api/meetings') return Object.values(records).map(m => m.manifest);
    if (url.endsWith('/notes')) { records.A.notes = JSON.parse(options.body).notes; return {}; }
    if (url === '/api/meetings/B/rename') { records.B.manifest.title = JSON.parse(options.body).title; return {}; }
    if (url === '/api/meetings/A/trash') { removed.A = records.A; delete records.A; return {}; }
    if (url === '/api/trash/A/restore') { records.A = removed.A; delete removed.A; return {}; }
    if (url.startsWith('/api/meetings/')) return records[url.split('/').at(-1)];
    throw new Error(url);
  }, { native:true, trash:() => Object.values(removed).map(m => ({ id:m.manifest.id, title:m.manifest.title })) });
  ui.window.MeetingArchiveDesktop.enableNativeShell(); ui.run('connected=true;'); ui.load(records.A);
  ui.get('notes').value = 'Keep these edits'; ui.get('notes').oninput();
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('meeting-rename', { id:'B', title:'项目 Beta' }), true);
  assert.equal(ui.run('selected'), 'A'); assert.equal(records.B.manifest.title, '项目 Beta');
  assert(calls.findIndex(([u]) => u.endsWith('/notes')) < calls.findIndex(([u]) => u.endsWith('/rename')));
  assert.equal(ui.window.MeetingArchiveDesktop.snapshot().meetings.find(m => m.id === 'B').title, '项目 Beta');
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('meeting-trash', { id:'A' }), true);
  assert.equal(ui.run('selected'), null); assert.equal(ui.run('view'), 'home');
  assert.equal(ui.window.MeetingArchiveDesktop.snapshot().deletedMeetings[0].id, 'A');
  assert.equal(removed.A.notes, 'Keep these edits');
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('meeting-restore', { id:'A' }), true);
  assert.equal(ui.run('selected'), 'A'); assert.equal(ui.get('notes').value, 'Keep these edits');
  assert.equal(ui.window.MeetingArchiveDesktop.snapshot().deletedMeetings.length, 0);
});
test('native delete aborts when notes cannot be saved and rename validates before sending', async () => {
  const calls = [];
  const ui = harness(url => { calls.push(url); throw new Error('Save unavailable'); });
  ui.run('connected=true;'); ui.load(meeting('A')); ui.get('notes').value = 'unsaved'; ui.get('notes').oninput();
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('meeting-trash', { id:'A' }), false);
  assert.deepEqual(calls, ['/api/meetings/A/notes']); assert.equal(ui.run('selected'), 'A');
  for (const title of ['', '   ', 'bad\nname', 'x'.repeat(301)]) {
    assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('meeting-rename', { id:'B', title }), false);
  }
  assert.equal(calls.length, 1); assert.equal(ui.run('notesDirty'), true);
  assert.equal(ui.get('notes').disabled, false); assert.equal(ui.run('meetingMutationInFlight'), false);
});

test('native deletion locks notes through the save and trash request so late typing cannot be lost', async () => {
  const saving = deferred(), deleting = deferred(), record = meeting('A'); let savedText, deleteCalls = 0;
  const ui = harness((url, options) => {
    if (url === '/api/meetings/A/notes') { savedText = JSON.parse(options.body).notes; return saving.promise; }
    if (url === '/api/meetings/A/trash') { deleteCalls++; return deleting.promise; }
    if (url === '/api/status') return statusFixture;
    if (url === '/api/meetings' || url === '/api/projects') return [];
    throw new Error(url);
  }, { native:true });
  ui.window.MeetingArchiveDesktop.enableNativeShell(); ui.run('connected=true;'); ui.load(record);
  ui.get('notes').value = 'The edits to preserve'; ui.get('notes').oninput();
  const deletion = ui.window.MeetingArchiveDesktop.dispatch('meeting-trash', { id:'A' }); await tick();
  assert.equal(ui.get('notes').disabled, true); assert.equal(ui.get('save-notes').disabled, true); assert.equal(deleteCalls, 0);
  saving.resolve({}); await tick();
  assert.equal(deleteCalls, 1); assert.equal(ui.get('notes').disabled, true); assert.equal(ui.run('notesDirty'), false);
  // A disabled textarea cannot accept this keystroke. Exercise the input
  // handler as well, because an already queued DOM input must not dirty it.
  if (!ui.get('notes').disabled) ui.get('notes').value = 'Typed too late';
  ui.get('notes').oninput(); assert.equal(ui.run('notesDirty'), false);
  assert.equal(ui.get('notes').value, 'The edits to preserve');
  deleting.resolve({}); assert.equal(await deletion, true);
  assert.equal(savedText, 'The edits to preserve'); assert.equal(ui.run('notesDirty'), false);
  assert.equal(ui.run('notesMeetingId'), null); assert.equal(ui.run('meetingMutationInFlight'), false);
  assert.equal(ui.get('notes').disabled, true);
});

test('failed native mutation unlocks the same notes editor without discarding its saved contents', async () => {
  const deleting = deferred(), ui = harness(url => {
    if (url === '/api/meetings/A/trash') return deleting.promise;
    throw new Error(url);
  }, { native:true });
  ui.run('connected=true;'); ui.load(meeting('A', 'Keep this content'));
  const deletion = ui.window.MeetingArchiveDesktop.dispatch('meeting-trash', { id:'A' }); await tick();
  assert.equal(ui.get('notes').disabled, true); deleting.reject(new Error('Recording still active'));
  assert.equal(await deletion, false); assert.equal(ui.run('selected'), 'A');
  assert.equal(ui.get('notes').value, 'Keep this content'); assert.equal(ui.get('notes').disabled, false);
  ui.get('notes').value += ' — next edit'; ui.get('notes').oninput(); assert.equal(ui.run('notesDirty'), true);
});

test('native restoration keeps notes locked until the restored meeting has loaded', async () => {
  const restoring = deferred(), loading = deferred(); let restored = false;
  const ui = harness(url => {
    if (url === '/api/trash/A/restore') return restoring.promise;
    if (url === '/api/status') return statusFixture;
    if (url === '/api/projects') return [];
    if (url === '/api/meetings') return [meeting('B').manifest, ...(restored ? [meeting('A').manifest] : [])];
    if (url === '/api/meetings/B') return meeting('B');
    if (url === '/api/meetings/A') return loading.promise;
    throw new Error(url);
  }, { native:true });
  ui.run('connected=true;'); ui.load(meeting('B'));
  const restoration = ui.window.MeetingArchiveDesktop.dispatch('meeting-restore', { id:'A' }); await tick();
  assert.equal(ui.get('notes').disabled, true); restored = true; restoring.resolve({}); await tick();
  assert.equal(ui.get('notes').disabled, true); assert.equal(ui.run('selected'), 'B');
  loading.resolve(meeting('A', 'Restored notes')); assert.equal(await restoration, true);
  assert.equal(ui.run('selected'), 'A'); assert.equal(ui.get('notes').value, 'Restored notes'); assert.equal(ui.get('notes').disabled, false);
});

test('a delayed detail refresh cannot overwrite a successful rename of the selected meeting', async () => {
  const stale = deferred(); let title = 'Old title', detailCalls = 0;
  const ui = harness((url, options) => {
    if (url === '/api/status') return statusFixture;
    if (url === '/api/projects') return [];
    if (url === '/api/meetings') return [meeting('A', 'Saved notes', title).manifest];
    if (url === '/api/meetings/A') return ++detailCalls === 1 ? stale.promise : meeting('A', 'Saved notes', title);
    if (url === '/api/meetings/A/rename') { title = JSON.parse(options.body).title; return {}; }
    throw new Error(url);
  }, { native:true });
  ui.run('connected=true;'); ui.load(meeting('A', 'Saved notes', title));
  const refresh = ui.run('refresh()'); await tick(); assert.equal(detailCalls, 1);
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('meeting-rename', { id:'A', title:'New title' }), true);
  assert.equal(ui.get('heading').textContent, 'New title');
  stale.resolve(meeting('A', 'Saved notes', 'Old title')); await refresh;
  assert.equal(ui.get('heading').textContent, 'New title'); assert.equal(ui.run('current.manifest.title'), 'New title');
});

test('a delayed project refresh cannot put a deleted meeting back into its project timeline', async () => {
  const stale = deferred(), original = { ...meeting('A').manifest, notes:'Project discussion' }; let deleted = false, detailCalls = 0;
  const ui = harness(url => {
    if (url === '/api/status') return statusFixture;
    if (url === '/api/projects') return [{ id:'P', name:'Project', meetingCount:deleted ? 0 : 1 }];
    if (url === '/api/meetings') return deleted ? [] : [original];
    if (url === '/api/projects/P') return ++detailCalls === 1 ? stale.promise : { meetings:[], durationSeconds:0 };
    if (url === '/api/meetings/A/trash') { deleted = true; return {}; }
    throw new Error(url);
  }, { native:true });
  ui.run("connected=true; view='project'; projectViewId='P';");
  const refresh = ui.run('refresh()'); await tick(); assert.equal(detailCalls, 1);
  assert.equal(await ui.window.MeetingArchiveDesktop.dispatch('meeting-trash', { id:'A' }), true);
  assert.match(ui.get('project-stats').textContent, /^0 meetings/);
  stale.resolve({ meetings:[original], durationSeconds:5 }); await refresh;
  assert.match(ui.get('project-stats').textContent, /^0 meetings/); assert.equal(ui.get('project-timeline').children.length, 0);
});
