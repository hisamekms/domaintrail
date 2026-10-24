import { Check, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Diagnostic } from '../src/core/diagnostics';
import type { DomainModel, Location } from '../src/model/model';
import { highlight, type Token } from './highlight';
import { useT } from './i18n';

/** A position in the sources to show: a declaration range, or a single line (e.g. a syntax error). */
export interface SourceFocus {
    file: string;
    line: number;
    endLine?: number;
}

export interface SourceRange extends Location {
    id: string;
}

/** Declaration ranges of every element, state and command. */
export function declarationRanges(model: DomainModel | null): SourceRange[] {
    if (!model) return [];
    const out: SourceRange[] = [];
    for (const el of Object.values(model.elements)) {
        out.push({ id: el.id, ...el.location });
        for (const s of el.states ?? []) out.push({ id: s.id, ...s.location });
        for (const c of el.commands ?? []) out.push({ id: c.id, ...c.location });
    }
    return out;
}

export function locationOf(model: DomainModel | null, id: string): Location | undefined {
    return declarationRanges(model).find((r) => r.id === id);
}

/** The original text of the lines `line`..`endLine` (1-based, inclusive). */
export function linesOf(text: string, range: { line: number; endLine?: number }): string {
    return text
        .split(/\r?\n/)
        .slice(range.line - 1, range.endLine ?? range.line)
        .join('\n');
}

/** Copies the source of the highlighted range, keeping the click from selecting the line underneath. */
function CopyCode({ text }: { text: string }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    return (
        <button
            className="icon-button src-copy"
            data-tooltip={t.copyCode}
            aria-label={t.copyCode}
            onClick={async (e) => {
                e.stopPropagation();
                try {
                    await navigator.clipboard.writeText(text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                } catch {
                    // clipboard unavailable (insecure context, permissions)
                }
            }}
        >
            {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
    );
}

export function CodeLines(props: {
    lines: Token[][];
    from: number;
    to: number;
    focus?: { line: number; endLine?: number };
    diagnostics?: Map<number, Diagnostic[]>;
    onLineClick?: (line: number) => void;
    lineRef?: (line: number, el: HTMLDivElement | null) => void;
    /** Shown at the right end of the focus's first line. */
    focusAction?: ReactNode;
}) {
    const rows = [];
    for (let n = props.from; n <= props.to && n <= props.lines.length; n++) {
        const diags = props.diagnostics?.get(n) ?? [];
        const severity = diags.some((d) => d.severity === 'error') ? 'error' : diags.length ? 'warning' : undefined;
        const focused = props.focus && n >= props.focus.line && n <= (props.focus.endLine ?? props.focus.line);
        rows.push(
            <div
                key={n}
                ref={(el) => props.lineRef?.(n, el)}
                className={`src-line${focused ? ' src-focus' : ''}${severity ? ` src-${severity}` : ''}${props.onLineClick ? ' src-clickable' : ''}`}
                onClick={() => props.onLineClick?.(n)}
                title={diags.map((d) => `${d.code}: ${d.message}`).join('\n') || undefined}
            >
                <span className="src-gutter">
                    <span className="src-mark">{severity === 'error' ? '✕' : severity === 'warning' ? '!' : ''}</span>
                    {n}
                </span>
                <span className="src-code">
                    {props.lines[n - 1].map((t, i) => (
                        <span key={i} className={`tok-${t.kind}`}>
                            {t.text}
                        </span>
                    ))}
                    {'\n'}
                </span>
                {n === props.focus?.line && props.focusAction}
            </div>,
        );
    }
    return <pre className="src-code-block">{rows}</pre>;
}

/** Read-only view of one .dt file, linked with the selection and the diagnostics; scrolls to `focus`. */
export function SourceView(props: {
    sources: { path: string; text: string }[];
    diagnostics: Diagnostic[];
    model: DomainModel | null;
    file: string | undefined;
    focus: SourceFocus | undefined;
    onSelect: (elementId: string) => void;
}) {
    const t = useT();
    const file = props.file ?? props.sources[0]?.path;
    const source = props.sources.find((s) => s.path === file);
    const lines = useMemo(() => (source ? highlight(source.text) : []), [source]);
    const rows = useRef(new Map<number, HTMLDivElement>());

    useEffect(() => {
        if (!props.focus || props.focus.file !== file) return;
        rows.current.get(props.focus.line)?.scrollIntoView({ block: 'center' });
    }, [props.focus, file]);

    const byLine = new Map<number, Diagnostic[]>();
    for (const d of props.diagnostics.filter((x) => x.file === file)) {
        for (let l = d.start.line; l <= d.end.line; l++) byLine.set(l, [...(byLine.get(l) ?? []), d]);
    }
    const ranges = declarationRanges(props.model).filter((r) => r.file === file);
    const onLineClick = (line: number) => {
        const hit = ranges.filter((r) => r.line <= line && line <= r.endLine).sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
        if (hit) props.onSelect(hit.id);
    };
    const focus = props.focus?.file === file ? props.focus : undefined;
    const focusText = focus && source ? linesOf(source.text, focus) : undefined;

    if (!source) return <p className="muted pad">{t.noDtFiles}</p>;
    return (
        <div className="source-view">
            <CodeLines
                lines={lines}
                from={1}
                to={lines.length}
                focus={focus}
                focusAction={focusText !== undefined && <CopyCode text={focusText} />}
                diagnostics={byLine}
                onLineClick={onLineClick}
                lineRef={(n, el) => (el ? rows.current.set(n, el) : rows.current.delete(n))}
            />
        </div>
    );
}
