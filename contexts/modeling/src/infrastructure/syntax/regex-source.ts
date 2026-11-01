// The regular expression of `matches(value, "...")` as written, which both builders put on their model (the Typed
// Model's `ExprModel` and the model as written's `Expr`): it reads the CST, so it lives with the syntax.
import { GrammarUtils } from 'langium';
import type { MatchesExpr } from './generated/ast.js';

/**
 * The pattern of `matches(value, "...")` exactly as written: backslashes are not string escapes,
 * so `"\d+"` is the regular expression `\d+` (only `\"` stands for a quote).
 */
export function regexSource(e: MatchesExpr): string {
    const text = GrammarUtils.findNodeForProperty(e.$cstNode, 'pattern')?.text;
    return text ? text.slice(1, -1).replace(/\\"/g, '"') : e.pattern;
}
