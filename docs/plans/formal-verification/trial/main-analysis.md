---
status: draft
---

# Trial analysis: main-2026-11-28-80791eee

Attempts: 192. Exhausted: 0.

Reviewer agreement: 192/192; adjudicated: 0.

## M2 vs A0

| Packet | Family | n (arm/A0) | First syntax | First type | Repair tokens / attempt | Semantic pass |
|---|---|---|---|---|---|---|
| WS-01 | Claude | 6/6 | 100% vs 100% | 33% vs 17% | 118847 vs 171076 | 100% vs 100% |
| WS-01 | Codex | 6/6 | 100% vs 100% | 67% vs 83% | 124412 vs 76262 | 100% vs 100% |
| WS-01 | pooled | 12/12 | 0% pts | 0% pts | ≥15% more (a family) | 100% vs 100% |
| WS-02 | Claude | 6/6 | 100% vs 100% | 0% vs 17% | 140107 vs 115408 | 83% vs 67% |
| WS-02 | Codex | 6/6 | 100% vs 100% | 0% vs 0% | 389534 vs 336593 | 67% vs 100% |
| WS-02 | pooled | 12/12 | 0% pts | -8% pts | ≥15% more (a family) | 75% vs 83% |
| WS-03 | Claude | 6/6 | 83% vs 100% | 83% vs 100% | 20977 vs 0 | 100% vs 100% |
| WS-03 | Codex | 6/6 | 100% vs 100% | 100% vs 100% | 0 vs 0 | 100% vs 100% |
| WS-03 | pooled | 12/12 | -8% pts | -8% pts | ≥15% more (a family) | 100% vs 100% |
| WS-04 | Claude | 6/6 | 100% vs 100% | 0% vs 0% | 113243 vs 130480 | 100% vs 100% |
| WS-04 | Codex | 6/6 | 100% vs 100% | 100% vs 100% | 0 vs 0 | 100% vs 100% |
| WS-04 | pooled | 12/12 | 0% pts | 0% pts | within 15% | 100% vs 100% |

Mean first type-check difference over packets: -4% pts (95% bootstrap -8% to 0%, n=4).

## M3 vs A0

| Packet | Family | n (arm/A0) | First syntax | First type | Repair tokens / attempt | Semantic pass |
|---|---|---|---|---|---|---|
| WS-01 | Claude | 6/6 | 100% vs 100% | 50% vs 17% | 99187 vs 171076 | 100% vs 100% |
| WS-01 | Codex | 6/6 | 100% vs 100% | 33% vs 83% | 249394 vs 76262 | 100% vs 100% |
| WS-01 | pooled | 12/12 | 0% pts | -8% pts | ≥15% more (a family) | 100% vs 100% |
| WS-02 | Claude | 6/6 | 100% vs 100% | 17% vs 17% | 105963 vs 115408 | 33% vs 67% |
| WS-02 | Codex | 6/6 | 100% vs 100% | 0% vs 0% | 359610 vs 336593 | 100% vs 100% |
| WS-02 | pooled | 12/12 | 0% pts | 0% pts | within 15% | 67% vs 83% |
| WS-03 | Claude | 6/6 | 100% vs 100% | 100% vs 100% | 0 vs 0 | 100% vs 100% |
| WS-03 | Codex | 6/6 | 100% vs 100% | 100% vs 100% | 0 vs 0 | 100% vs 100% |
| WS-03 | pooled | 12/12 | 0% pts | 0% pts | within 15% | 100% vs 100% |
| WS-04 | Claude | 6/6 | 100% vs 100% | 0% vs 0% | 147669 vs 130480 | 100% vs 100% |
| WS-04 | Codex | 6/6 | 100% vs 100% | 100% vs 100% | 0 vs 0 | 100% vs 100% |
| WS-04 | pooled | 12/12 | 0% pts | 0% pts | within 15% | 100% vs 100% |

Mean first type-check difference over packets: -2% pts (95% bootstrap -6% to 0%, n=4).

## Q2 vs A0

| Packet | Family | n (arm/A0) | First syntax | First type | Repair tokens / attempt | Semantic pass |
|---|---|---|---|---|---|---|
| WS-01 | Claude | 6/6 | 100% vs 100% | 17% vs 17% | 234054 vs 171076 | 100% vs 100% |
| WS-01 | Codex | 6/6 | 100% vs 100% | 67% vs 83% | 157914 vs 76262 | 100% vs 100% |
| WS-01 | pooled | 12/12 | 0% pts | -8% pts | ≥15% more (a family) | 100% vs 100% |
| WS-02 | Claude | 6/6 | 100% vs 100% | 0% vs 17% | 150283 vs 115408 | 50% vs 67% |
| WS-02 | Codex | 6/6 | 100% vs 100% | 0% vs 0% | 347113 vs 336593 | 83% vs 100% |
| WS-02 | pooled | 12/12 | 0% pts | -8% pts | ≥15% more (a family) | 67% vs 83% |
| WS-03 | Claude | 6/6 | 100% vs 100% | 100% vs 100% | 0 vs 0 | 100% vs 100% |
| WS-03 | Codex | 6/6 | 100% vs 100% | 100% vs 100% | 0 vs 0 | 100% vs 100% |
| WS-03 | pooled | 12/12 | 0% pts | 0% pts | within 15% | 100% vs 100% |
| WS-04 | Claude | 6/6 | 100% vs 100% | 0% vs 0% | 127764 vs 130480 | 100% vs 100% |
| WS-04 | Codex | 6/6 | 100% vs 100% | 83% vs 100% | 47381 vs 0 | 100% vs 100% |
| WS-04 | pooled | 12/12 | 0% pts | -8% pts | ≥15% more (a family) | 100% vs 100% |

Mean first type-check difference over packets: -6% pts (95% bootstrap -8% to -2%, n=4).

## Decision

- M2: does not beat A0 (packets improved without regression or reversal: 0; a regression in some packet: yes; semantic veto: no).
- M3: does not beat A0 (packets improved without regression or reversal: 0; a regression in some packet: yes; semantic veto: yes).
- Q2: does not beat A0 (packets improved without regression or reversal: 0; a regression in some packet: yes; semantic veto: yes).

No arm met the decision rule: A0 stays adopted.

