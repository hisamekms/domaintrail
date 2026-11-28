// The method forms of Phase 2's TS-like expressions (`xs.every(x => p)`, `xs.includes(x)`, `xs.unique()`,
// `text.matches("r")`, `x.length`). The grammar reads every `x.name(…)` as a member access with a call; this tells
// which expression each one is, for both model builders and for the diagnostics of a call that is none of them.
import type { AstNode } from 'langium';
import { isBinaryExpr, isNullLiteral, isStringLiteral, type Expression, type MemberAccess, type StringLiteral } from './generated/ast.js';

/** What a member access with or without a call is. */
export type MethodForm =
    | { readonly k: 'member' }
    | { readonly k: 'length' }
    | { readonly k: 'quantifier'; readonly quantifier: 'all' | 'any'; readonly param: string; readonly body: Expression }
    | { readonly k: 'contains'; readonly element: Expression }
    | { readonly k: 'unique'; readonly param?: string; readonly keys: readonly Expression[] }
    | { readonly k: 'matches'; readonly pattern: StringLiteral }
    | { readonly k: 'invalid'; readonly message: string };

const usage: Record<string, string> = {
    every: 'xs.every(x => condition)',
    some: 'xs.some(x => condition)',
    includes: 'xs.includes(value)',
    unique: 'xs.unique() or xs.unique(x => key, …)',
    matches: 'text.matches("pattern")',
};

export function methodForm(e: MemberAccess): MethodForm {
    if (!e.call) return e.member === 'length' ? { k: 'length' } : { k: 'member' };
    const param = e.param?.name;
    const args = e.args;
    const wrong = (): MethodForm => ({ k: 'invalid', message: `'.${e.member}(…)' is written ${usage[e.member]}.` });
    switch (e.member) {
        case 'every':
        case 'some':
            return param !== undefined && args.length === 1
                ? { k: 'quantifier', quantifier: e.member === 'every' ? 'all' : 'any', param, body: args[0] }
                : wrong();
        case 'includes':
            return param === undefined && args.length === 1 ? { k: 'contains', element: args[0] } : wrong();
        case 'unique':
            return (param === undefined && args.length === 0) || (param !== undefined && args.length > 0)
                ? { k: 'unique', ...(param !== undefined && { param }), keys: args }
                : wrong();
        case 'matches':
            return param === undefined && args.length === 1 && isStringLiteral(args[0]) ? { k: 'matches', pattern: args[0] } : wrong();
        default:
            return { k: 'invalid', message: `'${e.member}' is not a method: the methods are every, some, includes, unique and matches.` };
    }
}

/** The text of a pattern as written between its quotes (backslashes kept, `\"` unescaped), as `regexSource` reads it. */
export function patternSource(lit: StringLiteral): string {
    const text = lit.$cstNode?.text;
    return text ? text.slice(1, -1).replace(/\\"/g, '"') : lit.value;
}

/**
 * `x != null` / `x == null` (either side): the optional `x` and whether it is compared as present. These are the
 * `exists(x)` and `!exists(x)` of the models, so narrowing, the IR and the generated checks stay as they are.
 */
export function nullComparison(e: AstNode | undefined): { operand: Expression; present: boolean } | undefined {
    if (!isBinaryExpr(e) || (e.op !== '==' && e.op !== '!=')) return undefined;
    const operand = isNullLiteral(e.right) ? e.left : isNullLiteral(e.left) ? e.right : undefined;
    if (!operand || isNullLiteral(operand)) return undefined;
    return { operand, present: e.op === '!=' };
}
