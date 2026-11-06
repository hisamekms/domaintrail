import { LangiumParserErrorMessageProvider } from 'langium';
import { didYouMean } from '@domaintrail/kernel';

type Options<K extends 'buildMismatchTokenMessage' | 'buildNoViableAltMessage' | 'buildEarlyExitMessage'> = Parameters<LangiumParserErrorMessageProvider[K]>[0];

const isEof = (token: { tokenType: { name: string } } | undefined): boolean => token?.tokenType.name === 'EOF';

/** The words of `.dtes` (ADR 0032): a near miss (`handledby`, `readModel`, `emit`) gets a suggestion. */
const KEYWORDS = [
    'storming',
    'event',
    'actor',
    'external',
    'command',
    'policy',
    'aggregate',
    'readmodel',
    'hotspot',
    'timeline',
    'exception',
    'group',
    'stage',
    'ref',
    'by',
    'reads',
    'handledBy',
    'emits',
    'on',
    'issues',
    'from',
    'status',
    'resolution',
    'level',
    'after',
    'then',
];

/** `(did you mean 'handledBy'?)` for an unknown word close to a keyword (case aside), else nothing. */
function suggestion(token: { image: string; tokenType: { name: string } } | undefined): string {
    if (!token || token.tokenType.name !== 'ID' || KEYWORDS.includes(token.image)) return '';
    const exact = KEYWORDS.find((k) => k.toLowerCase() === token.image.toLowerCase());
    const hint = exact
        ? `did you mean '${exact}'?`
        : didYouMean(
              token.image,
              KEYWORDS.filter((k) => k.length > 2),
          );
    return hint ? ` (${hint})` : '';
}

/**
 * Syntax messages of `.dtes`, the same as Modeling's for `.dt` (a copy: the two syntaxes share no code): an unexpected
 * end of input reads "found end of file" instead of the EOF token's empty image ("found ``").
 */
export class StormingParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
    override buildMismatchTokenMessage(options: Options<'buildMismatchTokenMessage'>): string {
        const message = super.buildMismatchTokenMessage(options);
        return isEof(options.actual) ? message.replace(/ but found `.*`\.$/s, ' but found end of file.') : message + suggestion(options.actual);
    }

    override buildNoViableAltMessage(options: Options<'buildNoViableAltMessage'>): string {
        const message = super.buildNoViableAltMessage(options);
        return isEof(options.actual[0]) ? message.replace(/\nbut found: '.*'$/s, '\nbut found end of file') : message + suggestion(options.actual[0]);
    }

    override buildEarlyExitMessage(options: Options<'buildEarlyExitMessage'>): string {
        const message = super.buildEarlyExitMessage(options);
        return isEof(options.actual[0]) ? message.replace(/\nbut found: '.*'$/s, '\nbut found end of file') : message + suggestion(options.actual[0]);
    }
}
