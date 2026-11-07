// What 探す finds of the domain model: its contexts, elements, and each aggregate's commands and states, in the order
// they are written, each named as the explorer names it (its qualified name, `Sales.Order.confirm`, and its label) and
// placed in its context (a command and a state also under their aggregate).
import { commandsOf, statesOf, type DomainModel } from '@domaintrail/modeling';
import { nameIn, type DisplayMode } from '@domaintrail/visualization';
import type { Messages } from '../i18n';
import type { Findable } from './find';

/** The domain model's findables; `go` takes the page to one (its ID). */
export function modelFindables(model: DomainModel | null, mode: DisplayMode, t: Pick<Messages, 'kinds'>, go: (id: string) => void): Findable[] {
    if (!model) return [];
    const contextName = new Map(model.contexts.map((c) => [c.name, nameIn(mode, c.name, c.label)]));
    const out: Findable[] = model.contexts.map((c) => ({
        key: c.name,
        world: 'model',
        kind: 'context',
        name: c.name,
        label: c.label,
        kindName: t.kinds.context,
        run: () => go(c.name),
    }));
    for (const el of model.elements) {
        const place = contextName.get(el.context) ?? el.context;
        out.push({ key: el.id, world: 'model', kind: el.kind, name: el.id, label: el.label, kindName: t.kinds[el.kind], place, run: () => go(el.id) });
        const under = `${place} › ${nameIn(mode, el.name, el.label)}`;
        for (const c of commandsOf(el))
            out.push({
                key: c.id,
                world: 'model',
                kind: 'command',
                name: `${el.id}.${c.name}`,
                label: c.label,
                kindName: t.kinds.command,
                place: under,
                run: () => go(c.id),
            });
        for (const s of statesOf(el))
            out.push({
                key: s.id,
                world: 'model',
                kind: 'state',
                name: `${el.id}.${s.name}`,
                label: s.label,
                kindName: t.kinds.state,
                place: under,
                run: () => go(s.id),
            });
    }
    return out;
}
