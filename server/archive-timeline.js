// Preserve original capture metadata. Apply only the evidenced legacy defect:
// a non-media stopped notification at PTS zero rebased an established clock.
function effectiveTimeline(timeline, segments, events) {
  if (timeline?.clock !== 'SCK-presentation-time' || timeline.originPolicy !== 'earliest-observed-source-PTS'
      || timeline.originPTS?.seconds !== 0 || !segments.length) return timeline;
  const starts = segments.map(segment => segment.startPTS?.seconds);
  if (starts.some(value => !Number.isFinite(value) || value <= 0)) return timeline;
  const earliest = Math.min(...starts);
  let anchor = null, offendingIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.event !== 'timeline') continue;
    if (Number.isFinite(event.originPTS?.seconds) && event.originPTS.seconds > 0) anchor = event.originPTS;
    else if (event.originPTS?.seconds === 0 && event.rebased === true) {
      const next = events[i + 1];
      if (!anchor || next?.event !== 'frame-state' || next.status !== 5 || next.usable !== false
          || next.pts?.seconds !== 0 || Math.abs(anchor.seconds - earliest) > 0.000001) return timeline;
      offendingIndex = i;
    } else return timeline;
  }
  if (offendingIndex < 0 || !anchor || Math.abs(anchor.seconds - earliest) > 0.000001) return timeline;
  return { ...timeline, originPTS: { ...anchor }, originPolicy: 'earliest-valid-media-PTS',
    correction: { kind: 'legacy-stopped-notification-zero-PTS', originalOriginPTS: timeline.originPTS,
      evidence: { eventFile: 'raw/capture_events.jsonl', timelineEventLine: offendingIndex + 1,
        stoppedFrameEventLine: offendingIndex + 2, earliestCommittedMediaPTS: earliest }, rawUnchanged: true } };
}
module.exports = { effectiveTimeline };
