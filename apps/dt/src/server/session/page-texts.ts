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
export type JoinError = 'invalidName' | 'sessionFull' | 'sessionNotOpen';

export type PageMessage =
    | 'signInRequired'
    | 'signInThroughAccess'
    | 'formMethod'
    | 'formMediaType'
    | 'formTooLarge'
    | 'linkMethod'
    | 'linkIncomplete'
    | 'linkNotValid'
    | 'notFound';

export interface PageTexts {
    readonly join: {
        readonly title: string;
        readonly heading: string;
        readonly name: string;
        readonly submit: string;
        readonly errors: Readonly<Record<JoinError, string>>;
    };
    readonly backToSession: string;
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
        },
    },
    backToSession: 'Back to the session',
    messages: {
        signInRequired: { title: 'Sign in required', message: 'Open this session through its Cloudflare Access URL to sign in.' },
        signInThroughAccess: { title: 'Not found', message: 'Participants of this session sign in through Cloudflare Access.' },
        formMethod: { title: 'Method not allowed', message: 'Use the form.' },
        formMediaType: { title: 'Unsupported form', message: 'Use the form.' },
        formTooLarge: { title: 'Form too large', message: 'The form is larger than this session accepts.' },
        linkMethod: { title: 'Method not allowed', message: 'Open the link.' },
        linkIncomplete: { title: 'Not a facilitator link', message: 'The link is incomplete.' },
        linkNotValid: { title: 'Link not valid', message: 'This facilitator link was used already or has expired. Ask for a new one (dt session link).' },
        notFound: { title: 'Not found', message: 'No such page.' },
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
        },
    },
    backToSession: 'セッションに戻る',
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
            message: 'このファシリテーターのリンクは使用済みか、期限が切れています。新しいリンクをもらってください（dt session link）。',
        },
        notFound: { title: 'ページがありません', message: 'このページはありません。' },
    },
};

export const PAGE_TEXTS: Readonly<Record<PageLanguage, PageTexts>> = { en, ja };
