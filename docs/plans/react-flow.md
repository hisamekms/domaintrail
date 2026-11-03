# Plan: drawing the Live View's diagrams with React Flow instead of tldraw

The Live View draws its diagrams (コンテキストマップ, 構造図, イベントストーミング, the inspector's 状態遷移) with tldraw
5.5.2. This plan replaces tldraw with React Flow (`@xyflow/react`, MIT). It was written against `main` at `45bc5a8`
with W1: the boundary between the app and the canvas library (the scene model and the canvas port), still drawn with
tldraw and with no visible change. The later tasks implement the same port with React Flow and remove tldraw. W2 did
(see [W2: the swap as done](#w2-the-swap-as-done)); the decision is [ADR 0029](../adr/0029-react-flow-canvas.md).

## Why

tldraw is not free to use in production. Its `LicenseManager` (`@tldraw/editor`, `lib/license/LicenseManager.ts`)
treats an origin as a development one only when its protocol is `http:`, or `https:` on a loopback host (`localhost`,
`127.0.0.0/8`, `::1`), or the bundle is not built for production (`getIsDevelopment`, `isLoopbackHost`). Any other
`https:` origin is production, and without a license key its state is `unlicensed-production`; the `LicenseProvider`
(`lib/license/LicenseProvider.tsx`, `shouldHideEditorAfterDelay`, `LICENSE_TIMEOUT` = 5000 ms) then renders a hidden
`LicenseGate` instead of the editor five seconds after load. `dt view` on `http://127.0.0.1:4321` is unaffected, but a
session shared through Cloudflare Tunnel and Access (e.g. `https://dt-verify.logrise.dev`) shows no diagram at all,
and before it disappears it carries the "Get a license for production" watermark.

React Flow is MIT licensed, has no license gate, and does what the Live View needs of a canvas: custom HTML nodes,
custom SVG edges, pan and zoom, selection and a camera API.

## Inventory of tldraw in `main`

tldraw is used purely as a read-only viewer. ELK (`elkjs`, `capabilities/visualization`) computes the layout, and the
page draws it at the given positions; the user never edits the canvas.

| File | What it took from tldraw |
| --- | --- |
| `main.tsx` | `tldraw/tldraw.css` |
| `shapes.tsx` | four custom shape utils (`domain-node`, `domain-group`, `domain-internal`, `domain-edge`): props validators, `HTMLContainer` / `SVGContainer`, `Polyline2d` geometry for edges, `getIndicatorPath` (the selection outline, stepping around the change badge and the diagnostic mark), `useEditor` / `useValue` for the selection ring and the zoom-dependent size of the marks |
| `render.ts` | `renderGraph`: built `TLShapePartial`s from a `LaidOutGraph` and reconciled them with the editor (`createShapes`, `updateShapes`, `deleteShapes`, `sendToBack`, `bringToFront`); `withWriteAccess` (read-only mode lifted while syncing); `shapeElementId` and `findShapeForElement` (`getShape`, `getCurrentPageShapes`, shape `meta`) |
| `theme.ts` | `editor.user.updateUserPreferences({ colorScheme })` |
| `view/workspace.tsx`, `states-canvas.tsx` | `<Tldraw shapeUtils hideUi onMount>`, `updateInstanceState({ isReadonly: true })`, `window.__domaintrailEditor` |
| `view/canvas.ts` | `fitReadable` (`zoomToFit`, `getZoomLevel`, `getCurrentPageBounds`, `getViewportScreenBounds`, `setCamera`, `centerOnPoint`), `fitAll` (`zoomToBounds` with `targetZoom` 1, `inset` 16, `Box.Common`), `highlightElement` (`select`, `selectNone`, `getShapePageBounds`, `getViewportPageBounds().contains`, `centerOnPoint`), `usePointerCursor` (`react`, `getHoveredShapeId`, `getInstanceState().cursor`, `setCursor`) |
| `view/camera.ts` | `TLCamera`, `getCamera`, `setCamera`, the reconciliation of `render.ts` |
| `view/center.ts` | `getContainer`, `updateViewportScreenBounds`, `getCamera` / `setCamera`, the internal `_viewportAnimation` |
| `view/canvas-controls.tsx` | `useValue` of `getZoomLevel` and `getSelectedShapeIds`; `zoomIn`, `zoomOut`, `resetZoom` around `getViewportScreenCenter`; `zoomToFit`, `zoomToSelection`; the edge hint (`inputs.getIsPointing`, `getHoveredShapeId`, `getShape`, `inputs.getCurrentScreenPoint`, `getViewportScreenBounds`) |
| `view/navigation.ts` | `useValue` of `getOnlySelectedShape` (a click on the canvas selects its element) |
| `session/page.tsx` | `useValue` of `getOnlySelectedShapeId` and `getSelectedShapeIds`, shape IDs `shape:n:<graph node>`, `createShapeId`, `select`, `getShapePageBounds`, `centerOnPoint` |
| `session/cursors.tsx` | `useValue` of `getCamera` and `getViewportScreenBounds`, `pageToViewport` (peer cursors) |
| `session/selection-action.tsx` | `getSelectedShapeIds`, `inputs.getIsDragging` / `getIsPanning`, `getCameraState`, `getSelectionPageBounds`, `pageToViewport`, `getViewportScreenBounds` (the 💬 next to the selection) |
| `session/useSession.ts` | `getContainer`, `screenToPage` (this page's cursor, sent as presence) |

Behaviours that come from tldraw itself rather than from these calls: panning (drag on the background, the wheel or
trackpad, space-drag, `H` hand tool), zooming (Ctrl/⌘ + wheel, pinch), click and shift-click selection, the selection
box (drag on the background), `Escape` clearing the selection, tldraw's own keys in the inspector's diagram while it has
the focus (`Shift+1` / `Shift+2`, `+` / `-`), hit-testing of shapes (DOM hover never reaches them), and the hover and
selection outlines (`getIndicatorPath`).

## The boundary (W1)

### The scene model (`apps/web/scene.ts`, `apps/web/render.ts`)

`buildScene(graph, opts)` (`render.ts`) turns a `LaidOutGraph` and the `RenderOptions` (diff, diagnostics, previous
graph, display mode, language, transition labels) into a `Scene`: plain data, no React, no canvas library, unit tested
(`render.test.ts`).

```ts
interface Scene {
    groups: SceneGroup[]; // contexts, aggregate boundaries, storming groups (drawn behind; contexts behind boundaries)
    nodes: SceneNode[]; // model elements
    ghosts: (SceneNode | SceneInternal)[]; // removed elements, where they were in the baseline
    internal: SceneInternal[]; // internal transitions, rows over their state's compartment
    edges: SceneEdge[]; // ELK routes, relative to the item's origin, with the label box
}
// every item: { id, type, x, y, elementId, ghost?, props } (+ graphNode on nodes and groups, edge on internal rows and edges)
```

- IDs are stable across redraws: `n:<graph node>`, `i:<internal transition>`, `e:<edge>`, `ghost:<graph node>`,
  `ghost:i:<internal transition>`. `graphNodeOf(id)` reads the graph node back (the session's targets need it).
- `props` are what the item shows: `NodeProps` (size, kind, label, stereotype, text scale, rows with their changes,
  compartment height, change mark and badge text, diagnostic mark), `GroupProps`, `InternalProps`, `EdgeProps` (points,
  kind, label and second line, faded, label box, tone).
- `sceneItems(scene)` lists the items back to front; `itemForElement` finds the item of a model element (its node
  first). `Rect`, `rectCenter`, `rectContains` and `unionRects` replace tldraw's `Box`.

### The item components (`apps/web/diagram-items.tsx`)

The HTML and SVG of each item, without tldraw: `NodeContent` (with `nodeClassName` and `nodeStyle`), `GroupContent`,
`InternalContent`, `EdgeContent` (line, hit path, arrowhead, composition diamond, label) and `EdgeMarks` (the change
badge and the diagnostic mark, enlarged by `markScale(zoom)` when zoomed out). The tldraw shape utils in `shapes.tsx`
are thin wrappers that put them in `HTMLContainer` / `SVGContainer`; React Flow's custom nodes and edges reuse them.

### The canvas port (`apps/web/view/diagram.ts`)

`DiagramCanvas` is everything the app asks of the canvas; its contract is in the doc comment. In short:

- **Scene**: `show(scene)` (reconcile by ID, keep the selection of unchanged items, never move the camera), `clear()`.
- **Camera**: `getCamera` / `setCamera` (tldraw's convention: a page point is on the canvas at `(page + camera) * z`),
  `getZoom`, `zoomIn`, `zoomOut`, `resetZoom` (around the center), `fitContent`, `fitBounds(rect, { maxZoom, inset })`,
  `fitSelection`, `centerOn(point)`, `isAnimating`, `isMoving` (dragging, panning or the camera moving), `measure`
  (the container resized).
- **Geometry**: `contentBounds`, `viewportPageBounds`, `viewportScreenBounds`, `screenToPage`, `pageToViewport`,
  `itemBounds(id)`, `selectionBounds`.
- **Items and selection**: `item(id)` (type, element, ghost, kind), `findElement(elementId)`, `selectedIds`,
  `onlySelectedId`, `select(ids)`, `selectNone`, `hoveredId`, `isPointing`, `pointer`.
- **Page**: `setTheme(theme)`, `container()`.
- **Changes**: `watch(effect)` runs the effect again whenever what it read changed; `useCanvasValue(canvas, compute,
  deps)` is its React hook (in place of tldraw's `useValue`).

`view/tldraw-canvas.tsx` implements it with tldraw (`createTldrawCanvas(editor)`, and `<TldrawCanvas onMount expose>`,
which also makes the canvas read-only, keeps the pointer cursor over clickable items and exposes the editor on
`window.__domaintrailEditor`). `view/*`, `session/*`, `states-canvas.tsx` and `theme.ts` only know the port;
`apps/web/canvas-boundary.test.ts` fails when any file other than `main.tsx` (the stylesheet), `shapes.tsx` and
`view/tldraw-canvas.tsx` imports tldraw.

## The swap (W2 and later)

1. **Dependency**: `@xyflow/react` **12.12.0** in `apps/web/package.json` (the repo's `bunfig.toml` has a
   `minimumReleaseAge` of 3 days, and 12.12.1 is newer than that). Its stylesheet `@xyflow/react/dist/style.css` (or
   `base.css`, styling the rest ourselves) replaces `tldraw/tldraw.css` in `main.tsx`.
2. **The adapter** `view/flow-canvas.tsx`: `<ReactFlowProvider>` around `<ReactFlow>`, and a `DiagramCanvas` built
   from `useReactFlow()` and the store (`useStoreApi`). `<FlowCanvas onMount expose>` takes the place of
   `<TldrawCanvas>` in `view/workspace.tsx` and `states-canvas.tsx`; nothing else changes.
   - **Scene → nodes and edges**: groups, nodes, ghosts and internal rows become nodes of four custom types (`zIndex`
     from the scene's layers: contexts, boundaries, nodes, ghosts, internal rows, edges on top), with `position` from
     the scene and `width` / `height` from the props, absolute (no `parentId`: groups do not clip). Edges become one
     custom edge type drawing `EdgeContent` at the item's origin (`<g transform>` in the edge layer) along the ELK
     points. React Flow requires an edge's `source` and `target`: they name the nodes the graph edge joins, and the
     custom edge ignores the handles' positions (`BaseEdge` and the path helpers are not used: they would re-route).
   - **Read-only**: `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable`, `edgesFocusable`,
     `deleteKeyCode={null}`, `selectionOnDrag` with `panOnDrag` as tldraw has it (background drag selects, space or
     middle button pans), `zoomOnDoubleClick={false}`, `onlyRenderVisibleElements`, `minZoom` / `maxZoom` as tldraw's
     (its `zoomSteps`, 0.05–8; `zoomIn` / `zoomOut` step through them, React Flow's multiply by 1.2), `proOptions={{ hideAttribution: true }}` only if the attribution is acceptable to hide (MIT: allowed).
   - **Camera**: React Flow's viewport `{ x, y, zoom }` puts a page point at `page * zoom + (x, y)`; the port's camera is
     `x = viewport.x / zoom`, `y = viewport.y / zoom`, `z = zoom` (and back). `setViewport`, `zoomIn` / `zoomOut` /
     `zoomTo(1)` (with `{ duration: 200 }`), `fitView` (`fitContent`, and `fitSelection` with `nodes: selected`),
     `fitBounds(rect, { padding, duration })` with `maxZoom` applied by computing the zoom (React Flow's `fitBounds`
     has no target zoom), `setCenter(x, y, { zoom })` for `centerOn`, `screenToFlowPosition` and
     `flowToScreenPosition` for the coordinates. `isAnimating` / `isMoving`: `onMoveStart` / `onMoveEnd` and the
     store's `paneDragging`. `measure` has nothing to do (React Flow observes its container).
   - **Selection**: controlled `selected` on nodes and edges (`onSelectionChange`, `onNodesChange` for select
     changes only), so that `select` / `selectNone` and `show` keep the selection by ID.
   - **Hover and pointer**: `onNodeMouseEnter` / `Leave`, `onEdgeMouseEnter` / `Leave` and the pane's pointer move
     give `hoveredId`, `pointer` and `isPointing`; the pointer cursor is CSS (`cursor: pointer` on items that are not
     ghosts).
   - **Theme**: `colorMode` from `setTheme`; our CSS tokens already follow `<html data-theme>`.
   - **Watch**: the store's `subscribe` (zustand) plus the adapter's own hover state; effects run on any change.
   - **The selection outline and the marks**: the node component draws the selection ring (`.dn-selected`, already
     ours) and the hover outline in CSS; `EdgeMarks` gets `markScale(zoom)` from `useStore((s) => s.transform[2])`
     (only nodes with marks subscribe). The outline that steps around the badge (`outlineAround` in `shapes.tsx`) becomes
     CSS or an SVG path in the node.
3. **Remove tldraw**: `shapes.tsx`, `view/tldraw-canvas.tsx`, the `tldraw` and `@tldraw/tlschema` dependencies, the
   tldraw-specific CSS in `styles.css` (`.tl-*`), and the mentions in the docs (`docs/live-view.md`: `H` stays tldraw's
   hand tool; ADR 0001, 0024, 0026; `CONTRIBUTING.md`) and `contexts/collaboration/src/protocol.ts` ("tldraw world
   coordinates": page coordinates, which stay the same, so peers on old and new pages agree). The boundary test then
   allows `@xyflow/react` in the new adapter only.

## W2: the swap as done

`view/flow-canvas.tsx` implements the port; `view/workspace.tsx` and `states-canvas.tsx` mount `<FlowCanvas onMount>`;
`shapes.tsx`, `view/tldraw-canvas.tsx`, `tldraw`, `@tldraw/tlschema`, `tldraw/tldraw.css` (now
`@xyflow/react/dist/base.css`) and the `.tl-*` / `--tl-*` CSS are gone. Where it differs from the plan above:

- **Gestures.** A drag pans everywhere (`panOnDrag`; non-draggable nodes do not stop it, and `noPanClassName` is one
  no element has, so edges do not either); the selection box is Shift + drag (`selectionKeyCode`), not a plain drag on
  the background, and takes a group only when it does not lie inside it. `H` (tldraw's hand tool) is dropped. *For the
  maintainer to confirm.* The wheel pans 1:1 (`panOnScroll`, `panOnScrollSpeed` 1); Ctrl / ⌘ + wheel and the pinch are
  the adapter's own listener with tldraw's arithmetic (`viewport.ts` `wheelZoom`: at most 10% per event), not React
  Flow's (×4 per mouse-wheel notch).
- **The camera's arithmetic** is in `view/viewport.ts`, tested: the conversion, tldraw's zoom steps (`zoomInStep` /
  `zoomOutStep`, a level within half a step counting as that step), `zoomAround`, `fitCamera` (inset 128 or 28% of
  the width by default, clamped to 5–800%), `selectionMaxZoom` (tldraw's `zoomToSelection`), `centerCamera`. The
  adapter applies them with the store's `panZoom.setViewport` (200 ms, linear interpolation for an animated move), not
  with `fitView` / `fitBounds` / `setCenter`.
- **Scene, selection and hover are the adapter's** (`CanvasState`): the port answers from them at once (`show` then
  `fitContent` in the same task), and React Flow gets controlled nodes and edges built from them, reusing the objects
  of unchanged items. Select changes come back through `onNodesChange` / `onEdgesChange`; ghosts are not selectable.
- **Node types** are `domain-node`, `domain-group`, `domain-internal` (React Flow's stylesheet draws its own `group`).
  Each renders two hidden `<Handle>`s and carries `handles`: React Flow draws an edge only between handles, measured or
  declared. An edge whose end the scene does not draw gets an invisible anchor node, so that it is still drawn.
  `SceneEdge` gained `source` / `target`, the items of the graph nodes it joins.
- **The outline** (tldraw's indicator) is an SVG in each node and a path in each edge, shown by CSS on hover (not on a
  ghost) and on React Flow's `selected` class, 1.5 px on the screen (`vector-effect: non-scaling-stroke`); a node with
  marks follows the zoom for its `nodeOutlinePath`. It is drawn in the item's layer, so an edge passes over a node's
  outline (tldraw drew outlines over everything).
- **Keys and focus.** The canvas's container takes the focus on a pointer press (as tldraw's did): `Escape` clears the
  selection; `+` / `-`, `Shift+0`, `Shift+1`, `Shift+2` move the camera (on the main canvas the app takes `Shift+1` /
  `Shift+2` first, as before).
- **`watch`** runs its effects once per task (a microtask) after any change of the adapter's state or React Flow's
  store; `useCanvasValue` keeps the previous value when the new one is equal (`sameValue`), so that an effect that
  returns a fresh object does not render on every pointer move.
- **The attribution** is hidden (`proOptions.hideAttribution`, the maintainer's decision); **`window.__domaintrailEditor`** is gone (nothing used it).
- **Culling.** `onlyRenderVisibleElements`: an edge is drawn when the box of its two nodes is in view (see ADR 0029,
  Consequences).

## To verify after the swap

On `dt view` (http, loopback) and behind an https origin that is not loopback (the license gate is gone):

- Every view draws as before: コンテキストマップ, 構造図 at its three levels and focused, イベントストーミング at each
  level and timeline, the inspector's 状態遷移 for each labeling; change badges, diagnostic marks, ghosts of removed
  elements, row changes, edge labels with their second line, the composition diamond and arrowheads, text scale.
- Stacking: contexts behind aggregate boundaries behind nodes; internal rows over their state; edges on top.
- Camera: the first view fitted readably (from the top-left when large), a storming view fitted whole each time, each
  view's camera kept when switching views and restored, a live reload keeping the camera, the inspector diagram's
  camera kept per aggregate, the center kept while panes open, close, are dragged or the window resizes (and not
  during an animated fit).
- Controls: `− 85% +` (around the middle; the level live; a click resets to 100%), ⤢ and `Shift+1`, ◎ and `Shift+2`
  (disabled without a selection), `U`; the keys ignored while typing; the inspector diagram's keys while it has focus.
- Selection: a click selects the element (inspector, history, explorer), shift-click and the selection box select
  several (the session's 💬 adds them all), selecting elsewhere highlights and centers an item out of view, Escape
  clears, ghosts are not clickable (no pointer cursor), the selection ring outside the node.
- Hover: the pointer cursor over clickable items, the edge hint after 300 ms (hidden while the pointer is pressed).
- Session: peer cursors at the same page point on both pages, following the camera; this page's cursor sent in page
  coordinates; the 💬 next to the selection, hidden while dragging, panning or moving.
- Theme: light and dark on the canvas (background, grid if any, selection colours).
- Performance: the largest structure view and a storming integrated view pan and zoom smoothly
  (`onlyRenderVisibleElements`).
