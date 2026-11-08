// Stages, main flows and exceptions (docs/dtes-v0.1.md §3.7): `stage`, `after`, `exception` and `then` from the text
// through the parser, the formatter and the validator (S017–S022, with S002–S004 for what names no stage or is written
// twice), and the order, branch points and rejoin points the projection draws from.
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Diagnostic } from '@domaintrail/kernel';
import { analyzeStormings } from './analyze.js';
import { formatStorming } from '../infrastructure/syntax/format.js';
import { branchPoints, drawnInSections, hasExceptions, orderStages, rejoinPoint, topLevel } from '../domain/stages.js';
import type { Stage, Storming } from '../domain/ir.js';
import { stormingTimelines } from '../domain/semantic.js';

const FIXTURES = path.join(import.meta.dir, '..', '..', '..', '..', 'test', 'fixtures', 'stages');
const STAGED = await readFile(path.join(FIXTURES, 'convenience-store-stages.dtes'), 'utf8');

async function analyze(text: string): Promise<{ stormings: Storming[]; diagnostics: Diagnostic[] }> {
    return analyzeStormings([{ path: 's.dtes', text }], undefined);
}

const summary = (ds: Diagnostic[]): string[] => ds.map((d) => `${d.start.line} ${d.code} ${d.severity}`);

const EVENTS = `  event A
  event B
  event C
  event D
  event X
  event Y
`;

/** A storming with the events A, B, C, D, X and Y on lines 2–7; the body starts on line 8. */
const storming = (body: string): string => `storming S {\n${EVENTS}${body}}\n`;

const stage = (s: Storming, id: string): Stage => s.elements.find((e): e is Stage => e.kind === 'stage' && e.id === id)!;

describe('parsing and formatting stages and exceptions', () => {
    test('a stage: its label, `after`, main flow, an exception and its `then`, as written', async () => {
        const text = storming(`  stage First "最初" {
    timeline Main1 "通常" {
      A
      B
    }
  }
  stage Second "次" after First {
    timeline Main2 {
      C
      D
    }
    exception Fail {
      C
      X
      then D
    }
  }
`);
        const { stormings, diagnostics } = await analyze(text);
        expect(diagnostics).toEqual([]);
        const second = stage(stormings[0]!, 'Second');
        expect(second).toMatchObject({ kind: 'stage', id: 'Second', label: '次', afters: [{ stageId: 'First' }] });
        expect(second.afters[0]!.range.start).toEqual({ line: 14, column: 26 });
        expect(second.timelines.map((t) => [t.id, !!t.exception])).toEqual([
            ['Main2', false],
            ['Fail', true],
        ]);
        expect(second.timelines[1]!.rejoin).toMatchObject({ eventId: 'D', range: { start: { line: 22, column: 12 } } });
        // the timelines of the stages are the storming's
        expect(stormingTimelines(stormings[0]!).map((t) => t.id)).toEqual(['Main1', 'Main2', 'Fail']);
        expect(formatStorming(text)).toBe(text);
    });

    test('the formatter puts every timeline of a stage and its `then` on lines of their own, and keeps `after` on the stage’s', () => {
        const messy = `storming S { event A event B stage P "p"   after   Q { timeline M { A   B } exception E { A then   B } } stage Q { } }`;
        expect(formatStorming(messy)).toBe(`storming S {
  event A
  event B
  stage P "p" after Q {
    timeline M {
      A
      B
    }
    exception E {
      A
      then B
    }
  }
  stage Q {}
}
`);
    });

    test('the user’s storming in stages checks clean and is formatted', async () => {
        const { diagnostics, stormings } = await analyze(STAGED);
        expect(diagnostics).toEqual([]);
        expect(formatStorming(STAGED)).toBe(STAGED);
        expect(hasExceptions(stormings[0]!)).toBe(true);
    });

    test('`then` closes a timeline: a step after it, or two of them, is a syntax error', async () => {
        for (const body of ['A\n then B\n C', 'A\n then B\n then C']) {
            const { diagnostics } = await analyze(storming(`  stage P {\n    exception M {\n ${body}\n    }\n  }\n`));
            expect(diagnostics.map((d) => d.code)).toContain('SYNTAX');
        }
    });

    test('a stage holds timelines and exceptions only: an event declared in it is a syntax error', async () => {
        const { diagnostics } = await analyze(storming(`  stage P {\n    event Z\n  }\n`));
        expect(new Set(diagnostics.map((d) => d.code))).toEqual(new Set(['SYNTAX']));
    });
});

describe('validating stages and exceptions (S017–S022)', () => {
    test('`after` naming nothing is S002, naming an event S003, a second one S004, itself S017', async () => {
        const text = storming(`  stage P {
    timeline M1 {
      A
    }
  }
  stage Q after Nope {
    timeline M2 {
      B
    }
  }
  stage R after A {
    timeline M3 {
      C
    }
  }
  stage T after P after Q {
    timeline M4 {
      D
    }
  }
  stage U after U {
    timeline M5 {
      X
    }
  }
`);
        const { diagnostics } = await analyze(text);
        expect(summary(diagnostics)).toEqual(['13 S002 error', '18 S003 error', '23 S004 error', '28 S017 error']);
        expect(diagnostics[0]!.message).toBe("`after` of stage 'Q' names 'Nope', which is not declared in storming 'S'.");
        expect(diagnostics[1]!.message).toBe("`after` of stage 'R' names 'A', which is an event; it must name a stage.");
        expect(diagnostics[2]!.message).toBe("Stage 'T' has more than one `after`; it takes at most one.");
        expect(diagnostics[3]!.message).toBe("Stage 'U' comes `after` itself.");
    });

    test('S017: a cycle of `after`s is reported at the `after` of each of its stages', async () => {
        const text = storming(`  stage P after R {
    timeline M1 {
      A
    }
  }
  stage Q after P {
    timeline M2 {
      B
    }
  }
  stage R after Q {
    timeline M3 {
      C
    }
  }
`);
        const { diagnostics, stormings } = await analyze(text);
        expect(summary(diagnostics)).toEqual(['8 S017 error', '13 S017 error', '18 S017 error']);
        expect(diagnostics[0]!.message).toBe(
            "Stage 'P' is on a cycle of `after`: P after R after Q after P. Stages are in time order, so none comes after a later one.",
        );
        // the stages of a cycle start anew, in source order
        expect(orderStages(stormings[0]!).stages.map((s) => s.id)).toEqual(['P', 'Q', 'R']);
    });

    test('S018: `then` on a main flow, or naming an event of no main flow; S002/S003 for what is not an event', async () => {
        const text = storming(`  stage P {
    timeline Main {
      A
      B
      then A
    }
    exception E1 {
      A
      X
      then Y
    }
    exception E2 {
      A
      X
      then Nope
    }
    exception E3 {
      A
      X
      then P
    }
  }
`);
        const { diagnostics } = await analyze(text);
        expect(summary(diagnostics)).toEqual(['12 S018 error', '17 S018 error', '22 S002 error', '27 S003 error']);
        expect(diagnostics[0]!.message).toBe("Timeline 'Main' is a main flow; only an exception returns to a main flow with `then`.");
        expect(diagnostics[1]!.message).toBe(
            "`then Y` of exception 'E1' names an event in no main flow; an exception returns to a step of a main flow (a `timeline`).",
        );
    });

    test('`then` may return to a main flow of its own stage, of a later stage or of an earlier one', async () => {
        const text = storming(`  stage P {
    timeline M1 {
      A
      B
    }
    exception Later {
      A
      X
      then C
    }
  }
  stage Q after P {
    timeline M2 {
      C
      D
    }
    timeline Alternative {
      C
      Y
    }
    exception Earlier {
      D
      X
      then B
    }
    exception Own {
      C
      X
      then Y
    }
  }
`);
        const { diagnostics, stormings } = await analyze(text);
        expect(diagnostics).toEqual([]);
        const s = stormings[0]!;
        expect(rejoinPoint(s, stage(s, 'P'), 'C')).toEqual({ sectionId: 'Q', timelineId: 'M2', step: 0 });
        expect(rejoinPoint(s, stage(s, 'Q'), 'B')).toEqual({ sectionId: 'P', timelineId: 'M1', step: 1 });
        // another main flow than the trunk
        expect(rejoinPoint(s, stage(s, 'Q'), 'Y')).toEqual({ sectionId: 'Q', timelineId: 'Alternative', step: 1 });
    });

    test('S019: a timeline whose first step is in neither the trunk nor another timeline branching off is a warning', async () => {
        const text = storming(`  stage P {
    timeline Main {
      A
      B
      C
    }
    exception FromMain {
      B
      X
    }
    exception FromException {
      X
      Y
    }
    exception Dangling {
      D
      Y
    }
    timeline AlsoDangling {
      D
    }
  }
`);
        const { diagnostics, stormings } = await analyze(text);
        expect(summary(diagnostics)).toEqual(['23 S019 warning', '27 S019 warning']);
        expect(diagnostics[0]!.message).toBe(
            "Exception 'Dangling' of stage 'P' starts with 'D', which is in neither the main flow 'Main' nor another timeline branching off it; it is drawn apart, not branching off.",
        );
        expect(branchPoints(stage(stormings[0]!, 'P'))).toEqual(
            new Map([
                ['FromMain', { timelineId: 'Main', step: 1 }],
                ['FromException', { timelineId: 'FromMain', step: 1 }],
                ['Dangling', undefined],
                ['AlsoDangling', undefined],
            ]),
        );
    });

    test('several main flows: the first is the trunk, another branches off it like an exception, wherever it is written', async () => {
        const text = storming(`  stage P {
    exception Fail {
      B
      X
    }
    timeline Trunk {
      A
      B
      C
    }
    timeline Other {
      A
      Y
      D
    }
  }
`);
        const { diagnostics, stormings } = await analyze(text);
        expect(diagnostics).toEqual([]);
        expect(branchPoints(stage(stormings[0]!, 'P'))).toEqual(
            new Map([
                ['Fail', { timelineId: 'Trunk', step: 1 }],
                ['Other', { timelineId: 'Trunk', step: 0 }],
            ]),
        );
    });

    test('a branch point is the first matching step of the trunk; a group matches a group of the same events or one of its events', async () => {
        const text = storming(`  stage P {
    timeline Main {
      A
      group G1 {
        B
        C
      }
      A
    }
    exception Again {
      A
      X
    }
    exception SameGroup {
      group G2 {
        C
        B
      }
      Y
    }
    exception Member {
      C
      Y
    }
  }
`);
        const { diagnostics, stormings } = await analyze(text);
        expect(diagnostics).toEqual([]);
        expect(branchPoints(stage(stormings[0]!, 'P'))).toEqual(
            new Map([
                ['Again', { timelineId: 'Main', step: 0 }],
                ['SameGroup', { timelineId: 'Main', step: 1 }],
                ['Member', { timelineId: 'Main', step: 1 }],
            ]),
        );
    });

    test('exceptions without stages: top-level ones branch off the first timeline, and return to a top-level main flow', async () => {
        const text = storming(`  timeline Main {
    A
    B
    C
  }
  exception Fail {
    B
    X
    then C
  }
  exception Apart {
    D
  }
`);
        const { diagnostics, stormings } = await analyze(text);
        expect(summary(diagnostics)).toEqual(['19 S019 warning']);
        const s = stormings[0]!;
        expect(drawnInSections(s)).toBe(true);
        expect(rejoinPoint(s, topLevel(s), 'C')).toEqual({ sectionId: '', timelineId: 'Main', step: 2 });
    });

    test('without stages and exceptions, timelines are as they were: no branch point is looked for (no S019)', async () => {
        const text = storming(`  timeline One {
    A
    B
  }
  timeline Two {
    X
    Y
  }
`);
        const { diagnostics, stormings } = await analyze(text);
        expect(diagnostics).toEqual([]);
        expect(drawnInSections(stormings[0]!)).toBe(false);
    });

    test('S020: a storming with stages has no timeline or exception outside them', async () => {
        const text = storming(`  timeline Loose {
    A
  }
  exception LooseToo {
    A
  }
  stage P {
    timeline Main {
      B
    }
  }
`);
        const { diagnostics } = await analyze(text);
        expect(summary(diagnostics)).toEqual(['8 S020 error', '11 S020 error']);
        expect(diagnostics[0]!.message).toBe("Timeline 'Loose' is outside the stages of storming 'S'; once a storming has stages, every timeline is in one.");
        expect(diagnostics[1]!.message).toBe(
            "Exception 'LooseToo' is outside the stages of storming 'S'; once a storming has stages, every timeline is in one.",
        );
    });

    test('S021: a second stage without `after` is a warning; it starts anew after the stages before it', async () => {
        const text = storming(`  stage P {
    timeline M1 {
      A
    }
  }
  stage Q {
    timeline M2 {
      B
    }
  }
`);
        const { diagnostics, stormings } = await analyze(text);
        expect(summary(diagnostics)).toEqual(['13 S021 warning']);
        expect(diagnostics[0]!.hint).toBe('add `after <Stage>` naming the stage it follows (e.g. `after P`)');
        expect(orderStages(stormings[0]!)).toEqual({ stages: [stage(stormings[0]!, 'P'), stage(stormings[0]!, 'Q')], previous: new Map() });
    });

    test('S022: a stage without a main flow is a warning: an empty one, or one of exceptions only (which branch off nothing)', async () => {
        const { diagnostics } = await analyze(storming(`  stage P {}\n`));
        expect(summary(diagnostics)).toEqual(['8 S022 warning']);
        const only = await analyze(storming(`  stage P {\n    exception E {\n      A\n    }\n  }\n`));
        expect(summary(only.diagnostics)).toEqual(['8 S022 warning', '10 S019 warning']);
        expect(only.diagnostics[0]!.message).toBe("Stage 'P' has no main flow: a `timeline` (an `exception` is not one).");
    });

    test('stage, timeline and exception IDs share the storming’s one namespace (S001)', async () => {
        const text = storming(`  stage A {
    timeline B {
      C
    }
    exception D {
      C
    }
  }
`);
        const { diagnostics } = await analyze(text);
        expect(summary(diagnostics)).toEqual(['8 S001 error', '9 S001 error', '12 S001 error']);
    });

    test('stages are ordered by `after` whatever their source order', async () => {
        const text = storming(`  stage Last after Middle {
    timeline M3 {
      C
    }
  }
  stage Middle after First {
    timeline M2 {
      B
    }
  }
  stage First {
    timeline M1 {
      A
    }
  }
`);
        const { stormings } = await analyze(text);
        const order = orderStages(stormings[0]!);
        expect(order.stages.map((s) => s.id)).toEqual(['First', 'Middle', 'Last']);
        expect(order.previous).toEqual(
            new Map([
                ['Last', 'Middle'],
                ['Middle', 'First'],
            ]),
        );
    });
});
