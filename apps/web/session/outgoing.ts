// What the composer sends: a message (`POST /api/session/requests`) and a `/` command started
// (`POST /api/session/interviews`), each with where the page was looking (`viewedAt`), so that the AI knows what "here"
// is.
import type { SendRequestBody, StartInterviewBody } from '@domaintrail/collaboration/protocol';
import type { ComposerValue } from './mentions';
import { replyTargetOf, type ReplyDraft } from './replies';
import type { SentView } from './views';

/** A message of the composer's value: its chips as targets seen in `revision`, what it replies to, whom it mentions, the view. */
export function messageBody(input: {
    readonly value: ComposerValue;
    readonly revision: string;
    readonly reply?: ReplyDraft;
    readonly viewedAt?: SentView;
}): SendRequestBody {
    const { value, revision, reply, viewedAt } = input;
    return {
        targets: value.chips.map((c) => ({ ...c.target, sourceRevision: revision })),
        body: value.text,
        ...(reply && { replyTo: replyTargetOf(reply) }),
        ...(value.people.length > 0 && { mentions: value.people }),
        ...(viewedAt && { viewedAt }),
    };
}

/** A `/` command started: its opening text, the UI language, the element selected and the view. */
export function interviewBody(input: StartInterviewBody): StartInterviewBody {
    const { command, body, language, focus, viewedAt } = input;
    return { command, body, language, ...(focus && { focus }), ...(viewedAt && { viewedAt }) };
}
