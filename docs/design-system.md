# Agent Console Design System

This document outlines the design system for the Agent Console PWA.

## Tokens

The design system uses CSS custom properties (variables) defined in `:root` and media queries for dark mode and touch preferences.

### Typography

- Font families:
  - UI: `--font-ui`: Inter (with fallbacks)
  - Text: `--font-text`: Newsreader (for conversation text)
  - Mono: `--font-mono`: JetBrains Mono (for code and paths)
- Font sizes (defined as `size/line-height`):
  - `--f-xs`: 0.75rem/1rem (12px)
  - `--f-sm`: 0.8125rem/1.125rem (13px)
  - `--f-md`: 0.875rem/1.25rem (14px)
  - `--f-base`: 0.9375rem/1.6rem (15px)
  - `--f-lg`: 1.0625rem/1.5rem (17px)
  - `--f-xl`: 1.25rem/1.75rem (20px)
  - `--f-2xl`: 1.5rem/1.875rem (24px)
  - `--fm-xs`: 0.75rem/1.125rem (12px) for mono
  - `--fm-sm`: 0.8125rem/1.55rem (13px) for mono
- Font weights:
  - `--fw-reg`: 400
  - `--fw-med`: 500
  - `--fw-semi`: 600
  - `--fw-text`: 380 (for body text)
- Letter spacing:
  - `--ls-xs`: 0.01em
  - `--ls-sm`: 0.005em
  - `--ls-md`: 0
  - `--ls-base`: -0.006em
  - `--ls-lg`: -0.011em
  - `--ls-xl`: -0.016em
  - `--ls-2xl`: -0.021em

### Spacing

- `--sp-1`: 0.25rem
- `--sp-2`: 0.5rem
- `--sp-3`: 0.75rem
- `--sp-4`: 1rem
- `--sp-5`: 1.25rem
- `--sp-6`: 1.5rem
- `--sp-8`: 2rem

### Border Radius

- `--r-xs`: 0.375rem
- `--r-sm`: 0.625rem
- `--r-md`: 0.875rem
- `--r-lg`: 1.25rem
- `--r-xl`: 1.5rem
- `--r-full`: 999px (pill)

### Animation Durations

- `--dur-1`: 120ms
- `--dur-2`: 160ms
- `--dur-3`: 200ms
- `--ease`: cubic-bezier(.2,.7,.2,1)

### Layout

- `--col`: 46rem (reading column width)
- `--side-w`: 16.5rem (sidebar width)
- Control heights:
  - `--ctl-h`: 2rem (fine pointer)
  - `--ctl-h-sm`: 1.75rem (small control height)
  - `--item-h`: 2.25rem (item height)
  - Adjusted to 2.75rem for touch screens via media query
- Icon size: `--ico`: 1rem
- Icon stroke width: `--ico-stroke`: 1.5

### Colors (Light Theme)

- Surfaces:
  - `--s0`: #eeeef2 (canvas + sidebar)
  - `--s1`: #fff (panel)
  - `--s2`: #f4f4f7 (raised: cards, composer, user bubble)
  - `--s3`: #e7e7ed (hover / pressed)
  - `--pop`: #fff (menus, dialogs)
  - `--code-bg`: #f6f6f9
  - `--code-head`: #ececf1
- Text:
  - `--t1`: #17171b (primary text)
  - `--t2`: #51515c (secondary text)
  - `--t3`: #62626d (tertiary text)
- Accent:
  - `--accent`: #4a43d6
  - `--fill`: #4a43d6
  - `--on-fill`: #fff
  - `--fill-hover`: #3f38c4
  - `--accent-tint`: rgba(74,67,214,.1)
  - `--sel`: #e4e4f5
- Status:
  - `--ok`: #13703a
  - `--warn`: #7d4a00
  - `--bad`: #bf2a22
  - `--stop`: #dc2626
  - `--on-stop`: #fff
- Misc:
  - `--hover`: rgba(20,20,40,.06)
  - `--press`: rgba(20,20,40,.1)
  - `--edge`: rgba(20,20,40,.1)
  - `--edge-strong`: rgba(20,20,40,.16)
  - `--scrim`: rgba(10,10,20,.35)
  - `--shadow-card`: 0 1px 2px rgba(20,20,40,.06)
  - `--shadow-pop`: 0 12px 32px rgba(20,20,40,.16),0 2px 6px rgba(20,20,40,.08)
  - `--focus`: #4a43d6
  - Syntax highlighting colors (for code blocks):
    - `--hl-kw`: #c2255c
    - `--hl-str`: #2f7d1f
    - `--hl-num`: #b45309
    - `--hl-fn`: #1d5fb8
    - `--hl-type`: #8a5a00
    - `--hl-var`: #b42318
    - `--hl-cmt`: #6b6f7f
    - `--hl-attr`: #0f766e
    - `--hl-meta`: #7c3aed
  - Chart series (viz-1 through viz-6):
    - `--viz-1`: #4a43d6
    - `--viz-2`: #0f766e
    - `--viz-3`: #b45309
    - `--viz-4`: #c2255c
    - `--viz-5`: #1d5fb8
    - `--viz-6`: #7c3aed

### Colors (Dark Theme)

- Surfaces:
  - `--s0`: #0b0b0d
  - `--s1`: #131316
  - `--s2`: #1b1b20
  - `--s3`: #25252b
  - `--pop`: #202026
  - `--code-bg`: #0f0f12
  - `--code-head`: #1a1a1f
- Text:
  - `--t1`: #ededf0
  - `--t2`: #a4a4ae
  - `--t3`: #8d8d98
- Accent:
  - `--accent`: #9aa5ff
  - `--fill`: #5a60ea
  - `--on-fill`: #fff
  - `--fill-hover`: #4f55e0
  - `--accent-tint`: rgba(154,165,255,.14)
  - `--sel`: #1f2133
- Status:
  - `--ok`: #5fd38a
  - `--warn`: #f2b45a
  - `--bad`: #ff8f87
  - `--stop`: #dc2626
  - `--on-stop`: #fff
- Misc:
  - `--hover`: rgba(255,255,255,.06)
  - `--press`: rgba(255,255,255,.1)
  - `--edge`: rgba(255,255,255,.08)
  - `--edge-strong`: rgba(255,255,255,.14)
  - `--scrim`: rgba(0,0,0,.55)
  - `--shadow-card`: 0 1px 2px rgba(0,0,0,.4)
  - `--shadow-pop`: 0 14px 40px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4)
  - `--focus`: #9aa5ff
  - Syntax highlighting:
    - `--hl-kw`: #ff8fa3
    - `--hl-str`: #a6d98a
    - `--hl-num`: #f5a970
    - `--hl-fn`: #7cc4ff
    - `--hl-type`: #e8c27a
    - `--hl-var`: #f0a0a0
    - `--hl-cmt`: #8b90a0
    - `--hl-attr`: #79d3c9
    - `--hl-meta`: #c4a7f5
  - Chart series:
    - `--viz-1`: #9aa5ff
    - `--viz-2`: #79d3c9
    - `--viz-3`: #f5a970
    - `--viz-4`: #ff8fa3
    - `--viz-5`: #7cc4ff
    - `--viz-6`: #c4a7f5

### Touch and Contrast Adjustments

- For touch screens (pointer: coarse): control heights increased to 2.75rem
- For high contrast prefers-contrast: more: text and edge colors adjusted for higher contrast

## Components

The Agent Console uses a component-based approach with vanilla JavaScript. Key components include:

- **Button**: Base component for actions, uses `--f-base`, `--fw-reg`, `--r-md`, `--sp-2`/`--sp-4` padding, `--edge` border, `--s1` background, `--t1` text, `--hover`/`--press` background on interaction, `--focus` outline.
- **Input/Textarea**: Form controls with `--f-base`, `--fw-reg`, `--r-md`, `--sp-2`/`--sp-4` padding, `--edge` border, `--s1` background, `--t1` text, `--focus` outline.
- **Checkbox/Radio**: Toggle controls with `--sp-2` size, `--edge` border, `--s1` background, `--accent` checkmark.
- **Select**: Dropdown with similar styling to input.
- **Modal/Dialog**: Floating panel with `--pop` background, `--shadow-pop`, `--r-lg` radius, `--sp-4` padding.
- **Card**: Raised surface with `--s2` background, `--shadow-card`, `--r-md` radius, `--sp-4` padding.
- **Sidebar**: Fixed vertical panel with `--s0` background, `--sp-4` padding.
- **TabBar**: Horizontal list of tabs, uses `--f-sm`, `--fw-med`, `--s1`/`--s3` for active/inactive, `--sp-2`/`--sp-4` padding.
- **ChatBubble**: Message bubbles with `--s2` background (user) or `--s3` (agent), `--r-md` radius, `--sp-3`/`--sp-4` padding.
- **Composer**: Input area for messages, uses `--s2` background, `--edge` border, `--r-md` radius, `--sp-3`/`--sp-4` padding.
- **Notification**: Toast-like messages with `--s1` background, `--shadow-pop`, `--r-lg` radius, `--sp-4` padding, `--accent` accent bar.
- **Badge**: Small status indicator, uses `--f-xs`, `--fw-med`, `--r-full`, `--sp-1`/`--sp-2` padding, status-based background (`--ok`/`--warn`/`--bad`).

## Usage Guidelines

1. **Tokens First**: All styling should reference design tokens. Avoid hard-coded values.
2. **Dark Mode**: The design system supports dark mode via `prefers-color-scheme` media query. Ensure components adapt to both light and dark surface colors.
3. **Touch Targets**: Minimum touch target size is 44px. Adjust control heights via the `@media (pointer:coarse)` rule.
4. **High Contrast**: Respect `prefers-contrast: more` by adjusting text and edge colors as defined.
5. **Typography Scale**: Use the defined font sizes for consistency. Use `--f-base` for body text, `--f-lg` for titles, etc.
6. **Spacing**: Use the spacing tokens (`--sp-1` through `--sp-8`) for padding and margin.
7. **Component Composition**: Build components by combining tokens and following the patterns outlined above.
8. **Extending the Design System**: To add new tokens, define them in `:root` and dark media query. Add new components by following existing patterns.

## Documentation

This design system is documented in `docs/design-system.md`. Component usage should be documented in the respective component's code or in the `docs/` folder.

## Scope: Component and Token Inventory (In/Out)

Each token and component is explicitly scoped as **In** (published, supported) or **Out** (not in this version, may be added later).

### Tokens — All In
- Typography: font families (UI, Text, Mono), font sizes (f-xs through f-2xl, fm-xs, fm-sm), weights (fw-reg, fw-med, fw-semi, fw-text), letter spacing (ls-xs through ls-2xl) — **In**
- Spacing: sp-1 through sp-8 — **In**
- Border Radius: r-xs through r-full — **In**
- Durations & Easing: dur-1 through dur-3, ease — **In**
- Layout: col, side-w, control heights, icon size — **In**
- Colors (light + dark): surfaces (s0–s3, pop, code-bg, code-head), text (t1–t3), accent/fill/on-fill, status (ok/warn/bad/stop), hover/press/edge/scrim, shadows, focus, visualization series (viz-1–6), syntax highlighting (hl-kw–hl-meta) — **In**

### Components — All In
- Button, Input/Textarea, Checkbox/Radio, Select, Modal/Dialog, Card, Sidebar, TabBar, ChatBubble, Composer, Notification, Badge — **In**

### Out of Scope (v0)
- Data grid / table component — **Out**
- Date picker / calendar — **Out**
- Tooltip / popover — **Out**
- Accordion / disclosure — **Out**
- Carousel / slider — **Out**
- Tree view — **Out**
- Virtual list — **Out**
- Form validation library — **Out**

## Icon-Pack Style Constraint

The design system mandates a single icon pack for visual consistency. All icons use **Lucide** (via inline SVG glyphs) with the following constraints:

- **Stroke weight**: `1.5` (defined by `--ico-stroke: 1.5`), matching the Lucide default for 24×24 canvas.
- **Size**: `1rem` (defined by `--ico: 1rem`), scales with text size.
- **No fills**: Icons must be stroke-only; filled variants are not used in the UI layer.
- **Color**: Icons inherit `currentColor` from the parent, ensuring they follow the token color system (`--accent`, `--t1`, `--t2`, status colors).
- **No external icon fonts**: No Font Awesome, Material Icons, or similar. Lucide SVGs are inlined via the `icon_markup` helper in architecture diagrams and the UI components.

## Publishing

The design system is published as an npm package to GitHub Packages. See `packages/design-system/package.json` for the package configuration.

- **Versioning**: semver in `packages/design-system/package.json`. Token removal or rename = major; new token/component = minor; value tweak = patch.
- **Publish**: `cd packages/design-system && npm publish` (registry `https://npm.pkg.github.com`, needs a GitHub token with `write:packages` in your own `~/.npmrc`; never commit it). `npm pack --dry-run` shows the tarball: `index.js`, `index.d.ts`, `tokens.json`, `design-system.css`.
- **Install**: `npm install @agent-console/design-system`, then `import { tokens, cssString } from '@agent-console/design-system'` or `@agent-console/design-system/css`.

## Popular-opinion sources

`scripts/check-design-system-sources.js` polls these sources and turns new matches into GitHub issues (labels `design-system`, `suggestion`), deduplicated by URL in `.design-system-seen.json`:

| Source | Endpoint | Match |
| --- | --- | --- |
| Reddit r/design_system | `new.json?limit=10` | title has "design system" plus improve/suggestion/idea/feedback |
| Hacker News | newest 50 stories | same title rule, story must have a URL |

Run it: `node scripts/check-design-system-sources.js` (`--dry-run` prints without creating issues). Schedule it daily with the console's Schedules (`schedule_create`, folder = repo root, prompt = run that command and report the result); a manual `schedule_run_now` is the end-to-end check. Matches are appended to `logs/design-system-suggestions.log`. Test: `node test/design-system-sources.ts` (fetch and `gh` are injected, no network).
