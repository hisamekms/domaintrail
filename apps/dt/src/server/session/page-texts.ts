// The texts of the session's server-rendered pages (`pages.ts`), one table per language. The server has no i18n of its
// own: a page's language is picked from the request's `Accept-Language` (`pageLanguage` in `pages.ts`).
import { MAX_NAME } from './input.js';

export type PageLanguage = 'en' | 'ja';

/** A page that only says something: its title (also its heading) and its message. */
export interface PageMessageText {
    readonly title: string;
    readonly message: string;
}

/** Why the join form is shown again. */
export type JoinError = 'invalidName' | 'sessionFull' | 'sessionNotOpen' | 'tooManyPending' | 'rateLimited';

export type PageMessage =
    | 'signInRequired'
    | 'signInThroughAccess'
    | 'formMethod'
    | 'formMediaType'
    | 'formTooLarge'
    | 'linkMethod'
    | 'linkIncomplete'
    | 'linkNotValid'
    | 'notFound'
    | 'useInvite'
    | 'inviteNotValid'
    | 'denied'
    | 'requestExpired'
    | 'sessionFull'
    | 'sessionClosed';

export interface PageTexts {
    readonly join: {
        readonly title: string;
        readonly heading: string;
        readonly name: string;
        readonly submit: string;
        readonly errors: Readonly<Record<JoinError, string>>;
    };
    readonly backToSession: string;
    /** The waiting page of a join request (`link`): its title, also its only words. */
    readonly waiting: string;
    readonly messages: Readonly<Record<PageMessage, PageMessageText>>;
}

const en: PageTexts = {
    join: {
        title: 'Join the session',
        heading: 'Join the DomainTrail session',
        name: 'Your name, as the others will see it',
        submit: 'Join',
        errors: {
            invalidName: `A name of 1 to ${MAX_NAME} characters on one line.`,
            sessionFull: 'The session is full.',
            sessionNotOpen: 'The session is not open.',
            tooManyPending: 'Too many people are waiting to join. Try again in a moment.',
            rateLimited: 'Too many requests. Try again later.',
        },
    },
    backToSession: 'Back to the session',
    waiting: 'Waiting to be let in',
    messages: {
        signInRequired: { title: 'Sign in required', message: 'Open this session through its Cloudflare Access URL to sign in.' },
        signInThroughAccess: { title: 'Not found', message: 'Participants of this session sign in through Cloudflare Access.' },
        formMethod: { title: 'Method not allowed', message: 'Use the form.' },
        formMediaType: { title: 'Unsupported form', message: 'Use the form.' },
        formTooLarge: { title: 'Form too large', message: 'The form is larger than this session accepts.' },
        linkMethod: { title: 'Method not allowed', message: 'Open the link.' },
        linkIncomplete: { title: 'Not a facilitator link', message: 'The link is incomplete.' },
        linkNotValid: { title: 'Link not valid', message: 'This facilitator link was used already or has expired. Ask for a new one (dt collab link).' },
        notFound: { title: 'Not found', message: 'No such page.' },
        useInvite: { title: 'Invite needed', message: 'Join through the invite link the facilitator shared.' },
        inviteNotValid: { title: 'Invite not valid', message: 'This invite link has expired or was stopped. Ask for a new one.' },
        denied: { title: 'Not let in', message: 'The facilitator did not let you in.' },
        requestExpired: { title: 'Request expired', message: 'Nobody let you in in time. Open the invite link again.' },
        sessionFull: { title: 'Session full', message: 'The session is full.' },
        sessionClosed: { title: 'Session not open', message: 'The session is not open.' },
    },
};

const ja: PageTexts = {
    join: {
        title: 'セッションに参加',
        heading: 'DomainTrail のセッションに参加',
        name: 'ほかの参加者に見える名前',
        submit: '参加する',
        errors: {
            invalidName: `名前は1行・${MAX_NAME}文字以内で入力してください。`,
            sessionFull: 'セッションの参加者が上限に達しています。',
            sessionNotOpen: 'セッションは開かれていません。',
            tooManyPending: '参加を待っている人が多すぎます。少し待ってから試してください。',
            rateLimited: 'リクエストが多すぎます。しばらくしてから試してください。',
        },
    },
    backToSession: 'セッションに戻る',
    waiting: '参加の許可を待っています',
    messages: {
        signInRequired: { title: 'サインインが必要です', message: 'Cloudflare Access の URL からこのセッションを開いてサインインしてください。' },
        signInThroughAccess: { title: 'ページがありません', message: 'このセッションには Cloudflare Access でサインインします。' },
        formMethod: { title: 'この操作はできません', message: 'フォームから送ってください。' },
        formMediaType: { title: 'この形式は受け付けません', message: 'フォームから送ってください。' },
        formTooLarge: { title: 'フォームが大きすぎます', message: 'このセッションが受け付ける大きさを超えています。' },
        linkMethod: { title: 'この操作はできません', message: 'リンクを開いてください。' },
        linkIncomplete: { title: 'ファシリテーターのリンクではありません', message: 'リンクが途中で切れています。' },
        linkNotValid: {
            title: 'リンクが無効です',
            message: 'このファシリテーターのリンクは使用済みか、期限が切れています。新しいリンクをもらってください（dt collab link）。',
        },
        notFound: { title: 'ページがありません', message: 'このページはありません。' },
        useInvite: { title: '招待が必要です', message: 'ファシリテーターが共有した招待リンクから参加してください。' },
        inviteNotValid: { title: '招待リンクが無効です', message: 'この招待リンクは期限切れか、止められています。新しいリンクをもらってください。' },
        denied: { title: '参加できませんでした', message: 'ファシリテーターが参加を許可しませんでした。' },
        requestExpired: { title: '期限が切れました', message: '時間内に許可されませんでした。招待リンクをもう一度開いてください。' },
        sessionFull: { title: '参加できませんでした', message: 'セッションの参加者が上限に達しています。' },
        sessionClosed: { title: 'セッションは開かれていません', message: 'セッションは開かれていません。' },
    },
};

export const PAGE_TEXTS: Readonly<Record<PageLanguage, PageTexts>> = { en, ja };
