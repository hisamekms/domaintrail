# Plan: the brand identity and the colour tokens (issues #34, #33)

Issue #34 rolls out the approved DomainTrail logo (Balanced+ v0.4 / 03 Through) and one colour system for the Live View;
issue #33 holds the design values it refers to (the fixed brand values in §1, the palette targets in §3–§4, the overlay
rules in §5). This plan records what `main` had (the inventory), the token layers that replace the placeholder colours,
the mapping from the old tokens, the contrast checks, and where the logo files go. It was written against `main` at
`8d951a8` (W1: the inventory, the token foundation and the app chrome); the later tasks (chat and agent, diagrams and
legend, the logo) consume the tokens defined here.

## Inventory of `main`

### The theme mechanism

- **One source of tokens**: `apps/web/styles.css` declares every colour as a custom property on `:root` (light) and
  overrides them on `:root[data-theme='dark']`. No component declares its own colour constants.
- **The switch**: `apps/web/theme.ts` resolves the preference (`auto` | `light` | `dark`, stored as JSON under
  `domaintrail.theme`) and writes `<html data-theme>`; it also sets tldraw's `colorScheme`, so tldraw's own canvas
  colours follow. `apps/web/index.html` applies the stored theme before the app loads (no light flash).
- **Bundling**: `scripts/build.ts` builds `apps/web/index.html` with `Bun.build` into `dist/web` (the HTML, one CSS
  chunk, one JS chunk, plus any referenced file, hashed). `apps/dt/src/server/http/assets.ts` loads every file of
  `dist/web` at start and serves it by path (`.svg` as `image/svg+xml`).

### Where colours were used

| Area | Files | Tokens used (before) |
| --- | --- | --- |
| App chrome: left pane, activity bar, view tabs, toolbars, menus, settings dialog, banners, health | `app/shell.tsx`, `app/status.tsx`, `view/toolbar.tsx`, `settings-dialog.tsx` | `--bg`, `--panel`, `--border`, `--border-strong`, `--text`, `--text-soft`, `--muted`, `--hover`, `--hover-strong`, `--accent`, `--violet-tint` (selection), `--neutral-tint`, `--banner-*`, `--shadow` |
| Brand slot | `app/shell.tsx` (`.brand-mark`: lucide `Waypoints` icon; `.brand`: the text "DomainTrail"), `index.html` (no favicon) | `--accent` |
| Explorer, lists, problems, catalog, inspector | `explorer.tsx`, `lists.tsx`, `catalog.tsx`, `inspector.tsx` | chrome tokens, `--violet-tint` (selected row), `--error`/`--warning` (diagnostics), `--added`/`--changed`/`--removed` (row diffs) |
| Chat and session | `session/*.tsx` (`.session-*`, `.chat-*`, `.reply-*`, `.reaction*`, `.vote-*`) | `--accent` (own marks, primary buttons, running state, AI avatar), `--violet-tint` (selected rows, running chip, mention kind), `--warning` (clarification), `--error` (failed), `--added` (completed: a diff token used for a run state), `#fff` on filled badges |
| AI status and activity | `session/activity.tsx`, `session/status.ts`, `session/status-slot.tsx` | `--accent` (running, `.run-activity-icon`, pulses), `--warning`, `--error`, `--added` |
| Presence and cursors | `session/presence.ts` (`participantColor`: `hsl(hash 70% 45%)`, the only colour computed in TypeScript), `session/parts.tsx`, `session/cursors.tsx` | an inline `background`/`color` from `participantColor`, `#fff` text |
| Event Storming | `storming.tsx`, `shapes.tsx` (`.dn-es*`), `.kind-es-*` chips | `--es-*`, `--es-*-border`, `--es-sequence` ("default colours, with no meaning") |
| Domain diagrams, behaviour, states | `shapes.tsx` (`.dn-*`, `.dg-*`, `.de-*`), `behavior.tsx`, `states-canvas.tsx` | `--node-*`, `--ink-strong`, `--context-*`, `--boundary-*`, `--edge*`, `--ref-*`, the hue families `--violet-*`, `--purple-*`, `--blue-*`, `--green-*`, `--teal-*`, `--amber*`, `--red-*`, `--orange-text` |
| Legend | `legend.tsx` (`.legend`, edge samples drawn with the `.de-*` classes) | `--legend-bg`, the edge tokens; the storming note says the colours carry no meaning |
| Diffs | `.change-*`, `.diffrow-*`, `.row-*`, `.dn-change-*`, `.de-tone-*`, `.tree-change-*`, `.diff-*` | `--added`, `--changed`, `--removed`, `--error-wash` (removed node) |
| Diagnostics | `.diag-*`, `.di-diag-*`, `.dn-diag-*`, `.card-diag-*`, `.src-*`, `.problem-*`, `.tree-diag-*`, `.count-*` | `--error`, `--warning`, `--error-wash`, `--warning-wash` |

Hardcoded colours outside the token block: `color: #fff` on filled badges and buttons (32 rules), `background: #fff`
on the selected chat tab's badge, the dialogs' `rgba(0, 0, 0, 0.35)` backdrops, and `participantColor` in TypeScript.
No other hex or `rgb()` colour appears in `apps/web` TypeScript.

**tldraw**: the canvas background, its selection, handles and UI are tldraw's own and follow `colorScheme`; the app
reads one tldraw variable (`--tl-color-background`, the halo behind edge labels). The tokens here do not override any
`--tl-*` variable or `.tl-*` rule; the focus ring below explicitly skips the inside of `.tl-container`. The canvas
background is therefore tldraw's (about `#f9fafb` light, `#101011` dark), not `--bg`; the contrast checks of the
sticky notes' borders use those.

## Token layers

Five layers, in this order in `styles.css`; a rule uses layers 2–5 (or the old aliases), never a primitive.

1. **Primitives** (`--p-*`): the raw palette, declared once on `:root`, the same in both themes (Tailwind-like steps;
   `--p-night-*` are the blue-black neutrals of the dark theme, `-night` suffixes the dark tinted backgrounds,
   `--p-person-*` the identity hues).
2. **Theme**: surfaces, text, borders, action, focus, selected, disabled, hovers.
3. **Meaning**: what an element is: the Event Storming kinds (`--es-*`) and the modeling concepts (`--model-*`).
4. **Status and diff**: how something went (`--status-*`), what changed from the baseline (`--diff-*`).
5. **Collaboration**: chat roles (`--chat-*`), the agent's activity (`--agent-*`), participants (`--participant-*`).

The dark theme re-points layers 2–5 to other primitives. An alias declared on `:root` (`--accent: var(--action)`)
resolves on the same element, so it follows the dark override without being repeated.

**Distinct roles, even with equal values.** The brand amber (`--brand-amber`) is only the logo's dot; warning is
`--status-warning-*`, the event is `--es-event*` / `--model-event`. Indigo is the brand (`--brand-ink`), actions
(`--action`), the local selection (`--selected-*`) and, by design, the agent's running state (`--agent-active`) and the
aggregate root (`--model-aggregate`); each has its own name so that one can change without the others.

### 2. Theme (issue #33 §3.1, plus disabled)

| Token | Light | Dark | Role | Used by |
| --- | --- | --- | --- | --- |
| `--brand-ink` | `#4338CA` | `#A5B4FC` | the logo's ink on this theme | `.brand-mark` |
| `--brand-amber` | `#FBBF24` | `#FBBF24` | the logo's discovery dot (never a status) | the logo only |
| `--bg` | `#F8FAFC` | `#10131D` | application background | `body`, blocks on panels |
| `--surface` | `#FFFFFF` | `#191D2B` | panels, chat, inspector | via `--panel` (45 rules) |
| `--surface-raised` | `#FFFFFF` | `#242A3B` | popovers, menus, dialogs | settings dialog, health popover, pane menu, toolbar menu, baseline menu (chat popovers: to do in the chat task) |
| `--surface-muted` | `#F1F5F9` | `#252B3B` | subtle blocks | new; for the chat and diagram tasks |
| `--text` | `#0F172A` | `#F1F5F9` | primary text | |
| `--text-secondary` | `#475569` | `#CBD5E1` | descriptions | via `--text-soft` |
| `--muted` | `#5E6B7F` | `#94A3B8` | the quietest text: hints, counts, group labels | 117 rules (kept name) |
| `--border` | `#CBD5E1` | `#465066` | separators | 61 rules |
| `--border-strong` | `#8492A6` | `#64708A` | edges of controls and menus (3:1) | 20 rules |
| `--action` | `#4338CA` | `#A5B4FC` | primary controls, links | via `--accent` (92 rules) |
| `--on-action` | `#FFFFFF` | `#10131D` | text and icons on an action fill | every accent-filled badge or button (was `#fff`) |
| `--focus` | `#6366F1` | `#A5B4FC` | keyboard focus ring | the global `:focus-visible` ring, `.explorer-section-title` |
| `--focus-ring` | 30% of `--focus` | same | soft halo (selection of a card) | `.card-selected` |
| `--selected-bg` | `#EEF2FF` | `#30345A` | the local selection | `.activity.active`, `.tree-item.selected`, pressed toggles; via `--violet-tint` the chat's selected rows |
| `--selected-text` | `#312E81` | `#E0E7FF` | text on the selection | `.tree-item.selected` |
| `--disabled-bg` | `#F1F5F9` | `#252B3B` | a disabled filled control | new |
| `--disabled-text` | `#94A3B8` | `#64708A` | a disabled control's text and icon | view tabs, `.filter-clear`, icon buttons, canvas controls (was `opacity`) |
| `--disabled-border` | `#E2E8F0` | `#343B4F` | a disabled control's edge | new |
| `--hover` | `#F1F5F9` | `#2A3042` | hover of rows and buttons (colourless) | 23 rules |
| `--hover-strong` | `#E2E8F0` | `#343B4F` | hover of toolbar buttons | |
| `--row-hover` | slate-900 at 4.5% | slate-100 at 5% | hover of the session's rows | |
| `--neutral-tint` | `#E2E8F0` | `#2E3547` | neutral chips and badges | |
| `--shadow`, `--legend-bg`, `--resizer` | slate-based | | | |

### 3. Meaning

**Event Storming** (issue #33 §3.2): conventional hues. Light: pale paper and dark text; dark: deep paper of the same
hue and pale text. Both the `-text` token and the theme's `--text` read on every paper (≥ 4.5:1), so the notes stay
legible until the diagrams task wires `-text`.

| Kind | `--es-<kind>` light | `-text` | `-border` | dark paper | `-text` | `-border` |
| --- | --- | --- | --- | --- | --- | --- |
| Domain event (`event`) | `#FB923C` | `#431407` | `#C2410C` | `#C2410C` | `#FFEDD5` | `#FB923C` |
| Command (`command`) | `#93C5FD` | `#172554` | `#2563EB` | `#1D4ED8` | `#DBEAFE` | `#93C5FD` |
| Policy (`policy`) | `#C4B5FD` | `#2E1065` | `#7C3AED` | `#6D28D9` | `#EDE9FE` | `#C4B5FD` |
| Aggregate (`aggregate`) | `#FDE68A` | `#78350F` | `#D97706` | `#975A0A` | `#FEF9C3` | `#FDE68A` |
| Read model (`readmodel`) | `#A7F3D0` | `#064E3B` | `#059669` | `#047857` | `#D1FAE5` | `#6EE7B7` |
| Hotspot (`hotspot`) | `#FCA5A5` | `#7F1D1D` | `#DC2626` | `#9D174D` | `#FCE7F3` | `#FCA5A5` |
| Actor (`actor`) | `#FEF9C3` | `#713F12` | `#A16207` | `#713F12` | `#FEF9C3` | `#FACC15` |
| External system (`external`) | `#F5D0FE` | `#4A044E` | `#C026D3` | `#86198F` | `#FAE8FF` | `#F0ABFC` |
| Timeline arrows (`--es-sequence`) | `#C2410C` | | | `#FB923C` | | |

Actor and external system are not in the issue's table: the actor takes the convention's small pale-yellow note (told
from the aggregate by its rounded shape and lighter paper), the external system fuchsia (the convention's pink/lilac,
kept apart from the hotspot's red and the policy's lavender, with its dashed edge). Groups and timelines keep the
event's dashed edge (`.kind-es-group`, `.dg-esGroup`). The timeline arrows are the event's hue (an order of events),
not a warning. The legend's note that the colours carry no meaning (`stormingColorNote`) is now wrong; the diagrams
task replaces it and documents the mapping in `docs/live-view.md`.

**Domain Modeling** (issue #33 §3.3): neutral cards, the concept's hue on a stripe, label or border (`--model-<x>`),
and a faint chip background (`--model-<x>-tint`).

| Concept | `--model-*` light | tint | dark | tint |
| --- | --- | --- | --- | --- |
| Bounded context (`context`) | `#64748B` | `#F8FAFC` | `#94A3B8` | `#252B3B` |
| Aggregate root (`aggregate`) | `#4338CA` | `#EEF2FF` | `#A5B4FC` | `#2A2E52` |
| Entity (`entity`) | `#475569` | `#F1F5F9` | `#CBD5E1` | `#252B3B` |
| Value object (`value`) | `#0F766E` | `#CCFBF1` | `#5EEAD4` | `#12332F` |
| Command (`command`) | `#2563EB` | `#EFF6FF` | `#93C5FD` | `#1D3552` |
| Domain event (`event`) | `#C2410C` | `#FFEDD5` | `#FDBA74` | `#43291A` |
| Policy (`policy`) | `#7C3AED` | `#EDE9FE` | `#C4B5FD` | `#2E2550` |

### 4. Status and diff (issue #33 §3.4)

| Token | Light ink / bg | Dark ink / bg | Meaning |
| --- | --- | --- | --- |
| `--status-info-ink` / `-bg` | `#1D4ED8` / `#DBEAFE` | `#93C5FD` / `#1D3552` | non-blocking status |
| `--status-success-*` | `#047857` / `#D1FAE5` | `#6EE7B7` / `#113B35` | completed, valid |
| `--status-warning-*` | `#92400E` / `#FEF3C7` | `#FCD34D` / `#47361F` | needs input, caution |
| `--status-danger-*` | `#B91C1C` / `#FEE2E2` | `#FCA5A5` / `#4B222A` | failed, diagnostic error |
| `--status-idle-*` | `#64748B` / `#F8FAFC` | `#CBD5E1` / `#252B3B` | inactive, cancelled |
| `--on-status` | `#FFFFFF` | `#10131D` | text on an ink used as a solid fill (badges, pills) |
| `--diff-added` / `-bg` | `#15803D` / `#DCFCE7` | `#86EFAC` / `#14321F` | added since the baseline |
| `--diff-changed` / `-bg` | `#A16207` / `#FEF9C3` | `#FDE047` / `#3A3214` | changed |
| `--diff-removed` / `-bg` | `#BE123C` / `#FFE4E6` | `#FDA4AF` / `#4A1D2A` | removed (ghosts) |

An ink doubles as a solid fill with `--on-status` on it: in the dark theme the inks are light, so the text on them is
dark (as `--on-action` on the dark action). The diff keeps the current diagrams' hue families (green, yellow-orange,
red) but has its own tokens: added (green-700) is not success (emerald-700), removed (rose-700) is not danger
(red-700). Every diff mark also carries a label or a symbol (`+`, `~`, strike-through), so the hue is not alone.

### 5. Collaboration (issue #33 §4)

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--chat-own-bg` | `#EEF2FF` | `#292D4C` | own message |
| `--chat-other-bg` | `#F1F5F9` | `#252B3B` | another participant's message |
| `--chat-agent-bg` | `#FFFFFF` | `#191D2B` | the agent's response (its icon and label say AI) |
| `--chat-mention-bg` | `#E0E7FF` | `#373C67` | a mention |
| `--chat-unread` | `#4338CA` | `#A5B4FC` | the unread marker (with a count or text) |
| `--agent-active` | = `--action` | | every running phase: reading, editing, checking, finishing (told apart by icon and text) |
| `--agent-active-bg` | = `--selected-bg` | | the running chip's background |
| `--participant-1` … `-6` | `#0F766E` teal, `#7C3AED` violet, `#B45309` ochre, `#BE185D` pink, `#0369A1` sky, `#4D7C0F` green | same | a participant's avatar, cursor, remote selection |
| `--on-participant` | `#FFFFFF` | `#FFFFFF` | name and initials on the participant's hue |
| `--participant-halo` | = `--surface` | | the ring around an avatar or cursor label |

The agent's other cases use the status tokens: queued and cancelled → idle; completed → success; needs clarification
and an assumption waiting for approval → warning; declined → info (not a failure); failed and interrupted → danger.
Connection states use the status tokens too, never a participant's hue. `participantColor` should pick
`var(--participant-<1 + hash % 6>)` instead of an `hsl()`.

### What W1 changed in the rules

- The token block, rewritten in the five layers; old names kept as aliases (table below).
- `#fff` on filled backgrounds: `var(--on-action)` on action fills, `var(--on-status)` on status and diff fills, and
  `var(--on-action)` for the AI avatar's icon and the selected chat tab's badge background (needed so that re-pointing
  `--accent` to the dark theme's light indigo does not leave white on light). Light is unchanged by this.
- App chrome (§3.1): the brand mark in `--brand-ink`; the activity bar, the tree, the filter and the explorer's and
  the legend's toggles on `--selected-*`; menus and dialogs on `--surface-raised`; activity-bar error and warning
  badges with `--on-status`; disabled chrome controls with `--disabled-text` instead of an opacity.
- Keyboard focus: one ring for the page's own controls,
  `:where(:is(button, a, select, summary, [role='tab'], [tabindex]):focus-visible:not(.tl-container *))` with a 2px
  `--focus` outline. It has zero specificity, so every control that already styles its focus keeps its own; tldraw's
  canvas is excluded.

### Mapping from the old tokens

| Old token | Now | Note |
| --- | --- | --- |
| `--panel` | alias of `--surface` | |
| `--text-soft` | alias of `--text-secondary` | |
| `--accent` | alias of `--action` | the chat and agent tasks move the AI avatar and running state to `--agent-active` |
| `--muted` | kept, re-valued (slate) | |
| `--border`, `--border-strong` | kept, re-valued | |
| `--hover`, `--hover-strong`, `--row-hover`, `--neutral-tint`, `--shadow`, `--legend-bg` | kept, slate-based | |
| `--focus-ring` | 30% of `--focus` | real focus uses `--focus` |
| `--resizer` | 35% of `--action` | |
| `--violet-tint` | alias of `--selected-bg` | the local selection everywhere it was used |
| `--violet`, `--violet-text`, `--violet-soft`, `--violet-wash`, `--violet-border`, `--boundary-border`, `--boundary-bg` | indigo values | the old accent's family follows the brand; aggregates and boundaries become indigo, as §3.3 asks for the aggregate root |
| `--error`, `--error-wash` | aliases of `--status-danger-ink` / `-bg` | |
| `--warning`, `--warning-wash`, `--banner-bg`, `--banner-border` | aliases of `--status-warning-*` | |
| `--added`, `--changed`, `--removed` | aliases of `--diff-*` | `.session-status.run-state-Completed` still uses `--added`: the chat task moves it to `--status-success-*` |
| `--amber` | alias of `--model-event` | it was only the event's dot and band, never the brand's amber |
| `--es-*`, `--es-*-border`, `--es-sequence` | kept, re-valued (conventional); `--es-*-text` added | |
| `--grey*`, `--node-*`, `--ink-strong`, `--stub-bg`, `--context-*`, `--edge*`, `--gutter` | kept, slate-based | |
| `--purple-*`, `--blue-*`, `--green-*`, `--teal-*`, `--amber-text`, `--amber-tint`, `--red-*`, `--orange-text`, `--ref-*`, `--keyword`, `--doc-comment` | unchanged | the diagrams task replaces their uses with `--model-*` / `--es-*` and removes them |

### Owners of the next steps

- **Chat and agent**: `--chat-*` on the message rows; `--agent-active(-bg)` for the running state, `.run-activity-icon`
  and pulses; the run states to `--status-*` (Completed off `--added`); `--surface-raised` for the chat's popovers
  (`.chat-mentions`, `.collab-menu-popover`, `.mark-who-list`, `.reaction-picker`, `.session-dialog`,
  `.cancel-dialog`); `participantColor` to `--participant-*`, `#fff` on avatars and cursor names to
  `--on-participant`, a `--participant-halo` ring.
- **Diagrams and legend**: `color: var(--es-<kind>-text)` on `.dn-es*` and `.kind-es-*`; `--model-*` for the
  modeling kinds (`.kind-*`, `.dn-*`, `.dot-*`, `.band-*`); the legend's storming note and a colour key; diagnostics
  as icon + text over the kind's colour; `docs/live-view.md`.
- **Logo**: the plan below.

## The logo's slots

The approved files are on `main` (#35) in `assets/brand/`: `logo-light.svg` (indigo `#4338CA`, amber `#FBBF24`),
`logo-dark.svg` (indigo `#A5B4FC`), `logo-mono.svg`, `logo-white.svg`, `favicon-16-optical.svg` (stroke 10, dot 10,
redrawn for 16px), all `viewBox="0 0 144 128"`. The geometry is not to be redrawn.

**How they get into the page.** The npm package ships only `dist/`, so the files must be bundled into `dist/web`, not
read from `assets/` at run time. Bun's HTML bundler already does this: a `<link rel="icon" href>` in
`apps/web/index.html` and an `import url from '…svg'` in a `.tsx` file are copied into `dist/web` with a hashed name
(`logo-light-<hash>.svg`) and the references rewritten, also for files outside `apps/web` (checked with Bun 1.4.3:
`../../assets/brand/x.svg` lands at `dist/web/x-<hash>.svg`). `loadAssets` serves them as `image/svg+xml`. The
imported URL is relative (`./logo-light-<hash>.svg`); the page is served at `/`, so it resolves.

| Slot | Today | Change |
| --- | --- | --- |
| Favicon | none | a new `apps/web/favicon.svg` derived from `assets/brand/favicon-16-optical.svg` (the same paths, unchanged) with an inner `<style>`: the strokes `#4338CA`, and under `@media (prefers-color-scheme: dark)` `#A5B4FC`; the amber dot stays `#FBBF24`. Linked from `index.html` as `<link rel="icon" type="image/svg+xml" href="./favicon.svg" />`. The browser tab follows the OS scheme, not the app's theme, which is why the switch is inside the file. |
| Activity bar mark (expanded and collapsed: the same 43px `.brand-mark` cell at the top of `.left-head`, `app/shell.tsx`) | lucide `Waypoints`, 20px, in `--accent` | two `<img alt="" src>` imported from `../../assets/brand/logo-light.svg` and `logo-dark.svg` (in `app/shell.tsx`, with `declare module '*.svg' { const url: string; export default url; }` in `apps/web/env.d.ts`), about 24×21px (the 144:128 ratio), one shown per `:root[data-theme]` in CSS; the span stays `aria-hidden` (the text "DomainTrail" names it). Collapsed, the cell is the whole bar, so nothing else changes. `--brand-ink` stays for anything drawn in CSS around it. |
| Top-bar text `.brand` ("DomainTrail") | text, `--text` | unchanged (the wordmark is text) |
| Other slots | none: the session's join page and dialogs show no logo; `README.md` could use `logo-light.svg` | optional |

The mono and white variants have no slot in the page today (they are for print and dark photos); the 16/24/32/64px
renders on both themes belong with the logo task's screenshots.

## Contrast

WCAG 2 ratios of the token pairs, computed from the values above (a small script, not in the repository: relative
luminance and `(L1 + 0.05) / (L2 + 0.05)`). Text needs 4.5:1; the focus ring, control edges, sticky-note edges
against the canvas and participant hues against the background need 3:1; separators and disabled controls are listed
for information (WCAG does not require them). All 200 pairs pass.

Notes on values that differ from issue #33:

- `--muted` (light `#5E6B7F` instead of slate-500 `#64748B`): the issue has no third text tier; slate-500 gives 4.34:1
  on `--surface-muted` and on the hover, so the quietest text is one step darker.
- `--border-strong` (`#8492A6` / `#64708A`): not in the issue; the edges of inputs and buttons need 3:1, which the
  issue's `border` (`#CBD5E1`, 1.48:1) does not reach; `--border` keeps the issue's value for separators.
- `--status-idle-bg` (light `#F8FAFC`): the issue gives no idle background; on `#F1F5F9` the idle ink is 4.34:1.
- `--model-context-tint` (`#F8FAFC`) and `--model-command-tint` (`#EFF6FF` instead of `#DBEAFE`): the accent on its
  tint reaches 4.5:1 only with the lighter tint.
- `--es-actor-border` light `#A16207` (yellow-700): yellow-600 is 2.8:1 on the canvas. It has the same value as
  `--diff-changed`; the roles stay apart.
- The dark sticky papers (not in the issue): deep fills of each hue, so that the light text of the dark theme reads
  on them; the aggregate's paper is `#975A0A` (yellow-700 gives 4.49:1 with `--text`), the hotspot's pink-800
  `#9D174D` (red-700 looked like the event's orange-700 side by side).

The tables (light, then dark):

#### Chrome (light)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| text / bg | `#0F172A` | `#F8FAFC` | 17.06 | 4.5 | pass |
| text / surface | `#0F172A` | `#FFFFFF` | 17.85 | 4.5 | pass |
| text / surface-raised | `#0F172A` | `#FFFFFF` | 17.85 | 4.5 | pass |
| text / surface-muted | `#0F172A` | `#F1F5F9` | 16.30 | 4.5 | pass |
| text-secondary / surface | `#475569` | `#FFFFFF` | 7.58 | 4.5 | pass |
| text-secondary / bg | `#475569` | `#F8FAFC` | 7.24 | 4.5 | pass |
| text-secondary / surface-muted | `#475569` | `#F1F5F9` | 6.92 | 4.5 | pass |
| muted / surface | `#5E6B7F` | `#FFFFFF` | 5.40 | 4.5 | pass |
| muted / bg | `#5E6B7F` | `#F8FAFC` | 5.17 | 4.5 | pass |
| muted / surface-muted | `#5E6B7F` | `#F1F5F9` | 4.93 | 4.5 | pass |
| muted / hover | `#5E6B7F` | `#F1F5F9` | 4.93 | 4.5 | pass |
| text-secondary / neutral-tint | `#475569` | `#E2E8F0` | 6.15 | 4.5 | pass |
| action (link text) / surface | `#4338CA` | `#FFFFFF` | 7.90 | 4.5 | pass |
| action (link text) / bg | `#4338CA` | `#F8FAFC` | 7.55 | 4.5 | pass |
| on-action / action | `#FFFFFF` | `#4338CA` | 7.90 | 4.5 | pass |
| action icon / selected-bg | `#4338CA` | `#EEF2FF` | 7.07 | 3 | pass |
| selected-text / selected-bg | `#312E81` | `#EEF2FF` | 10.22 | 4.5 | pass |
| focus ring / surface | `#6366F1` | `#FFFFFF` | 4.47 | 3 | pass |
| focus ring / bg | `#6366F1` | `#F8FAFC` | 4.27 | 3 | pass |
| focus ring / selected-bg | `#6366F1` | `#EEF2FF` | 3.99 | 3 | pass |
| disabled text / surface (informative; exempt) | `#94A3B8` | `#FFFFFF` | 2.56 | 1 | pass |
| border-strong (control edge) / surface | `#8492A6` | `#FFFFFF` | 3.16 | 3 | pass |
| border (separator) / surface | `#CBD5E1` | `#FFFFFF` | 1.48 | 1 | pass |

#### Status (light)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| info ink / info bg | `#1D4ED8` | `#DBEAFE` | 5.49 | 4.5 | pass |
| info ink / surface | `#1D4ED8` | `#FFFFFF` | 6.70 | 4.5 | pass |
| on-status / info solid | `#FFFFFF` | `#1D4ED8` | 6.70 | 4.5 | pass |
| success ink / success bg | `#047857` | `#D1FAE5` | 4.84 | 4.5 | pass |
| success ink / surface | `#047857` | `#FFFFFF` | 5.48 | 4.5 | pass |
| on-status / success solid | `#FFFFFF` | `#047857` | 5.48 | 4.5 | pass |
| warning ink / warning bg | `#92400E` | `#FEF3C7` | 6.37 | 4.5 | pass |
| warning ink / surface | `#92400E` | `#FFFFFF` | 7.09 | 4.5 | pass |
| on-status / warning solid | `#FFFFFF` | `#92400E` | 7.09 | 4.5 | pass |
| danger ink / danger bg | `#B91C1C` | `#FEE2E2` | 5.30 | 4.5 | pass |
| danger ink / surface | `#B91C1C` | `#FFFFFF` | 6.47 | 4.5 | pass |
| on-status / danger solid | `#FFFFFF` | `#B91C1C` | 6.47 | 4.5 | pass |
| idle ink / idle bg | `#64748B` | `#F8FAFC` | 4.55 | 4.5 | pass |
| idle ink / surface | `#64748B` | `#FFFFFF` | 4.76 | 4.5 | pass |
| on-status / idle solid | `#FFFFFF` | `#64748B` | 4.76 | 4.5 | pass |

#### Diff (light)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| added / surface | `#15803D` | `#FFFFFF` | 5.02 | 4.5 | pass |
| on-status / added solid | `#FFFFFF` | `#15803D` | 5.02 | 4.5 | pass |
| changed / surface | `#A16207` | `#FFFFFF` | 4.92 | 4.5 | pass |
| on-status / changed solid | `#FFFFFF` | `#A16207` | 4.92 | 4.5 | pass |
| removed / surface | `#BE123C` | `#FFFFFF` | 6.29 | 4.5 | pass |
| on-status / removed solid | `#FFFFFF` | `#BE123C` | 6.29 | 4.5 | pass |

#### Event Storming (light)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| event text / fill | `#431407` | `#FB923C` | 6.92 | 4.5 | pass |
| event theme text (until wired) / fill | `#0F172A` | `#FB923C` | 7.89 | 4.5 | pass |
| event border / canvas | `#C2410C` | `#F9FAFB` | 4.96 | 3 | pass |
| command text / fill | `#172554` | `#93C5FD` | 8.15 | 4.5 | pass |
| command theme text (until wired) / fill | `#0F172A` | `#93C5FD` | 9.90 | 4.5 | pass |
| command border / canvas | `#2563EB` | `#F9FAFB` | 4.95 | 3 | pass |
| policy text / fill | `#2E1065` | `#C4B5FD` | 8.25 | 4.5 | pass |
| policy theme text (until wired) / fill | `#0F172A` | `#C4B5FD` | 9.67 | 4.5 | pass |
| policy border / canvas | `#7C3AED` | `#F9FAFB` | 5.45 | 3 | pass |
| aggregate text / fill | `#78350F` | `#FDE68A` | 7.28 | 4.5 | pass |
| aggregate theme text (until wired) / fill | `#0F172A` | `#FDE68A` | 14.33 | 4.5 | pass |
| aggregate border / canvas | `#D97706` | `#F9FAFB` | 3.05 | 3 | pass |
| readmodel text / fill | `#064E3B` | `#A7F3D0` | 7.58 | 4.5 | pass |
| readmodel theme text (until wired) / fill | `#0F172A` | `#A7F3D0` | 13.92 | 4.5 | pass |
| readmodel border / canvas | `#059669` | `#F9FAFB` | 3.61 | 3 | pass |
| hotspot text / fill | `#7F1D1D` | `#FCA5A5` | 5.28 | 4.5 | pass |
| hotspot theme text (until wired) / fill | `#0F172A` | `#FCA5A5` | 9.41 | 4.5 | pass |
| hotspot border / canvas | `#DC2626` | `#F9FAFB` | 4.62 | 3 | pass |
| actor text / fill | `#713F12` | `#FEF9C3` | 8.07 | 4.5 | pass |
| actor theme text (until wired) / fill | `#0F172A` | `#FEF9C3` | 16.62 | 4.5 | pass |
| actor border / canvas | `#A16207` | `#F9FAFB` | 4.71 | 3 | pass |
| external text / fill | `#4A044E` | `#F5D0FE` | 10.81 | 4.5 | pass |
| external theme text (until wired) / fill | `#0F172A` | `#F5D0FE` | 13.04 | 4.5 | pass |
| external border / canvas | `#C026D3` | `#F9FAFB` | 4.51 | 3 | pass |

#### Modeling accents (light)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| context / surface | `#64748B` | `#FFFFFF` | 4.76 | 4.5 | pass |
| context / its tint | `#64748B` | `#F8FAFC` | 4.55 | 4.5 | pass |
| aggregate / surface | `#4338CA` | `#FFFFFF` | 7.90 | 4.5 | pass |
| aggregate / its tint | `#4338CA` | `#EEF2FF` | 7.07 | 4.5 | pass |
| entity / surface | `#475569` | `#FFFFFF` | 7.58 | 4.5 | pass |
| entity / its tint | `#475569` | `#F1F5F9` | 6.92 | 4.5 | pass |
| value / surface | `#0F766E` | `#FFFFFF` | 5.47 | 4.5 | pass |
| value / its tint | `#0F766E` | `#CCFBF1` | 4.86 | 4.5 | pass |
| command / surface | `#2563EB` | `#FFFFFF` | 5.17 | 4.5 | pass |
| command / its tint | `#2563EB` | `#EFF6FF` | 4.75 | 4.5 | pass |
| event / surface | `#C2410C` | `#FFFFFF` | 5.18 | 4.5 | pass |
| event / its tint | `#C2410C` | `#FFEDD5` | 4.52 | 4.5 | pass |
| policy / surface | `#7C3AED` | `#FFFFFF` | 5.70 | 4.5 | pass |
| policy / its tint | `#7C3AED` | `#EDE9FE` | 4.80 | 4.5 | pass |

#### Chat (light)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| text / own | `#0F172A` | `#EEF2FF` | 15.97 | 4.5 | pass |
| text / other | `#0F172A` | `#F1F5F9` | 16.30 | 4.5 | pass |
| text / agent | `#0F172A` | `#FFFFFF` | 17.85 | 4.5 | pass |
| text / mention | `#0F172A` | `#E0E7FF` | 14.49 | 4.5 | pass |
| unread / surface | `#4338CA` | `#FFFFFF` | 7.90 | 3 | pass |
| on-action / unread | `#FFFFFF` | `#4338CA` | 7.90 | 4.5 | pass |

#### Participants (light)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| #fff / participant-1 | `#FFFFFF` | `#0F766E` | 5.47 | 4.5 | pass |
| participant-1 / bg | `#0F766E` | `#F8FAFC` | 5.23 | 3 | pass |
| #fff / participant-2 | `#FFFFFF` | `#7C3AED` | 5.70 | 4.5 | pass |
| participant-2 / bg | `#7C3AED` | `#F8FAFC` | 5.45 | 3 | pass |
| #fff / participant-3 | `#FFFFFF` | `#B45309` | 5.02 | 4.5 | pass |
| participant-3 / bg | `#B45309` | `#F8FAFC` | 4.80 | 3 | pass |
| #fff / participant-4 | `#FFFFFF` | `#BE185D` | 6.04 | 4.5 | pass |
| participant-4 / bg | `#BE185D` | `#F8FAFC` | 5.77 | 3 | pass |
| #fff / participant-5 | `#FFFFFF` | `#0369A1` | 5.93 | 4.5 | pass |
| participant-5 / bg | `#0369A1` | `#F8FAFC` | 5.67 | 3 | pass |
| #fff / participant-6 | `#FFFFFF` | `#4D7C0F` | 4.99 | 4.5 | pass |
| participant-6 / bg | `#4D7C0F` | `#F8FAFC` | 4.77 | 3 | pass |

#### Chrome (dark)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| text / bg | `#F1F5F9` | `#10131D` | 16.92 | 4.5 | pass |
| text / surface | `#F1F5F9` | `#191D2B` | 15.31 | 4.5 | pass |
| text / surface-raised | `#F1F5F9` | `#242A3B` | 13.05 | 4.5 | pass |
| text / surface-muted | `#F1F5F9` | `#252B3B` | 12.89 | 4.5 | pass |
| text-secondary / surface | `#CBD5E1` | `#191D2B` | 11.30 | 4.5 | pass |
| text-secondary / bg | `#CBD5E1` | `#10131D` | 12.48 | 4.5 | pass |
| text-secondary / surface-muted | `#CBD5E1` | `#252B3B` | 9.51 | 4.5 | pass |
| muted / surface | `#94A3B8` | `#191D2B` | 6.54 | 4.5 | pass |
| muted / bg | `#94A3B8` | `#10131D` | 7.23 | 4.5 | pass |
| muted / surface-muted | `#94A3B8` | `#252B3B` | 5.51 | 4.5 | pass |
| muted / hover | `#94A3B8` | `#2A3042` | 5.12 | 4.5 | pass |
| text-secondary / neutral-tint | `#CBD5E1` | `#2E3547` | 8.24 | 4.5 | pass |
| action (link text) / surface | `#A5B4FC` | `#191D2B` | 8.41 | 4.5 | pass |
| action (link text) / bg | `#A5B4FC` | `#10131D` | 9.30 | 4.5 | pass |
| on-action / action | `#10131D` | `#A5B4FC` | 9.30 | 4.5 | pass |
| action icon / selected-bg | `#A5B4FC` | `#30345A` | 5.97 | 3 | pass |
| selected-text / selected-bg | `#E0E7FF` | `#30345A` | 9.66 | 4.5 | pass |
| focus ring / surface | `#A5B4FC` | `#191D2B` | 8.41 | 3 | pass |
| focus ring / bg | `#A5B4FC` | `#10131D` | 9.30 | 3 | pass |
| focus ring / selected-bg | `#A5B4FC` | `#30345A` | 5.97 | 3 | pass |
| disabled text / surface (informative; exempt) | `#64708A` | `#191D2B` | 3.38 | 1 | pass |
| border-strong (control edge) / surface | `#64708A` | `#191D2B` | 3.38 | 3 | pass |
| border (separator) / surface | `#465066` | `#191D2B` | 2.08 | 1 | pass |

#### Status (dark)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| info ink / info bg | `#93C5FD` | `#1D3552` | 6.92 | 4.5 | pass |
| info ink / surface | `#93C5FD` | `#191D2B` | 9.30 | 4.5 | pass |
| on-status / info solid | `#10131D` | `#93C5FD` | 10.28 | 4.5 | pass |
| success ink / success bg | `#6EE7B7` | `#113B35` | 8.10 | 4.5 | pass |
| success ink / surface | `#6EE7B7` | `#191D2B` | 11.00 | 4.5 | pass |
| on-status / success solid | `#10131D` | `#6EE7B7` | 12.16 | 4.5 | pass |
| warning ink / warning bg | `#FCD34D` | `#47361F` | 8.02 | 4.5 | pass |
| warning ink / surface | `#FCD34D` | `#191D2B` | 11.63 | 4.5 | pass |
| on-status / warning solid | `#10131D` | `#FCD34D` | 12.86 | 4.5 | pass |
| danger ink / danger bg | `#FCA5A5` | `#4B222A` | 7.09 | 4.5 | pass |
| danger ink / surface | `#FCA5A5` | `#191D2B` | 8.84 | 4.5 | pass |
| on-status / danger solid | `#10131D` | `#FCA5A5` | 9.77 | 4.5 | pass |
| idle ink / idle bg | `#CBD5E1` | `#252B3B` | 9.51 | 4.5 | pass |
| idle ink / surface | `#CBD5E1` | `#191D2B` | 11.30 | 4.5 | pass |
| on-status / idle solid | `#10131D` | `#CBD5E1` | 12.48 | 4.5 | pass |

#### Diff (dark)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| added / surface | `#86EFAC` | `#191D2B` | 11.95 | 4.5 | pass |
| on-status / added solid | `#10131D` | `#86EFAC` | 13.20 | 4.5 | pass |
| changed / surface | `#FDE047` | `#191D2B` | 12.72 | 4.5 | pass |
| on-status / changed solid | `#10131D` | `#FDE047` | 14.06 | 4.5 | pass |
| removed / surface | `#FDA4AF` | `#191D2B` | 8.87 | 4.5 | pass |
| on-status / removed solid | `#10131D` | `#FDA4AF` | 9.80 | 4.5 | pass |

#### Event Storming (dark)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| event text / fill | `#FFEDD5` | `#C2410C` | 4.52 | 4.5 | pass |
| event theme text (until wired) / fill | `#F1F5F9` | `#C2410C` | 4.73 | 4.5 | pass |
| event border / canvas | `#FB923C` | `#101011` | 8.40 | 3 | pass |
| command text / fill | `#DBEAFE` | `#1D4ED8` | 5.49 | 4.5 | pass |
| command theme text (until wired) / fill | `#F1F5F9` | `#1D4ED8` | 6.12 | 4.5 | pass |
| command border / canvas | `#93C5FD` | `#101011` | 10.55 | 3 | pass |
| policy text / fill | `#EDE9FE` | `#6D28D9` | 5.98 | 4.5 | pass |
| policy theme text (until wired) / fill | `#F1F5F9` | `#6D28D9` | 6.49 | 4.5 | pass |
| policy border / canvas | `#C4B5FD` | `#101011` | 10.30 | 3 | pass |
| aggregate text / fill | `#FEF9C3` | `#975A0A` | 5.17 | 4.5 | pass |
| aggregate theme text (until wired) / fill | `#F1F5F9` | `#975A0A` | 5.07 | 4.5 | pass |
| aggregate border / canvas | `#FDE68A` | `#101011` | 15.27 | 3 | pass |
| readmodel text / fill | `#D1FAE5` | `#047857` | 4.84 | 4.5 | pass |
| readmodel theme text (until wired) / fill | `#F1F5F9` | `#047857` | 5.01 | 4.5 | pass |
| readmodel border / canvas | `#6EE7B7` | `#101011` | 12.48 | 3 | pass |
| hotspot text / fill | `#FCE7F3` | `#9D174D` | 6.71 | 4.5 | pass |
| hotspot theme text (until wired) / fill | `#F1F5F9` | `#9D174D` | 7.20 | 4.5 | pass |
| hotspot border / canvas | `#FCA5A5` | `#101011` | 10.02 | 3 | pass |
| actor text / fill | `#FEF9C3` | `#713F12` | 8.07 | 4.5 | pass |
| actor theme text (until wired) / fill | `#F1F5F9` | `#713F12` | 7.91 | 4.5 | pass |
| actor border / canvas | `#FACC15` | `#101011` | 12.42 | 3 | pass |
| external text / fill | `#FAE8FF` | `#86198F` | 7.08 | 4.5 | pass |
| external theme text (until wired) / fill | `#F1F5F9` | `#86198F` | 7.52 | 4.5 | pass |
| external border / canvas | `#F0ABFC` | `#101011` | 10.81 | 3 | pass |

#### Modeling accents (dark)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| context / surface | `#94A3B8` | `#191D2B` | 6.54 | 4.5 | pass |
| context / its tint | `#94A3B8` | `#252B3B` | 5.51 | 4.5 | pass |
| aggregate / surface | `#A5B4FC` | `#191D2B` | 8.41 | 4.5 | pass |
| aggregate / its tint | `#A5B4FC` | `#2A2E52` | 6.54 | 4.5 | pass |
| entity / surface | `#CBD5E1` | `#191D2B` | 11.30 | 4.5 | pass |
| entity / its tint | `#CBD5E1` | `#252B3B` | 9.51 | 4.5 | pass |
| value / surface | `#5EEAD4` | `#191D2B` | 11.34 | 4.5 | pass |
| value / its tint | `#5EEAD4` | `#12332F` | 9.22 | 4.5 | pass |
| command / surface | `#93C5FD` | `#191D2B` | 9.30 | 4.5 | pass |
| command / its tint | `#93C5FD` | `#1D3552` | 6.92 | 4.5 | pass |
| event / surface | `#FDBA74` | `#191D2B` | 9.95 | 4.5 | pass |
| event / its tint | `#FDBA74` | `#43291A` | 7.93 | 4.5 | pass |
| policy / surface | `#C4B5FD` | `#191D2B` | 9.09 | 4.5 | pass |
| policy / its tint | `#C4B5FD` | `#2E2550` | 7.60 | 4.5 | pass |

#### Chat (dark)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| text / own | `#F1F5F9` | `#292D4C` | 12.18 | 4.5 | pass |
| text / other | `#F1F5F9` | `#252B3B` | 12.89 | 4.5 | pass |
| text / agent | `#F1F5F9` | `#191D2B` | 15.31 | 4.5 | pass |
| text / mention | `#F1F5F9` | `#373C67` | 9.56 | 4.5 | pass |
| unread / surface | `#A5B4FC` | `#191D2B` | 8.41 | 3 | pass |
| on-action / unread | `#10131D` | `#A5B4FC` | 9.30 | 4.5 | pass |

#### Participants (dark)

| Pair | Fg | Bg | Ratio | Needs | |
| --- | --- | --- | --- | --- | --- |
| #fff / participant-1 | `#FFFFFF` | `#0F766E` | 5.47 | 4.5 | pass |
| participant-1 / bg | `#0F766E` | `#10131D` | 3.39 | 3 | pass |
| #fff / participant-2 | `#FFFFFF` | `#7C3AED` | 5.70 | 4.5 | pass |
| participant-2 / bg | `#7C3AED` | `#10131D` | 3.25 | 3 | pass |
| #fff / participant-3 | `#FFFFFF` | `#B45309` | 5.02 | 4.5 | pass |
| participant-3 / bg | `#B45309` | `#10131D` | 3.69 | 3 | pass |
| #fff / participant-4 | `#FFFFFF` | `#BE185D` | 6.04 | 4.5 | pass |
| participant-4 / bg | `#BE185D` | `#10131D` | 3.07 | 3 | pass |
| #fff / participant-5 | `#FFFFFF` | `#0369A1` | 5.93 | 4.5 | pass |
| participant-5 / bg | `#0369A1` | `#10131D` | 3.12 | 3 | pass |
| #fff / participant-6 | `#FFFFFF` | `#4D7C0F` | 4.99 | 4.5 | pass |
| participant-6 / bg | `#4D7C0F` | `#10131D` | 3.71 | 3 | pass |

## Open for a human decision

- `--border` follows the issue (`#CBD5E1` / `#465066`) and is visibly heavier than the old hairlines (`#E2E2E6` /
  `#33333D`), in both themes. If it reads too heavy, a lighter separator (slate-200 `#E2E8F0` / `#2E3547`) is the
  alternative; the 3:1 edges of controls are `--border-strong` either way.
- The dark sticky notes use deep papers with pale text; the alternative is mid-tone papers with dark text (closer to
  paper notes, but brighter on a dark canvas). The `-text` tokens let the diagrams task switch either way.
- Same-value tokens across roles (`--es-actor-border` = `--diff-changed`; `--model-command-tint` = the dark info
  background; participant ochre vs the warning): accepted as the issue allows; the overlay rules (§5) keep them apart
  by channel.
