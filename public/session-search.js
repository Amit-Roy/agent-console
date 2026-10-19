const form = document.getElementById('session-search-form');
const query = document.getElementById('session-query');
const provider = document.getElementById('session-provider');
const status = document.getElementById('search-status');
const results = document.getElementById('session-results');
let pending;
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function search() {
  pending?.abort();
  const request = pending = new AbortController();
  const params = new URLSearchParams({q: query.value, limit: '30'});
  if (provider.value) params.set('provider', provider.value);
  history.replaceState(null, '', '/sessions?' + params);
  results.replaceChildren();
  status.textContent = 'Searching sessions…';
  results.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/sessions/search?' + params, {signal: request.signal, cache: 'no-store'});
    if (response.status === 401) { location.assign('/login'); return; }
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Search failed. Try again.');
    if (request !== pending) return;
    status.textContent = body.results.length ? `${body.results.length} matching messages · ${body.indexedSessions} sessions searched` : 'No matches. Try fewer words or another provider.';
    for (const hit of body.results) {
      const row = element('li');
      const heading = element('h2');
      const link = element('a', hit.title || hit.thread);
      link.href = '/#thread=' + encodeURIComponent(hit.thread);
      heading.append(link);
      row.append(heading, element('p', `${hit.provider} · ${hit.role} · line ${hit.line}`, 'search-meta'), element('p', hit.snippet || hit.text));
      const details = element('details');
      details.append(element('summary', 'Read surrounding messages'));
      details.addEventListener('toggle', async () => {
        if (!details.open || details.dataset.loaded) return;
        details.dataset.loaded = 'true';
        const text = element('pre', 'Loading messages…'); details.append(text);
        try {
          const response = await fetch(`/api/sessions/${encodeURIComponent(hit.thread)}?start=${Math.max(1, hit.line - 2)}&limit=8`, {cache: 'no-store'});
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Could not load messages.');
          text.textContent = body.events.map(event => `Line ${event.line} · ${event.role}\n${event.text}`).join('\n\n');
        } catch (error) { text.textContent = error.message; delete details.dataset.loaded; }
      });
      row.append(details); results.append(row);
    }
  } catch (error) {
    if (error.name !== 'AbortError' && request === pending) status.textContent = error.message;
  } finally { if (request === pending) results.setAttribute('aria-busy', 'false'); }
}
form.addEventListener('submit', event => { event.preventDefault(); search(); });
provider.addEventListener('change', () => { if (query.value.trim()) search(); });
const initial = new URLSearchParams(location.search);
query.value = initial.get('q') || '';
if ([...provider.options].some(option => option.value === initial.get('provider'))) provider.value = initial.get('provider');
if (query.value.trim()) search();
