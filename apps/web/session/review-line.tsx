// The review at the end of a run on its card (ADR 0034): one muted block under what the AI says — 見直し, then a line per
// kind dt found (「解決したが付箋はそのまま 1 件 · 直した」, or what is left), what the AI says it fixed (✓) and what it kept
// and why (–). With something left, the facilitator's 見直しを頼む sends a message to the AI that replies to the run.
import { useState, type ReactElement } from 'react';
import { useT } from '../i18n';
import { Act } from '../shared/act';
import { AI_NAME } from './ai';
import { sessionApi } from './api';
import { useChat } from './chat-context';
import { useTargetNaming } from './naming';
import { failure } from './parts';
import { targetLabel } from './proposal-view';
import { ReplyText } from './reply';
import { reviewGroups, reviewRequestBody, type RunReviewJson } from './review';
import { latestRevision } from './state';

export function ReviewLine({ run, review, offer }: { run: string; review: RunReviewJson; offer: boolean }): ReactElement {
    const { tx, session, onNavigate } = useChat();
    const t = tx.chat.review;
    const all = useT();
    const naming = useTargetNaming();
    const [asked, setAsked] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const groups = reviewGroups(review);
    const ask = async (): Promise<void> => {
        const revision = latestRevision(session.state);
        if (!revision) return;
        const label = (sticky: string): string => {
            const dot = sticky.indexOf('.');
            return targetLabel({ kind: 'DtesElement', storming: sticky.slice(0, dot), local: sticky.slice(dot + 1) }, naming, all).name;
        };
        try {
            await sessionApi.sendRequest(reviewRequestBody({ run, review, label, revision: revision.id, aiName: AI_NAME, text: t.askText }));
            setAsked(true);
            setError(undefined);
        } catch (e) {
            setError(failure(e));
        }
    };
    return (
        <div className="run-review" role="group" aria-label={t.title}>
            <span className="run-review-title">{t.title}</span>
            <ul className="run-review-lines">
                {groups.map((g) => (
                    <li key={g.kind} className={g.left === 0 ? 'fixed' : 'left'}>
                        {t.kinds[g.kind]} {t.count(g.found)}
                        <span className="run-review-state"> · {g.left === 0 ? t.fixed : t.left(g.left)}</span>
                    </li>
                ))}
                {review.fixed.map((f, i) => (
                    <li key={`f${i}`} className="said">
                        ✓ <ReplyText text={f} onNavigate={onNavigate} />
                    </li>
                ))}
                {review.kept.map((k, i) => (
                    <li key={`k${i}`} className="said">
                        – <ReplyText text={k.what} onNavigate={onNavigate} />: <ReplyText text={k.why} onNavigate={onNavigate} />
                    </li>
                ))}
            </ul>
            {offer && review.left.length > 0 && (
                <span className="run-review-actions">
                    <Act kind="send" onClick={() => void ask()} disabled={asked}>
                        {asked ? t.asked : t.ask}
                    </Act>
                    {error && <span className="session-error">{error}</span>}
                </span>
            )}
        </div>
    );
}
