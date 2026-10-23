// App ideas: list from index.md, add an idea (committed by the server), open an idea's markdown. Hash routes: "" list, "#/<slug>" one idea.
import { $, el, renderMarkdown } from "/render.js";

let ideas = [];
let current = ""; // slug of the open idea, "" on the list
const api = async (url, opts) => {
  const r = await fetch(url, { cache: "no-store", ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status}).`);
  return body;
};
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    t.hidden = true;
  }, 3000);
}
const chevron = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "ico chev");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M6 3.5 10.5 8 6 12.5");
  s.append(p);
  return s;
};

function renderList() {
  $("list").replaceChildren(
    ...ideas.map((i) => {
      const a = el("a");
      a.href = `#/${i.slug}`;
      const text = el("span", "txt");
      text.append(el("span", "n", i.name), el("span", "l", i.line));
      a.append(text, chevron());
      const li = el("li");
      li.append(a);
      return li;
    }),
  );
  $("status").textContent = ideas.length ? "" : "No ideas yet. Add the first one.";
  $("status").hidden = !!ideas.length;
}

async function loadList() {
  try {
    const d = await api("/api/ideas");
    ideas = d.ideas;
    $("repo").textContent = `Saved in ${d.dir}`;
    renderList();
  } catch (e) {
    $("status").textContent = e.message;
    $("status").hidden = false;
  }
}

async function route() {
  const slug = /^#\/([a-z0-9-]+)$/.exec(location.hash)?.[1];
  const detail = $("detail");
  $("listView").hidden = !!slug;
  detail.hidden = !slug;
  $("add").hidden = !!slug;
  $("addBullet").hidden = !slug;
  current = slug ?? "";
  $("back").href = slug ? "#" : "/";
  $("back").setAttribute("aria-label", slug ? "Back to all ideas" : "Back to the console");
  $("backLabel").textContent = slug ? "Ideas" : "Console";
  setForm(false);
  setBulletForm(false);
  $("im").setAttribute("aria-busy", "true");
  if (!slug) {
    $("title").textContent = "App ideas";
    document.title = "App ideas · Agent Console";
    await loadList();
  } else {
    const known = ideas.find((i) => i.slug === slug);
    $("title").textContent = known?.name ?? "Idea";
    detail.replaceChildren(el("p", "muted", "Loading…"));
    try {
      const d = await api(`/api/ideas/${slug}`);
      $("title").textContent = d.name;
      document.title = `${d.name} · App ideas`;
      renderMarkdown(d.markdown, detail);
    } catch (e) {
      detail.replaceChildren(el("p", "muted", e.message));
    }
  }
  $("im").setAttribute("aria-busy", "false");
}

function setForm(open) {
  $("form").hidden = !open;
  $("add").setAttribute("aria-expanded", String(open));
  $("formErr").hidden = true;
  if (open) $("name").focus();
}
$("add").onclick = () => setForm($("form").hidden);
$("cancel").onclick = () => {
  $("form").reset();
  setForm(false);
};
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const save = $("save");
  save.disabled = true;
  $("formErr").hidden = true;
  try {
    const r = await api("/api/ideas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("name").value, line: $("line").value }),
    });
    $("form").reset();
    setForm(false);
    ideas.push(r.idea);
    renderList();
    toast(
      r.pushed === false
        ? `Committed ${r.commit}, but the push failed: ${r.pushError}`
        : `Committed ${r.commit}${r.pushed ? " and pushed" : ""}.`,
    );
  } catch (err) {
    $("formErr").textContent = err.message;
    $("formErr").hidden = false;
  } finally {
    save.disabled = false;
  }
});
function setBulletForm(open) {
  $("bulletForm").hidden = !open;
  $("addBullet").setAttribute("aria-expanded", String(open));
  $("bulletErr").hidden = true;
  if (open) $("bullet").focus();
}
$("addBullet").onclick = () => setBulletForm($("bulletForm").hidden);
$("bulletCancel").onclick = () => {
  $("bulletForm").reset();
  setBulletForm(false);
};
$("bulletForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const save = $("bulletSave"),
    slug = current;
  save.disabled = true;
  $("bulletErr").hidden = true;
  try {
    const r = await api(`/api/ideas/${slug}/bullets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        section: new FormData($("bulletForm")).get("section"),
        text: $("bullet").value,
      }),
    });
    $("bulletForm").reset();
    setBulletForm(false);
    if (current === slug) renderMarkdown((await api(`/api/ideas/${slug}`)).markdown, $("detail"));
    toast(
      r.pushed === false
        ? `Committed ${r.commit}, but the push failed: ${r.pushError}`
        : `Committed ${r.commit}${r.pushed ? " and pushed" : ""}.`,
    );
  } catch (err) {
    $("bulletErr").textContent = err.message;
    $("bulletErr").hidden = false;
  } finally {
    save.disabled = false;
  }
});
addEventListener("hashchange", route);
route();
