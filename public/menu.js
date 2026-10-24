// Accessible popover menu button for value pickers (listbox) and actions (menu).
//   const m = createMenu({ trigger, items:[{value,label,desc?,group?,icon?,tone?,disabled?,keep?,checked?,children?}], value, onSelect, onOpen?, onClose?, kind:"listbox"|"menu", side:"top"|"bottom", align:"start"|"end" })
// Keyboard: trigger opens with Enter / Space / ArrowDown / ArrowUp. In the popover: ArrowUp/Down, Home/End, typeahead, Enter/Space select,
// Right opens a submenu; Left, Back, or Esc returns to its parent. Esc at the root returns focus to the trigger; Tab closes. Click or tap outside closes. Items are >=44px on coarse pointers (see .menu in style.css).
// Local DOM helpers keep this module independent of render.js and its markdown/highlight vendors.
const SVG = "http://www.w3.org/2000/svg";
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const icon = (name, cls = "") => {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", cls ? `ico ${cls}` : "ico");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};

let uid = 0;
const openMenus = new Set();

function isEnabled(ctx, index) {
  return ctx.items[index] && !ctx.items[index].disabled;
}

function currentItem(ctx) {
  return ctx.items.find((item) => item.value === ctx.value);
}

function paintTrigger(ctx) {
  const item = currentItem(ctx);
  if (ctx.config.renderTrigger) return ctx.config.renderTrigger(item, ctx.trigger);
  const span = ctx.trigger.querySelector("span") || ctx.trigger.appendChild(el("span"));
  span.textContent = item ? item.label : "";
}

function scrollNodeIntoPopup(popup, node) {
  if (node.offsetTop < popup.scrollTop) popup.scrollTop = node.offsetTop;
  else if (node.offsetTop + node.offsetHeight > popup.scrollTop + popup.clientHeight)
    popup.scrollTop = node.offsetTop + node.offsetHeight - popup.clientHeight;
}

function setActive(ctx, index, scroll = true) {
  const popup = ctx.pop;
  if (!popup) return;
  ctx.active = index;
  popup.querySelectorAll("[data-active]").forEach((node) => {
    node.removeAttribute("data-active");
  });
  const node = popup.querySelector(`[id="${ctx.id}-${index}"]`);
  if (!node) return popup.removeAttribute("aria-activedescendant");
  node.setAttribute("data-active", "");
  popup.setAttribute("aria-activedescendant", node.id);
  // Scroll the list itself; scrollIntoView also moves the dialog and dismisses this menu.
  if (scroll) scrollNodeIntoPopup(popup, node);
}

function moveActive(ctx, delta, from = ctx.active) {
  let index = from;
  for (let step = 0; step < ctx.items.length; step++) {
    index += delta;
    if (index < 0 || index >= ctx.items.length) return;
    if (isEnabled(ctx, index)) return setActive(ctx, index);
  }
}

function pickSide(preferred, height, above, below) {
  if (preferred === "bottom" && height > below && above > below) return "top";
  if (preferred === "top" && height > above && below > above) return "bottom";
  return preferred;
}

function placeMenu(ctx) {
  const { pop: popup, trigger, config } = ctx;
  const rect = trigger.getBoundingClientRect();
  const viewWidth = document.documentElement.clientWidth,
    viewHeight = window.innerHeight,
    gap = 6,
    pad = 8;
  popup.style.minWidth =
    config.kind === "listbox" && trigger.classList.contains("field") ? `${rect.width}px` : "";
  popup.style.maxHeight = "";
  const height = popup.offsetHeight,
    width = popup.offsetWidth;
  const below = viewHeight - rect.bottom - gap - pad,
    above = rect.top - gap - pad;
  const side = pickSide(config.side, height, above, below);
  const room = side === "top" ? above : below;
  popup.style.maxHeight = `${Math.max(120, Math.min(room, 24 * 16))}px`;
  const shownHeight = Math.min(height, room);
  popup.style.top = `${side === "top" ? rect.top - gap - shownHeight : rect.bottom + gap}px`;
  let left = config.align === "end" ? rect.right - width : rect.left;
  left = Math.max(pad, Math.min(left, viewWidth - width - pad));
  popup.style.left = `${left}px`;
  popup.dataset.side = side;
}

function buildItemNode(ctx, item, index) {
  const { config } = ctx;
  const node = el("div");
  node.id = `${ctx.id}-${index}`;
  node.dataset.value = String(item.value);
  node.setAttribute("role", ctx.itemRole);
  if (config.kind === "listbox")
    node.setAttribute(
      "aria-selected",
      String(item.keep ? !!item.checked : item.value === ctx.value),
    );
  if (item.disabled) node.setAttribute("aria-disabled", "true");
  if (item.tone) node.dataset.tone = item.tone;
  if (item.icon) {
    const itemIcon = icon(item.icon, "m-ico");
    node.append(itemIcon);
  }
  const text = el("span", "m-txt");
  text.append(el("span", "m-label", item.label));
  if (item.desc) text.append(el("span", "m-desc", item.desc));
  node.append(
    text,
    icon(item.children ? "chev-right" : "check", item.children ? "m-ico" : "m-check"),
  );
  if (item.children) node.setAttribute("aria-haspopup", "menu");
  return node;
}

function appendItems(ctx) {
  let group = "";
  ctx.items.forEach((item, index) => {
    if (item.group && item.group !== group) {
      group = item.group;
      const heading = el("div", "m-group", group);
      heading.setAttribute("aria-hidden", "true");
      ctx.pop.append(heading);
    }
    const node = buildItemNode(ctx, item, index);
    node.addEventListener(
      "pointermove",
      () => ctx.active !== index && isEnabled(ctx, index) && setActive(ctx, index, false),
    );
    node.addEventListener("click", () => isEnabled(ctx, index) && chooseItem(ctx, index));
    ctx.pop.append(node);
  });
}

function loadRootItems(ctx) {
  ctx.parents = [];
  ctx.items = ctx.config.getItems ? ctx.config.getItems() : ctx.rootItems;
  ctx.rootItems = ctx.items;
}

function createPopup(ctx, nested) {
  const { config, trigger } = ctx;
  const popup = el("div", "menu");
  ctx.pop = popup;
  popup.id = ctx.id;
  popup.tabIndex = -1;
  popup.setAttribute("role", config.kind);
  popup.setAttribute(
    "aria-label",
    config.label || trigger.getAttribute("aria-label") || trigger.title || "Menu",
  );
  const head = !nested && (typeof config.header === "function" ? config.header() : config.header); // read-only context line, e.g. a thread's full title
  if (head) popup.append(el("div", "m-head", head));
  return popup;
}

function startIndex(ctx, start) {
  const { items } = ctx;
  const selected = items.findIndex((item) => item.value === ctx.value && !item.disabled);
  const first = items.findIndex((_item, index) => isEnabled(ctx, index));
  const last =
    items.length -
    1 -
    [...items].reverse().findIndex((_item, index) => isEnabled(ctx, items.length - 1 - index));
  if (start === "last") return last;
  if (start === "first") return first;
  return selected >= 0 ? selected : first;
}

function openMenu(ctx, start = "selected", nested = false) {
  const { trigger } = ctx;
  if (ctx.pop || trigger.disabled) return;
  if (!nested) loadRootItems(ctx);
  if (!ctx.items.length) return;
  for (const menu of openMenus) menu.close(false);
  const popup = createPopup(ctx, nested);
  appendItems(ctx);
  (trigger.closest("dialog") || document.body).append(popup); // inside an open <dialog> so it sits in the top layer with it
  trigger.setAttribute("aria-expanded", "true");
  trigger.setAttribute("aria-controls", ctx.id);
  placeMenu(ctx);
  ctx.openedAt = performance.now();
  setActive(ctx, startIndex(ctx, start));
  popup.focus({ preventScroll: true });
  popup.addEventListener("keydown", ctx.onKey);
  document.addEventListener("pointerdown", ctx.onOutside, true);
  window.addEventListener("resize", ctx.onDismiss);
  window.addEventListener("scroll", ctx.onScroll, true);
  openMenus.add(ctx.api);
  if (!nested) ctx.config.onOpen();
}

function closeMenu(ctx, returnFocus = true, notify = true) {
  const popup = ctx.pop;
  if (!popup) return;
  ctx.pop = null;
  openMenus.delete(ctx.api);
  document.removeEventListener("pointerdown", ctx.onOutside, true);
  window.removeEventListener("resize", ctx.onDismiss);
  window.removeEventListener("scroll", ctx.onScroll, true);
  ctx.trigger.setAttribute("aria-expanded", "false");
  ctx.trigger.removeAttribute("aria-controls");
  popup.remove();
  if (returnFocus) ctx.trigger.focus({ preventScroll: true });
  if (notify) ctx.config.onClose();
}

function showItems(ctx, nextItems, selected) {
  closeMenu(ctx, false, false);
  ctx.items = nextItems;
  ctx.typed = "";
  openMenu(ctx, "first", true);
  if (selected != null) setActive(ctx, selected);
}

function goBack(ctx) {
  const parent = ctx.parents.pop();
  if (parent) showItems(ctx, parent.items, parent.active);
}

function selectValue(ctx, item) {
  const { config } = ctx;
  if (item.keep) {
    config.onSelect(item.value, item);
    return;
  } // an action row (e.g. "Advisor · Opus"): acts without becoming the menu's value
  if (config.kind !== "listbox") {
    config.onSelect(item.value, item);
    return;
  }
  if (item.value === ctx.value) return;
  if (config.onSelect(item.value, item) === false) return;
  ctx.value = item.value;
  paintTrigger(ctx);
}

function chooseItem(ctx, index) {
  const item = ctx.items[index];
  if (item.back) return goBack(ctx);
  if (item.children) {
    ctx.parents.push({ items: ctx.items, active: index });
    return showItems(ctx, [{ value: "menu-back", label: "Back", back: true }, ...item.children]);
  }
  closeMenu(ctx, true);
  selectValue(ctx, item);
}

function keyOpenSubmenu(ctx, event) {
  if (ctx.items[ctx.active]?.children) {
    event.preventDefault();
    chooseItem(ctx, ctx.active);
  }
  return true;
}

function keyBack(ctx, event) {
  if (ctx.parents.length) {
    event.preventDefault();
    goBack(ctx);
  }
  return true;
}

function keyMove(delta, fromEnd) {
  return (ctx, event) => {
    event.preventDefault();
    if (fromEnd == null) moveActive(ctx, delta);
    else moveActive(ctx, delta, fromEnd === "end" ? ctx.items.length : fromEnd);
    return true;
  };
}

function keyChoose(ctx, event) {
  event.preventDefault();
  if (ctx.typed && event.key === " ") return false; // space inside a typeahead word
  if (isEnabled(ctx, ctx.active)) chooseItem(ctx, ctx.active);
  return true;
}

function keyEscape(ctx, event) {
  event.preventDefault();
  event.stopPropagation();
  if (ctx.parents.length) goBack(ctx);
  else closeMenu(ctx, true);
  return true;
}

function keyTab(ctx) {
  closeMenu(ctx, true); // focus is back on the trigger, so Tab moves on from there
  return true;
}

const NAVIGATION_KEYS = {
  ArrowRight: keyOpenSubmenu,
  ArrowLeft: keyBack,
  ArrowDown: keyMove(1),
  ArrowUp: keyMove(-1),
  Home: keyMove(1, -1),
  End: keyMove(-1, "end"),
  Enter: keyChoose,
  " ": keyChoose,
  Escape: keyEscape,
  Tab: keyTab,
};

function typeAhead(ctx, event) {
  const now = Date.now();
  ctx.typed =
    now - ctx.typedAt > 700 ? event.key.toLowerCase() : ctx.typed + event.key.toLowerCase();
  ctx.typedAt = now;
  const order = [...ctx.items.keys()];
  const from = ctx.typed.length === 1 ? ctx.active + 1 : ctx.active; // repeated single letter cycles
  const rotated = order.slice(from).concat(order.slice(0, from));
  const hit = rotated.find(
    (index) => isEnabled(ctx, index) && ctx.items[index].label.toLowerCase().startsWith(ctx.typed),
  );
  if (hit != null) setActive(ctx, hit);
  event.preventDefault();
}

function handleKey(ctx, event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const navigate = Object.hasOwn(NAVIGATION_KEYS, event.key) && NAVIGATION_KEYS[event.key];
  if (navigate && navigate(ctx, event)) return;
  if ((event.key.length === 1 && /\S/.test(event.key)) || (event.key === " " && ctx.typed))
    typeAhead(ctx, event);
}

function handleOutside(ctx, event) {
  if (ctx.pop && !ctx.pop.contains(event.target) && !ctx.trigger.contains(event.target))
    closeMenu(ctx, false);
}

// only scrolling that moves the trigger dismisses the menu (the chat scrolling while history loads must not)
function handleScroll(ctx, event) {
  // Ignore the scroll that brings the trigger into view just before a tap opens this menu.
  if (performance.now() - ctx.openedAt < 150) return;
  const target = event.target;
  if (
    ctx.pop &&
    !ctx.pop.contains(target) &&
    (target === document || target.contains?.(ctx.trigger))
  )
    closeMenu(ctx, false);
}

function createMenuApi(ctx) {
  return {
    open: (start, nested) => openMenu(ctx, start, nested),
    close: (returnFocus, notify) => closeMenu(ctx, returnFocus, notify),
    get value() {
      return ctx.value;
    },
    get isOpen() {
      return !!ctx.pop;
    },
    setValue(newValue) {
      ctx.value = newValue;
      paintTrigger(ctx);
    },
    setItems(nextItems, newValue = ctx.value) {
      ctx.rootItems = ctx.items = nextItems;
      ctx.value = newValue;
      paintTrigger(ctx);
    },
    setDisabled(disabled) {
      ctx.trigger.disabled = disabled;
      if (disabled) closeMenu(ctx, false);
    },
    items: () => ctx.items,
  };
}

export function createMenu(opts) {
  const config = {
    kind: "listbox",
    side: "bottom",
    align: "start",
    onSelect() {},
    onOpen() {},
    onClose() {},
    renderTrigger: null,
    label: "",
    ...opts,
  };
  const items = config.items || [];
  const ctx = {
    config,
    trigger: config.trigger,
    id: `menu-${++uid}`,
    itemRole: config.kind === "menu" ? "menuitem" : "option",
    items,
    value: config.value,
    pop: null,
    active: -1,
    typed: "",
    typedAt: 0,
    parents: [],
    rootItems: items,
    openedAt: 0,
    api: null,
  };
  ctx.onKey = (event) => handleKey(ctx, event);
  ctx.onOutside = (event) => handleOutside(ctx, event);
  ctx.onDismiss = () => closeMenu(ctx, false);
  ctx.onScroll = (event) => handleScroll(ctx, event);

  const { trigger } = ctx;
  trigger.setAttribute("aria-haspopup", config.kind === "menu" ? "menu" : "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", () => (ctx.pop ? closeMenu(ctx, true) : openMenu(ctx)));
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      ctx.pop || openMenu(ctx, event.key === "ArrowUp" ? "last" : "first");
    }
  });
  ctx.api = createMenuApi(ctx);
  paintTrigger(ctx);
  return ctx.api;
}
