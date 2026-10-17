/** Key for the edges of the canvas views; every edge points from the dependent to its dependency. */
export function Legend({ view }: { view: 'structure' | 'states' }) {
    const rows =
        view === 'structure'
            ? [
                  { kind: 'owns', text: '所有（集約の内部）' },
                  { kind: 'references', text: '参照（ID で別の集約へ）' },
                  { kind: 'value', text: '値（Value Object を持つ）' },
              ]
            : [{ kind: 'transition', text: 'Command による遷移（⇒ 発生させる Event）' }];
    return (
        <div className="legend">
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
            <div className="legend-note">矢印の先が依存先</div>
        </div>
    );
}
