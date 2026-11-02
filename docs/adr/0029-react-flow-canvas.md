# ADR 0029: The Live View's diagrams are drawn with React Flow

- Status: accepted, implemented (W1 and W2 of [the plan](../plans/react-flow.md) on `feat/react-flow`). The changes
  users see (below, [Consequences](#consequences)) are for the maintainer to confirm.
- Date: 2026-11-03
- Input: `main` at `45bc5a8`, which drew the diagrams with tldraw 5.5.2.
- Amends: [ADR 0001](0001-mvp-implementation-decisions.md) (the drawing library of the Live View),
  [ADR 0024](0024-event-storming-dsl.md) (the storming's shapes) and [ADR 0026](0026-collaboration-sessions.md) (the
  coordinates of a cursor).

## Context

The Live View draws its diagrams (コンテキストマップ, 構造図, イベントストーミング, the inspector's 状態遷移) on a
canvas. ELK lays them out; the canvas only shows them, pans, zooms and selects. The user never edits it.

tldraw drew that canvas, and tldraw is not free to use in production. Its `LicenseManager` (`@tldraw/editor`,
`lib/license/LicenseManager.ts`) counts an origin as a development one only when it is `http:`, `https:` on a loopback
host, or the bundle is not a production build; any other origin without a license key is `unlicensed-production`, and
the `LicenseProvider` (`lib/license/LicenseProvider.tsx`) then replaces the editor with a hidden `LicenseGate` after
`LICENSE_TIMEOUT` (5 s), with a "Get a license for production" watermark until then. `dt view` on `127.0.0.1` was
unaffected, but a session shared through Cloudflare Tunnel and Access (ADR 0026, an `https:` origin that is not
loopback) showed no diagram at all.

## Decision

1. **React Flow** (`@xyflow/react` 12.12.0, MIT, with `@xyflow/system`, d3-zoom and zustand, all MIT or ISC) draws
   the canvas. It has no license check: the same build runs on any origin.
2. **Behind a port.** The app talks to the canvas through `apps/web/view/diagram.ts` (`DiagramCanvas`: the scene,
   the camera, the geometry, the selection and hover, the theme, `watch`), and draws a library-neutral scene
   (`scene.ts`, built by `render.ts`) with library-neutral items (`diagram-items.tsx`). Only `view/flow-canvas.tsx`
   (and `main.tsx`, for React Flow's stylesheet) imports React Flow; `canvas-boundary.test.ts` keeps it so, and keeps
   tldraw out for good.
3. **Nothing moves but the camera.** Groups, nodes, ghosts and internal transitions are custom nodes at their laid-out
   place and size (not draggable, connectable, deletable or focusable); every edge is one custom edge that draws its
   ELK route and ignores React Flow's handles (which it needs to draw an edge at all). The stacking is the scene's
   (React Flow's manual z-index).
4. **The camera keeps the Live View's arithmetic** (`view/viewport.ts`): the port's camera stays tldraw's
   (`(page + camera) * z`) and is converted to React Flow's viewport, so that the cameras kept per view and per
   aggregate, and the centring on resize, are unchanged; − and + step through tldraw's levels (5, 10, 25, 50, 100,
   200, 400, 800%), fits leave the same margins, a fit of the selection goes no further than 100% (but at 100%), and
   Ctrl / ⌘ + wheel zooms as much as before (at most 10% per wheel event).

## Alternatives considered

- **Keep tldraw with a license key passed by the user** (a setting or an environment variable read by `dt view` and
  `dt session start`, handed to `<Tldraw licenseKey>`). Rejected: everyone who shares a session would need a
  commercial tldraw license for what is a read-only viewer; an open-source tool should run as installed; and the
  failure without one is silent (the diagram disappears) and only seen once deployed behind https.
- **A hand-made viewer** (positioned HTML and SVG under a d3-zoom transform). Possible — the Live View uses little of
  a canvas library — but selection, the selection box, hit-testing, culling of what is off screen and the camera's
  gestures would all be ours to write and maintain. React Flow gives them with the same d3-zoom underneath.
- **Cytoscape.js** (MIT). A graph library with its own layouts and canvas renderer: nodes are drawn on a `<canvas>`,
  not as HTML, so the cards (rows, compartments, badges, the theme's CSS tokens) would have to be redrawn in its style
  language or overlaid; and its layouts are not needed (ELK lays out).

## Consequences

- The diagrams show on any origin, `https:` behind a tunnel included; the watermark is gone.
- **Dragging always pans**, on the background or over an item: there is no hand tool, so `H` does nothing (it was
  tldraw's). A drag on the background used to draw a selection box; it now takes Shift + drag. Shift-click still adds
  to the selection, `Escape` clears it, and once a canvas was clicked `+` / `-`, `Shift+0` (100%) and, in the
  inspector's diagram, `Shift+1` / `Shift+2` work as tldraw's did. Ctrl / ⌘ + A (select all) and tldraw's other
  shortcuts are gone. *For the maintainer to confirm.*
- **Attribution.** React Flow shows a small "React Flow" link in the bottom-right corner of each canvas. MIT allows
  hiding it (`proOptions.hideAttribution`), which React Flow asks only of its Pro subscribers; it is kept visible for
  now, and does not cover the canvas's controls, the legend or the chat's launcher. *For the maintainer to decide.*
- **The zoom steps, margins and limits are kept** (5%–800%, the steps above), not React Flow's (×1.2 per step,
  50%–200% by default).
- The look is unchanged: the canvas's background and the outline of the hovered or selected item keep tldraw's colours
  (`--canvas-bg`, `--canvas-outline`), 1.5 px on the screen at any zoom, stepping around the change badge and the
  diagnostic mark; the indigo selection ring, ghosts, change and diagnostic marks are ours as before.
- Only what is on screen is drawn (`onlyRenderVisibleElements`). An edge counts as on screen when the box of the two
  nodes it joins is; a route that leaves that box (around a third node) can be culled while only its detour is in
  view.
- `window.__domaintrailEditor` (tldraw's editor, for debugging) is gone; no test used it.
- A cursor's coordinates in a session are page coordinates, as before (`contexts/collaboration/src/protocol.ts`), so a
  page drawn with tldraw and one drawn with React Flow agree.
