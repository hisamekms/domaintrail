import { AstUtils, GrammarAST, LangiumParserErrorMessageProvider, type Grammar } from 'langium';

type Options<K extends 'buildMismatchTokenMessage' | 'buildNoViableAltMessage' | 'buildEarlyExitMessage'> = Parameters<LangiumParserErrorMessageProvider[K]>[0];
type Token = Options<'buildMismatchTokenMessage'>['actual'];
type TokenType = Options<'buildMismatchTokenMessage'>['expected'];

const isEof = (token: { tokenType: { name: string } } | undefined): boolean => token?.tokenType.name === 'EOF';
const labelOf = (t: TokenType): string => t.LABEL ?? t.name;
const found = (token: Token | undefined): string => (!token || isEof(token) ? 'end of file' : `\`${token.image}\``);

/** The keywords a name may be (the rules `FeatureName` and `ValueName` of the grammar). */
export function nameKeywords(grammar: Grammar): Set<string> {
    const out = new Set<string>();
    for (const rule of grammar.rules) {
        if (rule.name !== 'FeatureName' && rule.name !== 'ValueName') continue;
        for (const node of AstUtils.streamAllContents(rule)) if (GrammarAST.isKeyword(node)) out.add(node.value);
    }
    return out;
}

const PRIMITIVES = ['String', 'Int', 'Decimal', 'Bool', 'Timestamp', 'UUID'];
/** Keywords that start a declaration in a context: read as a field's name inside a block, a `}` may be missing above. */
const DECLARATIONS = new Set([
    'context',
    'shared',
    'terms',
    'id',
    'primitive',
    'verified',
    'enum',
    'value',
    'fields',
    'union',
    'entity',
    'aggregate',
    'persistent',
    'event',
    'error',
    'policy',
]);
/** Keywords of a block or clause that take a name after them. */
const NAMED = new Set(['state', 'command', 'owns', 'references', 'invariant', 'emits', 'errors', 'requires', 'changes']);

/**
 * Syntax messages of `.dt`: an unexpected end of input reads "found end of file" instead of the EOF token's empty image
 * ("found ``"); a name is "a name", not the identifier and every keyword that may be one; a keyword read as a field's
 * name (followed by something else than `:`) says so.
 */
export class DomainParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
    constructor(private readonly names: ReadonlySet<string> = new Set()) {
        super();
    }

    /** Token labels, the identifier and the keywords that may be names as one "a name" (with the primitives, "a type"). */
    private describe(labels: string[]): string {
        const unique = [...new Set(labels)];
        const named = unique.includes('ID');
        const type = named && PRIMITIVES.every((p) => unique.includes(p)) && unique.every((l) => l === 'ID' || PRIMITIVES.includes(l) || !this.names.has(l));
        const rest = unique.filter((l) => !(named && (l === 'ID' || this.names.has(l)))).map((l) => (l === 'EOF' ? 'end of file' : `'${l}'`));
        const all = [...(named ? [type ? 'a type' : 'a name'] : []), ...rest];
        return all.length < 2 ? all.join('') : `${all.slice(0, -1).join(', ')} or ${all[all.length - 1]}`;
    }

    override buildMismatchTokenMessage(options: Options<'buildMismatchTokenMessage'>): string {
        const { expected, actual, previous } = options;
        if (expected.name === 'EOF') return `Expecting end of file but found ${found(actual)}.`;
        const message = super.buildMismatchTokenMessage(options);
        const base = isEof(actual) ? message.replace(/ but found `.*`\.$/s, ' but found end of file.') : message;
        const keyword = previous?.image;
        if (labelOf(expected) !== ':' || !keyword || !this.names.has(keyword) || previous.tokenType.name === 'ID') return base;
        if (DECLARATIONS.has(keyword)) return `${base} \`${keyword}\` is read here as the name of a field: a '}' may be missing before it.`;
        if (NAMED.has(keyword)) return `${base} \`${keyword}\` is read here as the name of a field; as a keyword it is followed by a name.`;
        return base;
    }

    override buildNoViableAltMessage(options: Options<'buildNoViableAltMessage'>): string {
        const paths = options.expectedPathsPerAlt.flat();
        const [head, next] = options.actual;
        // the input starts like some alternatives (a keyword that may also be a name), then goes wrong
        const started = head ? paths.filter((p) => p.length > 1 && p[0].name === head.tokenType.name) : [];
        if (started.length) {
            const after = started.map((p) => labelOf(p[1]));
            const field = this.names.has(head.image) && after.includes(':');
            const expected = this.describe(after.filter((l) => !(field && l === ':')));
            return `Expecting ${expected} after \`${head.image}\`${field ? ` (or ':' for a field named \`${head.image}\`)` : ''} but found ${found(next)}.`;
        }
        const firsts = paths.map((p) => labelOf(p[0]));
        if (firsts.includes('ID')) return `Expecting ${this.describe(firsts)} but found ${found(head)}.`;
        const message = super.buildNoViableAltMessage(options);
        return isEof(head) ? message.replace(/\nbut found: '.*'$/s, '\nbut found end of file') : message;
    }

    override buildEarlyExitMessage(options: Options<'buildEarlyExitMessage'>): string {
        const message = super.buildEarlyExitMessage(options);
        return isEof(options.actual[0]) ? message.replace(/\nbut found: '.*'$/s, '\nbut found end of file') : message;
    }
}
