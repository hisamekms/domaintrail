import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../src/core/diagnostics.js';
import type { Clause, Group, NodeElement, NodeElementKind, RelationKeyword, SourceRange, Storming, Timeline } from '../src/dtes/ir.js';
import { validateStormings } from '../src/dtes/validate.js';

/**
 * Builds the storming IR of `.dtes` text written one clause per line, as the parser (T2) would, so that the validator is
 * tested on the IR alone (ADR 0024). Ranges are whole lines: what a diagnostic points at is checked by its line.
 */
function ir(text: string, file = 'cancel.dtes'): Storming[] {
    const lines = text.split('\n');
    const at = (i: number): SourceRange => ({ file, start: { line: i + 1, column: 1 }, end: { line: i + 1, column: lines[i]!.length + 1 } });
    const stormings: Storming[] = [];
    let storming: Storming | undefined;
    let element: NodeElement | undefined;
    let timeline: Timeline | undefined;
    let group: Group | undefined;
    const RELATIONS = ['actor', 'reads', 'target', 'emits', 'on', 'issues'];
    lines.forEach((raw, i) => {
        const l = raw.trim();
        if (!l) return;
        const [word, id = ''] = l.split(/\s+/);
        const label = /"([^"]*)"/.exec(l)?.[1];
        const opens = l.endsWith('{');
        if (l === '}') {
            if (group) group = undefined;
            else if (timeline) timeline = undefined;
            else if (element) element = undefined;
            else storming = undefined;
            return;
        }
        if (group) {
            group.events.push({ eventId: l, range: at(i) });
        } else if (timeline) {
            if (word === 'group') {
                group = { kind: 'group', id, label, range: at(i), nameRange: at(i), events: [] };
                timeline.steps.push({ type: 'group', ...group });
                // The step shares `events` with `group`, so the lines that follow fill both.
            } else {
                timeline.steps.push({ type: 'event', eventId: l, range: at(i) });
            }
        } else if (element) {
            let clause: Clause;
            if (word === 'ref') clause = { type: 'ref', path: id, segments: id.split('.'), range: at(i) };
            else if (word === 'status') clause = { type: 'status', value: id, range: at(i) };
            else if (word === 'resolution') clause = { type: 'resolution', text: label ?? '', range: at(i) };
            else if (RELATIONS.includes(word!)) clause = { type: 'relation', keyword: word as RelationKeyword, target: id, range: at(i), targetRange: at(i) };
            else throw new Error(`test IR: unknown clause '${l}'`);
            element.clauses.push(clause);
        } else if (!storming) {
            storming = { id, label, range: at(i), nameRange: at(i), elements: [] };
            stormings.push(storming);
        } else if (word === 'timeline') {
            timeline = { kind: 'timeline', id, label, range: at(i), nameRange: at(i), steps: [] };
            storming.elements.push(timeline);
        } else {
            const el: NodeElement = { kind: word as NodeElementKind, id, label, range: at(i), nameRange: at(i), clauses: [] };
            storming.elements.push(el);
            if (opens) element = el;
        }
    });
    return stormings;
}

const validate = (text: string): Diagnostic[] => validateStormings(ir(text));
const summary = (ds: Diagnostic[]) => ds.map((d) => ({ code: d.code, severity: d.severity, line: d.start.line }));

/** The base of spec §4: a valid storming, wrapped around `extra` declarations. */
const cancel = (extra = '') => `storming DeliveryCancellation "配送キャンセル" {
  event ShipmentCancelled "配送がキャンセルされた" {
    ref Delivery.ShipmentCancelled
  }
  event BikeReleased "車両割当が解除された"
  event SlotReleased "配送枠が解放された"
  event ReleaseFailed "車両割当の解放に失敗した"
  actor Customer "顧客"
  external PaymentGateway "決済サービス"
  readmodel DeliveryDetails "配送詳細"
  aggregate Shipment "配送" {
    ref Delivery.Shipment
  }
  aggregate BikeAssignment "車両割当"
  command CancelShipment "配送キャンセル" {
    ref Delivery.Shipment.cancel
    actor Customer
    reads DeliveryDetails
    target Shipment
    emits ShipmentCancelled
  }
  command ReleaseBike "車両割当解除" {
    target BikeAssignment
    emits BikeReleased
    emits ReleaseFailed
  }
  command ReleaseSlot "配送枠解除" {
    emits SlotReleased
  }
  policy CleanupAfterCancel "キャンセル後処理" {
    on ShipmentCancelled
    issues ReleaseBike
    issues ReleaseSlot
  }
  timeline Normal "通常キャンセル" {
    ShipmentCancelled
    group CleanupResults "後処理" {
      BikeReleased
      SlotReleased
    }
  }
  timeline Failure "車両解放失敗" {
    ShipmentCancelled
    ReleaseFailed
  }
  hotspot Compensation "補償する？" {
    on ReleaseFailed
    status open
  }
${extra}
}
`;

/** The line (1-based) of the first line of `text` that contains `needle`. */
const lineOf = (text: string, needle: string, from = 0): number => text.split('\n').findIndex((l, i) => i >= from && l.includes(needle)) + 1;

describe('validateStormings', () => {
    test('the sample of spec §4 is valid', () => {
        expect(validate(cancel())).toEqual([]);
    });

    test('ES02 a timeline or group step that is not an event is an error', () => {
        const text = cancel(`  timeline Wrong {
    CancelShipment
    group Mixed {
      BikeReleased
      CleanupAfterCancel
    }
    Normal
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S003', severity: 'error', line: lineOf(text, 'CancelShipment', 50) },
            { code: 'S003', severity: 'error', line: lineOf(text, 'CleanupAfterCancel', 50) },
            { code: 'S003', severity: 'error', line: lineOf(text, '    Normal', 50) },
        ]);
        expect(ds[0]!.message).toBe(`A step of timeline 'Wrong' names 'CancelShipment', which is a command; it must name an event.`);
        expect(ds[1]!.message).toBe(`Group 'Mixed' of timeline 'Wrong' names 'CleanupAfterCancel', which is a policy; it must name an event.`);
        expect(ds[2]!.message).toContain(`which is a timeline`);
        expect(ds[0]!.elementId).toBe('es/DeliveryCancellation/Wrong');
        expect(ds[1]!.elementId).toBe('es/DeliveryCancellation/Mixed');
    });

    test('ES03 two `target`s are an error, none is legal', () => {
        const text = cancel(`  command Reassign {
    target Shipment
    target BikeAssignment
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([{ code: 'S004', severity: 'error', line: lineOf(text, 'target BikeAssignment', 50) }]);
        expect(ds[0]!.message).toBe("Command 'Reassign' has more than one `target`; it takes at most one.");
        expect(ds[0]!.hint).toBe('keep one `target` and remove the others');
        // ReleaseSlot of the sample has no target.
        expect(validate(cancel('  command Noop')).filter((d) => d.code === 'S004')).toEqual([]);
    });

    test('ES04 several `actor`s (actor or external), `reads` and `emits` are legal', () => {
        expect(
            validate(
                cancel(`  readmodel Fleet
  command Release {
    actor Customer
    actor PaymentGateway
    reads DeliveryDetails
    reads Fleet
    emits BikeReleased
    emits ReleaseFailed
  }`),
            ),
        ).toEqual([]);
    });

    test('ES05 a policy may have several `on` and `issues`; one without either is an error', () => {
        expect(
            validate(
                cancel(`  event SlotExpired
  policy Retry {
    on SlotExpired
    on ShipmentCancelled
    issues ReleaseBike
    issues ReleaseSlot
  }`),
            ),
        ).toEqual([]);
        const text = cancel(`  policy NoTrigger {
    issues ReleaseBike
  }
  policy NoCommand {
    on ShipmentCancelled
  }
  policy Empty`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S008', severity: 'error', line: lineOf(text, 'policy NoTrigger') },
            { code: 'S008', severity: 'error', line: lineOf(text, 'policy NoCommand') },
            { code: 'S008', severity: 'error', line: lineOf(text, 'policy Empty') },
        ]);
        expect(ds[0]!.message).toBe(
            "Policy 'NoTrigger' has no `on`; a policy reacts to at least one event (`on`) and may issue at least one command (`issues`).",
        );
        expect(ds[0]!.hint).toBe('add `on <Event>`; while it is unknown, record the question as a hotspot instead');
        expect(ds[2]!.message).toContain('has no `on` and `issues`');
    });

    test('ES08 hotspot status and resolution', () => {
        const text = cancel(`  hotspot Settled "決着済み" {
    status resolved
    resolution "補償しない"
  }
  hotspot Unexplained {
    status resolved
  }
  hotspot Premature {
    status open
    resolution "まだ"
  }
  hotspot DefaultOpen {
    resolution "まだ"
  }
  hotspot Typo {
    status reslved
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S009', severity: 'error', line: lineOf(text, 'status resolved', lineOf(text, 'Unexplained')) },
            { code: 'S009', severity: 'error', line: lineOf(text, 'resolution', lineOf(text, 'Premature')) },
            { code: 'S009', severity: 'error', line: lineOf(text, 'resolution', lineOf(text, 'DefaultOpen')) },
            { code: 'S009', severity: 'error', line: lineOf(text, 'status reslved') },
        ]);
        expect(ds.map((d) => d.message)).toEqual([
            "Hotspot 'Unexplained' is resolved but has no `resolution`.",
            "Hotspot 'Premature' has a `resolution` but is open; only a resolved hotspot has a resolution.",
            "Hotspot 'DefaultOpen' has a `resolution` but is implicitly open; only a resolved hotspot has a resolution.",
            "Hotspot 'Typo' has status 'reslved'; a status is `open` or `resolved`.",
        ]);
        expect(ds[3]!.hint).toBe("did you mean 'resolved'?");
    });

    test('ES08 a hotspot `on` names one event at most', () => {
        const text = cancel(`  hotspot OnCommand {
    on CancelShipment
  }
  hotspot TwoEvents {
    on ShipmentCancelled
    on ReleaseFailed
  }
  hotspot Repeated {
    status open
    status open
    resolution "a"
    resolution "b"
  }`);
        expect(summary(validate(text))).toEqual([
            { code: 'S003', severity: 'error', line: lineOf(text, 'on CancelShipment') },
            { code: 'S004', severity: 'error', line: lineOf(text, 'on ReleaseFailed', lineOf(text, 'TwoEvents')) },
            { code: 'S004', severity: 'error', line: lineOf(text, 'status open', lineOf(text, 'Repeated') + 1) },
            { code: 'S009', severity: 'error', line: lineOf(text, 'resolution "a"') },
            { code: 'S004', severity: 'error', line: lineOf(text, 'resolution "b"') },
        ]);
    });

    test('ES10 a timeline in the reverse order of a causal path is not diagnosed', () => {
        // CleanupAfterCancel: ShipmentCancelled → ReleaseBike → BikeReleased; the timeline says the opposite.
        expect(
            validate(
                cancel(`  timeline Reversed {
    BikeReleased
    ShipmentCancelled
  }`),
            ),
        ).toEqual([]);
    });

    test('ES11 an event twice in one group is an error; again in other steps is legal', () => {
        const text = cancel(`  timeline Again {
    ShipmentCancelled
    group Twice {
      BikeReleased
      SlotReleased
      BikeReleased
    }
    BikeReleased
    group Other {
      BikeReleased
    }
    ShipmentCancelled
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S007', severity: 'error', line: lineOf(text, 'BikeReleased', lineOf(text, 'SlotReleased', lineOf(text, 'Twice'))) },
        ]);
        expect(ds[0]!.message).toBe(
            `Event 'BikeReleased' appears twice in group 'Twice' (first at line ${lineOf(text, 'BikeReleased', lineOf(text, 'Twice'))}); a group is an unordered set of events.`,
        );
        expect(ds[0]!.elementId).toBe('es/DeliveryCancellation/Twice');
    });

    test('ES12 an ID shared by declarations of different kinds is an error, timelines and groups included', () => {
        const text = cancel(`  command Customer
  readmodel Normal
  timeline Shipment {
    ShipmentCancelled
  }
  timeline Later {
    group CleanupResults {
      SlotReleased
    }
    group Later {
      SlotReleased
    }
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S001', severity: 'error', line: lineOf(text, 'command Customer') },
            { code: 'S001', severity: 'error', line: lineOf(text, 'readmodel Normal') },
            { code: 'S001', severity: 'error', line: lineOf(text, 'timeline Shipment') },
            { code: 'S001', severity: 'error', line: lineOf(text, 'group CleanupResults', 50) },
            { code: 'S001', severity: 'error', line: lineOf(text, 'group Later') },
        ]);
        expect(ds[0]!.message).toBe(
            `Command 'Customer' reuses the ID of the actor declared at line ${lineOf(text, 'actor Customer')} (an actor); the IDs of a storming are unique across all kinds, timelines and groups included.`,
        );
        expect(ds[0]!.hint).toBe('rename one of them and update the references to it');
    });

    test('ES12 the same kind twice, and two stormings with one ID in the workspace, are errors', () => {
        const ds = validateStormings([...ir(cancel('  event BikeReleased'), 'a.dtes'), ...ir('storming DeliveryCancellation {\n}\n', 'b.dtes')]);
        expect(ds.map((d) => [d.file, d.code, d.start.line])).toEqual([
            ['a.dtes', 'S001', lineOf(cancel('  event BikeReleased'), 'event BikeReleased', 10)],
            ['b.dtes', 'S001', 1],
        ]);
        expect(ds[0]!.message).toContain(`reuses the ID of the event declared at line 5;`);
        expect(ds[1]!.message).toBe("Storming 'DeliveryCancellation' is already declared at a.dtes:1; storming IDs are unique in the workspace.");
        expect(ds[1]!.elementId).toBe('es/DeliveryCancellation');
        // Local IDs belong to their storming: two stormings may both declare an event `Done`.
        expect(validate('storming A {\n  event Done\n}\nstorming B {\n  event Done\n}\n')).toEqual([]);
    });

    test('ES13 only events, aggregates and commands have a `ref`, at most one', () => {
        const text = cancel(`  policy Mapped {
    ref Delivery.CleanupAfterCancel
    on ShipmentCancelled
    issues ReleaseBike
  }
  actor Clerk {
    ref Delivery.Clerk
  }
  external Bank {
    ref Billing.Bank
  }
  readmodel Slots {
    ref Delivery.Slots
  }
  hotspot Question {
    ref Delivery.Question
  }
  aggregate Twice {
    ref Delivery.Shipment
    ref Fleet.BikeAssignment
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S005', severity: 'error', line: lineOf(text, 'ref Delivery.CleanupAfterCancel') },
            { code: 'S005', severity: 'error', line: lineOf(text, 'ref Delivery.Clerk') },
            { code: 'S005', severity: 'error', line: lineOf(text, 'ref Billing.Bank') },
            { code: 'S005', severity: 'error', line: lineOf(text, 'ref Delivery.Slots') },
            { code: 'S005', severity: 'error', line: lineOf(text, 'ref Delivery.Question') },
            { code: 'S004', severity: 'error', line: lineOf(text, 'ref Fleet.BikeAssignment') },
        ]);
        expect(ds[0]!.message).toBe("Policy 'Mapped' has a `ref`, but only events, aggregates and commands correspond to `.dt` symbols.");
        expect(ds[0]!.hint).toBe('remove `ref Delivery.CleanupAfterCancel`');
        expect(ds[5]!.message).toBe("Aggregate 'Twice' has more than one `ref`; it takes at most one.");
    });

    test('ES14 an `external` is legal as a command `actor`, and an error in every other reference', () => {
        const text = cancel(`  command ReceivePaymentNotice {
    actor PaymentGateway
    reads PaymentGateway
    target PaymentGateway
    emits PaymentGateway
  }
  policy Notify {
    on PaymentGateway
    issues PaymentGateway
  }
  hotspot Gateway {
    on PaymentGateway
  }
  timeline Paid {
    PaymentGateway
  }`);
        const ds = validate(text);
        expect(ds.every((d) => d.code === 'S003')).toBe(true);
        const hotspot = lineOf(text, 'hotspot Gateway');
        expect(ds.map((d) => d.start.line)).toEqual([
            lineOf(text, 'reads PaymentGateway'),
            lineOf(text, 'target PaymentGateway'),
            lineOf(text, 'emits PaymentGateway'),
            lineOf(text, 'on PaymentGateway'),
            lineOf(text, 'issues PaymentGateway'),
            lineOf(text, 'on PaymentGateway', hotspot),
            lineOf(text, 'PaymentGateway', lineOf(text, 'timeline Paid')),
        ]);
        expect(ds[0]!.message).toBe("`reads` of command 'ReceivePaymentNotice' names 'PaymentGateway', which is an external; it must name a read model.");
        expect(ds[1]!.message).toContain('it must name an aggregate.');
    });

    test('kind errors of every relation, with the closest name of the right kind as a hint', () => {
        const text = cancel(`  command Wrong {
    actor DeliveryDetails
    reads Customer
    target ShipmentCancelled
    emits Shipment
  }
  policy WrongPolicy {
    on CancelShipment
    issues ShipmentCancelled
  }`);
        const ds = validate(text);
        expect(ds.map((d) => [d.code, d.message])).toEqual([
            ['S003', "`actor` of command 'Wrong' names 'DeliveryDetails', which is a read model; it must name an actor or an external."],
            ['S003', "`reads` of command 'Wrong' names 'Customer', which is an actor; it must name a read model."],
            ['S003', "`target` of command 'Wrong' names 'ShipmentCancelled', which is an event; it must name an aggregate."],
            ['S003', "`emits` of command 'Wrong' names 'Shipment', which is an aggregate; it must name an event."],
            ['S003', "`on` of policy 'WrongPolicy' names 'CancelShipment', which is a command; it must name an event."],
            ['S003', "`issues` of policy 'WrongPolicy' names 'ShipmentCancelled', which is an event; it must name a command."],
        ]);
        expect(ds[3]!.hint).toBe("name one of 'ShipmentCancelled', 'BikeReleased', 'SlotReleased', 'ReleaseFailed'");
        expect(ds[1]!.hint).toBe("name one of 'DeliveryDetails'");
        expect(
            validate('storming S {\n  aggregate Shipment\n  event Shipped\n  command C {\n    target Shipmen\n    emits Shipment\n  }\n}\n').map((d) => d.hint),
        ).toEqual(["did you mean 'Shipment'?", "name one of 'Shipped'"]);
        expect(validate('storming S {\n  event E\n  command C {\n    reads E\n  }\n}\n')[0]!.hint).toBe('declare a read model first and name it here');
    });

    test('an undefined reference is an error, with a suggestion', () => {
        const text = cancel(`  command Typo {
    target Shipmnt
    emits Nowhere
  }
  timeline Short {
    ShipmentCancelld
    group G {
      Missing
    }
  }`);
        const ds = validate(text);
        expect(ds.map((d) => [d.code, d.message, d.hint])).toEqual([
            ['S002', "`target` of command 'Typo' names 'Shipmnt', which is not declared in storming 'DeliveryCancellation'.", "did you mean 'Shipment'?"],
            [
                'S002',
                "`emits` of command 'Typo' names 'Nowhere', which is not declared in storming 'DeliveryCancellation'.",
                "declare an event 'Nowhere' in the storming, or name an existing one",
            ],
            [
                'S002',
                "A step of timeline 'Short' names 'ShipmentCancelld', which is not declared in storming 'DeliveryCancellation'.",
                "did you mean 'ShipmentCancelled'?",
            ],
            [
                'S002',
                "Group 'G' of timeline 'Short' names 'Missing', which is not declared in storming 'DeliveryCancellation'.",
                "declare an event 'Missing' in the storming, or name an existing one",
            ],
        ]);
        expect(ds[0]!.elementId).toBe('es/DeliveryCancellation/Typo');
    });

    test('a clause the element kind does not take is an error, and its target is not checked', () => {
        const text = cancel(`  event Moved {
    target Shipment
  }
  aggregate Fleet {
    emits Nowhere
  }
  policy Targeted {
    on ShipmentCancelled
    issues ReleaseBike
    target Shipment
  }
  command Opened {
    status open
    resolution "x"
  }`);
        const ds = validate(text);
        expect(ds.map((d) => [d.code, d.message, d.hint])).toEqual([
            ['S006', "Event 'Moved' has `target Shipment`, but an event takes no relation.", 'remove the clause; `target` belongs in a command'],
            ['S006', "Aggregate 'Fleet' has `emits Nowhere`, but an aggregate takes no relation.", 'remove the clause; `emits` belongs in a command'],
            ['S006', "Policy 'Targeted' has `target Shipment`, but a policy takes `on`, `issues`.", 'remove the clause; `target` belongs in a command'],
            ['S006', "Command 'Opened' has a `status` clause, which only a hotspot takes.", 'remove the `status` clause'],
            ['S006', "Command 'Opened' has a `resolution` clause, which only a hotspot takes.", 'remove the `resolution` clause'],
        ]);
    });

    test('S014 a type-level cycle is a warning that does not claim an infinite loop', () => {
        const text = cancel(`  command RetryRelease {
    emits ReleaseFailed
  }
  policy RetryOnFailure {
    on ReleaseFailed
    issues RetryRelease
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([{ code: 'S014', severity: 'warning', line: lineOf(text, 'policy RetryOnFailure') }]);
        expect(ds[0]!.message).toBe(
            "Policy 'RetryOnFailure' is on a type-level cycle: RetryOnFailure → RetryRelease → ReleaseFailed → RetryOnFailure. Each step only may follow the previous one, so this is a cycle of possibilities, not an infinite loop.",
        );
        expect(ds[0]!.message).not.toMatch(/infinite loop\b(?<!not an infinite loop)/);
        expect(ds[0]!.hint).toContain('nothing to change if the repetition is intended');
    });

    test('S014 one warning per cycle, through every policy of it; invalid relations make no cycle', () => {
        // Two policies on one cycle: A → C1 → E1 → B → C2 → E2 → A, reported once at the first policy.
        const text = `storming Loop {
  event E1
  event E2
  command C1 {
    emits E1
  }
  command C2 {
    emits E2
  }
  policy A {
    on E2
    issues C1
  }
  policy B {
    on E1
    issues C2
  }
}
`;
        const ds = validate(text);
        expect(summary(ds)).toEqual([{ code: 'S014', severity: 'warning', line: lineOf(text, 'policy A') }]);
        expect(ds[0]!.message).toContain('A → C1 → E1 → B → C2 → E2 → A');
        // `emits` from a policy is not a relation (S006), so it closes no cycle.
        const broken = `storming Loop {
  event E
  command C
  policy P {
    on E
    issues C
    emits E
  }
}
`;
        expect(validate(broken).map((d) => d.code)).toEqual(['S006']);
    });

    test('S014 terminates on a large, densely cyclic storming', () => {
        const n = 300;
        const parts = ['storming Big {'];
        for (let i = 0; i < n; i++) {
            parts.push(`  event E${i}`, `  command C${i} {`, `    emits E${i}`, `    emits E${(i + 1) % n}`, '  }');
            parts.push(`  policy P${i} {`, `    on E${i}`, `    on E${(i * 7) % n}`, `    issues C${(i + 1) % n}`, `    issues C${(i * 3) % n}`, '  }');
        }
        parts.push('}');
        const started = performance.now();
        const ds = validate(parts.join('\n'));
        expect(performance.now() - started).toBeLessThan(5000);
        expect(ds.map((d) => d.code)).toEqual(['S014']);
    });

    test('completeness is not diagnosed: unreferenced events, missing `emits`, events in no timeline, elements without `ref`', () => {
        expect(
            validate(`storming Explore {
  event Lonely
  event Unused
  actor Nobody
  readmodel Unread
  aggregate Untargeted
  command Silent
  command Partial {
    target Untargeted
  }
  hotspot Open "未解決"
  timeline Partial2 {
    Lonely
    Lonely
  }
}
`),
        ).toEqual([]);
    });

    test('the optional Info rule (several `on` and several `issues`) is not implemented', () => {
        const ds = validate(
            cancel(`  event SlotExpired
  policy Broad {
    on ShipmentCancelled
    on SlotExpired
    issues ReleaseBike
    issues ReleaseSlot
  }`),
        );
        expect(ds).toEqual([]);
    });

    test('diagnostics are sorted by file and position', () => {
        const ds = validateStormings([...ir('storming B {\n  policy P\n}\n', 'b.dtes'), ...ir('storming A {\n  event X\n  event X\n}\n', 'a.dtes')]);
        expect(ds.map((d) => [d.file, d.code])).toEqual([
            ['a.dtes', 'S001'],
            ['b.dtes', 'S008'],
        ]);
    });
});
