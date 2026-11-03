// What `/es:names` and `/es:next` read of `dt check`: the findings on the `.dtes` files only, one line each.
import { describe, expect, test } from 'bun:test';
import { stormingDiagnostics } from './subscriber.js';

describe("the stormings' diagnostics for the answerer", () => {
    test('the .dtes findings, one line each (file:line:column severity code: message); the .dt ones left out', async () => {
        const long =
            'マイナンバーカードの暗証番号を三回間違えてロックされたので市役所の窓口で再設定の手続きをしてから改めてコンビニのマルチコピー機で住民票の写しを発行し直した';
        const sources = [
            { path: 'orders.dtes', text: `storming Orders "注文" {\n  event OrderPlaced "${long}"\n  timeline Normal {\n    OrderPlaced\n  }\n}\n` },
            { path: 'sales.dt', text: 'context Sales {\n  aggregate Order {\n    id: Missing\n  }\n}\n' },
        ];
        const lines = await stormingDiagnostics({ readSources: async () => sources });
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.every((l) => l.startsWith('orders.dtes:'))).toBe(true);
        expect(lines.some((l) => /^orders\.dtes:2:\d+ warning S015: /u.test(l))).toBe(true);
    });
});
