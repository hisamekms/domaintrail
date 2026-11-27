# Single-module spike run matrix

Run from the repository root with `./docs/plans/formal-verification/spike/run-checks.sh OUT`. Tool path overrides:
`DT_FV_JAVA_HOME`, `DT_FV_TLC174`, `DT_FV_TLC180`, `DT_FV_APALACHE_TGZ`, and `DT_FV_APALACHE_HOME`.
Capture B17b was taken outside the repository on 2026-11-27 and is not committed. The complete count and classification
table is in [results.md](results.md).

| Config(s) | Expected | Observed in capture B17b |
|---|---|---|
| `none__U_all` | Correct-model underspecification found | Exit 12, 36 / 36 / 34; state 2 after `Place`: `Inv` violation. |
| `none__C_all` | Exhaustive invariant pass | Exit 0, 246737 / 2901 / 0; 2.60 s. |
| `none__C_probes` | No constrained successor missing | Exit 0, 245765 / 2901 / 0. |
| `none__deadlock_U` | Terminal-aware unconstrained deadlock pass | Exit 0, 836313 / 10905 / 0. |
| `none__only_Place`, `none__only_AddItem`, `none__only_Cancel` | Attribute creation, AddItem, Cancel | Exit 12 each; Place violation in state 2 after `Place`, AddItem 176923 / 650 / 647, Cancel 176907 / 651 / 648. |
| `none__only_ChangeNote`, `none__only_Confirm` | No finding for those actions | Exit 0 each; 245765 / 2901 / 0. |
| `none__w_confirm`, `none__w_cancelled`, `none__w_confirm_C`, `none__w_cancelled_C` | Correct-model positive existential witnesses | Exit 12 each; 4 / 4 / 2 and 600606 / 2186 / 2183 for unconstrained; constrained witness checks also violate. |
| `creation_items_param__U_all`, `__only_Place` | Seeded creation result | Exit 12, 36 / 36 / 34; violation in state 2 after `Place`. |
| `creation_items_param__C_all` | Constrained invariant pass | Exit 0, 70481 / 2901 / 0. |
| `creation_items_param__C_probes` | Detect fixed duplicate-item input | Exit 12; initial `Probes` failure. Forced counterexample; `none` probes pass. |
| `changenote_on_cancelled__U_all` | Seeded violation surfaced | Exit 12, 36 / 36 / 34; violation in state 2 after `Place`. |
| `changenote_on_cancelled__only_ChangeNote` | Isolated ChangeNote violation | Exit 12, 236174 / 2902 / 2249; attributed to ChangeNote. |
| `changenote_on_cancelled__C_all`, `__C_probes` | Constrained seed passes | Exit 0; respectively 249977 / 2901 / 0 and 249005 / 2901 / 0. |
| `confirm_never_enabled__U_all` | Seeded violation surfaced | Exit 12, 36 / 36 / 34; violation in state 2 after `Place`. |
| `confirm_never_enabled__C_all`, `__C_probes`, `__only_Confirm` | Constrained checks pass | Exit 0; 234577 / 1621 / 0, 233605 / 1621 / 0, 233605 / 1621 / 0. |
| `confirm_never_enabled__w_confirm` | Confirm witness absent in seed | Exit 0, 788425 / 6553 / 0; `ConfirmNeverEnabled` holds. |
| `cancel_disabled__U_all` | Seeded violation surfaced | Exit 12, 36 / 36 / 34; violation in state 2 after `Place`. |
| `cancel_disabled__C_all`, `__C_probes`, `__only_Cancel` | Constrained checks pass | Exit 0; 239017 / 1929 / 0, 239017 / 1929 / 0, 239017 / 1929 / 0. |
| `cancel_disabled__w_cancelled` | Cancelled witness absent in seed | Exit 0, 805801 / 6537 / 0; `NotCancelled` holds. |
| `missing_requires_confirm__C_probes`, `__only_Confirm` | Missing `hasItems` requirement | `C_probes` 2 / 2 / 0; `only_Confirm` 176906 / 650 / 647. Both fail (exit 12); `none` counterparts pass. Detected. |
| `missing_requires_additem__U_all`, `__only_AddItem` | Missing AddItem requirement | Exit 12; correct model also violates `only_AddItem` (176923 / 650 / 647). Not detected at Level 2. |
| `missing_requires_additem__C_all`, `__C_probes` | Constrained checks pass | Exit 0; 288209 / 2901 / 0 and 287237 / 2901 / 0. |
| TLC 1.8.0 JSON runs (`missing_requires_confirm__C_probes`, `none__only_Cancel`) | JSON argument traces | Exit 12; formal parameters are present in JSON. |
| Both Apalache checks | Bounded result | Capture B19: `none__C_all` no error to length 4 (exit 0; a compatibility smoke test only, `Inv` holds under `NextC` by construction); `missing_requires_confirm__only_Confirm` violates `Inv` at state 2 (exit 12). Apalache cannot evaluate the `ENABLED` probes. |

## Interpretation

Counts are generated / distinct / queue left. The constrained form is `A_C(p) == A(p) /\ Inv'`; its probe is
`\A p: ENABLED A(p) => ENABLED A_C(p)`. Inputs are held fixed and never constrained. A failed probe is a forced
counterexample; an invariant violation available only with unconstrained outputs is `Underspecified`. Attribute
with `NextOnly_A`, leaving only A unconstrained. Missing `requires` is detectable when it protects unchanged or
specified fields, not fields that remain unspecified.
The missing AddItem requirement is not detected because `items'` is unspecified; the correct model also admits
duplicate SKUs. A postcondition such as `items' = Append(items, it)` is needed at Level 3. See the detection table
and trace mapping in [results.md](results.md).
