# ADR 0023: Verified types

- Status: accepted
- Date: 2026-10-24

## Context

Commands are pure functions of the aggregate and their parameters (ADR 0011, `dt guide pure`), so they cannot check
anything outside their aggregate: an email address that no other customer uses, an address an outside service
confirmed, a budget approved for this spend, stock reserved for an order. Such rules were written as invariants without
an expression (`invariant uniqueEmail "メールアドレスは顧客ごとに一意"`) and as an error in the command's `errors`
(`changeEmail … errors EmailTaken`), which a pure command can never return: it has nothing to decide it from. Nothing
made the application make the check before calling the command; forgetting it compiled.

The DSL is edited by AI agents, and AI agents implement against the generated TypeScript. A rule that only a comment
states is the rule an agent misses. What the compiler checks, it does not.

## Decision

### A verified type is the evidence that a check was made

```dt
/// 他の顧客に使われていないことを、登録・変更のときに確かめたメールアドレス。
verified AvailableEmail "未使用のメールアドレス" of EmailAddress for CustomerId? errors EmailTaken

create command register(id: CustomerId, name: String, email: AvailableEmail)
command changeEmail(email: AvailableEmail) changes email
```

- Grammar: a context element `'verified' name=ID label=STRING? 'of' base=TypeRef ('for' context=TypeRef '?'?)?
  ('errors' Error (',' Error)*)?`. `verified`, `of` and `for` are keywords added to `FeatureName`, so they still name
  fields and parameters.
- The base is a value type: a primitive type, a domain primitive, an ID, an enum, a value object, a union, or another
  verified type — a chain, whose value carries both verifications. Not an entity or an aggregate.
- `for` names the context the check needs besides the value: the customer to leave out, a tenant, the approver;
  optional with `?`. A value type, not a verified one.
- `errors` are the errors of the **factory**: a command taking the value does not return them (it cannot; the check was
  made before it ran).
- A verified type types **command parameters** and the base of another verified type only. It is evidence about the
  moment of the check, so no field holds it — of an aggregate, entity, value object, union, field set, event or error.
  The field stores the base type, and a command stores its verified parameter there as it is.
- In invariant and requirement expressions a verified value is a value of its base type, and the payload rule M022
  matches it by its base type.
- Not allowed in a shared context (M014 is unchanged): a check outside the aggregate belongs to the context whose
  commands need it.

M024 reports a base or context that is not a value type, a verified context, a cycle of verified types, and a field of a
verified type (with the hint `store the base type 'EmailAddress'`, the type at the end of a chain).

### Generated TypeScript

```ts
export type AvailableEmail = Common.EmailAddress & { readonly 'verified:Sales.AvailableEmail': true };
export type MakeAvailableEmail = (value: Common.EmailAddress, context: CustomerId | undefined) => Promise<Result<AvailableEmail, EmailTaken>>;
```

- **One property per verified type**, keyed by its qualified name. A shared key (`__verified: 'A'`) would make a value
  with two verifications (`A & B`) uninhabitable, since `'A' & 'B'` is `never`; with a key per type the verifications
  combine, and a value with only one of two is rejected. The type is assignable to its base, so storing it in a field of
  the base type needs no conversion. A value of the base is rejected where the verified type is expected (`Argument of
  type 'EmailAddress' is not assignable to parameter of type 'AvailableEmail'`), and so is a value with another
  verification.
- The factory is **async**, because the check reads repositories and services, and always returns a `Result`: the
  value or one of `errors`, `never` without `errors`. A `Result` even when it cannot fail, so that every factory is
  called the same way and adding an error later changes no call site. Its second parameter is the context: required
  with `for X`, `X | undefined` with `for X?`, absent without `for`.
- The JSDoc carries the label, the description, `@see`, and: "Evidence of a check made at that moment, not a guarantee
  when the aggregate is saved — keep enforcing it where it is stored (e.g. a unique index)."
- The user writes the factory, with repositories and services; generated code has nothing to call. It is the only code
  that may assert the type. A cast elsewhere (`raw as AvailableEmail`) still compiles — the same weakness as the
  constructors of domain primitives — and the guide says it defeats the purpose.

### Tests

The generated contract tests do **not** test the factories. A factory's correctness is its integration with
repositories and services — which customer is left out, what the outside service answers, what happens on a timeout —
none of which the model states, so there is no oracle to generate. The user tests the factory, as `examples/shop`
does in `src/app.test.ts`, and the guide lists the factories under what is outside the generated tests.

For a command taking a verified parameter, the arbitrary of the verified type is the arbitrary of its base, cast: the
tests take every value of the base as verified ("the check passed"). The command's contract is about what it does with
a checked value; whether the check is right is the factory's. The arbitrary is overridable with `arbitraries` like any
other (`{ Sales: { AvailableEmail: … } }`).

### Evidence, not a guarantee

The check holds at the moment it is made. Two customers registering the same address at once may both pass it. The
verified type makes the application *make* the check; the store still enforces the rule where the data is saved (a
unique index) and reports a conflict. The model stays honest about it: an aggregate keeps the rule as an invariant
without an expression when the saved state relies on it (`uniqueEmail` in the guide), and the generated JSDoc says it.

## Alternatives considered

### Generic or specific to uniqueness

Most cases that motivated this are uniqueness ("no other customer has this email"). A uniqueness-specific construct
could say more — which aggregate, which field — and could feed the store (an index) and documentation. But the same gap
exists for checks that are not about uniqueness at all: an address confirmed by an outside service, an approved budget,
reserved stock, a credit check. A generic construct covers them with one idea (evidence of a check outside the
aggregate) and one shape of generated code, and keeps the DSL from describing *how* the check is made, which is
behaviour, not structure (ADR 0011). The cost is that the model does not say what the check is beyond its name, label
and description; that is what a description is for.

### Rejected for now

- **B1. A `unique` declaration** on the aggregate (`unique email`), generating a repository query or an index
  definition. It covers uniqueness only, reaches into persistence (which index, which store, case folding), and still
  needs something at the command — the check before it runs — which is this ADR.
- **B2. Repository contracts** (`repository Customers { findByEmail(email): Customer? }`), so that generated code could
  make the check itself. Generated code would then do I/O and depend on infrastructure, and commands would no longer be
  pure; the model would describe the application layer.

Both can be revisited when a project needs them; neither conflicts with verified types.

### Possible extension: semantic tags

A verified type could later say what its check means in terms the tools understand, e.g. `verified AvailableEmail of
EmailAddress for CustomerId? by unique(Customer.email)`. Tools could then generate the store's index, document the rule
on the aggregate, or produce a reference factory for an in-memory repository. The generic form stays the base: a tag
would add meaning to a verified type, not replace it.

### Others

- **An error in the command's `errors`** (the state before this ADR): documents the rule but cannot be enforced or
  returned by a pure command.
- **A parameter of a plain type with a `requires` without an expression**: states the rule at the command, but nothing
  makes the caller make the check, and a declared requirement belongs to the aggregate's data, not the outside world.
- **A branded field type stored in the aggregate**: the evidence would outlive the moment it describes; a stored
  `AvailableEmail` claims something nobody re-checked.
