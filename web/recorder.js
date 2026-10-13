'use strict';
const $ = id => document.getElementById(id);
const stateNames = { starting:'Starting', recording:'Recording', paused:'Paused', finalizing:'Saving', recorded:'Saved', partial:'Partially saved · Gaps detected', failed:'Recording failed', unavailable:'Archive unavailable' };
let current = null, selected = null, previewID = null, connected = false, switching = false, sourceClip = null, notesDirty = false;
let captureSources = { windows:[], displays:[] }, sourceListRevision = 0, previewRequestRevision = 0;
let localProjects = [], meetingCatalog = [], deletedMeetings = [], projectFilter = null, projectViewId = null, view = 'home', rkaState = null, rkaCatalog = [], firstRefresh = true;
let artifactState = null, exportSignature = '', exportPolling = false;
let notesTimer = null, notesRevision = 0, notesSaving = null, notesMeetingId = null, meetingTab = 'notes';
let meetingLoadRevision = 0, meetingLoading = false, audioIndexError = null;
let audioPlaybackError = null;
let sourceJumpRevision = 0;
let playbackGroup = 'raw';
let rawPosition = 0, rawPlaying = false, rawStartedAt = 0, rawStartedPosition = 0, videoLoadRevision = 0, playbackRevision = 0, audioSyncRevision = 0, videoLoadError = null;
let timelineGesture = null, lastTimelineCommit = null;
const audioIndexes = new Map();
let permissionState = null, permissionTask = null, archiveRoot = '', settingsReturnFocus = null, closeTask = null, composingText = false;
let nativeShell = false, desktopStatus = null, desktopSettingsError = null, desktopStateSignature = '';
let desktopCommandQueue = Promise.resolve(), pendingDesktopCommands = 0;
let catalogRefreshRevision = 0;
let meetingMutationInFlight = false;
const renderedLists = new WeakMap();
const countLabel = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const seconds = n => { n = Math.max(0, Math.floor(n || 0)); return `${Math.floor(n / 60).toString().padStart(2,'0')}:${(n % 60).toString().padStart(2,'0')}`; };
const showMessage = message => { $('message').textContent = message; $('message').hidden = !message; publishDesktopState(); };
// The web controller remains the sole owner of navigation and unsaved notes.
// Native controls receive detached display data and send bounded commands back.
function desktopSnapshot() {
  const active = desktopStatus?.active?.[0];
  return {
    version:1, nativeShell, view, connected, busy:pendingDesktopCommands > 0 || meetingLoading || !!closeTask,
    selectedMeetingId:selected, selectedProjectId:view === 'project' ? projectViewId : view === 'meeting' ? current?.projectId || null : null,
    projects:localProjects.map(p => ({ id:p.id, name:p.name })),
    meetings:meetingCatalog.map(m => ({ id:m.id, title:m.title, createdAt:m.createdAt, status:m.status,
      projectId:m.projectId || null, notesPreview:m.notesPreview || '', durationSeconds:m.durationSeconds || 0, mutationBlocked:!!m.mutationBlocked })),
    deletedMeetings:deletedMeetings.map(m => ({ id:m.id, title:m.title })),
    activeRecording:active ? { id:active.id, title:active.title || 'Active recording', status:active.status,
      micEnabled:!!active.capture?.micEnabled,
      microphoneSelected:!!(active.capture?.micAuthorized ?? active.selection?.microphone),
      warning:active.status === 'recording' && active.capture?.videoAvailable === false ? captureVideoWarning(active) : '' } : null,
    archivePath:archiveRoot, freeBytes:Number.isFinite(desktopStatus?.freeBytes) ? desktopStatus.freeBytes : null,
    notesDirty, message:$('message').hidden ? '' : $('message').textContent,
    settings:{ checking:!!permissionTask, error:desktopSettingsError,
      permissions:{ screenCapture:permissionState?.screenRecording || 'unknown', microphone:permissionState?.microphone || 'unknown', accessibility:'not-required' } }
  };
}
function publishDesktopState(force = false) {
  if (!nativeShell) return;
  const handler = window.webkit?.messageHandlers?.meetingArchiveState;
  if (!handler?.postMessage) return;
  const state = desktopSnapshot(), signature = JSON.stringify(state);
  if (!force && signature === desktopStateSignature) return;
  try { handler.postMessage(state); desktopStateSignature = signature; } catch { /* Web UI remains usable if the native host is unavailable. */ }
}
function enableNativeShell() {
  if (!window.webkit?.messageHandlers?.meetingArchiveState?.postMessage) return false;
  nativeShell = true; document.body.classList.toggle('native-shell', true);
  closeSettings(false); publishDesktopState(true); return true;
}
function sendNativeCommand(action) {
  if (!nativeShell || !['search','settings'].includes(action)) return false;
  try { window.webkit.messageHandlers.meetingArchiveState.postMessage({ version:1, event:'command', action }); return true; }
  catch { return false; }
}
function validatedDesktopCommand(action, payload) {
  const definitions = { library:[], 'new-project':[], new:[], save:[], search:[], 'settings-refresh':[],
    'settings-request-permission':['permission'], 'settings-open-permission':['permission'],
    meeting:['id'], project:['id'], pause:['id'], resume:['id'], stop:['id'], mic:['id','enabled'],
    'meeting-rename':['id','title'], 'meeting-trash':['id'], 'meeting-restore':['id'] };
  if (typeof action !== 'string' || !Object.hasOwn(definitions, action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const keys = Object.keys(payload), expected = definitions[action];
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) return null;
  if (expected.includes('id') && (typeof payload.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(payload.id))) return null;
  if (action === 'mic' && typeof payload.enabled !== 'boolean') return null;
  if (action === 'meeting-rename' && (typeof payload.title !== 'string' || !payload.title.trim()
      || [...payload.title].length > 300 || /[\u0000-\u001f\u007f]/.test(payload.title))) return null;
  if (expected.includes('permission') && !['screen','microphone'].includes(payload.permission)) return null;
  return { action, payload:{ ...payload } };
}
async function desktopMeetingAction(action, payload) {
  // Save edits before any archive mutation. Failure leaves the meeting and
  // the current selection intact; the explicit right-click target is retained.
  catalogRefreshRevision++;
  meetingMutationInFlight = true; setMeetingLoading(meetingLoading);
  try {
    await flushNotes();
    if (action === 'meeting-restore') {
      await post(`/api/trash/${payload.id}/restore`, {});
      await refresh(); await openMeeting(payload.id);
      showMessage('Meeting restored.'); return;
    }
    await post(`/api/meetings/${payload.id}/${action === 'meeting-rename' ? 'rename' : 'trash'}`,
      action === 'meeting-rename' ? { title:payload.title } : {});
    if (action === 'meeting-trash' && selected === payload.id) {
      clearPlayback(); showView('home'); $('heading').textContent = 'All meetings';
    }
    await refresh();
    showMessage(action === 'meeting-trash' ? 'Meeting moved to Recently Deleted. You can restore it from the sidebar.' : 'Meeting renamed.');
  } finally {
    // Keep the editor locked through every await, including a restored
    // meeting's detail load. Its own loading state remains authoritative.
    meetingMutationInFlight = false; setMeetingLoading(meetingLoading);
  }
}
async function desktopCaptureAction(action, payload) {
  // Revalidate the explicitly chosen recording. A changed selection or a new
  // recording cannot redirect an in-flight native button to another session.
  const status = await api('/api/status'); desktopStatus = status;
  const active = status.active.find(m => m.id === payload.id);
  if (!active || !['recording','paused'].includes(active.status)) throw new Error('That recording is no longer available for this action.');
  if ((action === 'pause' && active.status !== 'recording') || (action === 'resume' && active.status !== 'paused')) throw new Error('Recording state changed. Check the current controls and try again.');
  if (action === 'mic' && !(active.capture?.micAuthorized ?? active.selection?.microphone)) throw new Error('Microphone recording was not enabled for this session.');
  await post(`/api/meetings/${payload.id}/${action}`, action === 'mic' ? { enabled:payload.enabled } : {});
  await refresh();
}
function dispatchDesktopAction(action, payload = {}) {
  const command = validatedDesktopCommand(action, payload);
  if (!command || !connected || composingText || document.body.inert || closeTask) return Promise.resolve(false);
  // Permission prompts and links must follow the current click, never a stale
  // duplicate queued while another dialog or native action is still in flight.
  if (action.startsWith('settings-') && (permissionTask || pendingDesktopCommands)) return Promise.resolve(false);
  pendingDesktopCommands++; publishDesktopState();
  const result = desktopCommandQueue.then(async () => {
    if (!connected || composingText || document.body.inert) return false;
    try {
      const { action, payload } = command;
      if (!action.startsWith('settings-')) closeSettings(false);
      if (action === 'library' || action === 'search') await openLibrary(false);
      else if (action === 'meeting') { await openMeeting(payload.id); return selected === payload.id && !meetingLoading; }
      else if (action === 'project' || action === 'new-project') { const id = action === 'project' ? payload.id : null; await openProject(id); return view === 'project' && projectViewId === id; }
      else if (action === 'new') await newMeeting();
      else if (['meeting-rename','meeting-trash','meeting-restore'].includes(action)) await desktopMeetingAction(action, payload);
      else if (action === 'settings-refresh') { await refreshSettings(); return !desktopSettingsError; }
      else if (action === 'settings-request-permission' || action === 'settings-open-permission') return await settingsPermissionAction(action, payload.permission);
      else if (action === 'save') { if (!notesMeetingId || meetingLoading || view !== 'meeting') return false; await flushNotes(); }
      else await desktopCaptureAction(action, payload);
      return true;
    } catch (error) { showMessage(error.message); return false; }
  }).finally(() => { pendingDesktopCommands--; publishDesktopState(); });
  desktopCommandQueue = result.then(() => undefined, () => undefined);
  return result;
}
function sizeNotes() {
  const editor = $('notes'); editor.style.height = 'auto';
  const style = getComputedStyle(editor);
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  editor.style.height = `${Math.max(parseFloat(style.minHeight) || 0, editor.scrollHeight + border)}px`;
}
// Polling keeps unchanged nodes intact. When content changes, restore the same
// logical item; if it was removed, focus its nearest neighbour or a stable control.
function updateList(id, signature, draw, fallbackId) {
  const root = $(id), serialized = JSON.stringify(signature), previous = renderedLists.get(root);
  if (previous?.signature === serialized && previous.text === root.textContent
      && previous.children.length === root.children.length && previous.children.every((node, index) => root.children[index] === node)) return;
  const active = document.activeElement, hadFocus = root.contains(active);
  const oldItems = [...root.querySelectorAll('[data-focus-key]')];
  const focusKey = active?.dataset?.focusKey, oldIndex = oldItems.indexOf(active);
  const scrollTop = root.scrollTop, scrollLeft = root.scrollLeft;
  draw(root);
  renderedLists.set(root, { signature:serialized, children:[...root.children], text:root.textContent });
  if (hadFocus && !root.contains(document.activeElement)) {
    const items = [...root.querySelectorAll('[data-focus-key]')].filter(node => !node.disabled);
    const target = [items.find(node => node.dataset.focusKey === focusKey), items[Math.min(Math.max(oldIndex, 0), items.length - 1)],
      fallbackId ? $(fallbackId) : null, $('heading'), $('all-meetings')].find(node => node && !node.disabled && !node.closest('[hidden]'));
    target?.focus({ preventScroll:true });
  }
  root.scrollTop = scrollTop; root.scrollLeft = scrollLeft;
}
function updateOptions(element, options, value = element.value) {
  updateList(element.id, options, root => root.replaceChildren(...options.map(([label, id]) => new Option(label, id))));
  element.value = options.some(([, id]) => String(id) === value) ? value : (options[0]?.[1] || '');
}
function markCurrent(element, active) {
  if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
}
function updateNavigationCurrent() {
  markCurrent($('all-meetings'), view === 'home');
  for (const button of $('meetings').children) { const active = view === 'meeting' && button.dataset.focusKey === selected; markCurrent(button, active); button.classList.toggle('selected', active); }
  for (const button of $('projects').children) { const active = view === 'project' && button.dataset.focusKey === projectViewId; markCurrent(button, active); button.classList.toggle('selected', button.dataset.focusKey === projectFilter); }
}
function focusHeading() { if (!$('settings-dialog').open) $('heading').focus({ preventScroll:true }); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type':'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { connected = false; $('auth').hidden = false; $('connection').textContent = 'Not connected'; }
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}
const post = (url, value = {}) => api(url, { method:'POST', body:JSON.stringify(value) });
const run = fn => async () => { try { await fn(); } catch (error) { showMessage(error.message); } };
function captureKind() { return $('capture-kind').value === 'display' ? 'display' : 'window'; }
function selectedCaptureTarget() { return { kind:captureKind(), id:Number($('window').value) }; }
function resetPreview() { previewRequestRevision++; previewID = null; $('confirmed').checked = false; $('confirmed').disabled = true; $('preview-image').removeAttribute('src'); $('preview-image').hidden = true; $('preview-placeholder').hidden = false; setStart(); }
function renderCaptureTargets() {
  const kind = captureKind(), display = kind === 'display';
  $('source-label').textContent = display ? 'Display' : 'Window';
  $('preview').textContent = display ? 'Preview display' : 'Preview window';
  $('preview-image').alt = `Recording preview of the selected ${kind}`;
  $('preview-placeholder').textContent = `The selected ${kind} will appear here`;
  $('confirmed-label').textContent = display ? 'Record this entire display, including other visible apps and notifications' : 'This is the window I want to record';
  $('capture-scope').textContent = display ? 'Records everything visible on this display, including other apps and notifications. Use this for presenting across windows. Protected content may still be unavailable.' : 'Records only the selected window. When presenting in Zoom, select the actual shared content window; the original Zoom window may stop providing video.';
  $('window').replaceChildren(new Option(`Choose a ${kind}`, ''));
  for (const source of display ? captureSources.displays : captureSources.windows) {
    const label = display ? `${source.name || 'Display'} · ${source.widthPixels} × ${source.heightPixels}` : `${source.app} · ${source.title || 'Untitled window'}`;
    $('window').append(new Option(label, source.id));
  }
  $('window').value = ''; resetPreview();
}
function captureVideoWarning(manifest) {
  if (manifest.capture?.videoWarning) return manifest.capture.videoWarning;
  const enabled = manifest.selection?.systemAudio || (manifest.selection?.microphone && manifest.capture?.micEnabled);
  return 'Video is unavailable from the selected source.' + (enabled ? ' Check the enabled audio sources separately.' : ' No audio source is recording.');
}
function setStart() {
  const kind = captureKind();
  const blocked = permissionTask ? 'Checking permissions. Respond to any macOS permission dialog.'
    : !permissionState ? 'Check recording permissions before starting.'
    : permissionState.screenRecording !== 'granted' ? 'Allow Screen & System Audio access before starting.'
    : !previewID ? ($('window').value ? `Preview the selected ${kind} before starting.` : `Choose a ${kind} and preview it before starting.`)
    : !$('confirmed').checked ? `Confirm that the preview shows the ${kind} you want to record.`
    : $('mic').checked && permissionState.microphone !== 'granted' ? 'Allow microphone access, or turn off Record microphone.'
    : $('mic').checked && !$('mic-device').value ? 'Choose a microphone in Audio, or turn off Record microphone.'
    : '';
  $('start').disabled = !!blocked;
  $('start-status').textContent = blocked || 'Ready to record.';
}
function renderPermissions() {
  const screenGranted = permissionState?.screenRecording === 'granted', micGranted = permissionState?.microphone === 'granted';
  const microphoneNames = { granted:'Allowed', 'not-determined':'Not requested', denied:'Denied · Allow in System Settings', restricted:'Restricted by system policy' };
  $('permission-screen').textContent = permissionState ? (screenGranted ? 'Allowed' : 'Allow access in macOS') : 'Not checked';
  $('permission-microphone').textContent = microphoneNames[permissionState?.microphone] || 'Not checked';
  $('permission-screen-request').hidden = screenGranted;
  $('permission-microphone-request').hidden = !$('mic').checked || micGranted;
  $('permission-screen-settings').hidden = !permissionState || screenGranted;
  $('permission-microphone-settings').hidden = !$('mic').checked || !permissionState || micGranted;
  for (const id of ['permissions-refresh','permission-screen-request','permission-microphone-request','permission-screen-settings','permission-microphone-settings']) $(id).disabled = !!permissionTask;
  $('permission-hint').textContent = permissionTask ? 'Checking permissions. Respond to any macOS permission dialog.'
    : permissionState && (!screenGranted || ($('mic').checked && !micGranted))
      ? 'Access is not yet allowed. Enable it in System Settings, then check again. Restart the local service if macOS asks. Accessibility permission is not required.'
      : 'Screen and system audio access is requested when choosing a recording source. Microphone access is requested when enabled. Accessibility permission is not required.';
  renderSettingsPermissions(); setStart(); publishDesktopState();
}
async function updatePermissions(request = {}, { explicitMicrophone = false } = {}) {
  // Keep system permission dialogs serialized; a later mic request is not lost
  // if the user enables it while the screen permission dialog is still open.
  if (permissionTask) {
    await permissionTask;
    return request.screen || request.microphone ? updatePermissions(request, { explicitMicrophone }) : permissionState;
  }
  const task = Promise.resolve().then(async () => {
    permissionState = await api('/api/permissions');
    const screen = !!request.screen && permissionState.screenRecording !== 'granted';
    const microphone = !!request.microphone && (explicitMicrophone || $('mic').checked) && permissionState.microphone !== 'granted';
    if (screen || microphone) permissionState = await post('/api/permissions/request', { screen, microphone });
    return permissionState;
  });
  permissionTask = task; renderPermissions();
  try { return await task; }
  catch (error) { permissionState = null; throw error; }
  finally { permissionTask = null; renderPermissions(); }
}
async function openPermissionSettings(permission) {
  if (!['screen','microphone'].includes(permission)) throw new Error('Choose a recording permission.');
  if (permissionTask) { await permissionTask; return openPermissionSettings(permission); }
  const task = Promise.resolve().then(async () => {
    await post('/api/permissions/settings', { permission });
    permissionState = await api('/api/permissions');
    return permissionState;
  });
  permissionTask = task; renderPermissions();
  try { return await task; }
  finally { permissionTask = null; renderPermissions(); }
}
async function settingsPermissionAction(action, permission) {
  if (permissionTask) return false;
  desktopSettingsError = null;
  try {
    if (action === 'settings-request-permission') await updatePermissions({ [permission]:true }, { explicitMicrophone:true });
    else await openPermissionSettings(permission);
    return true;
  } catch (error) {
    desktopSettingsError = `Could not ${action === 'settings-request-permission' ? 'request access' : 'open System Settings'}: ${error.message}`;
    throw error;
  } finally { renderSettingsPermissions(); publishDesktopState(); }
}
async function loadSources() {
  const revision = ++sourceListRevision;
  resetPreview();
  const state = await updatePermissions({ screen:true });
  if (state.screenRecording !== 'granted' || revision !== sourceListRevision) return;
  const data = await api('/api/sources');
  if (revision !== sourceListRevision) return;
  captureSources = { windows:data.windows || [], displays:data.displays || [] }; renderCaptureTargets();
  const previousMic = $('mic-device').value;
  $('mic-device').replaceChildren(new Option('Choose a microphone','')); for (const m of data.microphones) $('mic-device').append(new Option(m.name,m.id));
  if (data.microphones.some(m => m.id === previousMic)) $('mic-device').value = previousMic;
  else if (data.microphones.length === 1) $('mic-device').value = data.microphones[0].id;
  setStart();
}
function renderSettingsPermissions() {
  const labels = { granted:'Allowed', 'not-granted':'Not allowed', 'not-determined':'Not requested', denied:'Denied', restricted:'Restricted by system policy' };
  $('settings-permissions-refresh').disabled = !!permissionTask;
  for (const permission of ['screen','microphone']) {
    const status = permissionState?.[permission === 'screen' ? 'screenRecording' : 'microphone'];
    $(`settings-permission-${permission}`).textContent = labels[status] || 'Not checked';
    $(`settings-permission-${permission}-request`).disabled = !!permissionTask || ['granted','denied','restricted'].includes(status);
    $(`settings-permission-${permission}-settings`).disabled = !!permissionTask;
  }
  $('settings-permission-status').textContent = desktopSettingsError || (permissionTask ? 'Checking permissions. Respond to any macOS permission dialog.' : permissionState
    ? `Screen and system audio: ${labels[permissionState.screenRecording] || 'Unknown'}; Microphone: ${labels[permissionState.microphone] || 'Unknown'}. Accessibility permission is not required.`
    : 'Permissions have not been checked.');
}
async function refreshSettings() {
  desktopSettingsError = null;
  const results = await Promise.allSettled([
    api('/api/status').then(status => { desktopStatus = status; archiveRoot = status.archivePath; $('settings-archive-path').textContent = archiveRoot; }),
    updatePermissions()
  ]);
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
  desktopSettingsError = errors.length ? `Could not load settings: ${errors.join('; ')}. Please try again.` : null;
  if (desktopSettingsError) $('settings-permission-status').textContent = desktopSettingsError;
  publishDesktopState();
}
async function openSettings() {
  const dialog = $('settings-dialog');
  if (!dialog.open) { settingsReturnFocus = document.activeElement; dialog.showModal(); }
  $('settings-archive-path').textContent = archiveRoot || 'Loading save location…';
  renderSettingsPermissions();
  await refreshSettings();
}
function closeSettings(restoreFocus = true) { if ($('settings-dialog').open) { if (!restoreFocus) settingsReturnFocus = null; $('settings-dialog').close(); } }
function restoreSettingsFocus() {
  if (!settingsReturnFocus) return;
  const target = settingsReturnFocus?.isConnected && !settingsReturnFocus.disabled && !settingsReturnFocus.closest('[hidden]') ? settingsReturnFocus : $('settings-open');
  settingsReturnFocus = null; target.focus({ preventScroll:true });
}
async function openLibrary(focusSearch = false) {
  if (notesDirty && notesMeetingId) await flushNotes();
  clearPlayback(); projectFilter = null; showView('home'); $('heading').textContent = 'All meetings'; renderLibrary();
  if (!nativeShell) {
    if (focusSearch) { $('meeting-search').focus(); $('meeting-search').select(); } else focusHeading();
  }
  await refresh();
}
async function newMeeting() {
  if (notesDirty) await flushNotes();
  clearPlayback(); const revision = meetingLoadRevision;
  showView('setup'); resetPreview(); $('title').value = ''; $('setup-project').value = projectFilter || ''; $('heading').textContent = 'New meeting'; $('title').focus();
  await refresh();
  if (view === 'setup' && revision === meetingLoadRevision) await loadSources();
}
async function performDesktopAction(action) {
  if (composingText || !['new','search','save','settings'].includes(action)) return false;
  if (nativeShell && ['search','settings'].includes(action)) return sendNativeCommand(action);
  if (nativeShell) return dispatchDesktopAction(action);
  try {
    if (action === 'settings') { await openSettings(); return true; }
    if ($('settings-dialog').open) closeSettings(false);
    if (action === 'new') await newMeeting();
    else if (action === 'search') await openLibrary(true);
    else if (view === 'meeting' && notesMeetingId && !meetingLoading) await flushNotes();
    else { showMessage('Open a meeting to save its notes.'); return false; }
    return true;
  } catch (error) { showMessage(error.message); return false; }
}
function prepareToClose() {
  if (composingText) { showMessage('Finish the current text input before closing the window.'); return Promise.resolve(false); }
  if (closeTask) return closeTask;
  closeTask = Promise.resolve().then(async () => {
    try {
      await desktopCommandQueue;
      if (composingText) { showMessage('Finish the current text input before closing the window.'); return false; }
      await flushNotes();
      if (composingText) { showMessage('Finish the current text input before closing the window.'); return false; }
      return !notesDirty;
    }
    catch (error) { showMessage(`The window is still open because notes could not be saved: ${error.message}`); return false; }
  }).finally(() => { closeTask = null; publishDesktopState(); });
  publishDesktopState();
  return closeTask;
}
async function authenticate(token) { await post('/api/session', { token }); $('auth').hidden = true; connected = true; $('connection').textContent = 'Connected locally'; showMessage(''); await refresh(); }
async function refresh() {
  const refreshRevision = ++catalogRefreshRevision;
  const [status, meetings, projects, trashed] = await Promise.all([api('/api/status'), api('/api/meetings'), api('/api/projects'), nativeShell ? api('/api/trash') : []]);
  if (refreshRevision !== catalogRefreshRevision) return;
  window.meetingAnalysis?.setAvailable(status.processingAvailable === true);
  desktopStatus = status; localProjects = projects; meetingCatalog = meetings; deletedMeetings = trashed; renderProjectNavigation();
  connected = true; $('auth').hidden = true; $('connection').textContent = status.active.length ? 'Recorder running' : 'Connected locally';
  $('connection').classList.toggle('recording', status.active.length > 0);
  $('storage').textContent = `${(status.freeBytes / 1e9).toFixed(1)} GB free`;
  $('storage').title = status.archivePath; archiveRoot = status.archivePath; $('settings-archive-path').textContent = archiveRoot;
  if (!status.nativeBuilt) showMessage(nativeShell ? 'The recorder helper is missing. Reinstall MinuteShelf.' : 'The recorder helper is not built. Run npm run build:native in the project folder.');
  const visibleMeetings = meetings.filter(m => !projectFilter || m.projectId === projectFilter);
  updateList('meetings', visibleMeetings.map(m => [m.id, m.title, m.createdAt, m.status]), root => {
    root.replaceChildren();
    for (const m of visibleMeetings) {
      const button = document.createElement('button'); button.dataset.focusKey = m.id;
      const title = document.createElement('strong'); title.textContent = m.title;
      const info = document.createElement('small'); info.textContent = `${new Date(m.createdAt).toLocaleDateString('en-US')} · ${stateNames[m.status] || m.status}`;
      button.append(title, info); button.onclick = run(() => openMeeting(m.id)); root.append(button);
    }
  }, 'all-meetings');
  updateNavigationCurrent();
  if (!selected && view === 'home') renderLibrary();
  if (!selected && firstRefresh && status.active.length) await openMeeting(status.active[0].id);
  else if (selected && !meetingLoading) { const id = selected, revision = meetingLoadRevision; const value = await api(`/api/meetings/${id}`); if (refreshRevision === catalogRefreshRevision && id === selected && revision === meetingLoadRevision && !meetingLoading) renderMeeting(value, false); }
  else if (view === 'project' && projectViewId) {
    const id = projectViewId, value = await api(`/api/projects/${id}`);
    if (refreshRevision === catalogRefreshRevision && view === 'project' && id === projectViewId) renderProjectTimeline(value);
  }
  if (refreshRevision !== catalogRefreshRevision) return;
  firstRefresh = false; publishDesktopState();
}
function showView(name) {
  view = name;
  for (const [id, target] of [['home','home'], ['setup','setup'], ['review','meeting'], ['project-view','project']]) { const hidden = name !== target; if ($(id).hidden !== hidden) $(id).hidden = hidden; }
  updateNavigationCurrent();
  $('all-meetings').classList.toggle('selected', name === 'home');
  $('page-kicker').textContent = name === 'project' ? 'Project space' : name === 'meeting' ? 'Meeting notes' : name === 'setup' ? 'Start a discussion' : 'Your meeting space';
  publishDesktopState();
}
function selectMeetingTab(name, focus = false) {
  const leavingFocusedPanel = name !== meetingTab && $(`panel-${meetingTab}`).contains(document.activeElement);
  if (name !== 'playback') { pauseRawPlayback(); $('standalone-audio').pause(); $('merged-video').pause(); }
  meetingTab = name;
  for (const key of ['notes','playback','artifacts','context']) {
    $(`panel-${key}`).hidden = key !== name;
    $(`tab-${key}`).setAttribute('aria-selected', String(key === name));
    $(`tab-${key}`).tabIndex = key === name ? 0 : -1;
  }
  if (focus || leavingFocusedPanel) $(`tab-${name}`).focus();
  if (name === 'notes') sizeNotes();
}
function renderLibrary() {
  const query = $('meeting-search').value.trim().toLocaleLowerCase();
  const matches = meetingCatalog.filter(m => `${m.title}\n${m.notesPreview || ''}`.toLocaleLowerCase().includes(query));
  $('library-count').textContent = query ? `${countLabel(matches.length, 'meeting')} found` : `${countLabel(meetingCatalog.length, 'meeting')} · Notes, recordings, and materials together`;
  $('library-empty').hidden = meetingCatalog.length > 0;
  updateList('library-list', [query, meetingCatalog.length, matches.map(m => [m.id, m.title, m.createdAt, m.status, m.durationSeconds, m.notesPreview, m.archiveError, localProjects.find(p => p.id === m.projectId)?.name])], root => {
    root.replaceChildren();
    for (const m of matches) {
      const button = document.createElement('button'); button.className = 'library-meeting'; button.dataset.focusKey = m.id;
      const glyph = document.createElement('span'); glyph.className = 'meeting-glyph'; glyph.textContent = '▤'; glyph.setAttribute('aria-hidden','true');
      const copy = document.createElement('div'); copy.className = 'library-copy';
      const title = document.createElement('strong'); title.textContent = m.title;
      const info = document.createElement('small'), project = localProjects.find(p => p.id === m.projectId);
      info.textContent = `${new Date(m.createdAt).toLocaleDateString('en-US')} · ${seconds(m.durationSeconds)}${project ? ` · ${project.name}` : ''} · ${stateNames[m.status] || m.status}`;
      const note = document.createElement('p'); note.textContent = m.archiveError?.message || m.notesPreview || 'Open this meeting to add notes or organize materials';
      const arrow = document.createElement('span'); arrow.className = 'library-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden','true');
      copy.append(title, info, note); button.append(glyph, copy, arrow); button.onclick = run(() => openMeeting(m.id)); root.append(button);
    }
    if (!matches.length && meetingCatalog.length) { const row = document.createElement('p'); row.className = 'hint'; row.textContent = 'No matching meetings.'; root.append(row); }
  }, 'meeting-search');
}
function setMeetingLoading(loading) {
  meetingLoading = loading;
  $('notes').disabled = loading || meetingMutationInFlight || !notesMeetingId;
  $('save-notes').disabled = loading || meetingMutationInFlight || !notesMeetingId;
  publishDesktopState();
}
async function openMeeting(id) {
  const unavailable = meetingCatalog.find(m => m.id === id && m.status === 'unavailable');
  if (unavailable) { meetingLoadRevision++; setMeetingLoading(false); showMessage(`This meeting archive is unavailable: ${unavailable.archiveError?.message || 'Check the original archive files'}`); return; }
  const revision = ++meetingLoadRevision;
  setMeetingLoading(true);
  try {
    if (notesDirty && notesMeetingId) await flushNotes();
    if (revision !== meetingLoadRevision) return;
    const value = await api(`/api/meetings/${id}`);
    if (revision !== meetingLoadRevision) return;
    // Commit the selected meeting and its editor together, only after a successful load.
    selected = id; sourceClip = null; $('video').pause(); $('video').removeAttribute('src'); $('standalone-audio').pause(); $('standalone-audio').removeAttribute('src'); $('standalone-audio').dataset.clip = '';
    $('merged-video').pause(); $('merged-video').removeAttribute('src'); $('merged-preview').hidden = true;
    pauseAudio(); showView('meeting'); selectMeetingTab('notes'); rkaState = null; $('rka-records').replaceChildren(); $('rka-state').textContent = 'Loading context settings…';
    $('rka-save').disabled = true; $('rka-refresh').disabled = true;
    artifactState = null; exportSignature = ''; $('archive-path').textContent = 'Loading meeting folder…';
    $('document-list').replaceChildren(); $('artifact-list').replaceChildren(); $('export-files').replaceChildren(); $('document-state').textContent = 'Up to 100 MB per file';
    $('document-files').value = '';
    renderMeeting(value, true); setMeetingLoading(false); focusHeading();
    window.meetingAnalysis?.open(id);
    const results = await Promise.allSettled([
      api(`/api/meetings/${id}/rka-context`).then(context => { if (revision === meetingLoadRevision) renderRka(context); }),
      loadArtifacts(id, revision)
    ]);
    for (const result of results) if (result.status === 'rejected' && revision === meetingLoadRevision) showMessage(result.reason.message);
  } catch (error) {
    if (revision === meetingLoadRevision) throw error;
  } finally {
    if (revision === meetingLoadRevision) setMeetingLoading(false);
  }
}
function origin() { return current?.manifest.timeline?.originPTS?.seconds || 0; }
function allClips() { return [...(current?.manifest.segments || []), ...(current?.manifest.recovered || [])]; }
function videoClips() { return allClips().filter(s => s.kind === 'video').sort((a,b) => a.startPTS.seconds - b.startPTS.seconds); }
const playbackNow = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
function sessionDuration() { return Math.max(0, Number(current?.manifest.durationSeconds) || 0); }
function sessionPosition() { return rawPlaying ? Math.min(sessionDuration(), rawStartedPosition + (playbackNow() - rawStartedAt) / 1000) : rawPosition; }
function currentTimelineGesture(gesture = timelineGesture) { return gesture && gesture.id === selected && gesture.revision === meetingLoadRevision; }
function renderSessionPosition(position = sessionPosition()) {
  // A timer or metadata refresh must not move the native range thumb between
  // the user's input and change events. Playback continues until the seek is
  // committed, so canceling a drag does not pause or rewind the meeting.
  const previewing = currentTimelineGesture() && !timelineGesture.canceled;
  const displayed = previewing ? timelineGesture.position : position;
  if (!previewing) $('timeline').value = position;
  $('position').textContent = seconds(displayed);
  $('playback-duration').textContent = seconds(sessionDuration());
  $('timeline').setAttribute('aria-valuetext', `${seconds(displayed)} of ${seconds(sessionDuration())}`);
  $('play-session').textContent = rawPlaying ? 'Pause' : position >= sessionDuration() && sessionDuration() > 0 ? 'Replay' : 'Play';
  $('play-session').setAttribute('aria-label', rawPlaying ? 'Pause meeting playback' : 'Play meeting recording');
  $('play-session').disabled = !sessionDuration();
}
function beginTimelineGesture() {
  if (!current || !sessionDuration()) return;
  timelineGesture = { id:selected, revision:meetingLoadRevision, position:Number($('timeline').value) || 0, hasInput:false, canceled:false };
  lastTimelineCommit = null;
}
function previewTimelineGesture() {
  // A pointer that began on another meeting must not seek the new selection.
  if (timelineGesture && !currentTimelineGesture()) return;
  if (!timelineGesture || timelineGesture.canceled) beginTimelineGesture();
  if (!timelineGesture) return;
  timelineGesture.position = Math.max(0, Math.min(Number($('timeline').value) || 0, sessionDuration()));
  timelineGesture.hasInput = true; renderSessionPosition();
}
function cancelTimelineGesture() {
  if (timelineGesture) timelineGesture.canceled = true;
  renderSessionPosition();
}
async function commitTimelineGesture(source = 'change') {
  const gesture = timelineGesture;
  if (gesture && (!currentTimelineGesture(gesture) || gesture.canceled)) {
    if (source === 'change') timelineGesture = null;
    renderSessionPosition(); return;
  }
  if (source !== 'change' && (!gesture || !gesture.hasInput)) { cancelTimelineGesture(); return; }
  const position = gesture?.hasInput ? gesture.position : Number($('timeline').value);
  // WebKit may dispatch change before or after pointerup/keyup. Commit once;
  // a direct accessibility change without input remains supported.
  if (!gesture && lastTimelineCommit?.id === selected && lastTimelineCommit.revision === meetingLoadRevision
      && lastTimelineCommit.position === position) { lastTimelineCommit = null; return; }
  timelineGesture = null;
  lastTimelineCommit = { id:selected, revision:meetingLoadRevision, position };
  await seek(position, rawPlaying);
}
function pauseRawPlayback() {
  playbackRevision++;
  rawPosition = sessionPosition(); rawPlaying = false;
  $('video').pause(); pauseAudio(); renderSessionPosition();
}
function renderMeeting(value, initial) {
  current = value; const m = value.manifest;
  showView('meeting'); $('heading').textContent = m.title;
  const active = ['recording','paused'].includes(m.status), live = active || m.status === 'finalizing';
  $('export-media').disabled = live || m.status === 'starting' || artifactState?.exports.some(e => ['processing','queued'].includes(e.status));
  $('state').textContent = stateNames[m.status] || m.status;
  const project = localProjects.find(p => p.id === value.projectId);
  $('meeting-date').textContent = new Date(m.createdAt).toLocaleString('en-US', {month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});
  $('meeting-duration').textContent = seconds(m.durationSeconds);
  $('project-quick').textContent = project?.name || '＋ Add to project';
  document.querySelector('.capture-bar').classList.toggle('live', live);
  const unavailable = m.capture?.videoAvailable === false && m.status === 'recording';
  $('capture-warning').hidden = !unavailable && !(m.interruptedTail?.length || m.gaps?.some(e => ['gap','error'].includes(e.event) || (e.event === 'frame-state' && e.usable === false)));
  $('capture-warning').textContent = unavailable ? captureVideoWarning(m) : 'Recording gaps detected. See playback for details.';
  const sourceLabel = m.selection.display ? `Entire display · ${m.selection.display.name || 'Display'}` : `${m.selection.window?.app || 'Window'} · ${m.selection.window?.title || 'Untitled window'}`;
  $('target').textContent = `${sourceLabel} · ${m.preset.fps} fps · ${m.audioScope === 'all-system' ? 'All system audio' : 'System audio off'}`;
  $('stop').hidden = !active; $('pause').hidden = !active; $('pause').textContent = m.status === 'paused' ? 'Resume' : 'Pause';
  $('mic-toggle').hidden = !active || !m.capture?.micAuthorized; $('mic-toggle').textContent = m.capture?.micEnabled ? 'Stop recording microphone' : 'Record microphone';
  $('recover').hidden = live || !m.interruptedTail?.length;
  $('bookmark').disabled = !active;
  $('clock').textContent = `Duration ${seconds(m.durationSeconds)}`;
  $('size').textContent = `${(m.bytes / 1e9).toFixed(3)} GB${m.durationSeconds > 60 ? ` · ${(m.bytes / 1e9 * 3600 / m.durationSeconds).toFixed(2)} GB/hour` : ''}`;
  $('level-mic').textContent = active ? `Microphone ${m.capture?.micEnabled ? (m.capture.levels?.microphone || 0).toFixed(2) : 'Off'}` : `Microphone · ${countLabel(m.segments.filter(s=>s.kind==='microphone').length, 'segment')}`;
  $('level-system').textContent = active ? `System audio ${m.selection.systemAudio ? (m.capture?.levels?.system || 0).toFixed(2) : 'Off'}` : `System audio · ${countLabel(m.segments.filter(s=>s.kind==='system').length, 'segment')}`;
  const last = m.capture?.lastWrittenPTS?.video?.seconds;
  const elapsed = m.capture?.clockPTS?.seconds - last;
  $('write-health').textContent = m.status === 'paused' ? 'Recording paused' : unavailable ? 'No current video from the selected source' : (active && Number.isFinite(elapsed) ? `Last video write ${elapsed.toFixed(1)} seconds ago` : `${countLabel(m.segments.length, 'media segment')} saved`);
  $('timeline').max = Math.max(1, m.durationSeconds || 1);
  $('manifest').href = `/api/meetings/${selected}/manifest`;
  if (initial) { rawPlaying = false; rawPosition = 0; playbackGroup = 'raw'; videoLoadError = null; videoLoadRevision++; sourceClip = null; $('video').pause(); pauseAudio(); notesMeetingId = m.id; $('notes').value = value.notes; sizeNotes(); notesDirty = false; notesRevision++; $('notes-state').textContent = value.notes ? 'Saved' : ''; $('meeting-project').value = value.projectId || ''; }
  $('open-project').hidden = !value.projectId;
  updateList('gaps', [m.id, m.gaps, m.interruptedTail, origin()], root => {
  root.replaceChildren();
  for (const e of m.gaps || []) {
    const row = document.createElement('div'); row.className = 'event';
    const labels = { mic:'Microphone recording changed', pause:'Recording paused', resume:'Recording resumed', error:'Recording error', gap:'Media gap', 'gap-end':'Video restored', warning:'Warning', 'frame-state':'Video unavailable' };
    row.textContent = `${Number.isFinite(e.pts?.seconds) && e.pts.seconds >= origin() ? seconds(e.pts.seconds - origin()) : 'Time unknown'} · ${labels[e.event] || e.event} ${e.enabled === undefined ? '' : (e.enabled ? 'On' : 'Off')} ${e.reason || e.detail || ''}`;
    root.append(row);
  }
  for (const file of m.interruptedTail || []) { const row = document.createElement('div'); row.className='event'; row.textContent=`Uncommitted tail: ${file}. Recovery preserves the originals.`; root.append(row); }
  if (!m.gaps.length && !m.interruptedTail.length) root.textContent = 'No issues logged so far. Long-session reliability still requires validation.';
  });
  updateList('bookmarks', [m.id, m.bookmarks, origin()], root => {
    root.replaceChildren();
    for (const [index, b] of (m.bookmarks || []).entries()) { const button = document.createElement('button'); button.className = 'bookmark'; button.dataset.focusKey = b.id || `${b.pts.seconds}/${index}`; button.textContent = `${seconds(b.pts.seconds - origin())}  ${b.text || 'Bookmark'}`; button.onclick = run(() => { selectMeetingTab('playback'); return seek(b.pts.seconds - origin(), false); }); root.append(button); }
  }, 'bookmark-text');
  const clips = videoClips(); $('video-empty').hidden = clips.length > 0;
  updateList('segments', [m.id, clips.map(c => [c.file, c.startPTS, c.endPTS]), origin()], root => {
    root.replaceChildren();
    for (const clip of clips) { const button = document.createElement('button'); button.className = 'segment'; button.dataset.focusKey = clip.file; button.textContent = `${seconds(clip.startPTS.seconds - origin())}–${seconds(clip.endPTS.seconds - origin())}`; button.onclick = run(() => seek(clip.startPTS.seconds - origin(), false)); root.append(button); }
  }, 'timeline');
  renderSessionPosition(playbackGroup === 'raw' ? sessionPosition() : Number($('timeline').value));
  if (playbackGroup === 'raw') updateSessionVideo();
  renderAudioPicker();
}
function renderAudioPicker() {
  if (!current) return;
  const source = $('audio-source').value, previous = $('audio-clip').value;
  const clips = [...current.manifest.segments, ...(current.manifest.recovered || [])].filter(s=>s.kind===source).sort((a,b)=>a.startPTS.seconds-b.startPTS.seconds);
  updateOptions($('audio-clip'), [['Choose an audio segment',''], ...clips.map(c => [`${seconds(c.startPTS.seconds-origin())}–${seconds(c.endPTS.seconds-origin())}${c.recovered?' · Recovered':''}`, c.file])], previous);
}
function pauseAudio() { $('audio-system').pause(); $('audio-microphone').pause(); }
function activatePlayback(group) {
  if (group !== 'raw') pauseRawPlayback();
  playbackGroup = group;
  for (const [name, id] of [['raw','video'], ['merged','merged-video'], ['standalone','standalone-audio']]) {
    if (name !== group) $(id).pause();
  }
  if (group !== 'raw') pauseAudio();
}
function loadVideo(clip) {
  sourceClip = clip; const video = $('video'); switching = true;
  const revision = ++videoLoadRevision, id = selected;
  video.src = `/api/meetings/${selected}/media/${clip.file}`;
  video.onloadedmetadata = () => {
    if (revision !== videoLoadRevision || id !== selected || sourceClip !== clip) return;
    const target = origin() + sessionPosition() - clip.startPTS.seconds;
    if (target < 0 || target >= clip.endPTS.seconds - clip.startPTS.seconds) { switching = false; updateSessionVideo(); return; }
    video.currentTime = Math.min(Math.max(0, target), Number.isFinite(video.duration) ? Math.max(0, video.duration - .01) : Math.max(0, target));
    switching = false;
    if (rawPlaying && playbackGroup === 'raw') playRawVideo();
  };
  video.onerror = () => { if (revision === videoLoadRevision && id === selected) { switching = false; pauseRawPlayback(); videoLoadError = clip.file; sourceClip = null; updateSessionVideo(); } };
  video.load();
}
function playRawVideo() {
  const id = selected, revision = videoLoadRevision, epoch = playbackRevision;
  $('video').play().catch(error => {
    if (id === selected && revision === videoLoadRevision && epoch === playbackRevision && playbackGroup === 'raw' && rawPlaying) { pauseRawPlayback(); showMessage(error.message); }
  });
}
// The meeting clock, rather than a two-second video file, owns playback time.
// A missing picture leaves audio on its original PTS timeline.
function updateSessionVideo() {
  if (!current || playbackGroup !== 'raw') return;
  const global = origin() + sessionPosition();
  const clip = videoClips().find(value => value.startPTS.seconds <= global && value.endPTS.seconds > global);
  const video = $('video'), placeholder = $('video-gap');
  if (clip?.file === videoLoadError) { video.hidden = true; placeholder.hidden = false; placeholder.textContent = 'The original video could not be loaded. Press Play to retry.'; return; }
  video.hidden = !clip; placeholder.hidden = !!clip;
  if (!clip) {
    if (sourceClip || switching) { videoLoadRevision++; sourceClip = null; switching = false; video.pause(); }
    const next = videoClips().find(value => value.startPTS.seconds > global);
    const audioHint = allClips().some(value => ['microphone','system'].includes(value.kind)) ? ' Available audio continues during playback.' : ' No audio was saved for this recording.';
    placeholder.textContent = (next ? `Video unavailable at this time. The next saved picture starts at ${seconds(next.startPTS.seconds - origin())}.` : 'Video unavailable at this time.') + audioHint;
    return;
  }
  if (sourceClip?.file !== clip.file) loadVideo(clip);
  else if (!switching) {
    const offset = global - clip.startPTS.seconds;
    if (Math.abs(video.currentTime - offset) > .25) video.currentTime = Math.min(offset, Number.isFinite(video.duration) ? Math.max(0, video.duration - .01) : offset);
    if (rawPlaying && video.paused && !video.ended) playRawVideo();
  }
}
async function updateSessionPlayback() {
  if (!current || playbackGroup !== 'raw') return;
  const position = sessionPosition();
  if (rawPlaying && position >= sessionDuration()) pauseRawPlayback();
  renderSessionPosition(position); updateSessionVideo(); await syncAudio();
}
async function seek(relative, play) {
  sourceJumpRevision++;
  pauseRawPlayback();
  activatePlayback('raw');
  videoLoadError = null;
  rawPosition = Math.max(0, Math.min(Number(relative) || 0, sessionDuration()));
  if (play && rawPosition < sessionDuration()) { rawPlaying = true; rawStartedAt = playbackNow(); rawStartedPosition = rawPosition; }
  // Explicit seeks reposition even within the same fragment.
  if (sourceClip && sourceClip.startPTS.seconds <= origin() + rawPosition && sourceClip.endPTS.seconds > origin() + rawPosition) $('video').currentTime = Math.max(0, origin() + rawPosition - sourceClip.startPTS.seconds);
  await updateSessionPlayback();
}
// Evidence timestamps belong to the session clock. Audio WAV offsets do not:
// pauses and capture gaps can occur inside one file. Resolve through its PTS
// index before seeking, and never substitute system audio for a mic reference.
async function jumpToSource(evidence) {
  if (!current || !selected || !Number.isFinite(evidence?.startMs) || evidence.startMs < 0) throw new Error('This evidence has no valid recording time.');
  const id = selected, meetingRevision = meetingLoadRevision, jumpRevision = ++sourceJumpRevision;
  const isCurrent = () => selected === id && meetingLoadRevision === meetingRevision && sourceJumpRevision === jumpRevision;
  const originalTime = origin() + evidence.startMs / 1000;
  const source = ['system', 'microphone'].includes(evidence.source) ? evidence.source : null;
  selectMeetingTab('playback'); activatePlayback('none'); pauseAudio();
  if (source) { $('listen-system').checked = source === 'system'; $('listen-mic').checked = source === 'microphone'; }
  let time = Math.max(origin(), originalTime - 2), audioClip, audioOffset;
  if (source) {
    audioClip = [...current.manifest.segments, ...(current.manifest.recovered || [])].find(clip => clip.kind === source && clip.startPTS?.seconds <= originalTime && clip.endPTS?.seconds > originalTime);
    if (!audioClip || !Number.isFinite(audioClip.sampleRate) || audioClip.sampleRate <= 0) throw new Error(`No saved ${source === 'microphone' ? 'microphone' : 'system'} audio covers this evidence time. Other sources were not substituted.`);
    const key = `${id}/${audioClip.file}`;
    if (!audioIndexes.has(key)) {
      const request = api(`/api/meetings/${id}/index/${audioClip.file}`).catch(error => { if (audioIndexes.get(key) === request) audioIndexes.delete(key); throw error; });
      audioIndexes.set(key, request);
      if (audioIndexes.size > 64) audioIndexes.delete(audioIndexes.keys().next().value);
    }
    let records;
    try { records = await audioIndexes.get(key); }
    catch (error) { if (isCurrent()) throw error; return; }
    if (!isCurrent()) return;
    if (!Array.isArray(records)) throw new Error('The original audio timeline is unavailable.');
    const mapped = records.filter(record => Number.isFinite(record.pts?.seconds) && Number.isSafeInteger(record.frameOffset) && record.frameOffset >= 0 && Number.isSafeInteger(record.frames) && record.frames > 0)
      .map(record => ({ ...record, end: record.pts.seconds + record.frames / audioClip.sampleRate })).sort((a, b) => a.pts.seconds - b.pts.seconds);
    const index = mapped.findIndex(record => record.pts.seconds <= originalTime && record.end > originalTime);
    if (index < 0) throw new Error('This evidence falls in an audio gap. No sample offset was invented.');
    // A lead-in may cross ordinary sample buffers, but never a time/sample gap.
    let first = index;
    while (first > 0 && mapped[first].pts.seconds > time && Math.abs(mapped[first - 1].end - mapped[first].pts.seconds) <= 0.002
      && mapped[first - 1].frameOffset + mapped[first - 1].frames === mapped[first].frameOffset) first--;
    time = Math.max(time, mapped[first].pts.seconds);
    const record = mapped.slice(first, index + 1).find(value => value.pts.seconds <= time && value.end > time) || mapped[index];
    time = Math.max(time, record.pts.seconds);
    audioOffset = record.frameOffset / audioClip.sampleRate + time - record.pts.seconds;
  }
  if (!isCurrent()) return;
  const video = videoClips().find(clip => clip.startPTS.seconds <= originalTime && clip.endPTS.seconds > originalTime);
  if (video) { await seek(Math.max(time, video.startPTS.seconds) - origin(), false); return; }
  if (!audioClip) {
    $('standalone-audio').closest('details')?.setAttribute('open', '');
    throw new Error('No saved video covers this imported transcript time. Choose an original source under Audio-only playback; the transcript does not identify one.');
  }
  const player = $('standalone-audio');
  activatePlayback('standalone');
  $('audio-source').value = source; renderAudioPicker(); $('audio-clip').value = audioClip.file;
  player.closest('details')?.setAttribute('open', ''); player.hidden = false; player.dataset.clip = audioClip.file;
  player.onloadedmetadata = () => {
    if (!isCurrent() || player.dataset.clip !== audioClip.file) return;
    if (Number.isFinite(player.duration) && audioOffset >= player.duration) { showMessage('The audio file is shorter than its saved index. Check the original recording.'); return; }
    player.currentTime = audioOffset; player.pause();
  };
  player.onerror = () => { if (isCurrent()) showMessage('The original audio could not be loaded. Retry the evidence link.'); };
  player.src = `/api/meetings/${id}/media/${audioClip.file}`; player.load();
  rawPosition = time - origin(); renderSessionPosition();
  showMessage(`Positioned ${source === 'microphone' ? 'microphone' : 'system'} audio at ${seconds(time - origin())}. Press Play under Audio-only playback.`);
}
async function syncAudio() {
  if (!current || playbackGroup !== 'raw') return;
  const syncRevision = ++audioSyncRevision, playbackAtStart = playbackRevision;
  const playing = rawPlaying;
  const relative = sessionPosition();
  const global = origin() + relative;
  renderSessionPosition(relative);
  const selectedAtStart = selected, revision = meetingLoadRevision, jumpRevision = sourceJumpRevision;
  for (const source of ['system', 'microphone']) {
    const element = $(`audio-${source}`), enabled = $(source === 'system' ? 'listen-system' : 'listen-mic').checked;
    if (!enabled || !playing) { element.pause(); continue; }
    const clip = [...current.manifest.segments, ...(current.manifest.recovered || [])].find(c => c.kind === source && c.startPTS?.seconds <= global && c.endPTS?.seconds > global);
    if (!clip) { element.pause(); continue; }
    // Map clock PTS to sample offsets, including gaps within an audio segment.
    const key = `${selected}/${clip.file}`;
    if (!audioIndexes.has(key)) {
      const request = api(`/api/meetings/${selected}/index/${clip.file}`).catch(error => {
        if (audioIndexes.get(key) === request) audioIndexes.delete(key);
        throw error;
      });
      audioIndexes.set(key, request);
      if (audioIndexes.size > 64) audioIndexes.delete(audioIndexes.keys().next().value);
    }
    let records;
    try { records = await audioIndexes.get(key); }
    catch (error) {
      if (selectedAtStart === selected && revision === meetingLoadRevision && jumpRevision === sourceJumpRevision && playbackGroup === 'raw' && playbackAtStart === playbackRevision && syncRevision === audioSyncRevision) {
        pauseRawPlayback();
        audioIndexError = { key, message:`Could not load the audio index: ${error.message}. Press Play to retry.` };
        showMessage(audioIndexError.message);
      }
      return;
    }
    if (selectedAtStart !== selected || revision !== meetingLoadRevision || jumpRevision !== sourceJumpRevision || playbackGroup !== 'raw' || playbackAtStart !== playbackRevision || syncRevision !== audioSyncRevision || !rawPlaying) continue;
    if (audioIndexError?.key === key) {
      if ($('message').textContent === audioIndexError.message) showMessage('');
      audioIndexError = null;
    }
    const record = records.find(r => r.pts.seconds <= global && r.pts.seconds + r.frames / clip.sampleRate > global);
    if (!record) { element.pause(); continue; }
    const offset = record.frameOffset / clip.sampleRate + global - record.pts.seconds;
    const playSource = () => {
      const isCurrent = () => selectedAtStart === selected && revision === meetingLoadRevision && jumpRevision === sourceJumpRevision
        && playbackGroup === 'raw' && playbackAtStart === playbackRevision && element.dataset.clip === key
        && rawPlaying && $(source === 'system' ? 'listen-system' : 'listen-mic').checked;
      element.play().then(() => {
        if (isCurrent() && audioPlaybackError?.key === key) {
          if ($('message').textContent === audioPlaybackError.message) showMessage('');
          audioPlaybackError = null;
        }
      }).catch(error => {
        if (!isCurrent()) return;
        pauseRawPlayback();
        audioPlaybackError = { key, message:`${source === 'system' ? 'System audio' : 'Microphone audio'} could not start: ${error.message || 'Playback was blocked'}. Press Play to retry, or turn off this audio source.` };
        showMessage(audioPlaybackError.message);
      });
    };
    if (element.dataset.clip !== key) {
      element.dataset.clip = key; element.src = `/api/meetings/${selected}/media/${clip.file}`;
      element.onloadedmetadata = () => {
        if (selectedAtStart !== selected || revision !== meetingLoadRevision || jumpRevision !== sourceJumpRevision || playbackGroup !== 'raw' || playbackAtStart !== playbackRevision || element.dataset.clip !== key) return;
        const now = rawPlaying ? origin() + sessionPosition() : global;
        const latest = records.find(value => value.pts.seconds <= now && value.pts.seconds + value.frames / clip.sampleRate > now);
        if (!latest) { element.pause(); return; }
        element.currentTime = latest.frameOffset / clip.sampleRate + now - latest.pts.seconds;
        if (rawPlaying && $(source === 'system' ? 'listen-system' : 'listen-mic').checked) playSource();
      };
      element.load();
    } else {
      if (Math.abs(element.currentTime - offset) > .12) element.currentTime = offset;
      if (element.paused) playSource();
    }
  }
}
async function saveNotes() {
  if (!notesMeetingId || !notesDirty) return;
  if (notesSaving) { await notesSaving; return notesDirty ? saveNotes() : undefined; }
  const id = notesMeetingId, revision = notesRevision, text = $('notes').value;
  clearTimeout(notesTimer); $('notes-state').textContent = 'Saving…';
  notesSaving = api(`/api/meetings/${id}/notes`, { method:'PUT', body:JSON.stringify({ notes:text }) });
  try { await notesSaving; if (id === notesMeetingId && revision === notesRevision) { notesDirty = false; $('notes-state').textContent = 'Saved'; } }
  catch (error) { if (id === notesMeetingId) $('notes-state').textContent = 'Save failed. Please try again.'; throw error; }
  finally { notesSaving = null; publishDesktopState(); }
}
async function flushNotes() { clearTimeout(notesTimer); while (notesDirty && notesMeetingId) await saveNotes(); }
const artifactURL = (id, relative, inline = false) => `/api/meetings/${id}/artifact?path=${encodeURIComponent(relative)}${inline ? '&inline=1' : ''}`;
function artifactLink(id, relative, name) {
  const link = document.createElement('a'); link.className = 'artifact-link'; link.dataset.focusKey = `${id}/${relative}`; link.href = artifactURL(id, relative); link.textContent = name || relative; return link;
}
async function loadArtifacts(id = selected, revision = meetingLoadRevision) {
  const data = await api(`/api/meetings/${id}/artifacts`); if (selected !== id || revision !== meetingLoadRevision) return;
  artifactState = data; $('archive-path').textContent = data.folder;
  updateList('document-list', [id, data.documents], root => {
    root.replaceChildren();
    for (const d of data.documents) {
      const link = artifactLink(id, d.path, d.name), size = document.createElement('small'); size.textContent = `${(d.bytes / 1e6).toFixed(2)} MB · Local copy saved`; link.append(size); root.append(link);
    }
  }, 'document-files');
  updateList('artifact-list', [id, data.entries.map(item => item.path), data.generatedContentAvailable], root => {
    root.replaceChildren();
    for (const item of data.entries) root.append(artifactLink(id, item.path));
    if (!data.generatedContentAvailable) { const row = document.createElement('p'); row.className = 'hint'; row.textContent = 'Transcripts and AI notes are not available yet. Generated files will appear in outputs/.'; root.append(row); }
  }, 'artifacts-refresh');
  renderExports(data.exports);
}
function renderExports(jobs) {
  if (current) $('export-media').disabled = ['starting','recording','paused','finalizing'].includes(current.manifest.status) || jobs.some(e => ['processing','queued'].includes(e.status));
  if (artifactState) artifactState.exports = jobs;
  exportSignature = JSON.stringify(jobs.map(j => [j.id, j.status, j.files?.length]));
  const latest = jobs[0];
  const labels = { queued:'Starting export', processing:'Merging', ready:'Saved', failed:'Export failed', interrupted:'Export interrupted. Try again.' };
  $('export-state').textContent = latest ? `${labels[latest.status] || latest.status}${latest.status === 'processing' ? ` · ${Math.round((latest.progress || 0) * 100)}%` : ''}${latest.error ? ` · ${latest.error}` : ''}` : 'No merged export yet';
  const exportedFiles = jobs.flatMap(job => (job.files || []).filter(item => artifactState?.entries.some(e => e.path === item.path)).map(item => [item.path, job.createdAt]));
  updateList('export-files', [selected, exportedFiles], root => {
    root.replaceChildren();
    for (const [file, createdAt] of exportedFiles) root.append(artifactLink(selected, file, `${file.endsWith('.mp4') ? 'Meeting video with audio' : 'Full meeting audio'} · ${new Date(createdAt).toLocaleTimeString('en-US')}`));
  }, 'export-media');
  const playable = jobs.find(j => j.status === 'ready' && j.files?.some(f => f.path.endsWith('.mp4') && artifactState?.entries.some(e => e.path === f.path)));
  const file = playable?.files.find(f => f.path.endsWith('.mp4'));
  $('merged-preview').hidden = !file;
  if (file) {
    const url = artifactURL(selected, file.path, true);
    if ($('merged-video').getAttribute('src') !== url) { $('merged-video').pause(); $('merged-video').src = url; }
    $('merged-download').href = artifactURL(selected, file.path);
  }
}
async function pollExports() {
  if (!selected || !artifactState || exportPolling || !artifactState.exports.some(e => ['queued','processing'].includes(e.status))) return;
  const id = selected; exportPolling = true;
  try {
    const jobs = await api(`/api/meetings/${id}/exports`); if (selected !== id) return;
    const signature = JSON.stringify(jobs.map(j => [j.id, j.status, j.files?.length]));
    if (signature !== exportSignature) await loadArtifacts(id); else renderExports(jobs);
  } finally { exportPolling = false; }
}
$('open-folder').onclick = run(async () => { const id = selected, result = await post(`/api/meetings/${id}/open-folder`); if (artifactState && selected === id) $('archive-path').textContent = result.folder; });
$('artifacts-refresh').onclick = run(() => loadArtifacts());
$('documents-import').onclick = run(async () => {
  const id = selected, files = [...$('document-files').files];
  if (!files.length) throw new Error('Choose documents to import first');
  $('documents-import').disabled = true; let count = 0;
  try {
    for (const file of files) {
      if (file.size < 1 || file.size > 100 * 1024 * 1024) throw new Error(`${file.name} is empty or exceeds 100 MB`);
      if (selected === id) $('document-state').textContent = `Copying ${file.name}…`;
      await api(`/api/meetings/${id}/documents`, { method:'POST', headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name)}, body:file }); count++;
    }
    if (selected === id) { $('document-state').textContent = `Local document copies saved: ${count}`; $('document-files').value = ''; await loadArtifacts(id); }
  } catch (error) { if (selected === id) $('document-state').textContent = `Imported ${count}; ${error.message}`; throw error; }
  finally { $('documents-import').disabled = false; }
});
$('export-media').onclick = run(async () => {
  const id = selected, audioSources = [];
  if ($('export-system').checked) audioSources.push('system'); if ($('export-mic').checked) audioSources.push('microphone');
  await post(`/api/meetings/${id}/export-media`, {audioSources}); if (selected === id) await loadArtifacts(id);
});
function fillProjects(element, emptyLabel) {
  updateOptions(element, [[emptyLabel, ''], ...localProjects.map(p => [p.name, p.id])]);
}
function renderProjectNavigation() {
  updateList('projects', localProjects.map(p => [p.id, p.name, p.meetingCount, p.rkaProjectId]), root => {
    root.replaceChildren();
    for (const p of localProjects) {
      const button = document.createElement('button'); button.dataset.focusKey = p.id;
      const name = document.createElement('strong'); name.textContent = p.name;
      const count = document.createElement('small'); count.textContent = `${countLabel(p.meetingCount, 'meeting')}${p.rkaProjectId ? ' · RKA linked' : ''}`;
      button.append(name, count); button.onclick = run(() => openProject(p.id)); root.append(button);
    }
  }, 'project-new');
  updateNavigationCurrent();
  fillProjects($('setup-project'), 'No project'); fillProjects($('meeting-project'), 'No project');
}
function clearPlayback() { clearTimeout(notesTimer); pauseRawPlayback(); videoLoadRevision++; meetingLoadRevision++; selected = null; notesMeetingId = null; setMeetingLoading(false); current = null; sourceClip = null; $('standalone-audio').pause(); $('merged-video').pause(); }
async function openProject(id = null) {
  const revision = ++meetingLoadRevision;
  let committed = false;
  setMeetingLoading(true);
  try {
    if (notesDirty && notesMeetingId) await flushNotes();
    if (revision !== meetingLoadRevision) return;
    const data = id ? await api(`/api/projects/${id}`) : { project: { name: '', description: '', rkaProjectId: null }, meetings: [] };
    if (revision !== meetingLoadRevision) return;
    // Commit identity and fields together. A failed B load must never leave
    // project A's fields attached to B's Save route.
    clearPlayback(); committed = true;
    projectViewId = id; projectFilter = id; showView('project');
    $('project-save-state').textContent = ''; $('project-timeline').replaceChildren();
    $('heading').textContent = id ? data.project.name : 'Create project'; $('project-name').value = data.project.name; $('project-description').value = data.project.description;
    $('project-details').open = !id;
    fillRka($('project-rka'), data.project.rkaProjectId, 'No RKA project'); renderProjectTimeline(data); renderProjectNavigation(); focusHeading(); publishDesktopState();
  } finally {
    if (committed || revision === meetingLoadRevision) setMeetingLoading(false);
  }
}

function renderProjectTimeline(data) {
  $('project-stats').textContent = `${countLabel(data.meetings.length, 'meeting')} · ${seconds(data.durationSeconds)} total`;
  $('project-context-export').hidden = !projectViewId; $('project-context-export').href = `/api/projects/${projectViewId}/analysis-context`;
  updateList('project-timeline', [projectViewId, data.meetings.map(m => [m.id, m.title, m.createdAt, m.status, m.durationSeconds, m.notes])], root => {
    root.replaceChildren();
    if (!data.meetings.length) { root.textContent = 'Add meetings to this project to see their timeline here.'; return; }
    for (const m of [...data.meetings].reverse()) {
      const row = document.createElement('article'); row.className = 'project-meeting';
      const button = document.createElement('button'); button.dataset.focusKey = m.id; button.textContent = m.title; button.onclick = run(() => openMeeting(m.id));
      const info = document.createElement('p'); info.className = 'hint'; info.textContent = `${new Date(m.createdAt).toLocaleString('en-US')} · ${stateNames[m.status] || m.status} · ${seconds(m.durationSeconds)}`;
      const notes = document.createElement('div'); notes.className = 'history-note'; notes.textContent = m.notes || 'No saved notes';
      row.append(button, info, notes); root.append(row);
    }
  }, 'heading');
}
function fillRka(element, chosen, emptyLabel) {
  element.replaceChildren(new Option(emptyLabel, ''));
  for (const p of rkaCatalog) element.append(new Option(p.name, p.id));
  if (chosen && !rkaCatalog.some(p => p.id === chosen)) element.append(new Option(`${chosen} · Name not loaded`, chosen));
  element.value = chosen || '';
}
async function loadRkaProjects() {
  const data = await api('/api/rka/projects'); rkaCatalog = data.projects;
  fillRka($('project-rka'), $('project-rka').value, 'No RKA project'); fillRka($('rka-project'), $('rka-project').value, 'Choose an RKA project');
  showMessage(`Connected to RKA ${data.version} · ${countLabel(data.projects.length, 'project')}`);
}
function renderRka(data) {
  rkaState = data; const c = data.connection, snapshot = data.snapshot;
  $('rka-enabled').checked = c.enabled; fillRka($('rka-project'), c.projectId, 'Choose an RKA project');
  $('rka-query').value = c.query || current?.manifest.title || ''; $('rka-angles').value = c.angleQueries.join('\n');
  $('rka-save').disabled = false; $('rka-refresh').disabled = false; $('rka-export').href = `/api/meetings/${selected}/analysis-context`;
  for (const key of ['rka-enabled','rka-project','rka-query','rka-angles','rka-use-project','rka-load']) $(key).disabled = false;
  const chosen = c.selectedIds.length;
  $('rka-state').textContent = c.lastError ? `Last retrieval failed: ${c.lastError.message}${snapshot ? '; Previous snapshot retained' : ''}` :
    snapshot ? `${new Date(snapshot.fetchedAt).toLocaleString('en-US')} · ${countLabel(snapshot.records.filter(r => r.available).length, 'record')} · ${chosen} selected${snapshot.retrieval.truncated ? ' · Results truncated' : ''}${!c.enabled ? ' · Disabled' : ''}` : 'No context snapshot saved';
  $('rka-records').replaceChildren();
  for (const r of snapshot?.records || []) {
    const row = document.createElement('div'); row.className = 'context-record';
    const label = document.createElement('label'); label.className = 'check';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = r.id; checkbox.disabled = !r.available; checkbox.checked = c.selectedIds.includes(r.id);
    label.append(checkbox, document.createTextNode(r.title || r.id));
    const info = document.createElement('small'); info.textContent = r.available ? `${r.type} · ${r.id} · ${r.useAs === 'current_background' ? 'Current context when retrieved' : 'Historical or unconfirmed context'}${r.record.status ? ` · ${r.record.status}` : ''}` : `Unavailable · ${r.outcome}`;
    const details = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('pre');
    summary.textContent = 'View original record, version, and source'; content.textContent = JSON.stringify(r, null, 2); details.append(summary, content);
    row.append(label, info, details); $('rka-records').append(row);
  }
}
function rkaForm() {
  const c = rkaState.connection, projectId = $('rka-project').value || null, query = $('rka-query').value.trim(), angleQueries = $('rka-angles').value.split('\n').map(q => q.trim()).filter(Boolean);
  const unchanged = c.projectId === projectId && c.query === query && JSON.stringify(c.angleQueries) === JSON.stringify(angleQueries);
  return { enabled: $('rka-enabled').checked, projectId, query, angleQueries, revision: c.revision,
    selectedIds: unchanged ? [...$('rka-records').querySelectorAll('input:checked')].map(e => e.value) : [] };
}
async function saveRka() {
  if (!selected || !rkaState) return;
  const id = selected, input = rkaForm(); $('rka-save').disabled = true; $('rka-refresh').disabled = true;
  try {
    const result = await api(`/api/meetings/${id}/rka-context`, { method: 'PUT', body: JSON.stringify(input) });
    if (selected === id) { renderRka(result); $('rka-state').textContent += ' · Settings saved'; } return result;
  } finally { if (selected === id) { $('rka-save').disabled = false; $('rka-refresh').disabled = false; } }
}
$('project-new').onclick = run(() => openProject());
$('all-meetings').onclick = run(() => openLibrary());
$('meeting-search').oninput = renderLibrary;
$('empty-new').onclick = () => $('new').click();
$('project-quick').onclick = run(() => current?.projectId ? openProject(current.projectId) : selectMeetingTab('artifacts'));
$('playback-export-link').onclick = () => selectMeetingTab('artifacts');
const tabNames = ['notes','playback','artifacts','context'];
for (const name of tabNames) {
  $(`tab-${name}`).onclick = () => selectMeetingTab(name);
  $(`tab-${name}`).onkeydown = event => {
    let index = tabNames.indexOf(meetingTab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabNames.length;
    else if (event.key === 'ArrowLeft') index = (index + tabNames.length - 1) % tabNames.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabNames.length - 1;
    else return;
    event.preventDefault(); selectMeetingTab(tabNames[index], true);
  };
}
$('project-form').onsubmit = event => { event.preventDefault(); run(async () => {
  const input = { name: $('project-name').value, description: $('project-description').value, rkaProjectId: $('project-rka').value || null };
  const id = projectViewId, p = id ? await api(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(input) }) : await post('/api/projects', input);
  if (view === 'project' && projectViewId === id) { projectViewId = p.id; projectFilter = p.id; $('heading').textContent = p.name; $('project-save-state').textContent = 'Saved'; }
  await refresh();
})(); };
$('project-rka-load').onclick = run(loadRkaProjects); $('rka-load').onclick = run(loadRkaProjects);
$('assign-project').onclick = run(async () => {
  const id = selected; await api(`/api/meetings/${id}/project`, { method: 'PUT', body: JSON.stringify({ projectId: $('meeting-project').value || null }) });
  showMessage('Project assignment saved. Existing RKA snapshots keep their original source project; update the context link if needed.'); await refresh();
});
$('open-project').onclick = run(() => openProject(current.projectId));
$('rka-use-project').onclick = run(async () => {
  const p = localProjects.find(p => p.id === current?.projectId);
  if (!p?.rkaProjectId) throw new Error('This project has no RKA link. Choose one in project details.');
  fillRka($('rka-project'), p.rkaProjectId, 'Choose an RKA project'); $('rka-enabled').checked = true;
});
$('rka-save').onclick = run(saveRka);
$('rka-refresh').onclick = run(async () => {
  const id = selected, saved = await saveRka(); if (!saved || id !== selected) return;
  $('rka-refresh').disabled = true; $('rka-save').disabled = true; $('rka-state').textContent = 'Retrieving the selected project and saving a snapshot…';
  for (const key of ['rka-enabled','rka-project','rka-query','rka-angles','rka-use-project','rka-load']) $(key).disabled = true;
  try { const result = await post(`/api/meetings/${id}/rka-refresh`, { revision: saved.connection.revision }); if (selected === id) renderRka(result); }
  catch (error) { if (selected === id) { const latest = await api(`/api/meetings/${id}/rka-context`); if (selected === id) renderRka(latest); } throw error; }
});
$('auth-form').onsubmit = event => { event.preventDefault(); run(() => authenticate($('token').value))(); };
$('sources').onclick = run(loadSources);
$('permissions-refresh').onclick = run(() => updatePermissions());
$('permission-screen-request').onclick = run(() => updatePermissions({ screen:true }));
$('permission-microphone-request').onclick = run(() => updatePermissions({ microphone:$('mic').checked }));
for (const [id, permission] of [['permission-screen-settings','screen'], ['permission-microphone-settings','microphone']]) {
  $(id).onclick = run(() => openPermissionSettings(permission));
}
$('window').onchange = resetPreview;
$('capture-kind').onchange = renderCaptureTargets;
$('preview').onclick = run(async () => {
  resetPreview(); const revision = previewRequestRevision, target = selectedCaptureTarget();
  const data = await post('/api/preview', { target });
  const currentTarget = selectedCaptureTarget();
  if (revision !== previewRequestRevision || target.kind !== currentTarget.kind || target.id !== currentTarget.id || view !== 'setup') return;
  previewID = data.previewID;
  $('preview-image').src = `data:image/jpeg;base64,${data.jpeg}`; $('preview-image').hidden = false; $('preview-placeholder').hidden = true;
  $('confirmed').disabled = false; $('confirmed').checked = false; setStart();
});
for (const id of ['confirmed','mic-device']) $(id).onchange = setStart;
$('mic').onchange = run(async () => { renderPermissions(); if ($('mic').checked) await updatePermissions({ microphone:true }); });
$('start').onclick = run(async () => {
  $('start').disabled = true;
  $('start-status').textContent = 'Starting recording…';
  try { const projectId = $('setup-project').value; const m = await post('/api/record/start', { title:$('title').value, target:selectedCaptureTarget(), previewID, confirmed:$('confirmed').checked,
    microphone:$('mic').checked, microphoneID:$('mic-device').value, systemAudio:$('system').checked, fps:Number($('fps').value) });
    if (projectId) { try { await api(`/api/meetings/${m.id}/project`, { method:'PUT', body:JSON.stringify({ projectId }) }); } catch (error) { showMessage(`Recording started, but the project assignment could not be saved: ${error.message}`); } }
    await openMeeting(m.id); await refresh(); }
  finally { setStart(); }
});
$('new').onclick = run(newMeeting);
$('settings-open').onclick = run(openSettings);
$('settings-close').onclick = closeSettings;
$('settings-dialog').oncancel = event => { event.preventDefault(); closeSettings(); };
$('settings-dialog').onclose = restoreSettingsFocus;
$('settings-permissions-refresh').onclick = run(refreshSettings);
for (const permission of ['screen','microphone']) {
  $(`settings-permission-${permission}-request`).onclick = run(() => settingsPermissionAction('settings-request-permission', permission));
  $(`settings-permission-${permission}-settings`).onclick = run(() => settingsPermissionAction('settings-open-permission', permission));
}
$('stop').onclick = run(async () => { await post(`/api/meetings/${selected}/stop`); await refresh(); });
$('pause').onclick = run(async () => { await post(`/api/meetings/${selected}/${current.manifest.status === 'paused' ? 'resume' : 'pause'}`); await refresh(); });
$('mic-toggle').onclick = run(async () => { await post(`/api/meetings/${selected}/mic`, { enabled:!current.manifest.capture?.micEnabled }); await refresh(); });
$('bookmark').onclick = run(async () => { await post(`/api/meetings/${selected}/bookmark`, { text:$('bookmark-text').value }); $('bookmark-text').value = ''; await refresh(); });
$('recover').onclick = run(async () => { const result = await post(`/api/meetings/${selected}/recover`); showMessage(`Recovered ${countLabel(result.filter(r=>r.recovered).length, 'tail file')}; ${result.filter(r=>r.status==='unrecoverable').length} still unrecoverable. Originals preserved.`); await refresh(); });
$('notes').oninput = () => { if (meetingLoading || meetingMutationInFlight || !notesMeetingId) return; sizeNotes(); notesDirty = true; notesRevision++; $('notes-state').textContent = 'Unsaved'; clearTimeout(notesTimer); notesTimer = setTimeout(() => saveNotes().catch(error => showMessage(error.message)), 900); publishDesktopState(); };
$('notes').onblur = () => { if (notesDirty) saveNotes().catch(error => showMessage(error.message)); };
$('save-notes').onclick = run(saveNotes); $('refresh-meetings').onclick = run(refresh);
$('timeline').onpointerdown = beginTimelineGesture;
$('timeline').oninput = previewTimelineGesture;
$('timeline').onchange = run(() => commitTimelineGesture());
$('timeline').onpointerup = run(() => commitTimelineGesture('release'));
$('timeline').onpointercancel = cancelTimelineGesture;
$('timeline').onblur = cancelTimelineGesture;
const timelineKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
$('timeline').onkeydown = event => {
  if (timelineKeys.has(event.key)) beginTimelineGesture();
  else if (event.key === 'Escape' && timelineGesture) { event.preventDefault(); cancelTimelineGesture(); }
};
$('timeline').onkeyup = event => { if (timelineKeys.has(event.key)) return run(() => commitTimelineGesture('release'))(); };
$('play-session').onclick = run(async () => { if (rawPlaying) pauseRawPlayback(); else await seek(rawPosition >= sessionDuration() ? 0 : rawPosition, true); });
$('video').onplay = run(async () => {
  // This element has no independent transport controls. A delayed media play
  // event must never resurrect the session after the user pressed Pause.
  if (playbackGroup !== 'raw' || !rawPlaying) { $('video').pause(); return; }
  activatePlayback('raw');
  await syncAudio();
});
$('audio-source').onchange = () => { sourceJumpRevision++; $('standalone-audio').pause(); $('standalone-audio').hidden = true; renderAudioPicker(); };
$('audio-clip').onchange = () => { sourceJumpRevision++; const audio = $('standalone-audio'); audio.onloadedmetadata = null; audio.onerror = null; if (!$('audio-clip').value) { audio.pause(); audio.hidden = true; return; } audio.dataset.clip = $('audio-clip').value; audio.src = `/api/meetings/${selected}/media/${audio.dataset.clip}`; audio.hidden = false; audio.load(); };
$('standalone-audio').onplay = () => activatePlayback('standalone');
$('merged-video').onplay = () => activatePlayback('merged');
$('video').onended = run(updateSessionPlayback);
setInterval(() => { if (connected && selected) updateSessionPlayback().catch(e=>showMessage(e.message)); },150);
setInterval(() => { if (connected && !pendingDesktopCommands) refresh().catch(e=>showMessage(e.message)); },2500);
setInterval(() => { if (connected) pollExports().catch(e=>showMessage(e.message)); },2000);
window.addEventListener('compositionstart', () => { composingText = true; });
window.addEventListener('resize', () => { if (view === 'meeting' && meetingTab === 'notes') sizeNotes(); });
window.addEventListener('compositionend', () => { composingText = false; });
window.addEventListener('keydown', event => {
  if (composingText || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape' && $('settings-dialog').open) { event.preventDefault(); closeSettings(); return; }
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    const action = { n:'new', f:'search', s:'save', ',':'settings' }[event.key.toLowerCase()];
    if (action) { event.preventDefault(); if (!event.repeat) void performDesktopAction(action); }
    return;
  }
  if (!event.metaKey && !event.ctrlKey && event.altKey && event.shiftKey && event.code === 'KeyM' && !$('settings-dialog').open) {
    if (nativeShell) {
      const active = desktopSnapshot().activeRecording;
      if (active?.microphoneSelected && ['recording','paused'].includes(active.status)) {
        event.preventDefault();
        if (!event.repeat) void dispatchDesktopAction('mic', { id:active.id, enabled:!active.micEnabled });
      }
    } else if (selected && !$('mic-toggle').hidden) { event.preventDefault(); if (!event.repeat) $('mic-toggle').click(); }
  }
});
Object.defineProperty(window, 'MeetingArchiveDesktop', { value:Object.freeze({ perform:performDesktopAction, prepareToClose, enableNativeShell, snapshot:desktopSnapshot, dispatch:dispatchDesktopAction }), writable:false, configurable:false });
window.addEventListener('beforeunload', event => { if (notesDirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('focus', () => { if (connected && (view === 'setup' || $('settings-dialog').open)) updatePermissions().catch(error => showMessage(error.message)); });
(async () => { const fragment = new URLSearchParams(location.hash.slice(1)); const token = fragment.get('token'); if (token) history.replaceState(null,'',location.pathname); try { if (token) await authenticate(token); else await refresh(); } catch (error) { $('auth').hidden = false; showMessage(error.message); } })();
