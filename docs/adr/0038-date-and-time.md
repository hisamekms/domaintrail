# ADR 0038: Dates, times and time zones

- Status: proposed
- Date: 2026-11-22
- Amends: [ADR 0035](0035-kind-specific-lifecycles.md) (the target-independent semantics of `Timestamp`), the
  representation of `Timestamp` in generated TypeScript

## Context

The DSL has one temporal type, `Timestamp`. Models need others: a birth date, a due date, a closing time, a billing
month, a meeting at 10:00 in Tokyo. In trials (Sonnet agents learning the DSL from `dt guide` only), every agent of six
needed a date or a time of day; each declared a `String` primitive with a regular expression (`^\d{4}-\d{2}-\d{2}$`),
which admits `2026-02-30`, compares as text by accident, and says nothing to the reader or to the generator. Some
first wrote `Date` or `CalendarDate`, which did not resolve.

`Timestamp` itself is generated as the JavaScript `Date`: mutable, unbranded, able to hold an Invalid Date, compared
with JavaScript's semantics, and unlike the other values of a model, which are plain data. The generated contract tests
copy inputs with `structuredClone` and compare values structurally; events and aggregates cross JSON.

DomainTrail generates TypeScript today, and its semantics are target-independent (ADR 0035) so that other generators
(Rust, …) follow. Names and representations that are one target's (JavaScript's `Date`, Temporal's `Plain…`) do not
belong in the language.

## Decision

### Two kinds of value: instants, and values on a calendar or clock

- An **instant** (`Timestamp`) is a point in time, the same everywhere. A time zone only says how to show it; an
  instant is never paired with one.
- A **value on a calendar or a clock** (`Date`, `Time`, `YearMonth`, `DateTime`) is a business value without a time
  zone: a birth date, a closing time. Which zone it is read in, when that matters, is said explicitly in one of two
  ways:
  - the zone belongs to **one value**: a `ZonedDateTime` (a meeting at 10:00 in Asia/Tokyo) holds its date, time,
    offset and zone in that one value;
  - the zone is an **attribute of the owner** and applies to many values: a `TimeZone` field (a shop's zone, which its
    opening times and closing days are read in). That the shop's zone applies to its dates is a rule of the business,
    stated by the model's structure, not by a type.
- Placing a `DateTime` and a `TimeZone` side by side to mean "this time in that zone" is not a construct: which value
  the zone belongs to would be implicit, and generated code could not help. Use `ZonedDateTime`.

### Types

| DSL type | Meaning | Canonical text | Stage |
|---|---|---|---|
| `Date` | a calendar date, no time zone | `YYYY-MM-DD` | 1 |
| `Time` | a time of day, no time zone | `HH:MM:SS` | 1 |
| `YearMonth` | a month of a year, no time zone | `YYYY-MM` | 1 |
| `Timestamp` | an instant (UTC) | `YYYY-MM-DDTHH:MM:SS.sssZ` | 1 (reworked) |
| `DateTime` | a date and a time of day, no time zone | `YYYY-MM-DDTHH:MM:SS` | 2 |
| `ZonedDateTime` | a date and time in a time zone | `YYYY-MM-DDTHH:MM:SS±HH:MM[Zone]` (RFC 9557) | 2 |
| `TimeZone` | an IANA time zone ID | `Asia/Tokyo` | 2 |

- The names are the language's, neutral to any target: short, and what agents guessed. Their meaning is defined here,
  not by a target's library (`DateTime` never has a time zone, whatever `DateTime` means in .NET or Python).
- They are primitive types: fields, parameters, payloads, optional and list multiplicities, and the base of a domain
  primitive (`primitive BirthDate: Date { value >= "1900-01-01" }`).
- Years are 0001–9999; `Time` and `DateTime` have whole seconds; `Timestamp` has milliseconds. `ZonedDateTime`'s
  offset must be the zone's offset at that local time (checked where a value is made, with time zone data); it keeps
  a value unambiguous in a repeated hour.
- **Canonical text is part of the language**, the form every target writes and reads: a TypeScript service's event is
  read by a Rust one. A value is made from text only through its target's parser, which rejects what is not a valid
  value (`2026-02-30`, `24:00:00`, an unknown zone) and normalizes what it accepts (`HH:MM` to `HH:MM:SS`, an offset
  instant to UTC).
- Not added: a year (an `Int` primitive says it), a date or time of day with a time zone (meaningless across daylight
  saving time, as SQL's `timetz`), and a duration (a month and thirty days do not compare; a count of days is an `Int`
  until a model needs more).

### Expressions

- Values of the same type compare: `==`, `!=`, and for all but `TimeZone` the order operators and `x in a..b`.
  `Date`, `Time`, `YearMonth`, `DateTime` and `Timestamp` order by calendar and clock (their canonical texts order the
  same way). `ZonedDateTime` orders **by instant**, computed from its offset without time zone data; `==` compares the
  whole value, so two values of one instant in different zones are neither equal nor ordered apart.
- Values of different types never compare (M009): converting needs a time zone, which is decided where it is known,
  in the application, and passed in as a parameter of the right type. The hint says so.
- A string literal compares with a value of these types when it is canonical text of that type (checked by M009):
  `billingMonth >= "2020-01"`.
- There is no "now" or "today" in the DSL: commands are pure. A rule over the current date takes it as a parameter
  (`requires notPast { visitDate >= today } else PastDate`), decided in the application in the right zone.

### Generated TypeScript

- Each type is its canonical text, branded: `PlainDate`, `PlainTime`, `PlainYearMonth`, `PlainDateTime`,
  `ZonedDateTime`, `Timestamp`, `TimeZone` (`string & { readonly [brand]: 'PlainDate' }`). The TypeScript names are the
  generator's: they keep clear of the global `Date` and follow Temporal, which JavaScript developers and agents will
  know. The JSDoc names the DSL type (`DSL: Date`). Other generators choose their own (Rust: `jiff`'s `civil::Date`,
  `Timestamp`, `Zoned`, …).
- Plain text crosses JSON, `structuredClone` and structural equality unchanged, needs no dependency, and its order
  operators are the DSL's for all but `ZonedDateTime`, whose generated checks compare with the runtime's
  `zonedCompare` (by instant).
- The runtime makes values: `parseDate`, `parseTime`, `parseYearMonth`, `parseDateTime`, `parseTimestamp`,
  `parseZonedDateTime`, `parseTimeZone` (each `undefined` for text that is not a value, as `parseDecimal`), and
  `timestampOf(date: Date)`. `instantOf(z)` gives a `ZonedDateTime`'s instant. These and `make<Name>` of domain
  primitives over them are the only ways to make the types (no `as`, `dt guide lint`).
- Calculation (adding days, converting zones, today in a zone) is the application's, in `decide` or around it. The
  runtime converts to and from Temporal for those who use it (`toPlainDate` / `fromPlainDate`, `toInstant` /
  `fromInstant`, `toZonedDateTime` / `fromZonedDateTime`, …); the generated code does not depend on Temporal, which
  Safari and Bun do not ship at the time of writing.
- Generated contract tests draw valid values of each type (including month ends, leap days, the bounds of a range),
  and the generated checks compile the comparisons as above.

### `Timestamp` changes representation

`Timestamp` becomes a branded canonical string, no longer a `Date` (a breaking change). `JSON.stringify` of a `Date`
writes the same canonical text, so stored JSON stays readable as it is. Code that called `Date` methods on a
`Timestamp` uses `new Date(t)` or `toInstant(t)`; code that made one with `new Date()` uses `timestampOf(new Date())`.

## Stages

Stage 1: `Date`, `Time`, `YearMonth` and the rework of `Timestamp`. Stage 2: `DateTime`, `ZonedDateTime`, `TimeZone`,
when a model needs them. The decisions above cover both; the second stage adds types, not semantics.

## Rejected alternatives

- **Temporal objects as the generated representation**: they do not survive JSON or `structuredClone` as values,
  compare with `.equals` rather than `===`, need a polyfill where engines lack them, and are one target's library. The
  runtime converts to them for calculation instead; a later option may generate them where every engine has them.
- **`Plain…` (or `Local…`, `Naive…`) names in the DSL**: each is one ecosystem's convention (Temporal, Java, chrono);
  the language keeps neutral names and each generator maps them.
- **`DateTime` and `TimeZone` side by side for a zoned value**: the pairing is implicit and ambiguous with several
  values; `ZonedDateTime` makes it a value.
- **Comparing across types with implicit conversion** (a `Date` with a `Timestamp`): it needs a time zone the DSL does
  not have; the application converts where it knows one.
- **`now` / `today` in expressions**: commands are pure functions of their inputs; the clock is an input.
- **Keeping `Timestamp` as `Date`**: mutable, unbranded and target-specific; a second representation beside the plain
  data of every other value.
