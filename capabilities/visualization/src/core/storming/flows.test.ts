// What the canvas of a storming carries (ADR 0032 §11): every flow or one main flow, in the same layout, and the
// exceptions as a layer, one of them emphasized.
import { describe, expect, test } from 'bun:test';
import { analyzeStormings, type Storming } from '@domaintrail/storming';
import { buildScene } from '../drawing/build-scene.js';
import { layoutGrid } from '../graph/grid.js';
import { exceptionLanes, exceptionSpan, flowInDrawing, flowNotes, mainFlowOf, mainFlows, type FlowTimeline } from './flows.js';
import { renderToGraph } from './graph.js';
import type { RenderGraph, ViewOptions } from './ir.js';
import { projectView } from './render.js';

async function parse(text: string): Promise<Storming> {
    const a = await analyzeStormings([{ path: 's.dtes', text }], undefined);
    expect(a.diagnostics.filter((d) => d.severity === 'error' && d.code !== 'S024' && d.code !== 'S027')).toEqual([]);
    return a.stormings[0]!;
}

// two stages: P (its trunk A B C D, another main flow from B, two exceptions) and Q after it (its trunk E F)
const TEXT = `storming T {
  event A
  event B
  event C
  event D
  event E
  event F
  event K
  event X
  event Z
  command DoX "X をする" {
    emits X
  }
  command DoZ "Z をする" {
    emits Z
  }
  stage P {
    timeline Main {
      A
      B
      C
      D
    }
    timeline Other {
      B
      K
    }
    exception Fail {
      B
      X
      then C
    }
    exception Lost {
      C
      Z
    }
  }
  stage Q after P {
    timeline Next {
      E
      F
    }
  }
}
`;
const S = await parse(TEXT);
const TIMELINES: FlowTimeline[] = [
    { id: 'Main', stageId: 'P' },
    { id: 'Other', stageId: 'P' },
    { id: 'Fail', stageId: 'P', exception: true },
    { id: 'Lost', stageId: 'P', exception: true },
    { id: 'Next', stageId: 'Q' },
];
const STAGES = [{ id: 'P' }, { id: 'Q' }];
const FLOWS = mainFlows(TIMELINES, STAGES);
const flow = (id: string) => mainFlowOf(FLOWS, id)!;

const BP: ViewOptions = { level: 'big-picture' };
const DL: ViewOptions = { level: 'design-level' };
const named = (g: RenderGraph, ids: ReadonlySet<string>): string[] =>
    [...ids]
        .map((id) => {
            const n = g.nodes.find((x) => x.id === id);
            return n?.type === 'event' ? n.eventId : n?.type === 'element' ? n.elementId : id;
        })
        .sort();

describe('the main flows', () => {
    test('drawn in sections: the trunk through every stage is one, then each other main flow; else each timeline', () => {
        expect(FLOWS).toEqual([
            { id: 'Main', timelines: ['Main', 'Next'] },
            { id: 'Other', timelines: ['Other'] },
        ]);
        expect(mainFlowOf(FLOWS, 'Next')?.id).toBe('Main');
        expect(mainFlowOf(FLOWS, 'Fail')).toBeUndefined();
        expect(mainFlows([{ id: 'A', label: 'あ' }, { id: 'B' }], undefined)).toEqual([
            { id: 'A', label: 'あ', timelines: ['A'] },
            { id: 'B', timelines: ['B'] },
        ]);
    });
});

describe('one main flow, in the layout of every flow', () => {
    test('the trunk: the other main flow and what branches off it are not drawn; every exception of the trunk is', () => {
        const render = projectView(S, BP);
        const notes = flowNotes(render, S, TIMELINES, { main: flow('Main') });
        expect(named(render, notes.hidden)).toEqual(['K']);
        expect(notes.exceptions).toEqual(['Fail', 'Lost']);
        expect(notes.unused.size).toBe(0);
    });

    test('another main flow: the trunk before it, its own steps, the exceptions branching off them; a stage left empty is dashed', () => {
        const render = projectView(S, DL);
        const notes = flowNotes(render, S, TIMELINES, { main: flow('Other') });
        // A and B (the trunk before it), K; Fail branches off B; C, D, Lost (and its command), the next stage: not drawn
        expect(named(render, notes.hidden)).toEqual(['C', 'D', 'DoZ', 'E', 'F', 'Z']);
        expect(notes.exceptions).toEqual(['Fail']);
        expect([...notes.unused]).toEqual(['st:Q']);
        const all = layoutGrid(renderToGraph(render, S));
        const drawn = flowInDrawing(all, render, S, TIMELINES, { main: flow('Other') });
        // nothing moves
        expect(drawn.nodeLayout).toBe(all.nodeLayout);
        expect(drawn.nodes.find((n) => n.id === 'st:Q')?.unused).toBe(true);
        expect(drawn.edges.some((e) => notes.hidden.has(e.source) || notes.hidden.has(e.target))).toBe(false);
    });

    test('a storming without stages nor exceptions: its merged canvas keeps the main flow’s events and what relates to them', async () => {
        const s = await parse(`storming O {
  event A
  event B
  event C
  command DoC "C をする" {
    emits C
  }
  timeline One {
    A
    B
  }
  timeline Two {
    A
    C
  }
}
`);
        const tls = [{ id: 'One' }, { id: 'Two' }];
        const render = projectView(s, DL);
        const graph = renderToGraph(render, s);
        const one = flowInDrawing(graph, render, s, tls, { main: mainFlowOf(mainFlows(tls, undefined), 'One') });
        expect(one.nodes.map((n) => n.elementId).sort()).toEqual(['es/O/A', 'es/O/B']);
        const two = flowInDrawing(graph, render, s, tls, { main: mainFlowOf(mainFlows(tls, undefined), 'Two') });
        expect(two.nodes.map((n) => n.elementId).sort()).toEqual(['es/O/A', 'es/O/C', 'es/O/DoC']);
    });
});

describe('an exception emphasized', () => {
    test('its path dark: the main flow before it branches off, its steps, from where it returns onwards; the rest faint', () => {
        const render = projectView(S, BP);
        const fail = flowNotes(render, S, TIMELINES, { focus: 'Fail' });
        // every flow drawn: the other main flow and the other exception faint, nothing hidden
        expect(fail.hidden.size).toBe(0);
        expect(named(render, fail.dimmed)).toEqual(['K', 'Z']);
        // Lost does not return: the trunk after it branches off is faint, the next stage too
        expect(named(render, flowNotes(render, S, TIMELINES, { focus: 'Lost' }).dimmed)).toEqual(['D', 'E', 'F', 'K', 'X']);
    });

    test('with a main flow shown: of what is drawn', () => {
        const render = projectView(S, BP);
        const notes = flowNotes(render, S, TIMELINES, { main: flow('Other'), focus: 'Fail' });
        expect(named(render, notes.dimmed)).toEqual(['K']);
        // an exception not drawn: nothing faint
        expect(flowNotes(render, S, TIMELINES, { main: flow('Other'), focus: 'Lost' }).dimmed.size).toBe(0);
    });

    test('drawn faint, the lines too; nothing moves, nothing more is drawn or left out', () => {
        const render = projectView(S, BP);
        const all = layoutGrid(renderToGraph(render, S));
        const drawn = flowInDrawing(all, render, S, TIMELINES, { focus: 'Fail' });
        expect(drawn.nodes.map((n) => n.id)).toEqual(all.nodes.map((n) => n.id));
        expect(
            drawn.nodes
                .filter((n) => n.dimmed)
                .map((n) => n.elementId)
                .sort(),
        ).toEqual(['es/T/K', 'es/T/Z']);
        const dim = new Set(drawn.nodes.filter((n) => n.dimmed).map((n) => n.id));
        for (const e of drawn.edges) expect(e.dimmed === true).toBe(dim.has(e.source) || dim.has(e.target));
        const scene = buildScene(drawn, { diff: { added: [], changed: [], removed: [] }, diagnostics: [], mode: 'name', lang: 'ja' });
        expect(scene.nodes.filter((n) => n.props.dimmed).length).toBe(2);
        expect(flowInDrawing(all, render, S, TIMELINES, {})).toBe(all);
    });
});

describe('the lanes of the exceptions', () => {
    test('each exception’s own steps and the notes at them, the edges captioned with it; its span', () => {
        const render = projectView(S, DL);
        const lanes = exceptionLanes(render, TIMELINES);
        expect(named(render, new Set(lanes.get('Fail')!.notes))).toEqual(['DoX', 'X']);
        expect(lanes.get('Fail')!.captions.length).toBe(1);
        expect(named(render, new Set(lanes.get('Lost')!.notes))).toEqual(['DoZ', 'Z']);
        expect(named(render, new Set(exceptionSpan(render, 'Fail')))).toEqual(['B', 'C', 'X']);
    });
});
