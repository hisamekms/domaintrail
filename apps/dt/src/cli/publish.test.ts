// The published form of a storming (ADR 0031, section 11): its stickies once each with their labels (no timeline,
// group or stage), the whole storming at its two levels as the Live View lays it out, the commit and date of the
// drawing, and a version of the drawing alone: the same drawing has the same version whatever its commit.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { LaidOutGraph } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { loadDiagramViews } from '../wiring/diagram.js';
import { chosenStormings, publishedForm, PublishError, stickiesOf } from './publish.js';

const RETURNS = `storming Returns "返品" {
  event ReturnRequested "返品が依頼された"
  event RefundPaid "返金した"
  command Refund "返金する"
  timeline Accepted "受け付けた返品" {
    ReturnRequested
    group Closing "締め" {
      RefundPaid
    }
  }
  hotspot Deadline "返品は注文から何日まで？" {
    on ReturnRequested
  }
}
`;

let root: string;
const stormingsOf = async (text: string): Promise<StormingView[]> => {
    await writeFile(path.join(root, 'returns.dtes'), text);
    const views = await loadDiagramViews({ root, sources: ['**/*.dtes'], respectGitignore: false });
    try {
        return views.payload.stormings;
    } finally {
        views.dispose();
    }
};
let returns: StormingView;
beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'domaintrail-publish-'));
    [returns] = await stormingsOf(RETURNS);
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** A value as its JSON: compared with plain values. */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

const drawn = { at: new Date('2026-11-04T10:00:00.000Z'), commit: 'abc1234def' };

describe('the published form', () => {
    test('the stickies once each, with their labels, never the timelines, groups or stages', () => {
        expect(plain(stickiesOf(returns))).toEqual([
            { ref: 'Returns.ReturnRequested', label: '返品が依頼された' },
            { ref: 'Returns.RefundPaid', label: '返金した' },
            { ref: 'Returns.Refund', label: '返金する' },
            { ref: 'Returns.Deadline', label: '返品は注文から何日まで？' },
        ]);
    });

    test('both levels of the whole storming as the Live View lays them out, the commit and the date', () => {
        const form = publishedForm(returns, drawn);
        expect(form).toMatchObject({ format: 1, storming: 'Returns', label: '返品', drawing: drawn });
        const bp = form.views['big-picture'] as LaidOutGraph;
        const dl = form.views['design-level'] as LaidOutGraph;
        expect(bp.nodes.map((n) => n.elementId)).not.toContain('es/Returns/Refund');
        expect(dl.nodes.map((n) => n.elementId)).toContain('es/Returns/Refund');
        expect(Object.keys(dl.nodeLayout).length).toBe(dl.nodes.length);
        // nothing of the session or the files: no chat, no person, no path
        expect(JSON.stringify(form)).not.toContain(root);
    });

    test('the version is the drawing’s: the same drawing at another commit keeps it, another drawing changes it', async () => {
        const form = publishedForm(returns, drawn);
        expect(form.version).toMatch(/^[0-9a-f]{24}$/);
        expect(publishedForm(returns, { at: new Date() }).version).toBe(form.version);
        const [again] = await stormingsOf(RETURNS);
        expect(publishedForm(again, drawn).version).toBe(form.version);
        const [relabelled] = await stormingsOf(RETURNS.replace('"返金した"', '"返金を済ませた"'));
        expect(publishedForm(relabelled, drawn).version).not.toBe(form.version);
    });

    test('a storming that no longer parses is not published', () => {
        expect(() => publishedForm({ ...returns, stale: true }, drawn)).toThrow(PublishError);
    });
});

test('the stormings named, each known; or all of them', () => {
    expect(chosenStormings([returns], undefined)).toEqual([returns]);
    expect(chosenStormings([returns], ['Returns'])).toEqual([returns]);
    expect(() => chosenStormings([returns], ['Ordering'])).toThrow("Unknown storming 'Ordering'. Stormings: Returns");
});
