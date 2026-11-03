// An answer of the AI as the chat shows it (ADR 0030): its Markdown (`markdown.ts`) as React elements, never as HTML,
// the element references in its text as links (`ReplyText`). One heading style for every level; a code block and a
// table wider than the column scroll inside it.
import type { ReactNode } from 'react';
import { parseMarkdown, type Align, type Block, type Inline, type MdList } from './markdown';
import { ReplyText } from './reply';
import type { ModelTarget } from './targets';

type Navigate = (target: ModelTarget) => void;

function Inlines({ content, onNavigate }: { content: readonly Inline[]; onNavigate: Navigate }): ReactNode {
    return content.map((n, i) => {
        switch (n.kind) {
            case 'text':
                return <ReplyText key={i} text={n.text} onNavigate={onNavigate} />;
            case 'code':
                return <code key={i}>{n.text}</code>;
            case 'strong':
                return (
                    <strong key={i}>
                        <Inlines content={n.children} onNavigate={onNavigate} />
                    </strong>
                );
            case 'em':
                return (
                    <em key={i}>
                        <Inlines content={n.children} onNavigate={onNavigate} />
                    </em>
                );
        }
    });
}

function List({ list, onNavigate }: { list: MdList; onNavigate: Navigate }): ReactNode {
    const items = list.items.map((item, i) => (
        <li key={i}>
            <Inlines content={item.content} onNavigate={onNavigate} />
            {item.children && <List list={item.children} onNavigate={onNavigate} />}
        </li>
    ));
    return list.ordered ? <ol {...(list.start !== 1 && { start: list.start })}>{items}</ol> : <ul>{items}</ul>;
}

const alignStyle = (a: Align): { textAlign: 'center' | 'right' } | undefined => (a === 'center' || a === 'right' ? { textAlign: a } : undefined);

function MdBlock({ block, onNavigate }: { block: Block; onNavigate: Navigate }): ReactNode {
    switch (block.kind) {
        case 'heading':
            return (
                <p className="chat-md-heading" role="heading" aria-level={4}>
                    <Inlines content={block.content} onNavigate={onNavigate} />
                </p>
            );
        case 'paragraph':
            return (
                <p>
                    <Inlines content={block.content} onNavigate={onNavigate} />
                </p>
            );
        case 'list':
            return <List list={block} onNavigate={onNavigate} />;
        case 'code':
            return (
                <pre className="chat-md-code">
                    <code>{block.text}</code>
                </pre>
            );
        case 'table':
            return (
                <div className="chat-md-table">
                    <table>
                        <thead>
                            <tr>
                                {block.head.map((cell, k) => (
                                    <th key={k} style={alignStyle(block.align[k])}>
                                        <Inlines content={cell} onNavigate={onNavigate} />
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
                                                <Inlines content={cell} onNavigate={onNavigate} />
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

/** The answer's text as Markdown, its blocks one under the other. */
export function MarkdownText({ text, onNavigate }: { text: string; onNavigate: Navigate }): ReactNode {
    return parseMarkdown(text).map((block, i) => <MdBlock key={i} block={block} onNavigate={onNavigate} />);
}
