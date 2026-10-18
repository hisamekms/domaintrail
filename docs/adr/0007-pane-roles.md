# ADR 0007: What each pane of the Live View shows

- Status: accepted
- Date: 2026-10-18

## Context

The main pane had five tabs: Context Map, Structure, States, Primitives and Source. Context Map, Structure and
Primitives show the whole model; States showed one aggregate, picked in its own toolbar, and Source one file. So
switching tabs could also switch what was being looked at — the whole model or one item — which nothing on screen
said. The inspector meanwhile already showed the selected item, including an excerpt of its source.

## Decision

Each pane has one role, and a view goes in the pane whose role it fits:

| Pane | Role | Shows |
|---|---|---|
| Explorer (left) | find | the model tree and the files |
| Main (center) | the whole model | Context Map, Structure, Catalog |
| Inspector (right) | the selected item | 構造, 状態遷移, 振る舞い, 参照, ソース |
| Bottom | lists across the model | problems, changes |

- **States move to the inspector** as the 状態遷移 tab of an aggregate, its states and its commands. Selecting a
  state or command keeps the aggregate's diagram, so it can be explored by clicking in it. The canvas pans and zooms
  like the main one; state diagrams are laid out top to bottom to suit the pane.
- **Source moves to the inspector** as the whole file in the ソース tab, scrolled to the selected declaration.
  Without a selection nothing is shown. **Files are selectable** like model items (`file:<path>`), so the files in
  the explorer and problems that belong to no element (syntax errors) still have a place to be shown.
- **Primitives becomes the Catalog**: cards to look over the model, one section per kind of element. It stays in the
  main pane because it shows the whole model. Its sections are aggregates, entities, value objects and unions,
  primitives (primitives, IDs, enums), domain events and errors, each grouped by context with shared contexts first;
  links at the top jump to each section.

## Consequences

- The main pane no longer depends on the selection, and the inspector never shows the whole model.
- A state diagram in the inspector is narrower than it was in the main pane; it is fitted whole at first and zoomed
  from there.
- New views are placed by the same table: a view of one item is an inspector tab, a view of the whole model a main
  tab, and a new kind of card a section of the Catalog.
