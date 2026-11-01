// Storming's analysis of the .dtes sources, given the Typed Model of the .dt sources (the project analysis runs it after
// Modeling's: analysis/analyze.test.ts).
import { beforeAll, describe, expect, test } from 'bun:test';
import { analyzeDomain } from '@domaintrail/modeling';
import type { DomainModel } from '@domaintrail/modeling';
import { analyzeStormings } from './analyze.js';

const DT = `context Delivery {
  id ShipmentId: UUID
  event ShipmentCancelled { shipmentId: ShipmentId }
  aggregate Shipment {
    id: ShipmentId
    state Pending
    state Cancelled
    command cancel() Pending -> Cancelled emits ShipmentCancelled
  }
}
`;

/** S003 (line 5, a local rule) and S010 (line 2, a ref the model lacks). */
const FLOW = `storming Delivery {
  event Gone { ref Delivery.ShipmentGone }
  command Cancel {
    ref Delivery.Shipment.cancel
    target Gone
  }
}
`;

const where = (d: { file: string; start: { line: number }; code: string }): string => `${d.file}:${d.start.line} ${d.code}`;

let model: DomainModel;
beforeAll(async () => {
    const a = await analyzeDomain([{ path: 'domain.dt', text: DT }]);
    expect(a.diagnostics).toEqual([]);
    model = a.model!;
});

describe('analyzeStormings', () => {
    test('links the refs against the model it is given, after the local rules, sorted', async () => {
        const a = await analyzeStormings([{ path: 'flow.dtes', text: FLOW }], model);
        expect(a.diagnostics.map(where)).toEqual(['flow.dtes:2 S010', 'flow.dtes:5 S003']);
        expect(a).toMatchObject({ files: ['flow.dtes'], syntaxOk: true, stormings: [{ id: 'Delivery' }] });
    });

    test('without a model the refs are not checked, the local rules are', async () => {
        const a = await analyzeStormings([{ path: 'flow.dtes', text: FLOW }], undefined);
        expect(a.diagnostics.map(where)).toEqual(['flow.dtes:5 S003']);
    });
});
