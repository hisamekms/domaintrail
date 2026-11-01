import { LangiumParserErrorMessageProvider } from 'langium';

type Options<K extends 'buildMismatchTokenMessage' | 'buildNoViableAltMessage' | 'buildEarlyExitMessage'> = Parameters<LangiumParserErrorMessageProvider[K]>[0];

const isEof = (token: { tokenType: { name: string } } | undefined): boolean => token?.tokenType.name === 'EOF';

/**
 * Syntax messages shared by `.dt` and `.dtes`: an unexpected end of input reads "found end of file" instead of the
 * EOF token's empty image ("found ``").
 */
export class DomainParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
    override buildMismatchTokenMessage(options: Options<'buildMismatchTokenMessage'>): string {
        const message = super.buildMismatchTokenMessage(options);
        return isEof(options.actual) ? message.replace(/ but found `.*`\.$/s, ' but found end of file.') : message;
    }

    override buildNoViableAltMessage(options: Options<'buildNoViableAltMessage'>): string {
        const message = super.buildNoViableAltMessage(options);
        return isEof(options.actual[0]) ? message.replace(/\nbut found: '.*'$/s, '\nbut found end of file') : message;
    }

    override buildEarlyExitMessage(options: Options<'buildEarlyExitMessage'>): string {
        const message = super.buildEarlyExitMessage(options);
        return isEof(options.actual[0]) ? message.replace(/\nbut found: '.*'$/s, '\nbut found end of file') : message;
    }
}
