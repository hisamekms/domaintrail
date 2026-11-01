// The analysis of .dtes sources with the .dt model (through the CLI: test/dtes-cli.test.ts).
import { describe, expect, test } from 'bun:test';
import { check } from '../test-helpers.js';

const DT = `context Delivery {
  id ShipmentId: UUID
  id CourierId: UUID
  event ShipmentCancelled { shipmentId: ShipmentId }
  event ShipmentDelivered { shipmentId: ShipmentId }
  aggregate Shipment {
    id: ShipmentId
    state Pending
    state Delivered
    state Cancelled
    command cancel() Pending -> Cancelled emits ShipmentCancelled
    command deliver() Pending -> Delivered emits ShipmentDelivered
  }
  aggregate Courier {
    id: CourierId
    command assign()
  }
}
`;

/** A storming with one problem of each `.dt` rule: S011 (line 4), S010 (5), S012 (8), S013 (14). */
const FLOW = `storming Delivery "配送" {
  event ShipmentCancelled "配送キャンセル" { ref Delivery.ShipmentCancelled }
  event ShipmentDelivered { ref Delivery.ShipmentDelivered }
  event Lost { ref Delivery.Shipment }
  event Gone { ref ShipmentGone }
  aggregate Shipment { ref Delivery.Shipment }
  command Cancel {
    ref Delivery.Courier.assign
    target Shipment
  }
  command Deliver {
    ref Delivery.Shipment.deliver
    target Shipment
    emits ShipmentCancelled
  }
}
`;

const VALID = `storming Delivery {
  event ShipmentCancelled { ref Delivery.ShipmentCancelled }
  aggregate Shipment { ref Delivery.Shipment }
  command Cancel {
    ref Delivery.Shipment.cancel
    target Shipment
    emits ShipmentCancelled
  }
  timeline Main { ShipmentCancelled }
}
`;

const where = (d: { file: string; start: { line: number }; code: string }) => `${d.file}:${d.start.line} ${d.code}`;

describe('analyze with .dtes sources', () => {
    test('reports S010–S013 at their file and line, merged with the .dt diagnostics', async () => {
        const a = await check({ 'domain.dt': DT, 'flow.dtes': FLOW });
        expect(a.diagnostics.map(where)).toEqual(['flow.dtes:4 S011', 'flow.dtes:5 S010', 'flow.dtes:8 S012', 'flow.dtes:14 S013']);
        expect(a.ok).toBe(false);
        expect(a.syntaxOk).toBe(true);
        expect(a.files).toEqual(['domain.dt', 'flow.dtes']);
        expect(a.documents).toHaveLength(1);
        expect(a.stormings).toMatchObject({
            files: ['flow.dtes'],
            syntaxOk: true,
            stormings: [{ id: 'Delivery', label: '配送', range: { file: 'flow.dtes' } }],
        });
        expect(a.stormings.diagnostics).toEqual(a.diagnostics);
        expect(a.diagnostics.find((d) => d.code === 'S013')?.elementId).toBe('es/Delivery/Deliver');
    });

    test('a broken .dtes does not hide the model, and a valid one makes the workspace ok', async () => {
        const broken = await check({ 'domain.dt': DT, 'flow.dtes': 'storming Delivery {\n  event\n' });
        expect(broken.diagnostics.map(where)).toEqual(['flow.dtes:2 SYNTAX']);
        expect(broken.syntaxOk).toBe(true);
        expect(broken.model?.elements['Delivery.Shipment']).toBeDefined();
        expect(broken.stormings).toMatchObject({ syntaxOk: false, stormings: [] });
        expect(broken.ok).toBe(false);

        const valid = await check({ 'domain.dt': DT, 'flow.dtes': VALID });
        expect(valid.diagnostics).toEqual([]);
        expect(valid.ok).toBe(true);
    });

    test('without a .dt model the refs are not checked, the local rules are', async () => {
        const a = await check({ 'domain.dt': 'context Delivery {', 'flow.dtes': FLOW.replace('target Shipment', 'target Gone') });
        expect(a.model).toBeUndefined();
        expect(a.diagnostics.map(where)).toEqual(['domain.dt:1 SYNTAX', 'flow.dtes:9 S003']);
    });

    test('a workspace of .dtes files only is valid', async () => {
        const a = await check({ 'flow.dtes': VALID.replace(/ \{ ref [\w.]+ \}/g, '').replace(/    ref [\w.]+\n/, '') });
        expect(a.diagnostics).toEqual([]);
        expect(a.ok).toBe(true);
    });
});
