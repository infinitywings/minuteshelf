'use strict';
(() => {
  let available = false, meetingId = null, state = null, polling = false, generation = 0, resultSignature = '', review = null, runSelection = null;
  const names = { transcription: 'Speech', vision: 'Screen', summary: 'Summary' };
  const labels = { overview: 'Overview', topics: 'Topics', decisions: 'Decisions', actionItems: 'Action items', openQuestions: 'Open questions', uncertainties: 'Uncertainties' };
  const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
  const status = message => { $('analysis-state').textContent = message; };
  const guarded = action => async () => { const id = meetingId, revision = generation; try { await action(); } catch (error) { if (isCurrent(id, revision)) { status(error.message); if ($('analysis-review').open) $('analysis-review-error').textContent = error.message; } } };
  function isCurrent(id, revision) { return meetingId === id && selected === id && generation === revision; }
  async function poll() {
    if (!available || polling || !meetingId || selected !== meetingId || view !== 'meeting') return;
    const id = meetingId, revision = generation; polling = true;
    try {
      const value = await api(`/api/meetings/${id}/analysis`);
      if (!isCurrent(id, revision)) return;
      state = value; renderState();
      const chosen = value.jobs.find(job => job.id === runSelection) || value.jobs.find(job => job.status === 'ready') || value.jobs[0];
      if (chosen && resultSignature !== chosen.id + chosen.updatedAt) {
        const result = await api(`/api/meetings/${id}/analysis/${chosen.id}`);
        if (isCurrent(id, revision)) { renderResult(result); resultSignature = chosen.id + chosen.updatedAt; }
      }
    } catch (error) { if (isCurrent(id, revision)) status(error.message); }
    finally { polling = false; }
  }
  function renderState() {
    const tasks = state.settings?.tasks;
    $('analysis-models').textContent = tasks ? Object.entries(tasks).map(([task, config]) => `${names[task]}: ${config.provider}${config.model ? ` · ${config.model}` : ''}`).join('  |  ') : '';
    $('analysis-import').hidden = tasks?.transcription.provider !== 'imported-transcript';
    $('analysis-install').hidden = !['local-qwen', 'local-mimo'].includes(tasks?.transcription.provider);
    const running = state.jobs.find(job => ['queued', 'processing'].includes(job.status));
    $('analysis-start').disabled = state.recording || Boolean(running) || state.installation?.status === 'installing';
    $('analysis-install').disabled = state.recording || state.busy;
    status(state.settingsError || (state.installation?.status === 'installing' ? state.installation.message : state.recording ? 'Save the recording before analysis. Background analysis pauses when a new recording starts.' : running ? `${running.stage.replace(/-/g, ' ')} · ${Math.round(running.progress * 100)}%${running.detail ? ` · ${running.detail}` : ''}` : state.installation?.message || 'Analysis starts only when you confirm. Originals stay in this meeting’s folder.'));
    updateList('analysis-jobs', state.jobs, root => {
      root.replaceChildren();
      for (const job of state.jobs) {
        const row = document.createElement('div'); row.className = 'analysis-job';
        const caption = text('div', `${new Date(job.createdAt).toLocaleString()} · ${job.status} · ${job.stage.replace(/-/g, ' ')}`);
        if (job.error) caption.append(text('p', job.error, 'hint'));
        row.append(caption);
        const button = text('button', ['queued', 'processing'].includes(job.status) ? 'Pause' : 'View'); button.dataset.focusKey = job.id;
        button.onclick = guarded(async () => {
          if (['queued', 'processing'].includes(job.status)) { await post(`/api/meetings/${meetingId}/analysis-pause`, { runId: job.id }); await poll(); }
          else { runSelection = job.id; resultSignature = ''; await poll(); }
        });
        row.append(button);
        if (['paused', 'failed', 'interrupted'].includes(job.status)) {
          const retry = text('button', 'Retry'); retry.dataset.focusKey = `${job.id}/retry`; retry.disabled = state.recording || state.busy;
          retry.onclick = guarded(() => beginReview(job.id)); row.append(retry);
        }
        root.append(row);
      }
    }, 'analysis-start');
  }
  function evidenceButton(evidence) {
    const button = text('button', evidence.kind === 'visual' ? `View screen · ${seconds(evidence.sourceMs / 1000)}` : Number.isFinite(evidence.startMs) ? `Jump to source · ${seconds(evidence.startMs / 1000)}` : `Source ${evidence.id}`, 'evidence-ref');
    button.onclick = guarded(async () => {
      const id = meetingId, revision = generation;
      const target = document.getElementById(`evidence-${evidence.id}`);
      if (evidence.kind === 'visual' && evidence.framePath) {
        target?.closest('details')?.setAttribute('open', ''); target?.scrollIntoView({ block: 'center' });
      } else if (Number.isFinite(evidence.startMs)) {
        try { await jumpToSource(evidence); }
        catch (error) { if (isCurrent(id, revision)) showMessage(error.message); throw error; }
      } else { target?.closest('details')?.setAttribute('open', ''); target?.scrollIntoView({ block: 'center' }); }
    });
    return button;
  }
  function renderResult(result) {
    const evidence = new Map((result.evidence || []).map(item => [item.id, item]));
    $('analysis-result').hidden = !result.summary && !evidence.size;
    $('analysis-result-label').textContent = `${new Date(result.job.createdAt).toLocaleString()} · ${result.job.status}. Check important claims against the original evidence.`;
    $('analysis-download').hidden = result.job.status !== 'ready';
    $('analysis-download').href = artifactURL(meetingId, `outputs/${result.job.id}/summary.md`);
    $('analysis-summary').replaceChildren();
    for (const [key, label] of Object.entries(labels)) {
      const items = result.summary?.[key] || []; if (!items.length) continue;
      const section = document.createElement('section'); section.append(text('h3', label));
      for (const item of items) {
        const row = text('p', item.text); section.append(row);
        if (key === 'actionItems') section.append(text('p', `Owner: ${item.owner || 'Unspecified'} · Due: ${item.deadline || 'Unspecified'}`, 'hint'));
        const refs = document.createElement('div'); refs.className = 'evidence-links';
        for (const ref of item.evidence_refs || []) if (evidence.has(ref)) refs.append(evidenceButton(evidence.get(ref)));
        section.append(refs);
      }
      $('analysis-summary').append(section);
    }
    $('analysis-evidence').replaceChildren();
    for (const item of evidence.values()) {
      const row = document.createElement('article'); row.id = `evidence-${item.id}`; row.className = 'evidence-item';
      row.append(text('strong', `${item.id} · ${item.kind}${item.source ? ` · ${item.source}` : ''}${item.timingAccuracy ? ` · ${item.timingAccuracy}` : ''}`), text('p', item.text), evidenceButton(item));
      if (item.framePath) { const img = document.createElement('img'); img.src = artifactURL(meetingId, item.framePath, true); img.alt = item.title || 'Selected meeting frame'; img.loading = 'lazy'; row.append(img); }
      if (item.provenance?.path) row.append(artifactLink(meetingId, item.provenance.path, 'Open context document'));
      $('analysis-evidence').append(row);
    }
  }
  async function beginReview(retryRunId) {
    if (!meetingId || selected !== meetingId) return;
    const id = meetingId, revision = generation;
    await flushNotes();
    if (!isCurrent(id, revision)) return;
    const options = { includeContext: $('analysis-context').checked, transcript: $('analysis-transcript').value, ...(retryRunId ? { retryRunId } : {}) };
    const preview = await post(`/api/meetings/${id}/analysis-preview`, options);
    if (!isCurrent(id, revision)) return;
    if (preview.transcriptImportRequired && !retryRunId && !options.transcript.trim()) throw new Error('Paste a transcript before analyzing.');
    review = { id, revision, options: { ...options, settingsRevision: preview.settingsRevision } };
    const uploads = preview.uploads.length ? preview.uploads.map(u => `${names[u.task]} → ${u.provider} / ${u.model}\n${u.endpoint || 'Managed provider connection'}\nShared: ${u.content.join(', ')}`).join('\n\n') : 'All selected analysis providers run locally. No meeting content will be sent to a cloud model.';
    $('analysis-review-details').textContent = `${uploads}\n\nDuration: ${seconds(preview.durationSeconds)}\nAudio: ${preview.audioSources.join(', ') || 'None'}\nSelected images: at most ${preview.maxSelectedImages}\nContext: ${preview.includeContext ? 'Attached documents and selected RKA records' : 'Excluded'}\n\n${preview.limitations.join('\n')}`;
    $('analysis-review-error').textContent = '';
    $('analysis-review-confirm').disabled = false;
    $('analysis-review-confirm').textContent = retryRunId ? 'Retry analysis' : 'Start analysis';
    $('analysis-review-confirm').onclick = guarded(confirmAnalysis); $('analysis-review').showModal();
  }
  async function confirmAnalysis() {
    const pending = review; if (!pending || !isCurrent(pending.id, pending.revision)) { $('analysis-review').close(); return; }
    $('analysis-review-confirm').disabled = true;
    try { const job = await post(`/api/meetings/${pending.id}/analysis`, pending.options); if (!isCurrent(pending.id, pending.revision) || review !== pending) return; runSelection = job.id; review = null; $('analysis-review').close(); await poll(); }
    finally { if (isCurrent(pending.id, pending.revision)) $('analysis-review-confirm').disabled = false; }
  }
  $('analysis-start').onclick = guarded(() => beginReview());
  $('analysis-settings').onclick = () => { if (!sendNativeCommand('settings')) status('Open the installed MinuteShelf app and choose Settings → Analysis to configure providers and credentials.'); };
  $('analysis-install').onclick = guarded(async () => {
    review = null; $('analysis-review-error').textContent = ''; $('analysis-review-confirm').disabled = false;
    $('analysis-review-details').textContent = 'This downloads a private Python/MLX runtime and the selected speech model from package and model repositories. Model weights can take several GB. No meeting audio is uploaded. Python 3.11 or later is required. Setup pauses if you start recording.';
    $('analysis-review-confirm').textContent = 'Download & install';
    $('analysis-review-confirm').onclick = guarded(async () => { $('analysis-review').close(); await post('/api/analysis/runtime-install', {}); await poll(); });
    $('analysis-review').showModal();
  });
  $('analysis-review-cancel').onclick = () => { review = null; $('analysis-review').close(); };
  window.meetingAnalysis = {
    setAvailable(value) { available = value; },
    open(id) { meetingId = id; generation++; state = null; resultSignature = ''; runSelection = null; review = null;
      $('analysis-review').close(); $('analysis-review-confirm').disabled = false; $('analysis-result').hidden = true; $('analysis-jobs').replaceChildren(); $('analysis-transcript').value = ''; poll(); }
  };
  setInterval(poll, 2000);
})();
