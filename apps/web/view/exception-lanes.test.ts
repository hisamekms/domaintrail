// The exceptions' lanes over a storming's canvas (view/exception-lanes.tsx): their bands and labels, what a label's
// press emphasizes, and what Escape ends.
import { afterAll, describe, expect, test } from 'bun:test';
import { createViewService, ElkLayoutEngine } from '@domaintrail/visualization';
import { drawnLanes, escapeEnds, pressedLabel } from './exception-lanes';
import { chooseTimeline, stormingDrawing, stormingGraph, type StormingChoice } from '../storming';

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

const TEXT = `storming D "配車" {
  event Req "依頼を受け付けた"
  event Rej "取込に失敗した"
  event Alloc "配車を組んだ"
  event AllocFail "自動配車できなかった"
  event Assign "担当を割り当てた"
  event Collect "回収した"
  stage Intake "受付" {
    timeline IntakeMain "通常" { Req }
    exception IntakeErr "取込エラー" { Req Rej }
  }
  stage Allocation "配車" after Intake {
    timeline AllocMain "通常" { Alloc Assign }
    timeline AllocCollect "回収" { Assign Collect }
    exception AllocFailed "失敗" { Alloc AllocFail then Assign }
  }
}`;
const { stormings } = await createViewService({
    root: '/workspace',
    engine,
    workspace: { readSources: async () => [{ path: 'd.dtes', text: TEXT }] },
    layoutStore: { load: async () => new Map(), save: async () => {} },
    git: {
        resolveCommit: (ref) => Promise.reject(new Error(`no git: ${ref}`)),
        sourcesAt: async () => [],
        listRefs: async () => ({ branches: [], tags: [], commits: [] }),
        gitDirs: async () => undefined,
    },
}).refresh();
const start: StormingChoice = { stormingId: 'D', level: 'design-level', timelines: {} };

describe('the lanes drawn', () => {
    test('a band round each exception’s own notes, its label the caption of the line into its lane', () => {
        const render = stormingGraph(stormings, start)!.render;
        const lanes = drawnLanes(stormingDrawing(stormings, start, null)!, render, stormings[0]!.timelines);
        expect(lanes.map((l) => l.exceptionId)).toEqual(['IntakeErr', 'AllocFailed']);
        for (const lane of lanes) {
            expect(lane.band.w).toBeGreaterThan(0);
            expect(lane.labels.length).toBe(1);
        }
    });

    test('none for an exception not drawn (one main flow shown without it): no band, no label', () => {
        const collect = chooseTimeline(start, 'D', 'AllocCollect');
        const lanes = drawnLanes(stormingDrawing(stormings, collect, null)!, stormingGraph(stormings, collect)!.render, stormings[0]!.timelines);
        expect(lanes.map((l) => l.exceptionId)).toEqual(['IntakeErr', 'AllocFailed']);
        const none = drawnLanes({ ...stormingDrawing(stormings, start, null)!, nodes: [] }, stormingGraph(stormings, start)!.render, stormings[0]!.timelines);
        expect(none).toEqual([]);
    });
});

describe('a label pressed, and Escape', () => {
    test('a label emphasizes its exception; pressed again, ends it; one naming several goes through them', () => {
        expect(pressedLabel(['A'], undefined)).toBe('A');
        expect(pressedLabel(['A'], 'A')).toBeUndefined();
        expect(pressedLabel(['A'], 'B')).toBe('A');
        expect(pressedLabel(['A', 'B'], 'A')).toBe('B');
        expect(pressedLabel(['A', 'B'], 'B')).toBeUndefined();
    });

    test('Escape ends the stickies’ selection first, then the emphasis', () => {
        expect(escapeEnds(2)).toBe('selection');
        expect(escapeEnds(0)).toBe('emphasis');
    });
});
