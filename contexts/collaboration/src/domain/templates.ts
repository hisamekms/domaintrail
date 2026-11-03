// Message templates (the plan's "Later: message templates", round 4): typing `/` in the composer lists them next to
// the commands; picking one only puts its text in the composer, to edit and send (it never says whether the message is
// a 相談 or a 依頼: the triage decides). The list depends on what is open and selected: the contexts below. The
// built-in templates are the page's (both languages, its i18n); a team adds its own in `domaintrail.jsonc` (the
// top-level `templates`), shown after the built-in ones. Here: the contexts, and the section's shape and validation.
import { err, ok, type Result } from '../generated/index.js';

/**
 * Where a template is offered, from what the page shows: a storming at Big Picture or at Design Level (any storming:
 * `storming`), a `.dt` view (`model`), anything selected (`element`) — an aggregate, an event (a storming's or a
 * `.dt` one), a state — or nothing selected (`none`).
 */
export const TEMPLATE_CONTEXTS = ['big-picture', 'design-level', 'storming', 'model', 'element', 'aggregate', 'event', 'state', 'none'] as const;

export type TemplateContext = (typeof TEMPLATE_CONTEXTS)[number];

/** The limits of a team's template. */
export const TEMPLATE_LIMITS = { templates: 30, id: 40, name: 60, text: 2000 } as const;

/** A template's ID: what filtering after `/` matches besides its name (lowercase ASCII, digits and `-`). */
const TEMPLATE_ID = /^[a-z][a-z0-9-]*$/;

/** A team's template as the config file has it (`templates[]`). */
export interface MessageTemplateConfig {
    readonly id: string;
    /** One name for every language, or one per language. */
    readonly name: string | { readonly ja?: string; readonly en?: string };
    /** One text, or one per language. `{target}` is where the selected element goes, as a `#` mention. */
    readonly text: string | { readonly ja?: string; readonly en?: string };
    readonly when?: readonly TemplateContext[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A text, or one per language (`ja`, `en`, at least one), each non-blank within `max`. */
function localized(v: unknown, at: string, max: number): string | undefined {
    const one = (s: unknown, where: string): string | undefined =>
        typeof s !== 'string' || !s.trim()
            ? `'${where}' must be a non-empty string`
            : s.length > max
              ? `'${where}' must be at most ${max} characters`
              : undefined;
    if (typeof v === 'string') return one(v, at);
    if (!isObject(v)) return `'${at}' must be a string, or an object with 'ja' and/or 'en'`;
    const keys = Object.keys(v);
    const unknown = keys.find((k) => k !== 'ja' && k !== 'en');
    if (unknown) return `unknown key '${at}.${unknown}' (the languages are 'ja' and 'en')`;
    if (keys.length === 0) return `'${at}' must have 'ja' and/or 'en'`;
    for (const k of keys) {
        const e = one(v[k], `${at}.${k}`);
        if (e) return e;
    }
    return undefined;
}

/** The top-level `templates` checked (absent is fine): what is wrong with it first, if anything. */
export function checkTemplates(raw: unknown): Result<readonly MessageTemplateConfig[], string> {
    if (raw === undefined) return ok([]);
    if (!Array.isArray(raw)) return err("'templates' must be an array");
    if (raw.length > TEMPLATE_LIMITS.templates) return err(`'templates' has at most ${TEMPLATE_LIMITS.templates} entries`);
    const ids = new Set<string>();
    for (const [i, t] of raw.entries()) {
        const at = `templates[${i}]`;
        if (!isObject(t)) return err(`'${at}' must be an object`);
        const unknown = Object.keys(t).find((k) => !['id', 'name', 'text', 'when'].includes(k));
        if (unknown) return err(`unknown key '${at}.${unknown}'`);
        if (typeof t.id !== 'string' || !TEMPLATE_ID.test(t.id) || t.id.length > TEMPLATE_LIMITS.id)
            return err(`'${at}.id' must be lowercase letters, digits and '-' (starting with a letter, at most ${TEMPLATE_LIMITS.id})`);
        if (ids.has(t.id)) return err(`'${at}.id' repeats '${t.id}'`);
        ids.add(t.id);
        const name = localized(t.name, `${at}.name`, TEMPLATE_LIMITS.name);
        if (name) return err(name);
        const text = localized(t.text, `${at}.text`, TEMPLATE_LIMITS.text);
        if (text) return err(text);
        if (t.when !== undefined) {
            if (!Array.isArray(t.when) || t.when.length === 0) return err(`'${at}.when' must be a non-empty array`);
            const wrong = t.when.find((w) => !(TEMPLATE_CONTEXTS as readonly unknown[]).includes(w));
            if (wrong !== undefined) return err(`'${at}.when' must hold ${TEMPLATE_CONTEXTS.map((c) => `'${c}'`).join(', ')}: '${String(wrong)}'`);
        }
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every entry was checked above
    return ok(raw as readonly MessageTemplateConfig[]);
}
