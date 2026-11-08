// The composer's text field (ADR 0026, amendment "the composer's editor"): a Lexical editor in plain-text mode, with
// history, whose mentions are atomic inline chips. It is bound to React here, without `@lexical/react`: the editor is
// created once, attached to its element, and kept in step with the value both ways — an edit writes the lines back into
// the value (`composerValue`); a value changed from outside (a chip removed, the draft loaded, the text cleared after
// sending) is read into the editor again (`composerLines`).
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { registerPlainText } from '@lexical/plain-text';
import {
    $createParagraphNode,
    $createRangeSelection,
    $createTextNode,
    $getNodeByKey,
    $getRoot,
    $getSelection,
    $isElementNode,
    $isLineBreakNode,
    $isRangeSelection,
    $isTextNode,
    $setSelection,
    CLEAR_HISTORY_COMMAND,
    COMMAND_PRIORITY_HIGH,
    createEditor,
    DecoratorNode,
    HISTORIC_TAG,
    KEY_DOWN_COMMAND,
    type EditorConfig,
    type LexicalEditor,
    type LexicalNode,
    type NodeKey,
    type SerializedLexicalNode,
    type Spread,
} from 'lexical';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEventHandler, type ReactNode, type RefObject } from 'react';
import { composerLines, composerValue, type ComposerLine, type ComposerMention, type ComposerPiece } from './composer-text';
import { mentionQuery, type ComposerValue, type MentionQuery } from './mentions';

/** The most characters a request's text has (as the server takes it). */
const MAX_TEXT = 10_000;

/** The tag of an update that reads the value into the editor: not an edit, so it is not written back. */
const LOAD_TAG = 'composer-load';

/** How a mention reads in the text: its chip's text (`#未払い`, `@田中`) and its whole name (tooltip, accessible name). */
export interface MentionLook {
    readonly label: string;
    readonly title: string;
}

type SerializedMention = Spread<{ mention: ComposerMention; look: MentionLook }, SerializedLexicalNode>;

/** A mention in the text: an atomic inline chip that draws itself (no React); the caret steps over it as one character. */
export class MentionNode extends DecoratorNode<null> {
    __mention: ComposerMention;
    __look: MentionLook;

    static override getType(): string {
        return 'composer-mention';
    }

    static override clone(node: MentionNode): MentionNode {
        return new MentionNode(node.__mention, node.__look, node.__key);
    }

    static override importJSON(json: SerializedMention): MentionNode {
        return new MentionNode(json.mention, json.look);
    }

    constructor(mention: ComposerMention, look: MentionLook, key?: NodeKey) {
        super(key);
        this.__mention = mention;
        this.__look = look;
    }

    override exportJSON(): SerializedMention {
        return { ...super.exportJSON(), mention: this.__mention, look: this.__look };
    }

    override createDOM(_config: EditorConfig): HTMLElement {
        const { mention, look } = { mention: this.__mention, look: this.__look };
        const span = document.createElement('span');
        span.className = mention.kind === 'element' ? `chat-inline-chip kind-${mention.target.target.kind}` : 'chat-inline-chip person';
        span.textContent = look.label;
        span.contentEditable = 'false';
        // the chip is one thing to assistive technology, named by its whole name
        span.setAttribute('role', 'img');
        span.setAttribute('aria-label', look.title);
        if (look.title !== look.label) span.dataset.tooltip = look.title;
        return span;
    }

    override updateDOM(): boolean {
        return false;
    }

    override decorate(): null {
        return null;
    }

    override isInline(): boolean {
        return true;
    }

    // the caret steps over it; it is never selected on its own
    override isKeyboardSelectable(): boolean {
        return false;
    }

    override getTextContent(): string {
        return this.__look.label;
    }

    getMention(): ComposerMention {
        return this.getLatest().__mention;
    }
}

const $isMentionNode = (node: LexicalNode | null | undefined): node is MentionNode => node instanceof MentionNode;

/** The editor's text as lines of text and mentions (paragraphs and line breaks both end a line). */
function $readLines(): ComposerLine[] {
    const lines: ComposerPiece[][] = [];
    for (const block of $getRoot().getChildren()) {
        let line: ComposerPiece[] = [];
        lines.push(line);
        if (!$isElementNode(block)) continue;
        for (const node of block.getChildren()) {
            if ($isLineBreakNode(node)) lines.push((line = []));
            else if ($isMentionNode(node)) line.push(node.getMention());
            else if ($isTextNode(node)) {
                const last = line.at(-1);
                if (last?.kind === 'text') line[line.length - 1] = { kind: 'text', text: last.text + node.getTextContent() };
                else line.push({ kind: 'text', text: node.getTextContent() });
            }
        }
    }
    return lines.length > 0 ? lines : [[]];
}

/** Replaces the editor's text with `lines`, a paragraph each. */
function $writeLines(lines: readonly ComposerLine[], look: (mention: ComposerMention) => MentionLook): void {
    const root = $getRoot();
    root.clear();
    for (const line of lines) {
        const p = $createParagraphNode();
        for (const piece of line) p.append(piece.kind === 'text' ? $createTextNode(piece.text) : new MentionNode(piece, look(piece)));
        root.append(p);
    }
}

/** The field's height, in rows of its line height (`styles.css`). */
const rowsStyle = (rows: number): CSSProperties & { '--composer-rows': number } => ({ '--composer-rows': rows });

/** The `#query` or `@query` the caret is in, and where: the text node and the caret's offset in it. */
export interface EditorQuery extends MentionQuery {
    readonly node: NodeKey;
    readonly end: number;
}

/** The query at a collapsed caret in a text, if any (a mention is its own node, so a query never spans one). */
function $queryAtCaret(): EditorQuery | undefined {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return undefined;
    const node = selection.anchor.getNode();
    if (!$isTextNode(node)) return undefined;
    const end = selection.anchor.offset;
    const query = mentionQuery(node.getTextContent(), end);
    return query && { ...query, node: node.getKey(), end };
}

/** What the composer does with its text field. */
export interface ComposerEditorApi {
    /** Puts the focus in the text, the caret at its end. */
    focusEnd(): void;
    /** Writes `mention` over `query` (its sign to the caret), a space after it, the caret after that. */
    pick(query: EditorQuery, mention: ComposerMention): void;
}

export function ComposerEditor(props: {
    value: ComposerValue;
    onChange: (value: ComposerValue) => void;
    /** How a mention reads in the text. */
    look: (mention: ComposerMention) => MentionLook;
    /** The `#` or `@` query at the caret (unchanged while an IME composes). */
    onQuery: (query: EditorQuery | undefined) => void;
    /** A key before the editor handles it: true when the composer took it (the editor then ignores it). */
    onKeyDown: (e: KeyboardEvent) => boolean;
    onFocus: FocusEventHandler<HTMLDivElement>;
    onBlur: FocusEventHandler<HTMLDivElement>;
    placeholder: string;
    /** The field's height, in rows of its text. */
    rows: number;
    /** The field's element (measured by the resizer). */
    input: RefObject<HTMLElement | null>;
    api: RefObject<ComposerEditorApi | null>;
}): ReactNode {
    const { value, input, api } = props;
    const [editor] = useState<LexicalEditor>(() =>
        createEditor({
            namespace: 'domaintrail-composer',
            nodes: [MentionNode],
            theme: { paragraph: 'chat-input-line' },
            onError: (e) => console.error(e),
        }),
    );
    // the callbacks as last rendered, for the editor's listeners registered once
    const latest = useRef(props);
    useLayoutEffect(() => {
        latest.current = props;
    });
    // the value as last known (the editor's own edits are known before React renders them) and the text the editor holds
    const known = useRef(value);
    const held = useRef<string | undefined>(undefined);

    const attach = useCallback(
        (el: HTMLDivElement | null) => {
            editor.setRootElement(el);
            input.current = el;
        },
        [editor, input],
    );

    useEffect(() => {
        const off = [
            registerPlainText(editor),
            registerHistory(editor, createEmptyHistoryState(), 300),
            editor.registerCommand(
                KEY_DOWN_COMMAND,
                (e) => {
                    if (!latest.current.onKeyDown(e)) return false;
                    e.preventDefault();
                    return true;
                },
                COMMAND_PRIORITY_HIGH,
            ),
            editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
                const composing = editor.isComposing();
                if (!tags.has(LOAD_TAG) && (dirtyElements.size > 0 || dirtyLeaves.size > 0)) {
                    const next = composerValue(known.current, editorState.read($readLines));
                    // past the limit: the edit is undone (the text as it was, not a step of the history), once this
                    // update is through (an editor state set from its listener is not applied)
                    if (!composing && next.text.length > MAX_TEXT && next.text.length > known.current.text.length) {
                        setTimeout(() => editor.setEditorState(prevEditorState, { tag: HISTORIC_TAG }));
                        return;
                    }
                    if (next.text !== known.current.text || next.chips !== known.current.chips || next.people !== known.current.people) {
                        known.current = next;
                        held.current = next.text;
                        latest.current.onChange(next);
                    }
                }
                // the candidates do not follow a text being composed
                if (!composing) latest.current.onQuery(editorState.read($queryAtCaret));
            }),
        ];
        return () => off.forEach((f) => f());
    }, [editor]);

    // a value changed from outside: read into the editor again (its history starts anew)
    useLayoutEffect(() => {
        known.current = value;
        if (value.text === held.current) return;
        held.current = value.text;
        const root = editor.getRootElement();
        const focused = root !== null && root.contains(document.activeElement);
        editor.update(
            () => {
                $writeLines(composerLines(value), latest.current.look);
                if (focused) $getRoot().selectEnd();
            },
            { tag: LOAD_TAG, discrete: true },
        );
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    }, [editor, value]);

    useLayoutEffect(() => {
        api.current = {
            focusEnd: () => {
                editor.update(() => $getRoot().selectEnd(), { discrete: true });
                editor.focus();
            },
            pick: (query, mention) => {
                editor.update(
                    () => {
                        const node = $getNodeByKey(query.node);
                        if (!$isTextNode(node)) return;
                        const at = $createRangeSelection();
                        at.anchor.set(node.getKey(), query.start, 'text');
                        at.focus.set(node.getKey(), Math.min(query.end, node.getTextContentSize()), 'text');
                        $setSelection(at);
                        at.insertNodes([new MentionNode(mention, latest.current.look(mention)), $createTextNode(' ')]);
                    },
                    { discrete: true },
                );
                editor.focus();
            },
        };
        return () => {
            api.current = null;
        };
    }, [editor, api]);

    return (
        <div className="chat-input-box">
            <div
                ref={attach}
                className="session-text chat-input"
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-multiline
                aria-label={props.placeholder}
                aria-placeholder={props.placeholder}
                style={rowsStyle(props.rows)}
                onFocus={props.onFocus}
                onBlur={props.onBlur}
            />
            {value.text === '' && (
                <div className="chat-input-placeholder" aria-hidden>
                    {props.placeholder}
                </div>
            )}
        </div>
    );
}
