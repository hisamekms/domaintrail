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
