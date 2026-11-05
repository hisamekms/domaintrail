// A Markdown text as the page shows it — an answer of the AI in the chat (ADR 0030), an item of the knowledge in the
// Live View and on the Worker's page (ADR 0031): its Markdown (`markdown.ts`) as React elements, never as HTML, its runs
// of text through the caller's `renderText` (which shows the element references in them as links). One heading style
// for every level, or none (`headings: 'paragraph'`: a knowledge item has its title for a heading, so its text's
// headings are ordinary paragraphs, their `#` dropped); a code block and a table wider than the column scroll inside it. An attached image
// (`![alt](image:<id>)`) is drawn from where the page's `MarkdownImages` resolves its id, bounded by the column; without
// a resolver (the chat, for now) it stays text, as other images do. The container gives `.markdown` its blocks' spacing.
import { createContext, Fragment, useContext, type ReactNode } from 'react';
import { parseMarkdown, type Align, type Block, type Inline, type MdList } from './markdown';

/** A run of text as the caller shows it: its element references (`@{…}`) as links. */
export type RenderText = (text: string) => ReactNode;

/** Where an attached image (`image:<id>`) is shown from; undefined where the page has none (it stays text). */
export const MarkdownImages = createContext<((id: string) => string) | undefined>(undefined);

/** A code span's text that is exactly one element reference (`@{…}`), spaces around it aside. */
const ONE_REFERENCE = /^\s*@\{[^{}\n]+\}\s*$/;

function Inlines({ content, renderText }: { content: readonly Inline[]; renderText: RenderText }): ReactNode {
    const imageUrl = useContext(MarkdownImages);
    return content.map((n, i) => {
        switch (n.kind) {
            case 'text':
                return <Fragment key={i}>{renderText(n.text)}</Fragment>;
            case 'code':
                // a code span that is one element reference and nothing else is the reference: the AI often puts its
                // references in backticks, and a reference is meant to be read as the element's name
                return ONE_REFERENCE.test(n.text) ? <Fragment key={i}>{renderText(n.text.trim())}</Fragment> : <code key={i}>{n.text}</code>;
            case 'image':
                return imageUrl ? (
                    <img key={i} className="md-image" src={imageUrl(n.id)} alt={n.alt} loading="lazy" />
                ) : (
                    <Fragment key={i}>{renderText(n.alt === '' || n.alt === n.url ? n.url : `${n.alt} (${n.url})`)}</Fragment>
                );
            case 'strong':
                return (
                    <strong key={i}>
                        <Inlines content={n.children} renderText={renderText} />
                    </strong>
                );
            case 'em':
                return (
                    <em key={i}>
                        <Inlines content={n.children} renderText={renderText} />
                    </em>
                );
        }
    });
}

function List({ list, renderText }: { list: MdList; renderText: RenderText }): ReactNode {
    const items = list.items.map((item, i) => (
        <li key={i}>
            <Inlines content={item.content} renderText={renderText} />
            {item.children && <List list={item.children} renderText={renderText} />}
        </li>
    ));
    return list.ordered ? <ol {...(list.start !== 1 && { start: list.start })}>{items}</ol> : <ul>{items}</ul>;
}

const alignStyle = (a: Align): { textAlign: 'center' | 'right' } | undefined => (a === 'center' || a === 'right' ? { textAlign: a } : undefined);

/** How a heading is drawn: as one heading style (the chat), or as an ordinary paragraph of its text (a knowledge item). */
export type MarkdownHeadings = 'heading' | 'paragraph';

function MdBlock({ block, renderText, headings }: { block: Block; renderText: RenderText; headings: MarkdownHeadings }): ReactNode {
    switch (block.kind) {
        case 'heading':
            if (headings === 'paragraph')
                return (
                    <p>
                        <Inlines content={block.content} renderText={renderText} />
                    </p>
                );
            return (
                <p className="md-heading" role="heading" aria-level={4}>
                    <Inlines content={block.content} renderText={renderText} />
                </p>
            );
        case 'paragraph':
            return (
                <p>
                    <Inlines content={block.content} renderText={renderText} />
                </p>
            );
        case 'list':
            return <List list={block} renderText={renderText} />;
        case 'code':
            return (
                <pre className="md-code">
                    <code>{block.text}</code>
                </pre>
            );
        case 'table':
            return (
                <div className="md-table">
                    <table>
                        <thead>
                            <tr>
                                {block.head.map((cell, k) => (
                                    <th key={k} style={alignStyle(block.align[k])}>
                                        <Inlines content={cell} renderText={renderText} />
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        {block.rows.length > 0 && (
                            <tbody>
                                {block.rows.map((row, r) => (
                                    <tr key={r}>
                                        {row.map((cell, k) => (
                                            <td key={k} style={alignStyle(block.align[k])}>
                                                <Inlines content={cell} renderText={renderText} />
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        )}
                    </table>
                </div>
            );
    }
}

/** The text as Markdown, its blocks one under the other; its headings as `headings` says (one heading style by default). */
export function MarkdownText({ text, renderText, headings = 'heading' }: { text: string; renderText: RenderText; headings?: MarkdownHeadings }): ReactNode {
    return parseMarkdown(text).map((block, i) => <MdBlock key={i} block={block} renderText={renderText} headings={headings} />);
}
