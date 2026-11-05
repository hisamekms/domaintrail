// An item's text as the knowledge's panels show it (ADR 0031, sections 2 and 10), in the Live View and on the Worker's
// page: opened, as Markdown with the chat's rules (`shared/markdown-text.tsx`), its attached images drawn from the
// page's knowledge API (dt's route in the Live View, the Worker's on its page); closed, plain, its marks dropped and its
// images left out, for the two lines of a row. Its element references name the stickies as the canvas does (the
// panels' `label`); opened, a sticky's reference is a link that selects it (`select`), on either page. A reference to
// anything else (a `.dt` element, a storming) is named as the chat names it where the page has a model, never a link.
import { Fragment, type ReactElement, type ReactNode } from 'react';
import { useTargetNaming } from '../session/naming';
import { parseReplyText, referenceText, type ReplySegment } from '../session/references';
import type { NamingContext } from '../session/targets';
import { markdownPlain } from '../shared/markdown';
import { MarkdownImages, MarkdownText } from '../shared/markdown-text';
import { useKnowledgeApi } from './api';
import { useKnowledgeView, type KnowledgeView } from './useKnowledge';

type Ref = Extract<ReplySegment, { kind: 'ref' }>;

/** The sticky (`<Storming>.<LocalId>`) a reference names: a storming element's, by its own ID (the last of a path). */
export function stickyOfReference(ref: Ref): string | undefined {
    if (ref.target.kind !== 'DtesElement') return undefined;
    const local = ref.target.local.split('/').at(-1) ?? ref.target.local;
    return `${ref.target.storming}.${local}`;
}

/** Text with its references by their names; a sticky's a link when `links`. */
function References({
    text,
    links,
    view,
    naming,
}: {
    text: string;
    links: boolean;
    view: KnowledgeView | undefined;
    naming: NamingContext | undefined;
}): ReactNode {
    return parseReplyText(text).map((seg, i) => {
        if (seg.kind === 'text') return <Fragment key={i}>{seg.text}</Fragment>;
        const sticky = stickyOfReference(seg);
        if (sticky === undefined) return <Fragment key={i}>{referenceText(seg, naming).text}</Fragment>;
        const name = view?.label(sticky) ?? referenceText(seg, naming).text;
        if (!links || !view) return <Fragment key={i}>{name}</Fragment>;
        return (
            <a
                key={i}
                className="reply-element"
                onClick={(e) => {
                    // the text is in the item's head, which closes it
                    e.stopPropagation();
                    view.select(sticky);
                }}
            >
                {name}
            </a>
        );
    });
}

/** An opened item's text: Markdown, its stickies linked, its images drawn. */
export function KnowledgeMarkdown({ text }: { text: string }): ReactElement {
    const view = useKnowledgeView();
    const naming = useTargetNaming();
    const api = useKnowledgeApi();
    return (
        <MarkdownImages.Provider value={(id) => api.imageUrl(id)}>
            <MarkdownText text={text} renderText={(t) => <References text={t} links view={view} naming={naming} />} />
        </MarkdownImages.Provider>
    );
}

/** A closed item's text: plain, its marks dropped, its stickies named. */
export function KnowledgePlain({ text }: { text: string }): ReactElement {
    const view = useKnowledgeView();
    const naming = useTargetNaming();
    return <References text={markdownPlain(text)} links={false} view={view} naming={naming} />;
}
