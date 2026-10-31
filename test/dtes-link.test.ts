import { beforeAll, describe, expect, test } from 'bun:test';
import type { Diagnostic } from '@domaintrail/modeling/core/diagnostics';
import { esElementId, type Clause, type NodeElement, type NodeElementKind, type SourceRange, type Storming } from '@domaintrail/modeling/storming/ir';
import { linkStormings, resolveDtRef } from '@domaintrail/modeling/storming/link';
import type { DomainModel } from '@domaintrail/modeling/model/model';
import { check } from './helpers.js';

// Spec §4's example, as `.dt`: two contexts, a policy across them, and exhaustive `emits`.
const DT = `context Delivery {
  id ShipmentId: UUID
  event ShipmentCancelled { shipmentId: ShipmentId }
  event ShipmentDelivered { shipmentId: ShipmentId }
  error AlreadyDelivered
  aggregate Shipment {
    id: ShipmentId
    state Pending
    state Delivered
    state Cancelled
    command cancel() Pending -> Cancelled emits ShipmentCancelled errors AlreadyDelivered
    command deliver() Pending -> Delivered emits ShipmentDelivered
  }
}
context Fleet {
  id BikeId: UUID
  event BikeReleased { bikeId: BikeId }
  aggregate BikeAssignment {
    id: BikeId
    command release() emits BikeReleased
    command target()
  }
  policy ReleaseBike when Delivery.ShipmentCancelled -> BikeAssignment.release
}
`;

let model: DomainModel;
beforeAll(async () => {
    const a = await check({ 'domain.dt': DT });
    expect(a.diagnostics).toEqual([]);
    model = a.model!;
});

// ---- IR built by hand (the parser is another task) ----

let line = 0;
const at = (): SourceRange => {
    line++;
    return { file: 'flow.dtes', start: { line, column: 5 }, end: { line, column: 20 } };
};
const ref = (path: string): Clause => ({ type: 'ref', path, segments: path.split('.'), range: at() });
const rel = (keyword: 'target' | 'emits' | 'on' | 'issues' | 'actor', target: string): Clause => ({
    type: 'relation',
    keyword,
    target,
    range: at(),
    targetRange: at(),
});
const el = (kind: NodeElementKind, id: string, ...clauses: Clause[]): NodeElement => {
    const range = at();
    return { kind, id, clauses, range, nameRange: range };
};
const storming = (...elements: NodeElement[]): Storming => {
    const range = at();
    return { id: 'Cancel', elements, range, nameRange: range };
};

const link = (...elements: NodeElement[]): Diagnostic[] => linkStormings([storming(...elements)], model);
const summary = (ds: Diagnostic[]) => ds.map((d) => ({ code: d.code, severity: d.severity, elementId: d.elementId, hint: d.hint }));

/** The elements of spec §4 that refer to `.dt`, each `ref` valid. */
const cancelFlow = (overrides: { command?: Clause[]; extra?: NodeElement[] } = {}): NodeElement[] => [
    el('event', 'ShipmentCancelled', ref('Delivery.ShipmentCancelled')),
    el('event', 'BikeReleased', ref('Fleet.BikeReleased')),
    el('aggregate', 'Shipment', ref('Delivery.Shipment')),
    el('aggregate', 'BikeAssignment', ref('Fleet.BikeAssignment')),
    el('command', 'CancelShipment', ...(overrides.command ?? [ref('Delivery.Shipment.cancel'), rel('target', 'Shipment'), rel('emits', 'ShipmentCancelled')])),
    el('command', 'ReleaseBike', ref('Fleet.BikeAssignment.release'), rel('target', 'BikeAssignment'), rel('emits', 'BikeReleased')),
    el('policy', 'ReleaseBikeOnCancel', rel('on', 'ShipmentCancelled'), rel('issues', 'ReleaseBike')),
    ...(overrides.extra ?? []),
];

describe('resolveDtRef', () => {
    test('resolves events, aggregates and commands to their .dt IDs', () => {
        expect(resolveDtRef('event', 'Delivery.ShipmentCancelled', model)).toEqual({ ok: true, id: 'Delivery.ShipmentCancelled' });
        expect(resolveDtRef('aggregate', 'Fleet.BikeAssignment', model)).toEqual({ ok: true, id: 'Fleet.BikeAssignment' });
        expect(resolveDtRef('command', 'Delivery.Shipment.cancel', model)).toEqual({ ok: true, id: 'Delivery.Shipment:cancel' });
        // A command named like a `.dtes` keyword.
        expect(resolveDtRef('command', 'Fleet.BikeAssignment.target', model)).toEqual({ ok: true, id: 'Fleet.BikeAssignment:target' });
    });

    test('ES06: a ref that is not fully qualified is S010, never resolved by simple name', () => {
        const r = resolveDtRef('event', 'ShipmentCancelled', model);
        expect(r).toMatchObject({ ok: false, code: 'S010', hint: "did you mean 'Delivery.ShipmentCancelled'?" });
        expect(r.ok || r.message).toContain("'Context.Event'");
        expect(resolveDtRef('command', 'Shipment.cancel', model)).toMatchObject({
            ok: false,
            code: 'S010',
            hint: "did you mean 'Delivery.Shipment.cancel'?",
        });
        expect(resolveDtRef('aggregate', 'Delivery.Shipment.cancel', model)).toMatchObject({ ok: false, code: 'S010' });
        expect(resolveDtRef('command', 'Delivery.Shipment.cancel.now', model)).toMatchObject({ ok: false, code: 'S010' });
    });

    test('ES06: a ref naming nothing is S010 with a did-you-mean over the right kind', () => {
        expect(resolveDtRef('event', 'Delivery.ShipmentCanceled', model)).toMatchObject({
            ok: false,
            code: 'S010',
            hint: "did you mean 'Delivery.ShipmentCancelled'?",
        });
        expect(resolveDtRef('aggregate', 'Delivery.Shipmint', model)).toMatchObject({ ok: false, code: 'S010', hint: "did you mean 'Delivery.Shipment'?" });
        // Another context is not guessed, only suggested.
        expect(resolveDtRef('event', 'Fleet.ShipmentCancelled', model)).toMatchObject({
            ok: false,
            code: 'S010',
            hint: "did you mean 'Delivery.ShipmentCancelled'?",
        });
        expect(resolveDtRef('event', 'Delivery.Nothing', model)).toEqual({
            ok: false,
            code: 'S010',
            message: "The event ref 'Delivery.Nothing' names nothing in the .dt model.",
        });
        expect(resolveDtRef('command', 'Delivery.Shipmnt.cancel', model)).toMatchObject({
            ok: false,
            code: 'S010',
            hint: "did you mean 'Delivery.Shipment.cancel'?",
        });
    });

    test('ES06: a ref naming a .dt symbol of the wrong kind is S011', () => {
        expect(resolveDtRef('event', 'Delivery.Shipment', model)).toMatchObject({
            ok: false,
            code: 'S011',
            message: expect.stringContaining('an aggregate, not an event'),
        });
        expect(resolveDtRef('aggregate', 'Delivery.ShipmentCancelled', model)).toMatchObject({ ok: false, code: 'S011' });
        // `.dt` policies, errors and IDs are never targets.
        expect(resolveDtRef('event', 'Fleet.ReleaseBike', model)).toMatchObject({ ok: false, code: 'S011', message: expect.stringContaining('a policy') });
        expect(resolveDtRef('event', 'Delivery.AlreadyDelivered', model)).toMatchObject({ ok: false, code: 'S011' });
        expect(resolveDtRef('command', 'Delivery.ShipmentCancelled.cancel', model)).toMatchObject({ ok: false, code: 'S011' });
        // An aggregate without the command, with the commands it has.
        expect(resolveDtRef('command', 'Delivery.Shipment.cancle', model)).toMatchObject({
            ok: false,
            code: 'S011',
            hint: "did you mean 'Delivery.Shipment.cancel'?",
        });
        expect(resolveDtRef('command', 'Fleet.BikeAssignment.assign', model)).toMatchObject({
            ok: false,
            code: 'S011',
            hint: "use a command of 'Fleet.BikeAssignment': Fleet.BikeAssignment.release, Fleet.BikeAssignment.target",
        });
    });
});

describe('linkStormings', () => {
    test('valid refs give no diagnostic; ES09: a policy across contexts is legal', () => {
        expect(link(...cancelFlow())).toEqual([]);
    });

    test('ES07: omitting ref is legal, and there is no completeness warning either way', () => {
        // No `ref` anywhere, although `.dt` has matching symbols.
        expect(
            link(
                el('event', 'ShipmentCancelled'),
                el('aggregate', 'Shipment'),
                el('command', 'CancelShipment', rel('target', 'Shipment'), rel('emits', 'ShipmentCancelled')),
            ),
        ).toEqual([]);
        // An empty storming leaves the `.dt` symbols unreferenced.
        expect(link()).toEqual([]);
        // Refs on some elements only, and a command with refs whose emitted event and target have none.
        expect(link(el('event', 'Draft'), el('command', 'CancelShipment', ref('Delivery.Shipment.cancel'), rel('emits', 'Draft')))).toEqual([]);
    });

    test('ES06: unresolved and wrong-kind refs are errors at the ref, on the element', () => {
        const ds = link(
            el('event', 'ShipmentCancelled', ref('ShipmentCancelled')),
            el('aggregate', 'Shipment', ref('Delivery.ShipmentCancelled')),
            el('command', 'CancelShipment', ref('Delivery.Shipment.cancle')),
        );
        expect(summary(ds)).toEqual([
            { code: 'S010', severity: 'error', elementId: 'es/Cancel/ShipmentCancelled', hint: "did you mean 'Delivery.ShipmentCancelled'?" },
            { code: 'S011', severity: 'error', elementId: 'es/Cancel/Shipment', hint: undefined },
            { code: 'S011', severity: 'error', elementId: 'es/Cancel/CancelShipment', hint: "did you mean 'Delivery.Shipment.cancel'?" },
        ]);
        expect(ds[0].file).toBe('flow.dtes');
    });

    test('refs the validator rejects are left to it', () => {
        // S005: a `ref` on a policy, an actor, a read model or a hotspot.
        expect(link(el('policy', 'P', ref('Fleet.ReleaseBike')), el('actor', 'Clerk', ref('Nowhere.Clerk')), el('hotspot', 'H', ref('X')))).toEqual([]);
    });

    test('without a .dt model nothing is linked', () => {
        expect(linkStormings([storming(el('event', 'E', ref('Nowhere.E')))], undefined)).toEqual([]);
    });

    test('S012: a command ref of another aggregate than the target ref is a warning', () => {
        const ds = link(...cancelFlow({ command: [ref('Delivery.Shipment.cancel'), rel('target', 'BikeAssignment')] }));
        expect(summary(ds)).toEqual([{ code: 'S012', severity: 'warning', elementId: 'es/Cancel/CancelShipment', hint: expect.any(String) }]);
        expect(ds[0].message).toContain("'Fleet.BikeAssignment'");
    });

    test('S012 needs both refs resolved and a single valid target', () => {
        const noWarning = (command: Clause[], extra: NodeElement[] = []) => expect(link(...cancelFlow({ command, extra }))).toEqual([]);
        // The target has no `ref`.
        noWarning([ref('Delivery.Shipment.cancel'), rel('target', 'Draft')], [el('aggregate', 'Draft')]);
        // The command has no `ref`.
        noWarning([rel('target', 'BikeAssignment')]);
        // Two targets (S004) or a target of another kind (S003) belong to the validator.
        noWarning([ref('Delivery.Shipment.cancel'), rel('target', 'BikeAssignment'), rel('target', 'Shipment')]);
        noWarning([ref('Delivery.Shipment.cancel'), rel('target', 'BikeReleased')]);
        noWarning([ref('Delivery.Shipment.cancel'), rel('target', 'Missing')]);
        // The target's `ref` does not resolve: only its S010.
        expect(
            link(
                el('aggregate', 'Shipment', ref('Fleet.Bike')),
                el('command', 'CancelShipment', ref('Delivery.Shipment.cancel'), rel('target', 'Shipment')),
            ).map((d) => d.code),
        ).toEqual(['S010']);
    });

    test('S013: emitting an event that the exhaustive .dt emits never lists is a warning', () => {
        const ds = link(
            ...cancelFlow({
                command: [ref('Delivery.Shipment.cancel'), rel('target', 'Shipment'), rel('emits', 'ShipmentCancelled'), rel('emits', 'BikeReleased')],
            }),
        );
        expect(summary(ds)).toEqual([
            { code: 'S013', severity: 'warning', elementId: 'es/Cancel/CancelShipment', hint: expect.stringContaining("'Fleet.BikeReleased'") },
        ]);
        expect(ds[0].message).toContain('never emits');
        // Reported at the `emits` clause.
        expect(ds[0].start.line).toBeGreaterThan(0);
    });

    test('S013 only when provable: no warning without both refs, or for events the .dtes leaves out', () => {
        const noWarning = (command: Clause[], extra: NodeElement[] = []) => expect(link(...cancelFlow({ command, extra }))).toEqual([]);
        // The `.dtes` lists fewer events than `.dt` (partial description): `deliver` would emit ShipmentDelivered.
        noWarning([ref('Delivery.Shipment.deliver'), rel('target', 'Shipment')]);
        // The emitted event has no `ref`.
        noWarning([ref('Delivery.Shipment.cancel'), rel('target', 'Shipment'), rel('emits', 'Unknown')], [el('event', 'Unknown')]);
        // The command has no `ref`.
        noWarning([rel('target', 'Shipment'), rel('emits', 'BikeReleased')]);
        // `emits` to something that is not an event is the validator's S003.
        noWarning([ref('Delivery.Shipment.cancel'), rel('target', 'Shipment'), rel('emits', 'BikeAssignment')]);
        // A command emitting nothing in `.dt` cannot be contradicted by a `.dtes` without `emits`.
        noWarning([ref('Fleet.BikeAssignment.target'), rel('target', 'BikeAssignment')]);
        // …but is by one with an `emits` whose event resolves.
        expect(link(...cancelFlow({ command: [ref('Fleet.BikeAssignment.target'), rel('emits', 'BikeReleased')] })).map((d) => d.code)).toEqual(['S013']);
    });

    test('a second ref (S004) is checked for resolution but not used for contracts', () => {
        const ds = link(
            ...cancelFlow({
                command: [
                    ref('Delivery.Shipment.cancel'),
                    ref('Fleet.BikeAssignment.release'),
                    rel('target', 'BikeAssignment'),
                    rel('emits', 'ShipmentCancelled'),
                ],
            }),
        );
        expect(ds).toEqual([]);
        expect(link(el('event', 'E', ref('Delivery.ShipmentCancelled'), ref('Delivery.Nope'))).map((d) => d.code)).toEqual(['S010']);
    });

    test('never modifies the storming IR or the model', () => {
        const s = storming(...cancelFlow({ command: [ref('Delivery.Shipment.cancel'), rel('target', 'BikeAssignment'), rel('emits', 'BikeReleased')] }));
        const before = { s: structuredClone(s), m: structuredClone(model) };
        expect(linkStormings([s], model).length).toBe(2);
        expect(s).toEqual(before.s);
        expect(model).toEqual(before.m);
    });

    test('R13: changing a ref does not change any semantic ID of the storming', () => {
        const ids = (s: Storming) => s.elements.map((e) => esElementId(s.id, e.id));
        const withRef = storming(el('event', 'ShipmentCancelled', ref('Delivery.ShipmentCancelled')), el('command', 'C', ref('Delivery.Shipment.cancel')));
        const renamed = storming(el('event', 'ShipmentCancelled', ref('Fleet.BikeReleased')), el('command', 'C', ref('Fleet.BikeAssignment.release')));
        const without = storming(el('event', 'ShipmentCancelled'), el('command', 'C'));
        expect(ids(renamed)).toEqual(ids(withRef));
        expect(ids(without)).toEqual(ids(withRef));
        // The diagnostics of a ref stay on the element's ID whatever the ref says.
        const broken = storming(el('event', 'ShipmentCancelled', ref('Delivery.Gone')));
        expect(linkStormings([broken], model).map((d) => d.elementId)).toEqual(['es/Cancel/ShipmentCancelled']);
    });
});
