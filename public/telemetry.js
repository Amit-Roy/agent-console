// Best effort, same-server metrics over the existing WebSocket. No background polling.
export function createLatencyReporter(deliver, enabled) {
  let pending = [], timer;
  function flush() {
    clearTimeout(timer); timer = null;
    while (pending.length) {
      const batch = pending.slice(0, 20);
      if (!deliver(batch)) return;
      pending.splice(0, batch.length);
    }
  }
  function record(sample) {
    if (!enabled()) return;
    pending.push({ ...sample, width: innerWidth, height: Math.round(window.visualViewport?.height || innerHeight), touch: matchMedia('(pointer:coarse)').matches, hidden: sample.hidden || document.visibilityState !== 'visible' });
    if (pending.length > 200) pending.shift();
    if (pending.length >= 20) flush();
    else if (!timer) timer = setTimeout(flush, 5000);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
  return { record, flush };
}
