export type TokenKind = 'keyword' | 'type' | 'primitive' | 'string' | 'number' | 'comment' | 'doc' | 'name' | 'plain';

export interface Token {
    kind: TokenKind;
    text: string;
}

const KEYWORDS = new Set([
    'shared', 'context', 'terms', 'id', 'primitive', 'verified', 'of', 'for', 'enum', 'value', 'union', 'by', 'entity', 'aggregate', 'state', 'owns', 'references',
    'create', 'command', 'requires', 'else', 'changes', 'emits', 'when', 'errors', 'persistent', 'event', 'error', 'invariant', 'fields', 'with', 'policy',
    'and', 'or', 'not', 'implies', 'in', 'count', 'exists', 'all', 'any', 'length', 'matches', 'unique', 'contains', 'true', 'false',
]);
const PRIMITIVES = new Set(['String', 'Int', 'Decimal', 'Bool', 'Timestamp', 'UUID']);

const TOKEN =
    /(\/\*[\s\S]*?\*\/)|(\/\/\/[^\n]*)|(\/\/[^\n]*)|("(?:\\.|[^"\\\n])*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|(\s+|[^\sA-Za-z_\d"/]+|\/)/g;

/** Splits DSL source into lines of coloured tokens (comments may span lines). */
export function highlight(source: string): Token[][] {
    const lines: Token[][] = [[]];
    const push = (kind: TokenKind, text: string) => {
        const parts = text.split('\n');
        parts.forEach((part, i) => {
            if (i > 0) lines.push([]);
            if (part) lines[lines.length - 1].push({ kind, text: part });
        });
    };
    for (const m of source.matchAll(TOKEN)) {
        const [text, block, doc, comment, str, num, word] = m;
        if (block || comment) push('comment', text);
        else if (doc) push('doc', text);
        else if (str) push('string', text);
        else if (num) push('number', text);
        else if (word) {
            // `id: OrderId` / `value: Int` are field names, not keywords
            const end = m.index + text.length;
            const isFieldName = /^\s*:/.test(source.slice(end, end + 16));
            push(KEYWORDS.has(word) && !isFieldName ? 'keyword' : PRIMITIVES.has(word) ? 'primitive' : /^[A-Z]/.test(word) ? 'type' : 'name', text);
        }
        else push('plain', text);
    }
    return lines;
}
