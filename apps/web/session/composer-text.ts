// The composer's text as its editor shows it (ADR 0026, amendment "the composer's editor"), without the editor: lines
// of plain text and mentions, each mention an atomic chip. The value (`ComposerValue`) stays the source of truth and
// keeps its tokens (`#name[n]`, `@name[pN]`); the editor reads it into lines (`composerLines`) and writes its lines back
// into a value (`composerValue`). A mention holds what it names, not its number: the numbers are given when the lines
// are written back, so a mention brought back by undo brings its chip back.
import { editText, MAX_REQUEST_MENTIONS, MAX_REQUEST_TARGETS, mentionName, parseBody, type ComposerChip, type ComposerValue } from './mentions';
import { targetKey, type TargetDraft } from './targets';

/** A mention in the editor: an element (one of the request's targets) or a person (a participant's ID). */
export type ComposerMention =
    | { readonly kind: 'element'; readonly name: string; readonly target: TargetDraft }
    | { readonly kind: 'person'; readonly name: string; readonly person: string };

/** A piece of a line: plain text or a mention. */
export type ComposerPiece = { readonly kind: 'text'; readonly text: string } | ComposerMention;

/** A line of the text (the text split at its line breaks). */
export type ComposerLine = readonly ComposerPiece[];

/** A value's text as lines of text and mentions: only the tokens of the value's chips and people are mentions. */
export function composerLines(value: ComposerValue): ComposerPiece[][] {
    const lines: ComposerPiece[][] = [[]];
    for (const seg of parseBody(value.text, { targets: value.chips.length, people: value.people.length })) {
        if (seg.kind === 'element') lines[lines.length - 1].push({ kind: 'element', name: seg.name, target: value.chips[seg.index].target });
        else if (seg.kind === 'person') lines[lines.length - 1].push({ kind: 'person', name: seg.name, person: value.people[seg.index] });
        else
            seg.text.split('\n').forEach((text, i) => {
                if (i > 0) lines.push([]);
                if (text !== '') lines[lines.length - 1].push({ kind: 'text', text });
            });
    }
    return lines;
}

/** The index of a target among the chips, if it is one. */
const chipOf = (chips: readonly ComposerChip[], target: TargetDraft): number => {
    const key = targetKey(target.target);
    return chips.findIndex((c) => targetKey(c.target.target) === key);
};

/** Whether one more mention fits: a target or a person already in the value always does, a new one within the limit. */
export function mentionFits(value: ComposerValue, mention: ComposerMention): boolean {
    if (mention.kind === 'element') return chipOf(value.chips, mention.target) >= 0 || value.chips.length < MAX_REQUEST_TARGETS;
    return value.people.includes(mention.person) || value.people.length < MAX_REQUEST_MENTIONS;
}

/**
 * The editor's lines written back into the value: each mention as its token, numbered by its chip or person (a target
 * or a person not in the value yet is added, as a pick adds it; one past the limit stays its name as text). Then, as for
 * any edit (`editText`), a chip that came from a mention goes once no mention of it is left, and so does a person.
 */
export function composerValue(value: ComposerValue, lines: readonly ComposerLine[]): ComposerValue {
    let chips = value.chips;
    let people = value.people;
    const token = (piece: ComposerPiece): string => {
        if (piece.kind === 'text') return piece.text;
        const name = mentionName(piece.name);
        if (piece.kind === 'person') {
            let index = people.indexOf(piece.person);
            if (index < 0) {
                if (people.length >= MAX_REQUEST_MENTIONS) return name;
                index = people.length;
                people = [...people, piece.person];
            }
            return `@${name}[p${index + 1}]`;
        }
        let index = chipOf(chips, piece.target);
        if (index < 0) {
            if (chips.length >= MAX_REQUEST_TARGETS) return name;
            index = chips.length;
            chips = [...chips, { target: piece.target, mentioned: true }];
        } else if (!chips[index].mentioned) {
            chips = chips.map((c, i) => (i === index ? { ...c, mentioned: true } : c));
        }
        return `#${name}[${index + 1}]`;
    };
    const text = lines.map((line) => line.map(token).join('')).join('\n');
    return editText({ ...value, chips, people }, text);
}
