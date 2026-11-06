import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '@domaintrail/kernel';
import type { Clause, Group, NodeElement, NodeElementKind, RelationKeyword, RemovedKeyword, SourceRange, Storming, Timeline } from './ir.js';
import { validateStormings } from './validate.js';

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
    const RELATIONS = ['by', 'reads', 'handledBy', 'emits', 'on', 'issues', 'from', 'actor', 'target'];
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
            else if (word === 'level') clause = { type: 'level', value: id, range: at(i) };
            else if (RELATIONS.includes(word!))
                clause = { type: 'relation', keyword: word as RelationKeyword | RemovedKeyword, target: id, range: at(i), targetRange: at(i) };
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

/** The errors and warnings of a storming; the infos (S029, an event without a source) are tested on their own. */
const validate = (text: string): Diagnostic[] => validateStormings(ir(text)).filter((d) => d.severity !== 'info');
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
  aggregate ShipmentSlot "配送枠"
  command CancelShipment "配送キャンセル" {
    ref Delivery.Shipment.cancel
    by Customer
    reads DeliveryDetails
    handledBy Shipment
    emits ShipmentCancelled
  }
  command ReleaseBike "車両割当解除" {
    handledBy BikeAssignment
    emits BikeReleased
    emits ReleaseFailed
  }
  command ReleaseSlot "配送枠解除" {
    handledBy ShipmentSlot
    emits SlotReleased
  }
  event PaymentRefunded "返金された" {
    from PaymentGateway
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

    test('ES03 two `handledBy`s are an error', () => {
        const text = cancel(`  command Reassign {
    by Customer
    handledBy Shipment
    handledBy BikeAssignment
    emits BikeReleased
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([{ code: 'S004', severity: 'error', line: lineOf(text, 'handledBy BikeAssignment', 50) }]);
        expect(ds[0]!.message).toBe("Command 'Reassign' has more than one `handledBy`; it takes at most one.");
        expect(ds[0]!.hint).toBe('keep one `handledBy` and remove the others');
    });

    test('ES04 several `by`s (actor or external), `reads` and `emits` are legal, and so is a list', () => {
        expect(
            validate(
                cancel(`  readmodel Fleet
  command Release {
    by Customer
    by PaymentGateway
    reads DeliveryDetails
    reads Fleet
    handledBy BikeAssignment
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
        expect(ds[0]!.message).toBe("Policy 'NoTrigger' has no `on`; a policy reacts to at least one event (`on`) and issues at least one command (`issues`).");
        expect(ds[0]!.hint).toBe(
            'add `on <Event>` if it is decided; don\'t guess: if it is not decided yet, add `hotspot NoTriggerOpen "何に反応する？" { on NoTrigger }`, which records the open question and turns this error off',
        );
        expect(ds[2]!.message).toContain('has neither `on` nor `issues`');
        // an open hotspot on the policy marks the gap as a question; a resolved one does not
        const asked = cancel(`  policy Empty
  hotspot WhatTrigger "何に反応する？" {
    on Empty
  }`);
        expect(validate(asked)).toEqual([]);
        const settled = cancel(`  policy Empty
  hotspot WhatTrigger "何に反応する？" {
    on Empty
    status resolved
    resolution "決めた"
  }`);
        expect(summary(validate(settled))).toEqual([{ code: 'S008', severity: 'error', line: lineOf(settled, 'policy Empty') }]);
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

    test('ES08 a hotspot `on` names one sticky at most, of any kind but a hotspot', () => {
        const text = cancel(`  hotspot OnCommand {
    on CancelShipment
  }
  hotspot OnHotspot {
    on OnCommand
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
            { code: 'S003', severity: 'error', line: lineOf(text, 'on OnCommand') },
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
        // the elements no relation names are S027, left out here
        const ds = validate(text).filter((d) => d.code !== 'S027');
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

    test('ES14 an `external` is legal as a command `by` and `handledBy`, an event `from` and a hotspot `on`, and an error elsewhere', () => {
        const legal = cancel(`  command ReceivePaymentNotice {
    by PaymentGateway
    handledBy PaymentGateway
    emits ReleaseFailed
  }
  hotspot Gateway {
    on PaymentGateway
  }`);
        expect(validate(legal)).toEqual([]);
        const text = cancel(`  command ReceivePaymentNotice {
    by PaymentGateway
    reads PaymentGateway
    handledBy PaymentGateway
    emits PaymentGateway
  }
  policy Notify {
    on PaymentGateway
    issues PaymentGateway
  }
  readmodel Payments {
    from PaymentGateway
  }
  timeline Paid {
    PaymentGateway
  }`);
        const ds = validate(text).filter((d) => d.code !== 'S027');
        expect(ds.every((d) => d.code === 'S003')).toBe(true);
        expect(ds.map((d) => d.start.line)).toEqual([
            lineOf(text, 'reads PaymentGateway'),
            lineOf(text, 'emits PaymentGateway'),
            lineOf(text, 'on PaymentGateway'),
            lineOf(text, 'issues PaymentGateway'),
            lineOf(text, 'from PaymentGateway', lineOf(text, 'readmodel Payments')),
            lineOf(text, 'PaymentGateway', lineOf(text, 'timeline Paid')),
        ]);
        expect(ds[0]!.message).toBe("`reads` of command 'ReceivePaymentNotice' names 'PaymentGateway', which is an external; it must name a read model.");
        expect(ds[0]!.hint).toBe('who issues the command is `by PaymentGateway`');
        expect(ds[1]!.hint).toBe('who handles the command is `handledBy PaymentGateway`; `emits` names its events');
        expect(ds[4]!.hint).toBe('data from an external system arrives as an event: declare `event <Id> { from PaymentGateway }` and write `from <Id>`');
    });

    test('kind errors of every relation, with the relation that says it, or the closest name of the right kind, as a hint', () => {
        const text = cancel(`  command Wrong {
    by DeliveryDetails
    reads Customer
    handledBy ShipmentCancelled
    emits Shipment
  }
  policy WrongPolicy {
    on CancelShipment
    issues ShipmentCancelled
  }`);
        const ds = validate(text);
        expect(ds.map((d) => [d.code, d.message, d.hint])).toEqual([
            [
                'S003',
                "`by` of command 'Wrong' names 'DeliveryDetails', which is a read model; it must name an actor or an external.",
                'a read model is what the issuer looks at: write `reads DeliveryDetails`',
            ],
            ['S003', "`reads` of command 'Wrong' names 'Customer', which is an actor; it must name a read model.", 'who issues the command is `by Customer`'],
            [
                'S003',
                "`handledBy` of command 'Wrong' names 'ShipmentCancelled', which is an event; it must name an aggregate or an external.",
                'an event is an outcome: write `emits ShipmentCancelled`',
            ],
            [
                'S003',
                "`emits` of command 'Wrong' names 'Shipment', which is an aggregate; it must name an event.",
                'who handles the command is `handledBy Shipment`; `emits` names its events',
            ],
            [
                'S003',
                "`on` of policy 'WrongPolicy' names 'CancelShipment', which is a command; it must name an event.",
                "a policy reacts to an event: write `on <an event 'CancelShipment' emits>`",
            ],
            [
                'S003',
                "`issues` of policy 'WrongPolicy' names 'ShipmentCancelled', which is an event; it must name a command.",
                'a policy issues commands; an event is emitted by the command it issues (`emits ShipmentCancelled` in that command)',
            ],
        ]);
        // the confusions of the grammar (ADR 0032): an aggregate as the issuer, an actor as the handler, a command issuing a command
        const confused = cancel(`  command Mixed {
    by Shipment
    handledBy Customer
    emits ReleaseBike
  }`);
        expect(validate(confused).map((d) => d.hint)).toEqual([
            'an aggregate handles a command, it never issues one: write `handledBy Shipment`',
            'an actor issues a command: write `by Customer`; the handler is an aggregate or an external system',
            'a command never issues a command: let it emit an event, and put a policy between, `policy <Id> { on <that event> issues ReleaseBike }`',
        ]);
        expect(
            validate('storming S {\n  aggregate Shipment\n  event Shipped\n  command C {\n    handledBy Shipmen\n    emits Shipped\n  }\n}\n').find(
                (d) => d.code === 'S002',
            )!.hint,
        ).toBe("did you mean 'Shipment'?");
        expect(validate('storming S {\n  event E\n  command C {\n    reads E\n  }\n}\n').find((d) => d.code === 'S003')!.hint).toBe(
            'a command reads a read model, not an event: declare `readmodel <Id> { from E }` and write `reads <Id>`',
        );
        expect(validate('storming S {\n  policy P\n  command C {\n    reads P\n  }\n}\n').find((d) => d.code === 'S003')!.hint).toBe(
            'declare a read model first and name it here',
        );
        // a duplicate declaration (S001) is listed once
        expect(validate('storming S {\n  event E\n  event E\n  command C\n  timeline T {\n    C\n  }\n}\n').find((d) => d.code === 'S003')!.hint).toBe(
            "name one of 'E'",
        );
    });

    test('an undefined reference is an error, with a suggestion', () => {
        const text = cancel(`  command Typo {
    by Customer
    handledBy Shipmnt
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
            ['S002', "`handledBy` of command 'Typo' names 'Shipmnt', which is not declared in storming 'DeliveryCancellation'.", "did you mean 'Shipment'?"],
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
    handledBy Shipment
  }
  aggregate Fleet {
    emits Nowhere
  }
  policy Targeted {
    on ShipmentCancelled
    issues ReleaseBike
    handledBy Shipment
  }
  command Opened {
    status open
    resolution "x"
  }
  command Chained {
    by Customer
    handledBy Shipment
    emits ShipmentCancelled
    issues ReleaseBike
    on ReleaseFailed
  }`);
        const ds = validate(text).filter((d) => d.code !== 'S024' && d.code !== 'S027');
        expect(ds.map((d) => [d.code, d.message, d.hint])).toEqual([
            [
                'S006',
                "Event 'Moved' has `handledBy Shipment`, but an event takes `from`.",
                'remove it: an event is emitted by a command (`emits` in it), or arrives `from` an external system; a read model is fed `from` it',
            ],
            [
                'S006',
                "Aggregate 'Fleet' has `emits Nowhere`, but an aggregate takes no relation.",
                'remove it: write the relation in the command instead (the command it handles has `handledBy` and its `emits`)',
            ],
            [
                'S006',
                "Policy 'Targeted' has `handledBy Shipment`, but a policy takes `by`, `reads`, `on`, `issues`.",
                'remove it: write `handledBy Shipment` in the command the policy `issues`',
            ],
            ['S006', "Command 'Opened' has a `status` clause, which only a hotspot takes.", 'remove the `status` clause'],
            ['S006', "Command 'Opened' has a `resolution` clause, which only a hotspot takes.", 'remove the `resolution` clause'],
            [
                'S006',
                "Command 'Chained' has `issues ReleaseBike`, but a command takes `by`, `reads`, `handledBy`, `emits`.",
                'a command never issues a command: let it `emits` an event, and put a policy between, `policy <Id> { on <the event> issues ReleaseBike }`',
            ],
            [
                'S006',
                "Command 'Chained' has `on ReleaseFailed`, but a command takes `by`, `reads`, `handledBy`, `emits`.",
                'a command does not react to an event: a policy does, `policy <Id> { on ReleaseFailed issues <this command> }`',
            ],
        ]);
    });

    test('S016 `level design` on an event is legal, before or after its `ref`', () => {
        const text = cancel(`  event BikeLocked "車両がロックされた" {
    level design
  }
  event SlotHeld "配送枠が仮押さえされた" {
    ref Delivery.SlotHeld
    level design
  }
  event SlotLocked "配送枠がロックされた" {
    level design
    ref Delivery.SlotLocked
  }`);
        expect(validate(text)).toEqual([]);
    });

    test('S016 `level big-picture` is an error that says no `level` already means both levels', () => {
        const text = cancel(`  event BikeLocked {
    level big-picture
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([{ code: 'S016', severity: 'error', line: lineOf(text, 'level big-picture') }]);
        expect(ds[0]!.message).toBe(
            "Event 'BikeLocked' has `level big-picture`, but an event without `level` is already shown at both levels; the only level to write is `design`.",
        );
        expect(ds[0]!.hint).toBe('remove `level big-picture`');
    });

    test('S016 a level other than `design` is an error, with a suggestion', () => {
        const text = cancel(`  event BikeLocked {
    level desing
  }
  event SlotHeld {
    level detail
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S016', severity: 'error', line: lineOf(text, 'level desing') },
            { code: 'S016', severity: 'error', line: lineOf(text, 'level detail') },
        ]);
        expect(ds[0]!.message).toBe("Event 'BikeLocked' has level 'desing'; the only level is `design` (shown at Design Level only).");
        expect(ds[0]!.hint).toBe("did you mean 'design'?");
        expect(ds[1]!.hint).toBe('write `level design`, or remove the clause to show the event at both levels');
    });

    test('a second `level` is S004, and `level` on anything but an event is S006', () => {
        const text = cancel(`  event BikeLocked {
    level design
    level design
  }
  command LockBike {
    by Customer
    handledBy BikeAssignment
    emits BikeReleased
    level design
  }
  hotspot Locking {
    level design
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S004', severity: 'error', line: lineOf(text, 'level design', lineOf(text, 'level design', lineOf(text, 'BikeLocked'))) },
            { code: 'S006', severity: 'error', line: lineOf(text, 'level design', lineOf(text, 'LockBike')) },
            { code: 'S006', severity: 'error', line: lineOf(text, 'level design', lineOf(text, 'Locking')) },
        ]);
        expect(ds.map((d) => d.message)).toEqual([
            "Event 'BikeLocked' has more than one `level`; it takes at most one.",
            "Command 'LockBike' has a `level` clause, which only an event takes.",
            "Hotspot 'Locking' has a `level` clause, which only an event takes.",
        ]);
    });

    test('S014 a type-level cycle is a warning that does not claim an infinite loop', () => {
        const text = cancel(`  command RetryRelease {
    handledBy BikeAssignment
    emits ReleaseFailed
  }
  policy RetryOnFailure {
    on ReleaseFailed
    issues RetryRelease
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([{ code: 'S014', severity: 'warning', line: lineOf(text, 'policy RetryOnFailure') }]);
        expect(ds[0]!.message).toBe(
            "Policy 'RetryOnFailure' is on a type-level cycle: RetryOnFailure → RetryRelease → ReleaseFailed → RetryOnFailure. Every step is only a possibility, so this is a cycle of possibilities, not an infinite loop.",
        );
        expect(ds[0]!.message).not.toMatch(/infinite loop\b(?<!not an infinite loop)/);
        expect(ds[0]!.hint).toContain('nothing to change if the repetition is intended');
    });

    test('S014 one warning per cycle, through every policy of it; invalid relations make no cycle', () => {
        // Two policies on one cycle: A → C1 → E1 → B → C2 → E2 → A, reported once at the first policy.
        const text = `storming Loop {
  event E1
  event E2
  aggregate G
  command C1 {
    handledBy G
    emits E1
  }
  command C2 {
    handledBy G
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
  event F
  aggregate G
  command C {
    handledBy G
    emits F
  }
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
        const parts = ['storming Big {', '  aggregate G'];
        for (let i = 0; i < n; i++) {
            parts.push(`  event E${i}`, `  command C${i} {`, `    handledBy G`, `    emits E${i}`, `    emits E${(i + 1) % n}`, '  }');
            parts.push(`  policy P${i} {`, `    on E${i}`, `    on E${(i * 7) % n}`, `    issues C${(i + 1) % n}`, `    issues C${(i * 3) % n}`, '  }');
        }
        parts.push('}');
        const started = performance.now();
        const ds = validate(parts.join('\n'));
        expect(performance.now() - started).toBeLessThan(5000);
        // a policy whose two `issues` (or `on`s) name one command (event) is S026
        expect(ds.filter((d) => d.code !== 'S026').map((d) => d.code)).toEqual(['S014']);
    });

    test('S015 a label too long for its sticky note even at the smallest font is a warning', () => {
        const long =
            'マイナンバーカードの暗証番号を三回間違えてロックされたので市役所の窓口で再設定の手続きをしてから改めてコンビニのマルチコピー機で住民票の写しを発行し直した';
        const text = cancel(`  event CertificateReissued "${long}"
  hotspot PinLocked "${long}？"`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S015', severity: 'warning', line: lineOf(text, 'event CertificateReissued') },
            { code: 'S015', severity: 'warning', line: lineOf(text, 'hotspot PinLocked') },
        ]);
        expect(ds[0]!.message).toBe(
            "The label of event 'CertificateReissued' is too long for its sticky note: even at its smallest font the Live View cuts it short with «…» (the whole label shows on hover and in the inspector).",
        );
        expect(ds[0]!.hint).toContain('about 12 Japanese characters');
        expect(ds[0]!.elementId).toBe('es/DeliveryCancellation/CertificateReissued');
    });

    test('S015 is quiet for labels that fit at some size, including long ones the canvas only shrinks', () => {
        const text = cancel(`  event Issued "マルチコピー機で証明書を発行した"
  event Submitted "証明書を提出先に提出した"
  event English "Certificate issued at the multi-copy machine of the convenience store"
  event Shrunk "マイナンバーカードの暗証番号を三回間違えてロックされたので窓口で再設定した"
  event WithoutLabel`);
        expect(validate(text)).toEqual([]);
    });

    test('Big Picture completeness is not diagnosed: unreferenced events, events in no timeline, elements without `ref`', () => {
        expect(
            validate(`storming Explore {
  event Lonely
  event Unused
  hotspot Open "未解決"
  timeline Partial2 {
    Lonely
    Lonely
  }
}
`),
        ).toEqual([]);
    });

    test('S024 a command without its issuer, handler or outcomes is an error, unless an open hotspot asks about it', () => {
        const text = cancel(`  command Silent
  command Unhandled {
    by Customer
    emits ShipmentCancelled
  }
  command Asked {
    by Customer
  }
  hotspot WhoHandles "誰が処理する？" {
    on Asked
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S024', severity: 'error', line: lineOf(text, 'command Silent') },
            { code: 'S024', severity: 'error', line: lineOf(text, 'command Unhandled') },
        ]);
        expect(ds[0]!.message).toBe(
            "Command 'Silent' does not say who issues it, who handles it and its outcomes. At Design Level a command's row is `by` (or a policy's `issues`) → `handledBy` → `emits`.",
        );
        expect(ds[1]!.message).toBe(
            "Command 'Unhandled' does not say who handles it. It emits 'ShipmentCancelled', but nothing handles it to produce that event. At Design Level a command's row is `by` (or a policy's `issues`) → `handledBy` → `emits`.",
        );
        expect(ds[1]!.hint).toBe(
            'add `handledBy <aggregate or external>` if it is decided; don\'t guess: if it is not decided yet, add `hotspot UnhandledOpen "誰が処理する？" { on Unhandled }`, which records the open question and turns this error off',
        );
        // a command a policy issues needs no `by` (ReleaseBike of the sample)
        expect(validate(cancel()).filter((d) => d.code === 'S024')).toEqual([]);
    });

    test('S023 `actor` and `target` of v0.1 are errors that name their replacement', () => {
        const text = cancel(`  command Old {
    actor Customer
    target Shipment
    emits ShipmentCancelled
  }
  policy Odd {
    on ShipmentCancelled
    issues ReleaseBike
    target Shipment
  }`);
        const ds = validate(text);
        expect(ds.map((d) => [d.code, d.message, d.hint])).toEqual([
            [
                'S023',
                "Command 'Old' has `actor Customer`, but `actor` is no longer a relation: who issues a command is `by`.",
                'write `by Customer` (`dt migrate dtes` rewrites every `actor` and `target` of a command)',
            ],
            [
                'S023',
                "Command 'Old' has `target Shipment`, but `target` is no longer a relation: who handles a command is `handledBy`.",
                'write `handledBy Shipment` (`dt migrate dtes` rewrites every `actor` and `target` of a command)',
            ],
            [
                'S023',
                "Policy 'Odd' has `target Shipment`, but `target` is no longer a relation: who handles a command is `handledBy`.",
                'remove it; `handledBy Shipment` belongs in a command',
            ],
        ]);
    });

    test('S025 a command a policy issues has no `by`', () => {
        const text = cancel(`  command Both {
    by Customer
    handledBy BikeAssignment
    emits BikeReleased
  }
  policy Auto {
    on ShipmentCancelled
    issues Both
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([{ code: 'S025', severity: 'error', line: lineOf(text, 'by Customer', lineOf(text, 'command Both')) }]);
        expect(ds[0]!.message).toBe(
            "Command 'Both' is issued by policy 'Auto', and also has `by Customer`; a command that a policy issues has the policy as its issuer.",
        );
    });

    test('S026 a relation written twice', () => {
        const text = cancel(`  command Twice {
    by Customer
    by Customer
    handledBy BikeAssignment
    emits BikeReleased
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([{ code: 'S026', severity: 'error', line: lineOf(text, 'by Customer', lineOf(text, 'command Twice') + 1) }]);
        expect(ds[0]!.message).toBe("Command 'Twice' has `by Customer` twice; a relation is written once.");
    });

    test('S027 an actor, external system, aggregate or read model that no relation names, unless an open hotspot asks about it', () => {
        const text = cancel(`  actor Nobody
  external Silent
  aggregate Untargeted
  readmodel Unread {
    from ShipmentCancelled
  }
  aggregate Pending
  hotspot WhoUses "どのコマンドが使う？" {
    on Pending
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([
            { code: 'S027', severity: 'error', line: lineOf(text, 'actor Nobody') },
            { code: 'S027', severity: 'error', line: lineOf(text, 'external Silent') },
            { code: 'S027', severity: 'error', line: lineOf(text, 'aggregate Untargeted') },
        ]);
        // a read model's own `from` is its part: one people only look at (Unread) is valid
        // at Big Picture (no command, no policy) nothing is a gap
        expect(validate('storming B {\n  event E\n  actor Someone\n  readmodel R\n}\n')).toEqual([]);
    });

    test('S024: the suggested hotspot asks every missing relation, under an ID no declaration has', () => {
        const text = cancel(`  command Silent
  hotspot SilentOpen "別の問い"`);
        const ds = validate(text).filter((d) => d.code === 'S024');
        expect(ds[0]!.hint).toContain('add `hotspot SilentOpen2 "誰が発行し、誰が処理する？結果は？" { on Silent }`');
        const handled = validate(cancel(`  command Half {\n    by Customer\n  }`)).find((d) => d.code === 'S024')!;
        expect(handled.hint).toContain('"誰が処理する？結果は？"');
    });

    test('a hotspot asks about the element of its first `on` only; a policy may be applied `by` an actor', () => {
        const text = cancel(`  command Silent
  hotspot Two {
    on ReleaseFailed
    on Silent
  }
  policy ByHand {
    by Customer
    on ShipmentCancelled
    issues ReleaseBike
  }
  policy ByMachine {
    by PaymentGateway
    on ShipmentCancelled
    issues ReleaseBike
  }`);
        expect(summary(validate(text))).toEqual([
            { code: 'S024', severity: 'error', line: lineOf(text, 'command Silent') },
            { code: 'S004', severity: 'error', line: lineOf(text, 'on Silent') },
            { code: 'S003', severity: 'error', line: lineOf(text, 'by PaymentGateway') },
        ]);
        expect(validate(text).find((d) => d.code === 'S003')!.hint).toContain('who applies a policy by hand is an actor');
    });

    test('S029 (info): at Design Level, an event without a source; nothing at Big Picture', () => {
        const text = cancel(`  event Arrived`);
        const infos = validateStormings(ir(text)).filter((d) => d.severity === 'info');
        expect(infos.map((d) => [d.code, d.start.line])).toEqual([['S029', lineOf(text, 'event Arrived')]]);
        expect(validateStormings(ir('storming B {\n  event E\n}\n'))).toEqual([]);
    });

    test('S028 an event both emitted by a command and from an external system', () => {
        const text = cancel(`  event BikeReleasedOutside {
    from PaymentGateway
  }
  command ReleaseOutside {
    by Customer
    handledBy BikeAssignment
    emits BikeReleasedOutside
  }`);
        const ds = validate(text);
        expect(summary(ds)).toEqual([{ code: 'S028', severity: 'error', line: lineOf(text, 'from PaymentGateway', lineOf(text, 'BikeReleasedOutside')) }]);
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

    test("a policy's `reads` names a read model (S003), and counts as a use of it (S027)", () => {
        const text = cancel(`  readmodel Looked
  policy Reading {
    on ShipmentCancelled
    reads Looked
    reads ReleaseFailed
    reads BikeAssignment
    reads Customer
    issues ReleaseBike
  }`);
        const ds = validate(text);
        expect(ds.map((d) => [d.code, d.start.line, d.hint])).toEqual([
            [
                'S003',
                lineOf(text, 'reads ReleaseFailed'),
                'a policy reads a read model, not an event: declare `readmodel <Id> { from ReleaseFailed }` and write `reads <Id>` (what it reacts to is `on ReleaseFailed`)',
            ],
            [
                'S003',
                lineOf(text, 'reads BikeAssignment'),
                'an aggregate is not read: what the policy looks at to decide is a read model (`readmodel <Id> { from <its events> }`)',
            ],
            ['S003', lineOf(text, 'reads Customer'), 'who applies a policy by hand is `by Customer`; `reads` names the read model it looks at'],
        ]);
        // without the policy's `reads`, the read model is used by nothing
        const unused = validate(cancel(`  readmodel Looked`));
        expect(unused.map((d) => d.code)).toEqual(['S027']);
        expect(unused[0]!.hint).toStartWith('write `reads Looked` in the command whose issuer looks at it (or in the policy that looks at it)');
    });

    test('diagnostics are sorted by file and position', () => {
        const ds = validateStormings([...ir('storming B {\n  policy P\n}\n', 'b.dtes'), ...ir('storming A {\n  event X\n  event X\n}\n', 'a.dtes')]);
        expect(ds.map((d) => [d.file, d.code])).toEqual([
            ['a.dtes', 'S001'],
            ['b.dtes', 'S008'],
        ]);
    });
});
