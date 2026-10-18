import { ChevronDown, ChevronUp } from 'lucide-react';

/**
 * Key for the edges of the canvas views; every edge points from the dependent to its dependency. Closed, it leaves a
 * flat tab on the bottom edge of the canvas that opens it.
 */
export function Legend({ view, open, onToggle }: { view: 'contextMap' | 'structure' | 'focus' | 'states'; open: boolean; onToggle: () => void }) {
    const rows =
        view === 'contextMap'
            ? [
                  { kind: 'references', text: 'ID だけで依存（ID 参照の件数）' },
                  { kind: 'dependsOn', text: '型も借りて依存（型の借用の件数）' },
              ]
            : view === 'focus'
              ? [
                    { kind: 'owns', text: '所有（集約の内部）' },
                    { kind: 'references', text: '参照（ID で別の集約・BC へ）' },
                    { kind: 'value', text: '値・型の借用（Value Object / Union / Enum など）' },
                ]
              : view === 'structure'
                ? [
                      { kind: 'owns', text: '所有（集約の内部）' },
                      { kind: 'references', text: '参照（ID で別の集約へ）' },
                      { kind: 'value', text: '値（Value Object / Union を持つ）' },
                  ]
                : [{ kind: 'transition', text: 'Command による遷移（⇒ 発生させる Event）' }];
    return (
        <>
            <div className={`legend${open ? '' : ' legend-closed'}`} inert={!open}>
                <div className="legend-title">
                    凡例
                    <button className="icon-button" onClick={onToggle} title="凡例を閉じる" aria-label="凡例を閉じる">
                        <ChevronDown size={14} aria-hidden />
                    </button>
                </div>
                {rows.map((r) => (
                    <div key={r.kind} className="legend-row">
                        <svg width="56" height="14" className={`de de-${r.kind}`} aria-hidden>
                            <path d="M4,7 L42,7" className="de-line" />
                            {r.kind === 'owns' && <path d="M2,7 L9,3.5 L16,7 L9,10.5 Z" className="de-head de-diamond" />}
                            <path d="M54,7 L41,0.5 L41,13.5 Z" className="de-head" />
                        </svg>
                        <span>{r.text}</span>
                    </div>
                ))}
                {view === 'focus' && <div className="legend-note">点線枠の小さな箱は別の BC の要素（スタブ）</div>}
                <div className="legend-note">矢印の先が依存先</div>
            </div>
            <button className={`legend-tab${open ? '' : ' shown'}`} inert={open} onClick={onToggle} title="凡例を開く" aria-label="凡例を開く">
                <ChevronUp size={14} aria-hidden />
            </button>
        </>
    );
}
