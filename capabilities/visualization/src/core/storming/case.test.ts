// One exception's case (ADR 0032 §11): the main flows and that exception, drawn from the layout of every flow — the
// other exceptions left out where they stood, the notes off the case's path faint.
import { describe, expect, test } from 'bun:test';
import { analyzeStormings, type Storming } from '@domaintrail/storming';
import { buildScene } from '../drawing/build-scene.js';
import { layoutGrid } from '../graph/grid.js';
import { caseInDrawing, caseNotes } from './case.js';
import { renderToGraph } from './graph.js';
import type { RenderGraph, ViewOptions } from './ir.js';
import { projectView } from './render.js';

async function parse(text: string): Promise<Storming> {
    const a = await analyzeStormings([{ path: 's.dtes', text }], undefined);
    expect(a.diagnostics.filter((d) => d.severity === 'error' && d.code !== 'S024' && d.code !== 'S027')).toEqual([]);
    return a.stormings[0]!;
}

// two stages: P (a main flow A B C D, another main flow from B, two exceptions) and Q after it (main flow E F)
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
  hotspot OnZ "Z は？" {
    on Z
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
const TIMELINES = [{ id: 'Main' }, { id: 'Other' }, { id: 'Fail', exception: true as const }, { id: 'Lost', exception: true as const }, { id: 'Next' }];

const BP: ViewOptions = { level: 'big-picture' };
const DL: ViewOptions = { level: 'design-level' };
const eventOf = (g: RenderGraph, id: string): string | undefined => {
    const n = g.nodes.find((x) => x.id === id);
    return n?.type === 'event' ? n.eventId : n?.type === 'element' ? n.elementId : undefined;
};
const named = (g: RenderGraph, ids: ReadonlySet<string>): string[] => [...ids].map((id) => eventOf(g, id) ?? id).sort();

describe('the notes of a case', () => {
    test('the other exceptions are left out; off the path in its stage, faint; another stage as it is', () => {
        const render = projectView(S, BP);
        const { hidden, dimmed } = caseNotes(render, TIMELINES, 'Fail');
        expect(named(render, hidden)).toEqual(['OnZ', 'Z']);
        // the path: A B (before it branches off), X, then C D from where it returns; the other main flow faint
        expect(named(render, dimmed)).toEqual(['K']);
        const lost = caseNotes(render, TIMELINES, 'Lost');
        expect(named(render, lost.hidden)).toEqual(['X']);
        // Lost does not return: the main flow after it branches off is faint, and so is the other main flow
        expect(named(render, lost.dimmed)).toEqual(['D', 'K']);
    });

    test('a stage’s view alike, and the elements go with their step', () => {
        const render = projectView(S, { ...DL, stageId: 'P' });
        const { hidden, dimmed } = caseNotes(render, TIMELINES, 'Fail');
        expect(named(render, hidden)).toEqual(['DoZ', 'OnZ', 'Z']);
        expect(named(render, dimmed)).toEqual(['K']);
        const lost = caseNotes(render, TIMELINES, 'Lost');
        expect(named(render, lost.hidden)).toEqual(['DoX', 'X']);
    });

    test('nothing for a main flow, an unknown exception, or a view of no sections', () => {
        const render = projectView(S, BP);
        expect(caseNotes(render, TIMELINES, 'Main').hidden.size).toBe(0);
        expect(caseNotes(render, TIMELINES, 'Nope').hidden.size).toBe(0);
        expect(caseNotes(projectView(S, { ...BP, timelineId: 'Main' }), TIMELINES, 'Fail').hidden.size).toBe(0);
    });
});

describe('a case drawn from the layout of every flow', () => {
    test('nothing moves: the notes drawn stand where they stood; the others and their lines are not drawn', () => {
        const render = projectView(S, DL);
        const all = layoutGrid(renderToGraph(render, S));
        const drawn = caseInDrawing(all, render, TIMELINES, 'Fail');
        const { hidden, dimmed } = caseNotes(render, TIMELINES, 'Fail');
        expect(drawn.nodes.map((n) => n.id)).toEqual(all.nodes.filter((n) => !hidden.has(n.id)).map((n) => n.id));
        expect(drawn.nodeLayout).toBe(all.nodeLayout);
        expect(drawn.edges.some((e) => hidden.has(e.source) || hidden.has(e.target))).toBe(false);
        expect(drawn.nodes.filter((n) => n.dimmed).map((n) => n.id)).toEqual([...dimmed].filter((id) => drawn.nodes.some((n) => n.id === id)).sort());
        // a line from or to a faint note is faint
        for (const e of drawn.edges) expect(e.dimmed === true).toBe(dimmed.has(e.source) || dimmed.has(e.target));
        // the time order of the other exception is gone with its lane
        expect(drawn.edges.some((e) => e.relation?.names?.some((n) => n.ja.name === 'Lost'))).toBe(false);
    });

    test('the scene draws the faint notes and lines faint (the canvas and the portable SVG alike)', () => {
        const render = projectView(S, BP);
        const drawn = caseInDrawing(layoutGrid(renderToGraph(render, S)), render, TIMELINES, 'Fail');
        const scene = buildScene(drawn, { diff: { added: [], changed: [], removed: [] }, diagnostics: [], mode: 'name', lang: 'ja' });
        expect(scene.nodes.filter((n) => n.props.dimmed).map((n) => n.elementId)).toEqual(['es/T/K']);
        expect(scene.edges.filter((e) => e.props.dimmed).length).toBeGreaterThan(0);
        expect(scene.nodes.filter((n) => !n.props.dimmed).every((n) => n.props.dimmed === undefined)).toBe(true);
    });

    test('the graph itself when there is no case to draw', () => {
        const render = projectView(S, BP);
        const graph = layoutGrid(renderToGraph(render, S));
        expect(caseInDrawing(graph, render, TIMELINES, 'Main')).toBe(graph);
    });
});
