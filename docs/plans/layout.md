# The Live View's layout, rebuilt (decided 2026-11-03, after feat/modes)

This plan is for a later branch, cut after `feat/modes` is on `main`. It changes the page's frame, not what the views draw.

## Why

- Four columns stand side by side today: the sidebar, the canvas, the inspector and the chat. At a 1400px window the
  canvas is about 410px wide.
- Two rows sit above the canvas, the view tabs and the view toolbar. Their vertical lines cannot line up, because they
  hold different things.
- The people think in two worlds:
  - the **domain model** (`.dt`), seen through three views: the context map, the structure and the catalog;
  - **event storming** (`.dtes`).

## The frame

```
┌ app bar (whole width) ─────────────────────────────────────────────────────────┐
│ ◆ DomainTrail ws │ [Blocks ドメインモデル | StickyNote イベントストーミング] … ⚠ 👥 AI ⋯ │
├──────────────┬───────────────────────────────────────────┬─────────────────────┤
│ navigator    │ view bar: views · conditions … 絞り込み 書き出し │ チャット | AI の作業 │
│ (per world)  ├───────────────────────────────────────────┤                     │
├══ drag ══════┤                                           │                     │
│ detail       │ canvas                                    │                     │
│ (selected)   │ [− % +][全体][選択][詰める][凡例][«]       │ [composer]          │
└──────────────┴───────────────────────────────────────────┴─────────────────────┘
```

1. **App bar**, the whole width. It holds only what concerns the whole page:
   - the app name and the workspace;
   - the world switch, ドメインモデル / イベントストーミング;
   - problems, participants, the AI's state and the ⋯ menu.

   The world is chosen here because it changes both the navigator and the canvas. Nothing that acts only on the
   canvas goes in this bar.
2. **View bar**: one row above the canvas column, for what acts on the canvas only.
   - Domain model: a view switch (マップ / 構造 / カタログ), then the conditions:
     - the structure's contexts and its level (詳細 / 概観 / 集約);
     - the catalog's search.
   - Event storming: the storming › stage or timeline crumbs, then the level (BP / DL).
   - Right end: 絞り込み and 書き出し (印刷 on the catalog).
   - Being one row inside one column, it has no line to align with.
3. **Left column**, split top and bottom:
   - top, the **navigator**, which follows the world:
     - domain model: the tree of contexts and elements;
     - event storming: stormings › stages › timelines, main flows and exceptions;
   - bottom, the **detail** of the selected element (today's inspector).
   - The split between them is dragged up and down, and the column's width is dragged too.
   - The sizes are remembered per viewer.
4. **Right column**: tabs チャット / AI の作業. The detail and the chat are seen at the same time (user requirement).
5. **Canvas controls** (bottom left): only the viewing tools: zoom, 全体, 選択に合わせる, 詰めて表示, 凡例, 畳む.
6. Switching between the worlds returns to the view, storming and conditions last used in each.
7. The print heading follows the same words: `ws › ドメインモデル › 構造図 · 詳細`.

## Icons and narrow widths

- **When wide**, the world and view switches show an icon and text; **when narrow**, the icon only, with the name as
  a tooltip and `aria-label`. Each bar decides by its own width (container queries), as the toolbar already does.
- **Order of shrinking in the view bar:**
  1. 絞り込み / 書き出し become icons;
  2. the view switch becomes icons;
  3. the levels become icons;
  4. the crumbs are cut with 「…」, and the pickers keep the full names.
- **Icons** (lucide):

  | Use | Icon | Note |
  |---|---|---|
  | ドメインモデル | `Blocks` | not `Boxes`, which looks like the aggregates level's `Box` |
  | イベントストーミング | `StickyNote` | |
  | マップ | `Network` | |
  | 構造 | `Workflow` | |
  | カタログ | `BookOpen` | taken from the legend |
  | 凡例 | `Shapes` | new |
  | 詳細 / 概観 / 集約 | `LayoutList` / `LayoutGrid` / `Box` | as today |
  | BP / DL | `Telescope` / `Microscope` | as today |

## Steps

Each step is a separate change, with its e2e and screenshots redone:

1. The app bar and the view bar.
2. The left column: the navigator, the detail and the drag.
3. The right column: the chat and AI の作業 as tabs.
4. The navigator per world, with the stormings' stages and timelines.

## Step 5: the detail of a storming element, inside the whole (decided 2026-11-03)

The detail is read next to the canvas. It shows what the canvas does not, and leads into the canvas. It is no longer a
standalone description of the element.

- **The order follows the use**:
  1. during a workshop: where things are, how they connect, the open questions;
  2. asking the AI: the talk about the element and the asking;
  3. tidying up: the model.
- **On the canvas.** Selecting a note keeps the notes and edges connected to it and dims the rest:
  - the previous and next events;
  - the command that causes it, with its actor;
  - the policies that react to it;
  - its hotspots.

  Clicking empty canvas restores the view. These connections are not listed in the detail.
- **In the detail**, only what the canvas does not show. A row with no content is not shown.
  - the description (`///`, in full);
  - **other places** (`MapPin`): occurrences outside the current view (another stage, timeline or storming, or an
    exception hidden by the filter). Each opens that view.
  - **hidden connections** (`EyeOff`), at Big Picture: what Design Level shows (cause and reactions), with a button to
    see it at Design Level;
  - **talk** (`MessageSquare`): the number of chat messages that target it, as a link, and the latest one quoted;
  - **AI runs** (`Bot`): their number, as a link;
  - **added or changed in this session** (`CirclePlus`, or a change icon): the request that did it, as a link;
  - **model**: the `.dt` counterpart, only when there is one;
  - **a resolved hotspot's conclusion** (`CircleCheck`);
  - **problems** (`TriangleAlert`), on top, in plain words (the code only as a tooltip), with a button to have the AI
    fix it (`Wrench`).
- **Not shown:**
  - the file and line, and "open file" (the AI edits the files);
  - the DSL's words (on, issues, emits);
  - the connections the canvas shows.
- **Fewer words:**
  - rows are labelled by icons, with the name as a tooltip;
  - counts are bare numbers;
  - buttons are icons with tooltips and `aria-label`.
- **Colours:** the icons that describe a row are grey (muted). The icons of actions are the brand colour (indigo on a
  pale indigo button).
  - Actions: target in the chat (`MessageSquare`), ask the AI (`Sparkles`, filled, primary), add a question
    (`MessageCircleQuestionMark`), tell the resolution (`CircleCheck`), have the AI fix it (`Wrench`, filled), see at
    Design Level (`Microscope`).
  - The same shape can be both. `Microscope` is a grey badge for "Design Level only" and an indigo button for "see at
    Design Level".
- **What the actions do:** each one only puts the beginning of a message, targeting the element (`#`), in the
  composer. The person sends it.
- **Per kind**, through what fills the rows:
  - hotspot: its conclusion when resolved, and "tell the resolution";
  - stage and timeline: their main flows and exceptions, branch and return points, and "open this view".

## Small: counts in the model tree

A group heading's count (「集約 1」) shows only while the group is collapsed, as a muted "(1)".

## As built (steps 2–4)

- **Left column.** The activity bar stays (木 / 差分, 問題 from the app bar): its lists are the navigator's contents.
  The detail is the inspector, unchanged inside, under a splitter with a grip (drag, ↑↓ with Shift for larger steps,
  Home / End, double click for the default: 55% of the column to the detail). The detail keeps at least 140px and the
  navigator 96px. The column is 280px wide by default (220–560, never leaving the canvas less than 320px). The
  inspector's right / below dock and its ⋯ menu are gone. Its tabs wrap onto a second row in the narrow column.
- **Collapsing.** The detail goes with the left column; it is not shown alone (drag the split up instead). Closing the
  detail folds it to a 28px rail at the column's foot; opening anything in it (or dragging the split up) opens it again,
  and the column too.
- **Right column.** チャット / AI の作業 and ✕, as before; its edge resizes, steps with ←→ and resets with a double click.
  The left column now collapses for the chat only below 1024px (was 1280px), so that the detail and the chat are seen
  together at the usual widths. With both columns open the canvas is 1094px wide at 1800px, 694px at 1400px (was about
  410px) and 474px at 1180px.
- **Navigator per world.** Domain model: the model tree. Event storming: stormings › stages › timelines (the main flow,
  then the exceptions with a small arrow), a storming's timelines in no stage right under it, a stage's count of
  timelines, and a filter. A click sets the storming view (the same function as the view bar's pickers, so the two stay
  in sync) and selects the row's declaration for the detail.
- Every size is remembered per browser (`domaintrail.layout.explorerWidth`, `.detailHeight`, `.conversationWidth`).

## As built (step 5)

- **Canvas highlight.** `focusedItems` (`apps/web/scene.ts`) works on the scene, so the ELK drawings and the stages'
  grid share it: the selected elements' notes (every copy of an element drawn once per use), the notes joined to them
  by one edge, and those edges; the command that causes a selected event also brings its dotted relations (actor or
  external system, read model, aggregate). An event in a group is joined through its group (scene nodes now carry
  their container, `parent`), and a group reached keeps its events. Containers are never dimmed. The canvas puts
  `diagram-dim` (opacity 0.25, a 160ms fade, none with reduced motion) on React Flow's wrappers. It applies to storming
  notes only: the domain-model diagrams are as before.
- **Detail.** `StormingDetails` keeps the heading (kind chip, the Design Level only badge as a grey microscope, the
  name and the 💬, now an action-coloured square) and shows rows labelled by grey icons, each only when it has content:
  problems on top (`storming-detail.ts` maps the codes that have an easy sentence, S001–S022; the others show the
  message; the code is the tooltip), the description, other places, hidden connections (Big Picture), talk, AI runs,
  added or changed, the `.dt` ref, a resolved hotspot's conclusion. The talk, runs and change come from
  `session/element-activity.ts`: the requests whose targets name the element or an occurrence of it, the runs whose
  frozen requests do or whose element changes touched it, and the run that added it (else the latest that changed it).
  The element changes are the server's per run (`loadModelChanges` between the run's base and result revisions,
  loaded once each); until they arrive a run counts by its messages only.
- **Actions** put a beginning in the composer (`beginMessage`): the element becomes a chip (or keeps its number) and
  its `#` mention starts a new line after what is written; the chat opens with the caret in it. 「デザインレベルで見る」
  switches the level instead (it is a view change, not a message), keeping the selection. The links of the talk and
  the change jump in the chat (`message:<id>`, the run's `card:<unit>`), the runs' opens AI の作業 at the run's unit;
  `SessionChat` takes them as `goTo`.
- **Stage and timeline.** Their rows got icons (この前の段階 `ArrowLeft`, 本流 `MoveRight`, 例外 `CornerDownRight`,
  steps `ListOrdered`, return `Undo2`, a group's events `Layers`); 「この段階を表示」 and a timeline's view are an eye.
- **Colours.** New tokens `--brand`, `--brand-wash`, `--brand-wash-border`, `--on-brand` (indigo 700 / 50 / 200 and
  white; dark: indigo 300 on the indigo night 700 wash, night 950 on it), their contrast pinned in `palette.test.ts`
  (4.5:1 for the icon on the wash and the surface, and for the primary's icon).
- **Tree counts.** A model-tree group heading shows its count only while collapsed, as a muted 「(1)」.
- **Command chips.** A `/` command's opening message (a SlashCommand's or Interview's `opening`) shows as a chip — the
  command's icon (`COMMAND_ICONS`, shared with `/`'s list), `/id`, name; pressed, its line from `/`'s list.
