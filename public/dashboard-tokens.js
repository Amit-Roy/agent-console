// Tokens tab: where input tokens go (range-scoped spend) and what every session carries before the first prompt (overhead, measured now).
// Pure DOM. dashboard.js passes its own helpers in `ui` so the look stays identical to the Usage tab.
//
// ui contract: { el, panel, kpi, hbars, legend, fmt, usd, pct, provMeta, showTip, hideTip?, retryOverhead? }
const KINDS = {
  instructions: ["Instructions", "--k-instructions"],
  import: ["Imports", "--k-import"],
  "brain-index": ["Brain index", "--k-brain"],
  style: ["Reply style", "--k-style"],
  session: ["Session rules", "--k-session"],
  "brain-contract": ["Brain contract", "--k-contract"],
  skills: ["Skills list", "--k-skills"],
  agents: ["Agents list", "--k-agents"],
};
const kindMeta = (k) => KINDS[k] || [k, "--c-other"];
const NF = new Intl.NumberFormat("en-US");
const bytesFmt = (n) => (n == null ? "—" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const cssVar = (v) => `var(${v})`;
const homeRel = (p) => (p ? p.replace(/^\/home\/[^/]+(?=\/|$)/, "~").replace(/^\/root(?=\/|$)/, "~") : null);

const WARN_ICON = '<svg class="ico tk-warn-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 14.2 13H1.8L8 2.2Z"/><path d="M8 6.5v3"/><path d="M8 11.4v.1"/></svg>';

export function renderTokens(root, cur, overhead, ui) {
  const { el, panel, kpi, hbars, legend, fmt, usd, pct, provMeta, showTip } = ui;
  const hideTip = ui.hideTip || (() => { const t = document.getElementById("tip"); if (t) t.hidden = true; });

  const wrap = el("div", "tk");
  const section = (title, sub) => {
    const s = el("section", "tk-sec");
    const h = el("div", "tk-sec-h");
    h.append(el("h2", "", title));
    if (sub) h.append(el("p", "muted", sub));
    s.append(h);
    return s;
  };
  // Panel chart rows get hover/focus tips; hbars itself has none.
  const tipRows = (box, rows) => {
    [...box.querySelectorAll(".hb")].forEach((row, i) => {
      const r = rows[i];
      if (!r) return;
      row.tabIndex = 0;
      row.setAttribute("aria-label", `${r.name}: ${r.tip.map(([k, v]) => `${k} ${v}`).join(", ")}`);
      const show = (e) => showTip(e, r.name, r.tip);
      row.addEventListener("pointermove", show);
      row.addEventListener("focus", show);
      row.addEventListener("pointerleave", hideTip);
      row.addEventListener("blur", hideTip);
    });
    return box;
  };
  const tableEl = (headers, rows, cls = "") => {
    const t = el("table", cls);
    const thead = el("thead"), hr = el("tr");
    for (const h of headers) hr.append(el("th", "", h));
    thead.append(hr);
    const tb = el("tbody");
    for (const r of rows) { const tr = el("tr"); for (const c of r) tr.append(el("td", "", c)); tb.append(tr); }
    t.append(thead, tb);
    return t;
  };
  const asTable = (headers, rows) => {
    const d = el("details", "tk-table");
    d.append(el("summary", "", "Show as table"));
    const sc = el("div", "tk-scroll");
    sc.append(tableEl(headers, rows));
    d.append(sc);
    return d;
  };
  const empty = (text) => el("div", "empty-c", text);

  // ---------- spend ----------
  const turns = cur?.turns || [];
  const spend = section("Spend", "Selected range, from recorded turns");
  wrap.append(spend);
  if (!turns.length) {
    const p = el("div", "panel");
    p.append(empty("No turns in this range. Try 30 days."));
    spend.append(p);
  } else {
    let tokens = 0, inp = 0, cache = 0, cost = 0, costKnown = false;
    const perReq = [];
    const byProv = new Map(), byModel = new Map(), byProj = new Map(), byThread = new Map(), byTool = new Map();
    for (const t of turns) {
      const tin = t.in || 0, tout = t.out || 0, tc = t.cache || 0;
      tokens += tin + tout; inp += tin; cache += tc;
      if (t.cost != null) { cost += t.cost; costKnown = true; }
      const calls = Object.values(t.tools || {}).reduce((s, n) => s + n, 0);
      const per = calls ? tin / (calls + 1) : null;
      if (per != null) perReq.push(per);
      const add = (map, key, init = () => ({ tokens: 0, in: 0, cache: 0, cost: 0 })) => {
        const r = map.get(key) || init();
        r.tokens += tin + tout; r.in += tin; r.cache += tc; r.cost += t.cost || 0;
        map.set(key, r);
        return r;
      };
      add(byProv, t.provider || "other");
      const th = add(byThread, t.thread); th.provider = t.provider;
      add(byProj, homeRel(cur.cwds?.[t.thread]) || "Unknown project");
      for (const m of t.models || []) {
        const r = byModel.get(m.model) || { in: 0, cacheRead: 0, out: 0, cost: 0, known: false };
        r.in += (m.fresh || 0) + (m.cacheWrite || 0) + (m.cacheRead || 0); r.cacheRead += m.cacheRead || 0; r.out += m.output || 0;
        if (m.cost != null) { r.cost += m.cost; r.known = true; }
        byModel.set(m.model, r);
      }
      if (per != null) for (const [name, n] of Object.entries(t.tools || {})) {
        const r = byTool.get(name) || { calls: 0, samples: [] };
        r.calls += n; r.samples.push(per);
        byTool.set(name, r);
      }
    }
    const kp = el("div", "kpis");
    kp.append(
      kpi("Total tokens", fmt(tokens), `${fmt(inp)} in · ${fmt(tokens - inp)} out`, true),
      kpi("Est. API cost", costKnown ? usd(cost) : "—", costKnown ? "Pay-as-you-go equivalent" : "No priced turns"),
      kpi("Cache share", inp ? pct((cache / inp) * 100) : "—", "Of input read from cache"),
      kpi("Input per request", perReq.length ? fmt(median(perReq)) : "—", "Median, estimate"),
    );
    spend.append(kp);

    const rank = (map, n, nameOf, colorOf, extraOf, tipOf) => {
      const sorted = [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
      const top = sorted.slice(0, n).map(([k, v]) => ({ key: k, v }));
      const rest = sorted.slice(n);
      const rows = top.map(({ key, v }) => ({ name: nameOf(key, v), value: v.tokens, color: colorOf(key, v), extra: extraOf(v), tip: tipOf(v) }));
      if (rest.length) {
        const o = rest.reduce((a, [, v]) => ({ tokens: a.tokens + v.tokens, in: a.in + v.in, cache: a.cache + v.cache, cost: a.cost + v.cost }), { tokens: 0, in: 0, cache: 0, cost: 0 });
        rows.push({ name: "Other", value: o.tokens, color: cssVar("--c-other"), extra: extraOf(o), tip: tipOf(o) });
      }
      return rows;
    };
    const cachePct = (v) => (v.in ? pct((v.cache / v.in) * 100) : "—");
    const costText = (v) => (v.cost ? usd(v.cost) : "—");
    const tipOf = (v) => [["Tokens", NF.format(v.tokens)], ["Cache share", cachePct(v)], ["Est. cost", costText(v)]];
    const chartPanel = (title, sub, rows, startEllipsis = false) => {
      const p = panel(title, sub);
      const box = hbars(rows, fmt);
      // Paths differ at the end: clip the start so the folder name stays visible. Full text stays in title and the table.
      if (startEllipsis) box.querySelectorAll(".hb .n").forEach((n) => { n.classList.add("tk-clip-start"); n.replaceChildren(el("span", "", n.title)); });
      p.append(tipRows(box, rows));
      p.append(asTable(["Name", "Tokens", "Cache share", "Est. cost"], rows.map((r) => [r.name, NF.format(r.value), r.tip[1][1], r.tip[2][1]])));
      return p;
    };

    const provRows = rank(byProv, 6, (k) => provMeta(k)[0], (k) => cssVar(provMeta(k)[1]), (v) => `${cachePct(v)} cached`, tipOf);
    const projRows = rank(byProj, 8, (k) => k, () => cssVar("--c-used"), (v) => costText(v), tipOf);
    const threadRows = rank(byThread, 10, (k) => cur.titles?.[k] || "Thread", (k, v) => cssVar(provMeta(v.provider)[1]), (v) => costText(v), tipOf);
    // "Other" never applies to threads: show only the top 10.
    if (byThread.size > 10) threadRows.pop();

    const g1 = el("div", "grid2");
    g1.append(chartPanel("By provider", "Tokens in plus out", provRows), (() => {
      const p = panel("By model", "Input includes cache reads and writes");
      const rows = [...byModel].filter(([, r]) => r.in || r.out).sort((a, b) => b[1].in + b[1].out - a[1].in - a[1].out);
      if (!rows.length) { p.append(empty("No model detail in this range.")); return p; }
      const t = el("div", "mtab tk-mtab");
      t.append(...["Model", "In", "Cache %", "Out", "Cost"].map((h) => el("div", "h", h)));
      for (const [name, r] of rows) {
        const n = el("div", "n", name); n.title = name;
        t.append(n, el("div", "", fmt(r.in)), el("div", "", r.in ? pct((r.cacheRead / r.in) * 100) : "—"), el("div", "", fmt(r.out)), el("div", "", r.known ? usd(r.cost) : "—"));
      }
      p.append(t);
      return p;
    })());
    const g2 = el("div", "grid2");
    g2.append(chartPanel("By project", "Working folder of each thread", projRows, true), chartPanel("Top threads", "Largest 10 by tokens", threadRows));
    const toolPanel = panel("Tools", "Input carried per call, median");
    const toolRows = [...byTool].sort((a, b) => b[1].calls - a[1].calls).slice(0, 12);
    if (!toolRows.length) toolPanel.append(empty("No tool calls in this range."));
    else {
      const t = el("div", "mtab tk-tools");
      t.append(...["Tool", "Calls", "Median input/call"].map((h) => el("div", "h", h)));
      for (const [name, r] of toolRows) { const n = el("div", "n", name); n.title = name; t.append(n, el("div", "", NF.format(r.calls)), el("div", "", fmt(median(r.samples)))); }
      toolPanel.append(t);
    }
    spend.append(g1, g2, toolPanel);
  }

  // ---------- overhead ----------
  const oh = section("Prompt overhead", "Measured now, not range-scoped");
  oh.classList.add("tk-oh");
  wrap.append(oh);
  const note = el("p", "note", "Measured from files; harness built-ins not included, so totals are a lower bound. Tokens are bytes divided by 4.");
  if (overhead?.loading) {
    oh.setAttribute("aria-busy", "true");
    const sk = el("div", "tk-skel");
    sk.setAttribute("role", "status");
    sk.setAttribute("aria-label", "Measuring instruction files");
    for (let i = 0; i < 3; i++) sk.append(el("div", "tk-skel-b"));
    oh.append(sk);
  } else if (!overhead || overhead.error) {
    const e = el("div", "tk-err");
    e.setAttribute("role", "alert");
    e.append(el("p", "", `Could not measure prompt overhead${overhead?.error ? `: ${String(overhead.error).replace(/[.\s]+$/, "")}` : ""}. Spend above is unaffected.`));
    const b = el("button", "btn sm", "Retry");
    b.type = "button";
    b.addEventListener("click", () => { b.disabled = true; ui.retryOverhead?.(); });
    e.append(b);
    oh.append(e);
  } else {
    const provs = (overhead.providers || []).filter((p) => p.sources?.some((s) => !s.missing));
    if (!provs.length) {
      const p = el("div", "panel");
      p.append(empty("No instruction files found"));
      oh.append(p);
    } else {
      const kp = el("div", "kpis");
      for (const p of provs) kp.append(kpi(p.label, `~${fmt(p.tokensEst)}`, `${bytesFmt(p.totalBytes)} before the first prompt`));
      oh.append(kp);

      // stacked bar per provider
      const kinds = [];
      for (const p of provs) for (const s of p.sources) if (s.bytes > 0 && !kinds.includes(s.kind)) kinds.push(s.kind);
      kinds.sort((a, b) => Object.keys(KINDS).indexOf(a) - Object.keys(KINDS).indexOf(b));
      const bp = panel("Share by source type", "Each bar is one provider's total");
      const stack = el("div", "tk-stacks");
      const tableRows = [];
      for (const p of provs) {
        const row = el("div", "tk-stack");
        row.append(el("div", "tk-stack-n", p.label));
        const bar = el("div", "tk-bar");
        bar.setAttribute("role", "img");
        const byKind = new Map();
        for (const s of p.sources) if (s.bytes > 0) byKind.set(s.kind, (byKind.get(s.kind) || 0) + s.bytes);
        const total = [...byKind.values()].reduce((a, b) => a + b, 0) || 1;
        const parts = [];
        for (const k of kinds) {
          const b = byKind.get(k);
          if (!b) continue;
          const seg = el("i");
          seg.style.flex = `${b} 1 0`;
          seg.style.background = cssVar(kindMeta(k)[1]);
          seg.tabIndex = 0;
          const share = pct((b / total) * 100);
          seg.setAttribute("aria-label", `${p.label} ${kindMeta(k)[0]}: ${bytesFmt(b)}, ${share}`);
          const show = (e) => showTip(e, `${p.label} · ${kindMeta(k)[0]}`, [["Bytes", bytesFmt(b), cssVar(kindMeta(k)[1])], ["~Tokens", fmt(b / 4)], ["Share", share]]);
          seg.addEventListener("pointermove", show);
          seg.addEventListener("focus", show);
          seg.addEventListener("pointerleave", hideTip);
          seg.addEventListener("blur", hideTip);
          bar.append(seg);
          parts.push(`${kindMeta(k)[0]} ${share}`);
          tableRows.push([p.label, kindMeta(k)[0], bytesFmt(b), fmt(b / 4), share]);
        }
        bar.setAttribute("aria-label", `${p.label}: ${parts.join(", ")}`);
        row.append(bar, el("div", "tk-stack-x", `~${fmt(p.tokensEst)}`));
        stack.append(row);
      }
      bp.append(stack, legend(kinds.map((k) => [kindMeta(k)[0], cssVar(kindMeta(k)[1])])), asTable(["Provider", "Type", "Bytes", "~Tokens", "Share"], tableRows));
      oh.append(bp);

      // sources per provider
      const sp = panel("Sources", "Largest first");
      for (const p of provs) {
        const h = el("h3", "tk-ph", p.label);
        const list = el("div", "tk-src");
        list.setAttribute("role", "table");
        list.setAttribute("aria-label", `${p.label} sources`);
        const head = el("div", "tk-r tk-rh");
        head.setAttribute("role", "row");
        for (const [c, cls] of [["Source", "s"], ["Path", "p"], ["Bytes", "b"], ["~Tokens", "t"], ["Flags", "f"]]) { const d = el("div", cls, c); d.setAttribute("role", "columnheader"); head.append(d); }
        list.append(head);
        const label = new Map(p.sources.map((s) => [s.id, s.label]));
        for (const s of [...p.sources].sort((a, b) => b.bytes - a.bytes)) {
          const r = el("div", "tk-r");
          r.setAttribute("role", "row");
          const name = el("div", "s");
          name.setAttribute("role", "cell");
          name.append(el("span", "", s.label));
          if (s.count != null) name.append(el("span", "tk-count", ` ${NF.format(s.count)}`));
          if (s.items?.length) {
            const d = el("details", "tk-items");
            d.append(el("summary", "", `Top items (${s.items.length})`));
            const ul = el("ul");
            for (const it of s.items) { const li = el("li"); li.append(el("span", "", it.name), el("span", "tk-num", bytesFmt(it.bytes))); ul.append(li); }
            d.append(ul);
            name.append(d);
          }
          const path = el("div", "p", homeRel(s.path) || "—"); path.setAttribute("role", "cell"); if (s.path) path.title = s.path;
          const by = el("div", "b", s.missing ? "—" : bytesFmt(s.bytes)); by.setAttribute("role", "cell");
          const tk = el("div", "t", s.missing ? "—" : `~${fmt(s.tokensEst)}`); tk.setAttribute("role", "cell");
          const fl = el("div", "f"); fl.setAttribute("role", "cell");
          const flag = (text, tone) => fl.append(el("span", `tk-flag${tone ? ` ${tone}` : ""}`, text));
          if (s.missing) flag("Missing");
          if (s.dupOf) flag(`Same as ${label.get(s.dupOf) || s.dupOf}`, "warn");
          if (s.dupSections?.length) flag(`${s.dupSections.length} duplicate ${s.dupSections.length === 1 ? "section" : "sections"}`, "warn");
          if (s.hidden) flag(`${NF.format(s.hidden)} hidden`);
          if (!fl.childNodes.length) fl.append(el("span", "tk-none", "—"));
          r.append(name, path, by, tk, fl);
          list.append(r);
        }
        sp.append(h, list);
      }
      oh.append(sp);

      // duplicates
      const dups = overhead.duplicates || [];
      const dp = panel("Duplicates", "Sections that appear in more than one file of the same provider");
      if (!dups.length) dp.append(empty("No duplicated sections found."));
      else {
        const ul = el("ul", "tk-dups");
        const labelOf = (prov, id) => overhead.providers?.find((x) => x.id === prov)?.sources.find((s) => s.id === id)?.label || id;
        const provLabel = (id) => overhead.providers?.find((x) => x.id === id)?.label || id;
        for (const d of dups) {
          const li = el("li");
          const top = el("div", "tk-dup-h");
          const badge = el("span", "tk-flag warn");
          badge.innerHTML = WARN_ICON;
          badge.append("Duplicate");
          top.append(badge, el("strong", "", d.heading || "(untitled)"));
          li.append(top, el("div", "muted tk-dup-d", `${provLabel(d.provider)} · ${bytesFmt(d.bytes)} · in ${d.sources.map((s) => labelOf(d.provider, s)).join(", ")}`));
          ul.append(li);
        }
        dp.append(ul);
      }
      oh.append(dp);
      if (overhead.skipped?.length) {
        const rs = {};
        for (const s of overhead.skipped) rs[s.reason] = (rs[s.reason] || 0) + 1;
        oh.append(el("p", "note", `Skipped ${overhead.skipped.length} ${overhead.skipped.length === 1 ? "file" : "files"}: ${Object.entries(rs).map(([k, n]) => `${n} ${k}`).join(", ")}.`));
      }
    }
  }
  oh.append(note);
  root.replaceChildren(wrap);
}
