# Single-module Order spike results

## Setup and reproduction

Capture B17b was taken outside the repository on 2026-11-27 and is not committed. Environment: Apple Silicon,
macOS 27, 8 cores, Temurin 27.0.1.1+4 arm64. TLC 1.7.4 (TLC 2.19) ran exhaustive checks; TLC 1.8.0
produced JSON traces. The Apalache 0.63.0 (build 67b8ec6) results come from capture B19, a re-run after the Apalache
seed run moved to `missing_requires_confirm__only_Confirm`; its 39 TLC results are identical to capture B17b's.
SHA-256 preflight:

| Tool | SHA-256 |
|---|---|
| TLC 1.7.4 `tla2tools.jar` | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` |
| TLC 1.8.0 `tla2tools.jar` | `67f9575c3b9ef7a0787b1bded34812862ffe79d711298e5a75b1a77720b19928` |
| Apalache 0.63.0 tarball | `a756e96af249bf33cd7629667a49472cb26ac8227c48583da139b414834d59df` |
| Apalache `apalache.jar` | `f2d43f2e279a657be50b2ecec3a013ba2915266008a2562b38412c3269347dc9` |

The finite profile has two order IDs, customers, item IDs, SKU atoms, currencies, timestamps, optional-note values,
quantities 1–2, and at most two items. Lists preserve order and duplicates. `Len(items) < 2` is a profile bound;
amount is omitted. The run matrix is the `.cfg` set in this directory: seeds `none`, `creation_items_param`,
`changenote_on_cancelled`,
`confirm_never_enabled`, `cancel_disabled`, `missing_requires_confirm`, and
`missing_requires_additem`; each run suffix (`U_all`, `C_all`, `C_probes`,
`only_<Action>`, `w_<property>`, `deadlock_U`) selects its check.

From the repository root, run `./docs/plans/formal-verification/spike/run-checks.sh OUT`. The script accepts
`DT_FV_JAVA_HOME`, `DT_FV_TLC174`, `DT_FV_TLC180`, `DT_FV_APALACHE_TGZ`, and `DT_FV_APALACHE_HOME` to override
its tool locations. It copies the single `Order.tla` and all configs to `OUT/spec`, then records logs, traces,
metadirs, and checker return codes in `OUT`.

## Classification rule implemented

For each action `A(p)`, the constrained form is mechanically `A_C(p) == A(p) /\ Inv'`. The probe is
`\A p: ENABLED A(p) => ENABLED A_C(p)`. Parameters are never constrained: for each fixed input tuple enabled
in the unconstrained relation, only unspecified output values can be chosen by `A_C`. A failed no-successor probe
means that enabled input has no invariant-preserving choice and is a forced `Counterexample found`. A bad target
state available only through unconstrained outputs is `Underspecified`. Attribution uses `NextOnly_A`, with only
action A unconstrained and all other action declarations constrained.

Existential goals use negated invariants and correct-model witnesses: the seed run passes while `none` violates the
negation, class `existential false within scope (negation Verified)`. Witnesses run on `Next` and `NextC`;
`none__w_confirm_C` and `none__w_cancelled_C` both violate, so neither positive witness depends on over-approximation.
Arguments are retained as quantified command inputs but do not bind to fields. Create is modeled as `Place` from
`Absent`, with its input tuple fixed; assigning its ID/customer parameters to fields is an explicit model
assumption. The create parameter `its` exists only for `creation_items_param`; in `none` it is quantified but unused.

## Seed detection

State counts are generated / distinct / left on queue. `—` means TLC stopped at the first-state invariant or probe,
before graph counts. The separation column lists the seed check that differs from the correct `none` result.

| Seed | Separating runs | Observed (exit; states) | Result class | Detected? |
|---|---|---|---|---|
| `creation_items_param` | `C_probes` (failed; `none` probes pass) | 12; — | Forced `Counterexample found` | Yes |
| `changenote_on_cancelled` | `only_ChangeNote` (failed; `none` only_ChangeNote passes) | 12; 236174 / 2902 / 2249 | `Underspecified`, attributed to ChangeNote | Yes |
| `confirm_never_enabled` | `w_confirm` seed holds; `none` violates negation | 0; 788425 / 6553 / 0 | Existential false within scope (negation `Verified`) | Yes |
| `cancel_disabled` | `w_cancelled` seed holds; `none` violates negation | 0; 805801 / 6537 / 0 | Existential false within scope (negation `Verified`) | Yes |
| `missing_requires_confirm` | `C_probes` fails; `none__C_probes` passes; `only_Confirm` fails; `none__only_Confirm` passes | Exit 12 | Detected via Confirm | Yes |
| `missing_requires_additem` | No separating run; `none__only_AddItem` also violates | Exit 12; 176923 / 650 / 647 | Level 2 limit | No |

Detection count: 5 of 5 seeded kinds, with missing-requires detected through `Confirm`; the `addItem` case is a
recorded Level 2 limit. A missing `requires` is detectable when it protects fields the command does not change (or
specify), not when it protects only unspecified outputs. With `changes items`, `items'` is unspecified, so the removed
requirement has no Level 2 effect. The correct model also admits duplicate SKUs (`none__only_AddItem` violates
`DistinctSkus`). Detection needs a Level 3 postcondition such as `ensures items' = Append(items, it)`. Removing the
`else DuplicateSku` leaves `error DuplicateSku` (`order.dt:108`) unused; a static check could flag it, but none exists.
`cancel_disabled` and `confirm_never_enabled` are the same mutation kind: a guard set to `FALSE`.

## Correct-model findings and mapped traces

`Init` is `Absent`. Violations in `U_all` and `only_Place` occur in state 2 after `Place`, not initially; only
`creation_items_param__C_probes` fails on the initial state because the probe is evaluated in `Absent`. The correct
model reports `Underspecified` for Place creation (`DistinctSkus` and `SingleCurrency`; TLC reports `Inv`), AddItem
(`none__only_AddItem`), and Cancel
(`none__only_Cancel`, `OtherNeedsNote`). It reports none for ChangeNote or Confirm
(`none__only_ChangeNote` and `none__only_Confirm` exhaust). Example source mappings follow; the source locations
refer to [`Order.tla`](Order.tla), whose comments identify the `.dt` source.

| Finding | Command / arguments | Fields before → after | Source / property |
|---|---|---|---|
| Place, `DistinctSkus` | `Place`; arguments inferred from state/action relation | Absent → Draft; two `(i1,s1,1,JPY)` items; outputs nondeterministic | `order.dt:26-28`; `distinctSkus`, `order.dt:20` |
| AddItem, `DistinctSkus` | `AddItem(it)`; argument not recorded (TLC 1.7.4), any `it` passing the guards | Draft with `items=<<>>` (after `Place_C`) → Draft with two `(i1,s1,1,JPY)` items selected for `items'` | `order.dt:43-49`; `distinctSkus`, `order.dt:20` |
| Cancel, `OtherNeedsNote` | `Cancel(r="Requested")` from TLC 1.8.0 JSON | Draft, `note=None`, `reason=None`, `confirmedAt=None` → Cancelled, `note=None`, `reason="Other"`, `confirmedAt=None`; `reason'="Other"` is the unspecified output | `order.dt:56-62`; `otherNeedsNote`, `order.dt:40` |

TLC 1.7.4 traces show states and action names, not arguments. TLC 1.8.0 JSON records context and parameters:
`missing_requires_confirm__C_probes` has `Place(oid=o1,cid=c1,its=[])`; `none__only_Cancel` has `Cancel(r="Requested")`.
Arguments elsewhere above are inferred from state/action relations. In the correct model `its` is unused and `items'`
is unspecified; there is no `items' = its`. A translator needs generated metadata for DomainTrail identity and field
provenance, and must recover inputs for forced failures reported through states alone.

## Stop criteria

| Criterion | Result | Evidence |
|---|---|---|
| Detect seeded kinds | Met: 5 of 5 | Missing requires is detected via Confirm; AddItem limit is recorded separately. |
| Complete correct constrained exhaustive run within time | Met | `none__C_all`: 246737 / 2901 / 0; 2.60 s; start 20:24:35, finish 20:24:38. |
| Map traces to model | Met manually | Generator needs command identity, argument recovery, field provenance, source spans, and property mapping. |
| Total capture runtime | Measured | Sum of all 45 wall entries: 84.86 s, including 0.02 s JVM startup and bounded Apalache runs (8.01 s, 7.64 s). |

`none__deadlock_U` passes with terminal-aware behavior: exit 0, 836313 / 10905 / 0. Cancelled is terminal. `U_all`
stops at its first violation, so violations requiring two unconstrained actions together were not checked. Phase 4
should use `-continue` and explain every violation through some `only_A` run.

Apalache (capture B19): `missing_requires_confirm__only_Confirm` reports an `Inv` violation at state 2 (exit 12,
3.50 s), the forced violation found by TLC's probe. `none__C_all` reports no error up to length 4 (exit 0, 8.19 s).
Under `NextC`, `Inv` holds by construction, and Apalache cannot evaluate the `ENABLED`
probes. The `none__C_all` run is a compatibility smoke test: it can show only that `Inv` holds under `NextC` to
length 4. Compatibility requires
annotations in the form keyword, `\* @type:` line comment, name; `DOMAIN items` replaces `1..Len(items)` because
Apalache requires a constant integer range there. Bounded success is not exhaustive proof.

Exit codes observed: TLC 0 and 12 in capture B17b; TLC 11, 75, 150, and 151 in earlier captures (their IDs are not
recorded in the available capture notes); TLC 255 in B14. Apalache 0 in B17b and 255 in B15 and B17. The translator must
inspect
checker diagnostics, completion markers, config, and traces rather than classify by exit code alone: map 12 via
the property and classification rule; map 11 to deadlock; map 0 to in-scope pass only after exhaustive completion;
map 75/150/151/255 to tool/spec/config errors based on diagnostics, not semantic findings.

## Phase 4 generator requirements and recommendation

- Treat SANY semantic diagnostics as failure even when SANY exits 0.
- Emit aligned bulleted action bodies and parenthesize quantified expressions and `IF` expressions.
- Emit definitions in dependency order and place `Inv'` last in constrained conjunctions.
- Use valid cfg keywords such as `CHECK_DEADLOCK`; define every cfg operator and validate operator closure.
- Generate one module with seed parameters instead of copied modules.
- Generate constrained forms mechanically and their fixed-parameter `ENABLED` probes; never constrain arguments.
- Produce provenance sufficient to map commands, args, fields, transitions, and violated source properties.
- Use `-continue` for attribution and account for every `U_all` violation through some `only_A`.
- Emit Apalache-compatible type comments (`\* @type:`) and constant ranges such as `DOMAIN items`; include bounded runs.

Use TLC as the default exhaustive checker; Java 27 works for TLC on this host. Apalache bounded runs now work;
they do not replace exhaustive TLC. `dt verify` needs per aggregate: one unconstrained all-invariant run; one
constrained exhaustive run; one probe run; per-action isolation runs when attribution is needed; and witness runs
for each existential property. Thus the baseline is 3 runs plus the number of actions for full isolation, with
additional witness runs
per existential. This profile has five actions. Capture B17b took 84.86 seconds across 45 timed invocations, including
startup
and Apalache runs. The exhaustive `none__C_all` itself is 2.60 seconds; aggregate count and domain growth multiply cost
and state-space growth can dominate.

## Unfinished

Joint attribution remains unchecked because `U_all` stops at its first violation; Phase 4 needs `-continue` and
per-violation `only_A` explanations. Apalache evidence is bounded to length 4. The `missing_requires_additem` case
remains undetectable until Level 3 `ensures` semantics are implemented. The unused-error static check does not exist.

## History: lessons for the generator

Earlier attempts exposed parser and checker traps: SANY can exit zero despite semantic errors; malformed alignment,
unparenthesized quantifiers or `IF`, and definition order can change parsing/evaluation; probe guard order matters
for safe evaluation; cfg keyword and missing-operator errors must be caught before execution. Multi-module copies
drifted, so seeds now share one module. Constraining arguments falsely removes forced input failures, while omitting
the generated input metadata makes state-only forced traces hard to explain. These failures motivate the Phase 4
requirements above.
