# Aggregate kinds review

This workspace exercises the CollectionRequest lifecycle in the Live View.

```sh
bun ./bin/dt.ts -r examples/lifecycle-review check --for-generation
bun ./bin/dt.ts -r examples/lifecycle-review open --no-agent --port 4341
```

Select the `CollectionRequest` aggregate, then its **状態遷移** tab. Switch the kind between `COLLECT` and `DROP_OFF`. Assignment, cancellation, and postponement are common. Each kind has its own create command; completion is common but decided in each kind's `on complete`; receiving for drop-off is a command of `DROP_OFF` only; the valid state set differs by kind (ADR 0037).
