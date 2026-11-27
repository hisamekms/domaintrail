# Verification results schema: proposal

Extend `schema/diagnostics.schema.json` with a draft-07 fragment and versioned envelope. The current schema is shared by
`dt check --format json` and `dt generate ts --format json`
([diagnostics.schema.json](../../../schema/diagnostics.schema.json#L1-L8)); it currently has no version. Version 2 adds
`schemaVersion: 2`, result records, and class counts to summaries for checks. `origin` belongs to each diagnostic and
each result, because one `verify` document can contain static diagnostics and formal results. The envelope has no
`origin`. `check` and `generate` emit static-origin diagnostics/results; `verify` can report both origins. `generate`
keeps `written`, `hints`, and `error`.

## Schema fragment

Merge these properties and definitions into the existing schema. The existing `diagnostic` definition in
`schema/diagnostics.schema.json` is retained and gains required `origin` with values `static` or `formal`.
Results identify a check kind with `code` and its outcome with `class`.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schemaVersion"],
  "oneOf": [
    {
      "required": ["diagnostics", "results", "summary"],
      "not": { "anyOf": [{ "required": ["error"] }, { "required": ["errorKind"] }] }
    },
    {
      "required": ["error", "errorKind"],
      "not": { "anyOf": [{ "required": ["diagnostics"] }, { "required": ["results"] }] }
    }
  ],
  "properties": {
    "schemaVersion": { "const": 2 },
    "diagnostics": { "type": "array", "items": { "$ref": "#/definitions/diagnostic" } },
    "results": { "type": "array", "items": { "$ref": "#/definitions/result" } },
    "error": { "type": "string" },
    "errorKind": { "enum": ["usage", "configuration", "io", "translation", "checker"] },
    "written": { "type": "array", "items": { "type": "string" } },
    "hints": { "type": "array", "items": { "type": "string" } },
    "summary": {
      "type": "object",
      "required": ["files", "errors", "warnings", "results"],
      "properties": {
        "files": { "type": "integer", "minimum": 0 },
        "errors": { "type": "integer", "minimum": 0 },
        "warnings": { "type": "integer", "minimum": 0 },
        "infos": { "type": "integer", "minimum": 0 },
        "results": {
          "type": "object",
          "required": ["verified", "counterexampleFound", "underspecified", "noCounterexample", "inconclusive", "unsupported", "skipped", "error"],
          "properties": {
            "verified": { "type": "integer", "minimum": 0 },
            "counterexampleFound": { "type": "integer", "minimum": 0 },
            "underspecified": { "type": "integer", "minimum": 0 },
            "noCounterexample": { "type": "integer", "minimum": 0 },
            "inconclusive": { "type": "integer", "minimum": 0 },
            "unsupported": { "type": "integer", "minimum": 0 },
            "skipped": { "type": "integer", "minimum": 0 },
            "error": { "type": "integer", "minimum": 0 }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    }
  },
  "definitions": {
    "result": {
      "type": "object",
      "required": ["origin", "code", "class", "property", "method", "scope", "assumptions", "unformalizedParts"],
      "properties": {
        "origin": { "enum": ["static", "formal"] },
        "code": { "type": "string", "pattern": "^(SYNTAX|[MLSJKG]\\d{3}|F\\d{3})$" },
        "class": { "$ref": "#/definitions/resultClass" },
        "property": {
          "type": "object",
          "required": ["id", "name"],
          "properties": { "id": { "type": "string", "minLength": 1 }, "name": { "type": "string", "minLength": 1 } },
          "additionalProperties": false
        },
        "method": { "enum": ["static", "tlc-exhaustive", "tlc-simulate", "apalache-bounded", "apalache-inductive"] },
        "scope": { "type": "object" },
        "assumptions": { "type": "array", "items": { "type": "string" } },
        "trace": { "type": "array", "items": { "type": "object" } },
        "attribution": { "type": "object" },
        "note": { "type": "string" },
        "unformalizedParts": { "type": "array", "items": { "type": "string" } },
        "skipReason": { "enum": ["noJava", "checkFailed", "unsupported"] },
        "errorKind": { "enum": ["usage", "configuration", "io", "translation", "checker"] }
      },
      "additionalProperties": false
    },
    "resultClass": {
      "type": "object",
      "required": ["id", "display"],
      "properties": {
        "id": { "enum": ["verified", "counterexampleFound", "underspecified", "noCounterexample", "inconclusive", "unsupported", "skipped", "error"] },
        "display": { "type": "string" }
      },
      "additionalProperties": false
    }
  }
}
```

The `diagnostic` definition adds the `origin` enum to its required fields and properties. A check result has `origin`
`static` or `formal`; error documents carry no records and therefore have no `origin`. `diagnostics`, `results`, and
`summary` are required
only when a check ran. A CLI error document has `schemaVersion`, `error`, and enum-valued `errorKind`, and does not
require check fields. `result` is deliberately extensible in `scope`, `trace`, and `attribution` pending a concrete
profile and trace codec; the outer shape and required fields are normative.

`property.id` is a stable IR declaration ID, with a readable model name alongside it. Kernel `Diagnostic.elementId`
exists but is not serialized by `jsonDiagnostic`
([diagnostics.ts](../../../shared/kernel/src/diagnostics.ts#L22-L34)); result property identity is serialized
explicitly.
The CLI currently maps diagnostics into JSON reports
([main.ts](../../../apps/dt/src/cli/main.ts#L186-L191),
[main.ts](../../../apps/dt/src/cli/main.ts#L1462-L1463)).

## Rule code audit and check-kind codes

Codes name check kinds, not outcomes; the outcome is exclusively `class`. A code remains stable when its check moves
between `check` and `verify`. The existing code pattern rejects codes already emitted by knowledge and generation:
K001/K002 ([check.ts](../../../contexts/knowledge/src/domain/check.ts#L8-L11)) and G001
([capabilities.ts](../../../capabilities/generation/src/core/capabilities.ts#L12-L20)). The corrected pattern admits
SYNTAX and the M/L, S, J, K, G families plus F verification codes. The rule registry is the `Rules` section of
`dt guide` ([guide.md](../../guide.md#L3522-L3528)); rule IDs are not all in `model/analysis.dt`. The M/L family is
listed there ([analysis.dt](../../../contexts/modeling/model/analysis.dt#L50-L95)); S is declared in Storming
([rule-ids.ts](../../../contexts/storming/src/domain/rule-ids.ts#L1-L12)); J includes J001
([journey.ts](../../../contexts/collaboration/src/domain/journey.ts#L623-L624)); K and G are defined at the linked
sources above. F codes are not currently used.

Assign F001 to creation invariant violation, F002 to invariant violated by a command, F003 to unexecutable command,
F004 to unsatisfiable `requires`, F005 to state or outcome unreachable within scope, F007 to contradictory
`ensures`, and F008 to deadlock. F006 is reserved. One unreachability code covers both exhaustive and bounded checks;
the class conveys strength.
There is no separate forced-violation code. F002 (for example) reports `counterexampleFound` for a forced, constrained
run or no-successor probe, and `underspecified` only for an unconstrained run with attribution. An invariant preserved
by
a command is reported as F002 with class `verified`.

A bounded or simulated search that found no counterexample to a universal claim has class `noCounterexample`, always
with `method` and `scope`, and exits 0. Reachability is reported on the positive claim: a witness found is `verified`
(exit 0); no witness within an exhaustive scope is `counterexampleFound` with note `unreachable within scope` (exit 1);
no witness within a bounded search is `inconclusive` with note `not reached within bound` (exit 1). `inconclusive` also
covers timeouts and resource limits.

When static `check` reports errors, `verify` does not explore. It emits each formal result as `skipped` with
`skipReason: checkFailed`. A missing Java runtime likewise produces `skipped` with `skipReason: noJava`.

## Full-envelope examples

The following are complete documents. `origin` is attached to each diagnostic and result. `Sales.Order:cancel`
identifies the command and `reason` is its input parameter. State property IDs use the exact stable ID form from
[ids.ts](../../../contexts/modeling/src/domain/ids.ts#L1-L30). Optional values use tagged values; enums are plain
strings. Fields absent from a state are omitted.

### Static check

```json
{
  "schemaVersion": 2,
  "diagnostics": [{ "origin": "static", "file": "order.dt", "line": 40, "column": 1, "endLine": 40, "endColumn": 12, "severity": "error", "code": "M001", "message": "Invalid model" }],
  "results": [],
  "summary": { "files": 1, "errors": 1, "warnings": 0, "results": { "verified": 0, "counterexampleFound": 0, "underspecified": 0, "noCounterexample": 0, "inconclusive": 0, "unsupported": 0, "skipped": 0, "error": 0 } }
}
```

### Verify result

The forced no-successor probe violates `hasItems`; it uses the F002 check-kind code and `counterexampleFound` class.

```json
{
  "schemaVersion": 2,
  "diagnostics": [],
  "results": [
    { "origin": "formal", "code": "F002", "class": { "id": "counterexampleFound", "display": "Counterexample found" }, "property": { "id": "Sales.Order#Confirmed.hasItems", "name": "hasItems" }, "method": "tlc-exhaustive", "scope": { "ids": 2, "maxItems": 2, "initialStates": ["creation"], "depth": "exhaustive" }, "assumptions": [], "attribution": { "command": "Sales.Order:confirm", "cause": "enabled input has no invariant-preserving successor" }, "trace": [{ "step": 1, "command": "Sales.Order:place", "arguments": { "id": "o1", "customer": "c1" }, "before": null, "after": { "state": "Draft", "items": [], "note": { "tag": "none" } }, "source": { "file": "order.dt", "line": 26 } }, { "step": 2, "command": "Sales.Order:confirm", "arguments": { "at": "t1" }, "before": { "state": "Draft", "items": [], "note": { "tag": "none" } }, "after": { "state": "Confirmed", "items": [], "note": { "tag": "none" }, "confirmedAt": "t1" }, "source": { "file": "order.dt", "line": 51 } }], "unformalizedParts": [] },
    { "origin": "formal", "code": "F002", "class": { "id": "underspecified", "display": "Underspecified" }, "property": { "id": "Sales.Order#Cancelled.otherNeedsNote", "name": "otherNeedsNote" }, "method": "tlc-exhaustive", "scope": { "ids": 2, "maxItems": 2, "initialStates": ["creation"], "depth": "exhaustive" }, "assumptions": [], "attribution": { "command": "Sales.Order:cancel", "cause": "reason is an unspecified output; the model does not bind the parameter to the field" }, "trace": [{ "step": 1, "command": "Sales.Order:place", "arguments": { "id": "o1", "customer": "c1" }, "before": null, "after": { "state": "Draft", "note": { "tag": "none" } }, "source": { "file": "order.dt", "line": 26 } }, { "step": 2, "command": "Sales.Order:cancel", "arguments": { "reason": "Requested" }, "before": { "state": "Draft", "note": { "tag": "none" } }, "after": { "state": "Cancelled", "reason": "Other", "note": { "tag": "none" } }, "source": { "file": "order.dt", "line": 56, "endLine": 62 } }], "unformalizedParts": ["The reason output is unspecified because the command parameter is not bound to the field"] },
    { "origin": "formal", "code": "F002", "class": { "id": "verified", "display": "Verified" }, "property": { "id": "Sales.Order#Confirmed.hasItems", "name": "hasItems" }, "method": "tlc-exhaustive", "scope": { "ids": 2, "maxItems": 2, "initialStates": ["creation"], "depth": "exhaustive" }, "assumptions": [], "attribution": { "command": "Sales.Order:changeNote" }, "unformalizedParts": [] }
  ],
  "summary": { "files": 1, "errors": 0, "warnings": 0, "results": { "verified": 1, "counterexampleFound": 1, "underspecified": 1, "noCounterexample": 0, "inconclusive": 0, "unsupported": 0, "skipped": 0, "error": 0 } }
}
```

### Generate

```json
{
  "schemaVersion": 2,
  "diagnostics": [],
  "results": [],
  "summary": { "files": 1, "errors": 0, "warnings": 0, "results": { "verified": 0, "counterexampleFound": 0, "underspecified": 0, "noCounterexample": 0, "inconclusive": 0, "unsupported": 0, "skipped": 0, "error": 0 } },
  "written": ["generated/domain"],
  "hints": []
}
```

### CLI error

```json
{
  "schemaVersion": 2,
  "errorKind": "usage",
  "error": "--timeline requires --storming <id>."
}
```

### Skipped results

A missing Java runtime skips formal execution:

```json
{
  "schemaVersion": 2,
  "diagnostics": [],
  "results": [{
  "origin": "formal",
  "code": "F002",
  "class": { "id": "skipped", "display": "Skipped" },
  "property": { "id": "Sales.Order#Confirmed.hasItems", "name": "hasItems" },
  "method": "tlc-exhaustive",
  "scope": { "initialStates": ["creation"] },
  "assumptions": [],
  "skipReason": "noJava",
  "unformalizedParts": []
  }],
  "summary": { "files": 1, "errors": 0, "warnings": 0, "results": { "verified": 0, "counterexampleFound": 0, "underspecified": 0, "noCounterexample": 0, "inconclusive": 0, "unsupported": 0, "skipped": 1, "error": 0 } }
}
```

A failed check prevents formal exploration:

```json
{
  "schemaVersion": 2,
  "diagnostics": [{ "origin": "static", "file": "order.dt", "line": 40, "column": 1, "endLine": 40, "endColumn": 12, "severity": "error", "code": "M001", "message": "Invalid model" }],
  "results": [{
  "origin": "formal",
  "code": "F002",
  "class": { "id": "skipped", "display": "Skipped" },
  "property": { "id": "Sales.Order#Confirmed.hasItems", "name": "hasItems" },
  "method": "tlc-exhaustive",
  "scope": { "initialStates": ["creation"] },
  "assumptions": [],
  "skipReason": "checkFailed",
  "unformalizedParts": []
  }],
  "summary": { "files": 1, "errors": 1, "warnings": 0, "results": { "verified": 0, "counterexampleFound": 0, "underspecified": 0, "noCounterexample": 0, "inconclusive": 0, "unsupported": 0, "skipped": 1, "error": 0 } }
}
```

### Error and unsupported results

```json
{
  "schemaVersion": 2,
  "diagnostics": [],
  "results": [{
  "origin": "formal",
  "code": "F002",
  "class": { "id": "error", "display": "Checker error" },
  "property": { "id": "Sales.Order#Confirmed.hasItems", "name": "hasItems" },
  "method": "tlc-exhaustive",
  "scope": { "initialStates": ["creation"] },
  "assumptions": [],
  "errorKind": "checker",
  "unformalizedParts": []
  }],
  "summary": { "files": 1, "errors": 0, "warnings": 0, "results": { "verified": 0, "counterexampleFound": 0, "underspecified": 0, "noCounterexample": 0, "inconclusive": 0, "unsupported": 0, "skipped": 0, "error": 1 } }
}
```

```json
{
  "schemaVersion": 2,
  "diagnostics": [],
  "results": [{
  "origin": "formal",
  "code": "F002",
  "class": { "id": "unsupported", "display": "Unsupported" },
  "property": { "id": "Sales.Order#OrderId.matches", "name": "matches" },
  "method": "tlc-exhaustive",
  "scope": { "initialStates": ["creation"], "stringDomain": "unbounded" },
  "assumptions": [],
  "unformalizedParts": ["The matches property uses an unbounded string domain"]
  }],
  "summary": { "files": 1, "errors": 0, "warnings": 0, "results": { "verified": 0, "counterexampleFound": 0, "underspecified": 0, "noCounterexample": 0, "inconclusive": 0, "unsupported": 1, "skipped": 0, "error": 0 } }
}
```

## Exit codes and error reporting

Exit codes follow result `class` and static errors, never diagnostic `severity`:

| Exit | Meaning |
|---|---|
| 0 | No static errors and no formal failure or required skip; includes `noCounterexample` |
| 1 | Static content error or formal `counterexampleFound`, underspecified, inconclusive, or unsupported result |
| 2 | Verification skipped |
| 3 | `SYNTAX`, unreadable files, usage/configuration/translation/checker errors, or any result of class `error` |

For mixed results, precedence is 3, then 1, then 2, then 0. `--allow-skip` can make skips non-failing only if no
other failure exists. `SYNTAX` and unreadable-file errors exit 3. J001 and K001 are content errors and exit 1.

Usage, configuration, translation, and checker errors, plus any result of class `error`, exit 3. Error documents carry
`schemaVersion`, `error`, and `errorKind`, without diagnostics or results. The `.dt` model parse failure is `SYNTAX` and
exits 3, while any available `.dtes` diagnostics remain included. `generate ts` check failures remain content errors
(exit 1); inability to parse or read files exits 3.

## Follow-on updates and verification

Update the check JSON contract snapshot at `test/__snapshots__/check-contract.test.ts.snap`, the JSON example in the
Rules guide and its contract at [guide.test.ts](../../../test/guide.test.ts#L170-L179), and CLI help text
([main.ts](../../../apps/dt/src/cli/main.ts#L318-L318)). Add a test that parses the fragment as JSON and validates each
example against the fragment merged with the existing `diagnostic` definition from
[schema/diagnostics.schema.json](../../../schema/diagnostics.schema.json). Keep baseline text and JSON contracts,
including exit behavior, in [check-contract.test.ts](../../../test/check-contract.test.ts#L1-L6).

The spike observed seed detection and reachability at [results.md](spike/results.md#L52-L59), mapped findings at
[results.md](spike/results.md#L71-L89), and bounded-check limitations at [results.md](spike/results.md#L104-L110). These
are finite-profile observations, not universal proofs. Nested trace encoding, simultaneous attribution, and stable IDs
for all property-bearing declarations still need implementation-level validation; no claim is made that these schema
fields or result codes already exist.
