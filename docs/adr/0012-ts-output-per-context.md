# ADR 0012: TypeScript output directory per context

- Status: accepted
- Date: 2026-10-18

## Context

All contexts were generated into one directory (`generate.ts.out`). A shared context such as `Common` often belongs in
a package used by several applications (`packages/shared`), while the other contexts belong to one application. With a
single output directory, the shared types had to be copied or re-exported by hand.

## Decision

- **`generate.ts.contexts`** maps a context name to `{ "out": "<dir>" }`. Listed contexts go to that directory; the
  others to `generate.ts.out` (default unchanged). No `{context}` template in `out`.
- **Validation**: a name that is not a context of the model is a config error (exit 2), detected by `generate ts` after
  the model is checked. Output directories stay inside the config file's directory, as `out` does, and must not be
  reached through a symlink.
- **`--out` replaces `generate.ts.out` only**; listed contexts keep their own directories.
- **Imports between contexts use relative paths** computed between the two directories
  (`import type * as Common from '../../packages/shared/src/generated/Common.js'`). Imports by package name are out of
  scope for now.
- **Every directory written to gets its own `_runtime.ts` and `index.ts`**; the index re-exports only the contexts in
  that directory. The runtimes are identical, and TypeScript's structural typing makes `Result`, `Decimal` and
  `Timestamp` from one interchangeable with the other's (tested by compiling across two directories).
- **Stale output is removed**: the files written are recorded in `<root>/.domaintrail/generated.json`. The next run
  deletes recorded files it no longer writes (an output directory moved, a context removed), but only those that still
  start with the generator's header, and removes a directory left empty. Files without the header are kept, and the
  existing rule stands: generation stops rather than overwrite such a file.
- **M011 is unchanged**: it checks every context against the runtime names and the namespace names of all other
  contexts, which covers any placement, since each module imports its own directory's runtime and other contexts by
  namespace.

## Consequences

- A shared kernel can be generated straight into a shared package; applications import it from there and their own
  contexts from their own output.
- `.domaintrail/generated.json` should be ignored by version control like `layout.json`; without it (first run, or
  deleted), only the current output directories are cleaned, as before.
- An index no longer necessarily exports every context: code that imported a moved context from the default index
  imports it from the context's directory instead.
