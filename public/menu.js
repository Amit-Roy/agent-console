// Accessible popover menu button, replacing native <select> (listbox, value picker) and serving as an actions menu (menu).
//   const m = createMenu({ trigger, items:[{value,label,desc?,icon?,tone?,disabled?,keep?,checked?,children?}], value, onSelect, onOpen?, onClose?, kind:"listbox"|"menu", side:"top"|"bottom", align:"start"|"end" })
// Keyboard: trigger opens with Enter / Space / ArrowDown / ArrowUp. In the popover: ArrowUp/Down, Home/End, typeahead, Enter/Space select,
// Right opens a submenu; Left, Back, or Esc returns to its parent. Esc at the root returns focus to the trigger; Tab closes. Click or tap outside closes. Items are >=44px on coarse pointers (see .menu in style.css).
import { el, icon } from "/render.js";

let uid = 0;
const openMenus = new Set();

export function createMenu(opts) {
  const o = { kind: "listbox", side: "bottom", align: "start", onSelect() {}, onOpen() {}, onClose() {}, renderTrigger: null, label: "", ...opts };
  const trigger = o.trigger;
  const id = `menu-${++uid}`;
  const itemRole = o.kind === "menu" ? "menuitem" : "option";
  let items = o.items || [];
  let value = o.value;
  let pop = null;
  let active = -1;
  let typed = "";
  let typedAt = 0;
  let parents = [];
  let rootItems = items;

  trigger.setAttribute("aria-haspopup", o.kind === "menu" ? "menu" : "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const enabled = (i) => items[i] && !items[i].disabled;
  const current = () => items.find((i) => i.value === value);

  function paintTrigger() {
    const it = current();
    if (o.renderTrigger) return o.renderTrigger(it, trigger);
    const span = trigger.querySelector("span") || trigger.appendChild(el("span"));
    span.textContent = it ? it.label : "";
  }

  function setActive(i, scroll = true) {
    if (!pop) return;
    active = i;
    pop.querySelectorAll("[data-active]").forEach((n) => n.removeAttribute("data-active"));
    const node = pop.children[i];
    if (!node) return pop.removeAttribute("aria-activedescendant");
    node.setAttribute("data-active", "");
    pop.setAttribute("aria-activedescendant", node.id);
    // Scroll the list itself; scrollIntoView also moves the dialog and dismisses this menu.
    if (scroll) {
      if (node.offsetTop < pop.scrollTop) pop.scrollTop = node.offsetTop;
      else if (node.offsetTop + node.offsetHeight > pop.scrollTop + pop.clientHeight) pop.scrollTop = node.offsetTop + node.offsetHeight - pop.clientHeight;
    }
  }
  function move(delta, from = active) {
    let i = from;
    for (let n = 0; n < items.length; n++) {
      i += delta;
      if (i < 0 || i >= items.length) return;
      if (enabled(i)) return setActive(i);
    }
  }

  function place() {
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, gap = 6, pad = 8;
    pop.style.minWidth = o.kind === "listbox" && trigger.classList.contains("field") ? `${r.width}px` : "";
    pop.style.maxHeight = "";
    const h = pop.offsetHeight, w = pop.offsetWidth;
    const below = vh - r.bottom - gap - pad, above = r.top - gap - pad;
    let side = o.side;
    if (side === "bottom" && h > below && above > below) side = "top";
    else if (side === "top" && h > above && below > above) side = "bottom";
    const room = side === "top" ? above : below;
    pop.style.maxHeight = `${Math.max(120, Math.min(room, 24 * 16))}px`;
    const hh = Math.min(h, room);
    pop.style.top = `${side === "top" ? r.top - gap - hh : r.bottom + gap}px`;
    let left = o.align === "end" ? r.right - w : r.left;
    left = Math.max(pad, Math.min(left, vw - w - pad));
    pop.style.left = `${left}px`;
    pop.dataset.side = side;
  }

  function open(start = "selected", nested = false) {
    if (pop || trigger.disabled) return;
    if (!nested) {
      parents = [];
      items = o.getItems ? o.getItems() : rootItems;
      rootItems = items;
    }
    if (!items.length) return;
    for (const m of openMenus) m.close(false);
    pop = el("div", "menu");
    pop.id = id;
    pop.tabIndex = -1;
    pop.setAttribute("role", o.kind);
    pop.setAttribute("aria-label", o.label || trigger.getAttribute("aria-label") || trigger.title || "Menu");
    items.forEach((it, i) => {
      const n = el("div");
      n.id = `${id}-${i}`;
      n.setAttribute("role", itemRole);
      if (o.kind === "listbox") n.setAttribute("aria-selected", String(it.keep ? !!it.checked : it.value === value));
      if (it.disabled) n.setAttribute("aria-disabled", "true");
      if (it.tone) n.dataset.tone = it.tone;
      if (it.icon) {
        const ic = icon(it.icon, "m-ico");
        n.append(ic);
      }
      const txt = el("span", "m-txt");
      txt.append(el("span", "m-label", it.label));
      if (it.desc) txt.append(el("span", "m-desc", it.desc));
      n.append(txt, icon(it.children ? "chev-right" : "check", it.children ? "m-ico" : "m-check"));
      if (it.children) n.setAttribute("aria-haspopup", "menu");
      n.addEventListener("pointermove", () => active !== i && enabled(i) && setActive(i, false));
      n.addEventListener("click", () => enabled(i) && choose(i));
      pop.append(n);
    });
    (trigger.closest("dialog") || document.body).append(pop); // inside an open <dialog> so it sits in the top layer with it
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", id);
    place();
    const sel = items.findIndex((it) => it.value === value && !it.disabled);
    const first = items.findIndex((_, i) => enabled(i));
    const last = items.length - 1 - [...items].reverse().findIndex((_, i) => enabled(items.length - 1 - i));
    setActive(start === "last" ? last : start === "first" ? first : sel >= 0 ? sel : first);
    pop.focus({ preventScroll: true });
    pop.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onScroll, true);
    openMenus.add(api);
    if (!nested) o.onOpen();
  }

  function close(returnFocus = true, notify = true) {
    if (!pop) return;
    const p = pop;
    pop = null;
    openMenus.delete(api);
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", onDismiss);
    window.removeEventListener("scroll", onScroll, true);
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-controls");
    p.remove();
    if (returnFocus) trigger.focus({ preventScroll: true });
    if (notify) o.onClose();
  }

  function showItems(next, selected) {
    close(false, false);
    items = next;
    typed = "";
    open("first", true);
    if (selected != null) setActive(selected);
  }

  function back() {
    const parent = parents.pop();
    if (parent) showItems(parent.items, parent.active);
  }

  function choose(i) {
    const it = items[i];
    if (it.back) return back();
    if (it.children) {
      parents.push({ items, active: i });
      return showItems([{ value: "menu-back", label: "Back", back: true }, ...it.children]);
    }
    close(true);
    if (it.keep) { o.onSelect(it.value, it); return; } // an action row (e.g. "Advisor · Opus"): acts without becoming the menu's value
    if (o.kind === "listbox") {
      if (it.value === value) return;
      if (o.onSelect(it.value, it) === false) return;
      value = it.value;
      paintTrigger();
    } else o.onSelect(it.value, it);
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case "ArrowRight":
        if (items[active]?.children) { e.preventDefault(); choose(active); }
        return;
      case "ArrowLeft":
        if (parents.length) { e.preventDefault(); back(); }
        return;
      case "ArrowDown": e.preventDefault(); return move(1);
      case "ArrowUp": e.preventDefault(); return move(-1);
      case "Home": e.preventDefault(); return move(1, -1);
      case "End": e.preventDefault(); return move(-1, items.length);
      case "Enter":
      case " ":
        e.preventDefault();
        if (typed && e.key === " ") break; // space inside a typeahead word
        return enabled(active) && choose(active);
      case "Escape": e.preventDefault(); e.stopPropagation(); return parents.length ? back() : close(true);
      case "Tab": return close(true); // focus is back on the trigger, so Tab moves on from there
    }
    if (e.key.length === 1 && /\S/.test(e.key) || (e.key === " " && typed)) {
      const now = Date.now();
      typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = now;
      const order = [...items.keys()];
      const from = typed.length === 1 ? active + 1 : active; // repeated single letter cycles
      const rot = order.slice(from).concat(order.slice(0, from));
      const hit = rot.find((i) => enabled(i) && items[i].label.toLowerCase().startsWith(typed));
      if (hit != null) setActive(hit);
      e.preventDefault();
    }
  }
  function onOutside(e) {
    if (pop && !pop.contains(e.target) && !trigger.contains(e.target)) close(false);
  }
  function onDismiss() { close(false); }
  // only scrolling that moves the trigger dismisses the menu (the chat scrolling while history loads must not)
  function onScroll(e) { if (pop && !pop.contains(e.target) && (e.target === document || e.target.contains?.(trigger))) close(false); }

  trigger.addEventListener("click", () => (pop ? close(true) : open()));
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      pop || open(e.key === "ArrowUp" ? "last" : "first");
    }
  });

  const api = {
    open, close,
    get value() { return value; },
    get isOpen() { return !!pop; },
    setValue(v) { value = v; paintTrigger(); },
    setItems(next, v = value) { rootItems = items = next; value = v; paintTrigger(); },
    setDisabled(b) { trigger.disabled = b; if (b) close(false); },
    items: () => items,
  };
  paintTrigger();
  return api;
}
