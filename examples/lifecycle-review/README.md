# Kind-specific lifecycle review

This workspace exercises the CollectionRequest lifecycle in the Live View.

```sh
bun ./bin/dt.ts -r examples/lifecycle-review check --for-generation
bun ./bin/dt.ts -r examples/lifecycle-review open --no-agent --port 4341
```

Select the `CollectionRequest` aggregate, then its **状態遷移** tab. Switch the kind between `COLLECT` and `DROP_OFF`. Assignment, cancellation, and postponement are common. Completion and the valid state set differ by kind.
