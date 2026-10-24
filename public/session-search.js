const form = document.getElementById("session-search-form");
const query = document.getElementById("session-query");
const provider = document.getElementById("session-provider");
const status = document.getElementById("search-status");
const results = document.getElementById("session-results");
let pending;
function heading(item, href) {
  const h = element("h2");
  const link = element("a", item.title || item.thread);
  link.href = href;
  h.append(link);
  if (item.archived) h.append(element("span", "Archived", "badge-archived"));
  return h;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
// A GitHub PR/issue/comment URL, owner/repo#n or #n asks "which session raised this PR?" instead of searching text.
const PR_REF =
  /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+\S*|[\w.-]+\/[\w.-]+#\d+|#\d+)$/;
async function lookupPrs(request, ref) {
  const response = await fetch("/api/sessions/prs?" + new URLSearchParams({ ref }), {
    signal: request.signal,
    cache: "no-store",
  });
  if (response.status === 401) {
    location.assign("/login");
    return;
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "PR lookup failed. Try again.");
  if (request !== pending) return;
  status.textContent = body.prs.length
    ? `${body.prs.length} session${body.prs.length === 1 ? "" : "s"} raised this PR`
    : "No session raised this PR. It may have been opened by hand, by automation, or before logs were kept.";
  for (const pr of body.prs) {
    const row = element("li");
    const pull = element("a", `${pr.repo}#${pr.number}`);
    pull.href = pr.url;
    pull.rel = "noopener noreferrer";
    const meta = element("p", `${pr.provider} · line ${pr.line} · `, "search-meta");
    meta.append(pull);
    row.append(heading(pr, pr.sessionUrl), meta);
    results.append(row);
  }
}
function groupByThread(hits) {
  const groups = new Map();
  for (const hit of hits) {
    if (!groups.has(hit.thread)) groups.set(hit.thread, []);
    groups.get(hit.thread).push(hit);
  }
  return groups;
}

async function loadSurroundingMessages(details, hit) {
  if (!details.open || details.dataset.loaded) return;
  details.dataset.loaded = "true";
  const text = element("pre", "Loading messages…");
  details.append(text);
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(hit.thread)}?start=${Math.max(1, hit.line - 2)}&limit=8`,
      { cache: "no-store" },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load messages.");
    text.textContent = body.events
      .map((event) => `Line ${event.line} · ${event.role}\n${event.text}`)
      .join("\n\n");
  } catch (error) {
    text.textContent = error.message;
    delete details.dataset.loaded;
  }
}

function buildHitBox(hit) {
  const box = element("div", undefined, "hit");
  box.append(
    element("p", `${hit.role} · line ${hit.line}`, "search-meta"),
    element("p", hit.snippet || hit.text),
  );
  const details = element("details");
  details.append(element("summary", "Read surrounding messages"));
  details.addEventListener("toggle", () => loadSurroundingMessages(details, hit));
  box.append(details);
  return box;
}

function buildGroupRow(hits) {
  const first = hits[0];
  const row = element("li");
  row.append(
    heading(first, "/#thread=" + encodeURIComponent(first.thread)),
    element(
      "p",
      `${first.provider} · ${hits.length} matching message${hits.length === 1 ? "" : "s"}`,
      "search-meta",
    ),
  );
  for (const hit of hits) row.append(buildHitBox(hit));
  return row;
}

async function runTextSearch(request, params) {
  const response = await fetch("/api/sessions/search?" + params, {
    signal: request.signal,
    cache: "no-store",
  });
  if (response.status === 401) {
    location.assign("/login");
    return;
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Search failed. Try again.");
  if (request !== pending) return;
  status.textContent = body.results.length
    ? `${body.results.length} matching messages · ${body.indexedSessions} sessions searched`
    : "No matches. Try fewer words or another provider.";
  for (const hits of groupByThread(body.results).values()) results.append(buildGroupRow(hits));
}

async function search() {
  pending?.abort();
  const request = (pending = new AbortController());
  const params = new URLSearchParams({ q: query.value, limit: "30" });
  if (provider.value) params.set("provider", provider.value);
  history.replaceState(null, "", "/sessions?" + params);
  results.replaceChildren();
  status.textContent = "Searching sessions…";
  results.setAttribute("aria-busy", "true");
  try {
    if (PR_REF.test(query.value.trim())) await lookupPrs(request, query.value.trim());
    else await runTextSearch(request, params);
  } catch (error) {
    if (error.name !== "AbortError" && request === pending) status.textContent = error.message;
  } finally {
    if (request === pending) results.setAttribute("aria-busy", "false");
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});
provider.addEventListener("change", () => {
  if (query.value.trim()) search();
});
const initial = new URLSearchParams(location.search);
query.value = initial.get("q") || "";
if ([...provider.options].some((option) => option.value === initial.get("provider")))
  provider.value = initial.get("provider");
if (query.value.trim()) search();
