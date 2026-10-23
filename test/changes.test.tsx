import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { diffModels } from '../src/graph/diff.js';
import { CommandCard } from '../web/behavior.js';
import { highlight } from '../web/highlight.js';
import { MESSAGES } from '../web/i18n.js';
import { namer } from '../web/model-utils.js';
import { check, only } from './helpers.js';

/**
 * Work moves Draft -> Review -> Done -> Archived. `draftNo` is in Draft and Review (carried over between them),
 * `reviewer` in Review and Done (carried over) and in Archived with another type (not carried over).
 */
const work = (commands: string, extra = '') =>
    check({
        'tasks.dt': `context Tasks {
  id WorkId: UUID
  id TagId: UUID
  event Renamed { workId: WorkId }
  error NotReady
  fields Audited { updatedAt: Timestamp? }
  aggregate Work with Audited {
    id: WorkId
    title: String
    note: String?
    tags: String[0..*]
    state Draft { draftNo: Int }
    state Review { draftNo: Int reviewer: String }
    state Done { reviewer: String doneAt: Timestamp }
    state Archived { reviewer: String? }
${commands}
  }
  aggregate Tag {
    id: TagId
    name: String
    color: String
    create command make(id: TagId, name: String, color: String)
    command recolor(color: String) changes color
  }
  ${extra}
}
`,
    });

const COMMANDS = `
    create command open(id: WorkId, title: String) -> Draft
    command rename(newTitle: String, at: Timestamp)
      Draft -> Draft, Review -> Review
      requires named { newTitle != "" } else NotReady
      changes title, updatedAt
      emits Renamed
    command submit(reviewer: String) Draft -> Review
    command renumber(n: Int) Draft -> Draft, Review -> Review changes draftNo
    command finish(at: Timestamp) Review -> Done
    command archive() Done -> Archived
    command clearNote() Draft -> Draft changes note
    command touch() Draft -> Draft`;

describe('changes in the DSL', () => {
    test('lists the fields a command may change, after requires and before emits; the Typed Model holds them', async () => {
        const a = await work(COMMANDS);
        expect(a.diagnostics).toEqual([]);
        const cmd = (name: string) => a.model!.elements['Tasks.Work'].commands!.find((c) => c.name === name)!;
        expect(cmd('rename').changes).toEqual(['title', 'updatedAt']);
        expect(cmd('rename').emits.map((e) => e.event)).toEqual(['Tasks.Renamed']);
        expect(cmd('renumber').changes).toEqual(['draftNo']);
        expect(cmd('submit').changes).toEqual([]);
        expect(a.model!.elements['Tasks.Tag'].commands![1].changes).toEqual(['color']);
    });

    test('after emits it is a syntax error', async () => {
        const a = await work('command x() Draft -> Draft emits Renamed changes title');
        expect(a.syntaxOk).toBe(false);
    });

    test('`changes` is still usable as a field and parameter name', async () => {
        const a = await check({
            'sales.dt': `context Sales {
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    changes: Int
    command count(changes: Int) changes changes
  }
}`,
        });
        expect(a.diagnostics).toEqual([]);
        expect(a.model!.elements['Sales.Order'].fields.map((f) => f.name)).toEqual(['id', 'changes']);
        expect(a.model!.elements['Sales.Order'].commands![0].changes).toEqual(['changes']);
    });

    test('M021: a field the command can change; not on a factory, not the identity', async () => {
        const a = await work(`
    create command make(id: WorkId) -> Draft changes title
    command a() Draft -> Draft changes titel
    command b() Draft -> Draft changes id
    command c() Draft -> Review changes reviewer
    command d() Done -> Archived changes doneAt
    command e() Done -> Archived changes reviewer
    command f() Draft -> Draft, Review -> Review changes reviewer
    command g() Draft | Review -> Review changes draftNo, reviewer`);
        // not reported: f (Review -> Review carries `reviewer` over), g (Review -> Review carries both; Draft -> Review sets `reviewer` anyway)
        expect(only(a, 'M021').map((d) => [d.message, d.hint])).toEqual([
            ["Factory command 'make' sets every field of the new 'Work'; 'changes' does not apply to it.", "remove 'changes title'; the decision of 'make' gives every field"],
            ["'Work' has no field 'titel'.", "did you mean 'title'?"],
            ["Field 'id' is the identity of 'Work' and never changes.", "remove 'id' from 'changes'"],
            [
                "Field 'reviewer' is in state 'Review', 'Done', 'Archived' only, and no transition of 'c' carries it over (from a state that has it to one that has it, with the same type), so 'changes' cannot apply to it.",
                "every outcome of 'c' that ends in 'Review' sets 'reviewer' anyway; remove it from 'changes'",
            ],
            [
                "Field 'doneAt' is in state 'Done' only, and no transition of 'd' carries it over (from a state that has it to one that has it, with the same type), so 'changes' cannot apply to it.",
                "'d' never ends in 'Done', so 'doneAt' is not kept; remove it from 'changes'",
            ],
            [
                "Field 'reviewer' is in state 'Review', 'Done', 'Archived' only, and no transition of 'e' carries it over (from a state that has it to one that has it, with the same type), so 'changes' cannot apply to it.",
                "every outcome of 'e' that ends in 'Archived' sets 'reviewer' anyway; remove it from 'changes'",
            ],
        ]);
    });

    test('M021: an aggregate without states changes its own fields; M002: a field is listed once', async () => {
        const a = await work('command x() Draft -> Draft, Review -> Review changes title, note, title', 'aggregate Plain { id: WorkId size: Int command grow() changes sise }');
        expect(only(a, 'M002').map((d) => d.message)).toEqual(["Field 'title' is listed more than once in 'changes' of command 'x'."]);
        expect(only(a, 'M021').map((d) => [d.message, d.hint])).toEqual([["'Plain' has no field 'sise'.", "did you mean 'size'?"]]);
    });

    test('changes is highlighted as a keyword; a change to it changes its command (and its aggregate)', async () => {
        expect(highlight('changes note emits X')[0].filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['changes', 'emits']);
        const before = await work('command x() Draft -> Draft changes title');
        const after = await work('command x() Draft -> Draft changes title, note');
        expect(diffModels(before.model, after.model!)).toEqual({ added: [], changed: ['Tasks.Work', 'Tasks.Work:x'], removed: [] });
    });

    test('the command card and the inspector list the fields it changes', async () => {
        const a = await work(COMMANDS);
        const agg = a.model!.elements['Tasks.Work'];
        const card = (name: string) =>
            renderToStaticMarkup(<CommandCard agg={agg} c={agg.commands!.find((c) => c.name === name)!} model={a.model!} names={namer('name', a.model!)} tx={MESSAGES.ja} onSelect={() => {}} />);
        expect(card('rename')).toContain(`<div class="bcard-caption">${MESSAGES.ja.changedFields}</div><div class="bcard-changes"><code class="bcard-change">title</code><code class="bcard-change">updatedAt</code></div>`);
        expect(card('submit')).not.toContain('bcard-changes');
    });
});
