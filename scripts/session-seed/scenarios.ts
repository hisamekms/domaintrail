// The scenarios of the session seed: each one plays, through the session API, the display patterns of one part of the
// chat — messages, runs, questions, assumptions, replies, reactions, element references — about examples/shop's model
// (注文, 請求書, 支払い, 返品), so that the targets and the agent's `@{…}` references resolve. Each one is self-contained
// (its own messages, runs and source files); `all` plays every one, in order, into one timeline.
import type { Ctx, RunJson } from './seed.js';
import { editFile, writeSource } from './workspace.js';

export const SCENARIO_NAMES = ['chat', 'runs', 'questions', 'assumptions', 'replies', 'reactions', 'references'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** A text longer than the stream shows at once (clamped, with "more"). */
const LONG_MESSAGE = [
    '#請求書[1] まわりで、経理チームから聞いた要望をまとめます。長くなりますがすみません。',
    '',
    '1. 請求書は注文が確定したときに発行されるが、確定から発行までの間に注文が取り消されることがある。そのときは発行しないでほしい。',
    '2. 支払いは基本的にカードだが、法人のお客さまは銀行振込が多い。振込の場合、入金の確認に2〜3営業日かかるので、その間は「入金確認中」のような状態が欲しい。',
    '3. #支払済み[2] になったあとで返品があった場合、返金は請求書ではなく返品の側で扱う、という理解で合っているか確認したい。',
    '4. #支払う[3] のときに入金額が請求金額と違うケース（振込手数料を差し引かれる等）がたまにある。今は手作業で調整している。',
    '5. 月末締めでまとめて請求したいお客さまもいる（いわゆる合算請求）。これは今回の範囲外でもよいが、将来の拡張として頭に入れておきたい。',
    '',
    'どれも急ぎではありませんが、1と2は次のリリースまでに入れたいとのことでした。優先度の相談は @ooyama_F[p1] さんにお願いします。',
].join('\n');

const chat = async (s: Ctx): Promise<void> => {
    await s.say('sato', 'おはようございます。今日は注文と返品まわりを詰めましょう 🙌', { reads: 'chat' });
    // the same person twice in a row: the second message continues the first
    await s.say('sato', 'まずは注文の状態遷移から見ていきたいです', { reads: 'chat' });
    // people mentioned: `@name[pN]` is the N-th of `mentions`; the one mentioned sees the message marked, and `@` on the launcher
    await s.say('tanaka', '@鈴木[p1] さん @高橋[p2] さん、返品の流れはあとで一緒に見ませんか', { mentions: ['suzuki', 'takahashi'], reads: 'chat' });
    const shipped = await s.say('suzuki', '#注文[1] に「出荷済み」の状態を足してください。確定のあと倉庫から出荷するまでを追いたいです。', {
        targets: [s.dt('Sales.Order', '注文')],
        reads: 'request',
    });
    await s.say('tanaka', '#返品が依頼された[1] の前に、顧客が返品理由を選ぶ操作が要りそうです。#受け付けた返品[2] の流れで見ると分かりやすいです', {
        targets: [s.es('Returns', 'ReturnRequested', '返品が依頼された'), s.occurrence('Returns', 'Accepted', 'ReturnRequested', '0', '受け付けた返品')],
        reads: 'unsure',
    });
    await s.say('takahashi', LONG_MESSAGE, {
        targets: [s.dt('Billing.Invoice', '請求書'), s.dt('Billing.Invoice#Paid', '支払済み'), s.dt('Billing.Invoice:pay', '支払う')],
        mentions: ['facilitator'],
        reads: 'request',
    });
    // the facilitator's own messages: 「あなた」 for whoever holds the facilitator's role
    await s.say('facilitator', 'ありがとうございます。#注文[1] の件から反映していきます', { targets: [s.dt('Sales.Order', '注文')], reads: 'chat' });
    await s.say('facilitator', '残りは順番に見ていきます。ちなみに請求書の再発行ってモデルにありましたっけ？', { reads: 'unsure' });
    // targets that the run below renames and removes: they read as stale afterwards
    const renamed = await s.say(
        'suzuki',
        '#備考変更[1] はほかのイベントと揃えて OrderNoteChanged にしてください。#RefundAndOrder[2] は Sales の返金依頼と同じものと決まったので消してください',
        { targets: [s.dt('Sales.NoteChanged', '備考変更'), s.es('Returns', 'RefundAndOrder', 'RefundAndOrder')], reads: 'request' },
    );
    await s.apply([shipped], {
        kind: 'reply',
        edit: async (root) => {
            await editFile(root, 'sales/order.dt', /( {4}command addItem\()/, '    /// 確定した注文を倉庫から出荷した。\n    state Shipped "出荷済み"\n\n$1');
            await editFile(root, 'sales/order.dt', /( {4}command cancel\(reason)/, '    command ship() "出荷する"\n      Confirmed -> Shipped\n\n$1');
        },
        reply: {
            outcome: 'done',
            title: '注文の出荷',
            summary: '@{Sales.Order} に @{Sales.Order#Shipped} と、確定済みから出荷済みにする @{Sales.Order:ship} を足しました。',
            requests: [{ request: 1, status: 'done' }],
        },
    });
    await s.apply([renamed], {
        kind: 'reply',
        edit: async (root) => {
            await editFile(root, 'sales/order.dt', /\bNoteChanged\b/g, 'OrderNoteChanged');
            await editFile(root, 'stormings/returns.dtes', /^ {2}hotspot RefundAndOrder .*\n/m, '');
        },
        reply: {
            outcome: 'done',
            title: 'イベント名の統一',
            summary: '@{Sales.NoteChanged} を @{Sales.OrderNoteChanged} に改名し、返品のストーミングからホットスポット RefundAndOrder を消しました。',
            requests: [{ request: 1, status: 'done' }],
        },
    });
    // a body as written before `#` named elements: `@name[n]` still reads as target n
    await s.say('sato', 'ありがとうございます！@出荷済み[1] が見えるようになりました', { targets: [s.dt('Sales.Order#Shipped', '出荷済み')], reads: 'chat' });
    // an element and people in one message
    await s.say('suzuki', '#出荷済み[1] のあとの返品は @田中[p1] さんの担当ですね。@ooyama_F[p2] さん、次はそこを見ましょう', {
        targets: [s.dt('Sales.Order#Shipped', '出荷済み')],
        mentions: ['tanaka', 'facilitator'],
        reads: 'chat',
    });
};

const runs = async (s: Ctx): Promise<void> => {
    // completed with changes, then applied again with a note: one card, two runs. Their replies have no title, as
    // replies from before titles: the card is named by its first message instead
    const failed = await s.say('sato', '#請求書[1] に、決済サービスで支払いに失敗したときのイベントを追加してください', {
        targets: [s.dt('Billing.Invoice', '請求書')],
        reads: 'request',
    });
    const event = (reason: boolean): string =>
        [
            'context Billing {',
            ...(reason
                ? ['  enum PaymentFailureReason "支払失敗の理由" { InsufficientFunds "残高不足" CardExpired "カード期限切れ" Other "その他" }', '']
                : []),
            '  /// 決済サービスが支払いを受け付けなかった。',
            '  event PaymentFailed "支払失敗" {',
            '    invoiceId: InvoiceId',
            ...(reason ? ['    reason: PaymentFailureReason'] : []),
            '  }',
            '}',
            '',
        ].join('\n');
    await s.apply([failed], {
        kind: 'reply',
        edit: (root) => writeSource(root, 'billing/payment-failed.dt', event(false)),
        reply: { outcome: 'done', summary: '@{Billing.PaymentFailed} を追加しました。請求書IDを持ちます。', requests: [{ request: 1, status: 'done' }] },
    });
    await s.apply(
        [failed],
        {
            kind: 'reply',
            edit: (root) => writeSource(root, 'billing/payment-failed.dt', event(true)),
            reply: {
                outcome: 'done',
                summary: '@{Billing.PaymentFailed} に理由（@{Billing.PaymentFailureReason}）を足しました。',
                requests: [{ request: 1, status: 'done' }],
            },
        },
        { note: '失敗の理由（残高不足・カード期限切れなど）も持たせてください' },
    );

    // completed without changes
    const confirm = await s.say('suzuki', '#注文を確定する[1] に「明細が1件以上」の条件が入っているか確認してください', {
        targets: [s.dt('Sales.Order:confirm', '注文を確定する')],
        reads: 'request',
    });
    await s.apply([confirm], {
        kind: 'reply',
        reply: {
            outcome: 'done',
            title: '注文確定の条件の確認',
            summary: 'すでに @{Sales.Order:confirm} に requires hasItems（明細が1件以上）があります。変更はしていません。',
            requests: [{ request: 1, status: 'done', note: '確認のみ' }],
        },
    });

    // failed: the agent exits non-zero (with its report), and an agent that cannot run at all
    const rebuild = await s.say('tanaka', '返品のストーミングを、受付・検品・返金の3つのタイムラインに作り直してください', { reads: 'request' });
    await s.apply([rebuild], { kind: 'exit', exitCode: 1 });
    const recommend = await s.say('takahashi', '#顧客[1] の購買履歴から、おすすめ商品を出す仕組みもモデルにしてください', {
        targets: [s.dt('Sales.Customer', '顧客')],
        reads: 'request',
    });
    await s.apply([recommend], { kind: 'crash' });

    // declined, with the agent's reason
    const erase = await s.say('sato', '#顧客[1] の個人情報を、本人確認なしで一括削除できるコマンドを足してください', {
        targets: [s.dt('Sales.Customer', '顧客')],
        reads: 'request',
    });
    await s.apply([erase], {
        kind: 'reply',
        reply: {
            outcome: 'declined',
            title: '顧客データの一括削除',
            summary:
                '本人確認なしの一括削除は、誤操作や成りすましで顧客データを失うおそれがあるため行いません。削除の手順と確認の方法を決めてから依頼してください。',
            requests: [{ request: 1, status: 'skipped', note: '本人確認の方法が決まっていないため' }],
        },
    });

    // cancelled while the agent works on it
    const screens = await s.say('suzuki', '請求書の一覧画面と検索条件も設計してください', { reads: 'request' });
    await s.cancelWhileRunning([screens]);

    // several requests in one run: a status line per request
    const ship = await s.say('sato', '注文の発送をイベントにしてください', { reads: 'request' });
    const method = await s.say('tanaka', '配送方法（通常・お急ぎ便）を選べるようにしてください。お急ぎ便の料金も', { reads: 'request' });
    const tracking = await s.say('takahashi', '配送業者の追跡番号も持たせてください', { reads: 'request' });
    await s.apply([ship, method, tracking], {
        kind: 'reply',
        edit: (root) =>
            writeSource(
                root,
                'sales/shipping.dt',
                [
                    'context Sales {',
                    '  enum ShippingMethod "配送方法" { Standard "通常配送" Express "お急ぎ便" }',
                    '',
                    '  /// 注文の商品を配送業者に引き渡した。',
                    '  event OrderShipped "注文発送" {',
                    '    orderId: OrderId',
                    '    method: ShippingMethod',
                    '  }',
                    '}',
                    '',
                ].join('\n'),
            ),
        reply: {
            outcome: 'done',
            title: '出荷イベントと配送方法',
            summary: '@{Sales.OrderShipped} と @{Sales.ShippingMethod} を追加しました。',
            requests: [
                { request: 1, status: 'done' },
                { request: 2, status: 'partial', note: '配送方法は足しましたが、お急ぎ便の料金は料金表が決まっていないため入れていません' },
                { request: 3, status: 'skipped', note: '追跡番号は配送業者のシステムの範囲として見送りました' },
            ],
        },
    });
};

const questions = async (s: Ctx): Promise<void> => {
    // a single-choice question, votes open
    const due = await s.say('suzuki', '#請求書[1] に支払期限を持たせたいです', { targets: [s.dt('Billing.Invoice', '請求書')], reads: 'request' });
    const dueRun = await s.apply([due], {
        kind: 'reply',
        reply: {
            outcome: 'clarification',
            title: '請求書の支払期限',
            summary: '支払期限の決め方を確認させてください。',
            requests: [{ request: 1, status: 'question' }],
            questions: [
                {
                    id: 'due',
                    text: '支払期限は何で決めますか？',
                    requests: [1],
                    multiple: false,
                    options: [
                        { id: 'days30', label: '発行から30日', detail: 'すべての請求書で同じ期限' },
                        { id: 'monthEnd', label: '翌月末' },
                        { id: 'perCustomer', label: '顧客ごとに設定', detail: '@{Sales.Customer} に締め日と支払サイトを持たせる' },
                    ],
                },
            ],
        },
    });
    await s.voteOption('sato', dueRun, 'due', 'days30');
    await s.voteOption('tanaka', dueRun, 'due', 'monthEnd');
    await s.voteOption('takahashi', dueRun, 'due', 'days30');

    // a multiple-choice question, votes open
    const methods = await s.say('tanaka', '請求書の支払方法を選べるようにしてください', { reads: 'request' });
    const methodsRun = await s.apply([methods], {
        kind: 'reply',
        reply: {
            outcome: 'clarification',
            title: '扱う支払方法',
            summary: 'どの支払方法を扱うか教えてください。',
            requests: [{ request: 1, status: 'question' }],
            questions: [
                {
                    id: 'methods',
                    text: '扱う支払方法をすべて選んでください。',
                    requests: [1],
                    multiple: true,
                    options: [
                        { id: 'card', label: 'クレジットカード' },
                        { id: 'bank', label: '銀行振込' },
                        { id: 'konbini', label: 'コンビニ払い' },
                        { id: 'cod', label: '代金引換', detail: '配送業者が集金する' },
                    ],
                },
            ],
        },
    });
    await s.voteOption('sato', methodsRun, 'methods', 'card');
    await s.voteOption('sato', methodsRun, 'methods', 'bank');
    await s.voteOption('suzuki', methodsRun, 'methods', 'card');
    await s.voteOption('takahashi', methodsRun, 'methods', 'card');
    await s.voteOption('takahashi', methodsRun, 'methods', 'konbini');

    // two questions, one answered in words only
    const returned = await s.say('takahashi', '#返金した[1] とき、元の請求書をどう扱うかもモデルに入れてください', {
        targets: [s.es('Returns', 'RefundPaid', '返金した')],
        reads: 'request',
    });
    const returnedRun = await s.apply([returned], {
        kind: 'reply',
        reply: {
            outcome: 'clarification',
            title: '返品と請求書の関係',
            summary: '返品と請求書の関係について2点確認させてください。',
            requests: [{ request: 1, status: 'question' }],
            questions: [
                {
                    id: 'credit',
                    text: '返品のとき、元の請求書はどうしますか？',
                    requests: [1],
                    multiple: false,
                    options: [
                        { id: 'cancel', label: '請求書を取り消す' },
                        { id: 'creditNote', label: '赤伝（マイナスの請求書）を発行する' },
                    ],
                },
                { id: 'partial', text: '一部の明細だけを返品することはありますか？あれば例を教えてください。', requests: [1], multiple: false, options: [] },
            ],
        },
    });
    await s.voteOption('sato', returnedRun, 'credit', 'creditNote');
    await s.voteOption('suzuki', returnedRun, 'credit', 'cancel');

    // answered: an option chosen, and その他 in the facilitator's own words; the answer's run completes the card
    const pay = await s.say('sato', '#支払う[1] とき、入金額が請求金額と違う場合も扱いたいです', {
        targets: [s.dt('Billing.Invoice:pay', '支払う')],
        reads: 'request',
    });
    const payRun = await s.apply([pay], {
        kind: 'reply',
        reply: {
            outcome: 'clarification',
            title: '入金額の差の扱い',
            summary: '入金額が違うときの扱いを確認させてください。',
            requests: [{ request: 1, status: 'question' }],
            questions: [
                {
                    id: 'diff',
                    text: '入金額が請求金額に足りないときは？',
                    requests: [1],
                    multiple: false,
                    options: [
                        { id: 'reject', label: '受け付けない' },
                        { id: 'partialPay', label: '一部入金として残額を残す' },
                    ],
                },
                {
                    id: 'tolerance',
                    text: '誤差として認める差額はありますか？',
                    requests: [1],
                    multiple: false,
                    options: [
                        { id: 'none', label: '誤差は認めない' },
                        { id: 'yen100', label: '100円まで認める' },
                    ],
                },
            ],
        },
    });
    await s.voteOption('suzuki', payRun, 'diff', 'partialPay');
    await s.voteOption('tanaka', payRun, 'diff', 'reject');
    await s.voteOption('takahashi', payRun, 'diff', 'partialPay');
    await s.voteOption('suzuki', payRun, 'tolerance', 'yen100');
    await s.answer(
        payRun,
        {
            answers: [
                { question: 'diff', options: ['partialPay'] },
                { question: 'tolerance', options: [], text: '振込手数料分（最大880円）までは誤差として認める' },
            ],
        },
        {
            kind: 'reply',
            edit: (root) =>
                writeSource(
                    root,
                    'billing/partial-payment.dt',
                    [
                        'context Billing {',
                        '  /// 請求金額に満たない入金。残額は請求書に残る。',
                        '  event PartiallyPaid "一部入金" {',
                        '    invoiceId: InvoiceId',
                        '    paidAmount: Money "入金額"',
                        '    remaining: Money "残額"',
                        '  }',
                        '',
                        '  /// 振込手数料分（最大880円）までの差額は誤差として認める。',
                        '  primitive PaymentTolerance "入金の許容差額": Int { value in 0..880 }',
                        '}',
                        '',
                    ].join('\n'),
                ),
            reply: {
                outcome: 'done',
                title: '一部入金と許容差額',
                summary: '@{Billing.PartiallyPaid} と、許容差額 @{Billing.PaymentTolerance}（0〜880円）を追加しました。',
                requests: [{ request: 1, status: 'done' }],
            },
        },
    );

    // taken over: the same message queued again with a note, not an answer; its votes stay as they were
    const defect = await s.say('suzuki', '#商品を検品した[1] で不良が見つかったときの流れも足してください', {
        targets: [s.es('Returns', 'ItemInspected', '商品を検品した')],
        reads: 'request',
    });
    const defectRun = await s.apply([defect], {
        kind: 'reply',
        reply: {
            outcome: 'clarification',
            title: '検品で不良が見つかったとき',
            summary: '不良が見つかったあとの対応を確認させてください。',
            requests: [{ request: 1, status: 'question' }],
            questions: [
                {
                    id: 'after',
                    text: '不良が見つかったらどうしますか？',
                    requests: [1],
                    multiple: false,
                    options: [
                        { id: 'repair', label: '修理して返送する' },
                        { id: 'refund', label: '返金する' },
                        { id: 'exchange', label: '交換品を送る' },
                    ],
                },
            ],
        },
    });
    await s.voteOption('sato', defectRun, 'after', 'refund');
    await s.voteOption('tanaka', defectRun, 'after', 'exchange');
    await s.voteOption('takahashi', defectRun, 'after', 'refund');
    await s.apply(
        [defect],
        {
            kind: 'reply',
            edit: (root) => editFile(root, 'stormings/returns.dtes', /^( {2}event ItemDisposed .*\n)/m, '$1  event DefectFound "不良が見つかった"\n'),
            reply: {
                outcome: 'done',
                title: '不良の発見',
                summary: '@{es:Returns/DefectFound} を追加しました。その後の対応はまだ入れていません。',
                requests: [{ request: 1, status: 'done' }],
            },
        },
        { note: '質問はいったん置いて、まず「不良が見つかった」イベントだけ足してください' },
    );
};

const assumptions = async (s: Ctx): Promise<void> => {
    // assumptions with alternatives, votes open (for an alternative, and for keeping it)
    const cancel = await s.say('tanaka', '#注文を取り消す[1] とき、請求書も取り消されるようにしてください', {
        targets: [s.dt('Sales.Order:cancel', '注文を取り消す')],
        reads: 'request',
    });
    const cancelRun = await s.apply([cancel], {
        kind: 'reply',
        edit: (root) =>
            writeSource(
                root,
                'billing/cancel-invoice.dt',
                [
                    'context Billing {',
                    '  /// 注文の取消に合わせて、未払いの請求書を取り消した。',
                    '  event InvoiceCancelled "請求書取消" {',
                    '    invoiceId: InvoiceId',
                    '    reason: Sales.CancelReason',
                    '  }',
                    '}',
                    '',
                ].join('\n'),
            ),
        reply: {
            outcome: 'done',
            title: '注文取消と請求書の取消',
            summary: '@{Billing.InvoiceCancelled} を追加しました。',
            requests: [{ request: 1, status: 'done' }],
            assumptions: [
                {
                    text: '取消の対象は未払い（@{Billing.Invoice#Open}）の請求書だけと考えました。',
                    requests: [1],
                    alternatives: [
                        { id: 'paidToo', label: '支払済みも取り消して返金する' },
                        { id: 'manual', label: '経理が手で取り消す' },
                    ],
                },
                {
                    text: '取消の理由は注文の取消理由（@{Sales.CancelReason}）をそのまま使います。',
                    requests: [1],
                    alternatives: [{ id: 'own', label: '請求側で独自の理由を持つ' }],
                },
            ],
        },
    });
    await s.voteAssumption('sato', cancelRun, 0, 'paidToo');
    await s.voteAssumption('suzuki', cancelRun, 0);
    await s.voteAssumption('takahashi', cancelRun, 0, 'paidToo');
    await s.voteAssumption('tanaka', cancelRun, 1, 'own');
    await s.voteAssumption('sato', cancelRun, 1);

    // an alternative picked: the run that redoes it continues the card (the pick's time links to it)
    const amount = await s.say('suzuki', '#請求書を発行する[1] とき、請求金額を注文の合計から計算するようにしてください', {
        targets: [s.dt('Billing.Invoice:issue', '請求書を発行する')],
        reads: 'request',
    });
    const rounding = (mode: string): string =>
        [
            'context Billing {',
            '  /// 請求金額の端数の扱い。',
            '  enum Rounding "端数処理" { Floor "切り捨て" HalfUp "四捨五入" }',
            '',
            `  /// 請求金額の計算に使う端数処理: ${mode}。`,
            '  primitive TaxIncludedAmount "税込金額": Int { value >= 0 }',
            '}',
            '',
        ].join('\n');
    const amountRun = await s.apply([amount], {
        kind: 'reply',
        edit: (root) => writeSource(root, 'billing/amount.dt', rounding('切り捨て')),
        reply: {
            outcome: 'done',
            title: '請求金額の端数処理',
            summary: '@{Billing.Rounding} と @{Billing.TaxIncludedAmount} を追加しました。',
            requests: [{ request: 1, status: 'done' }],
            assumptions: [
                {
                    text: '請求金額は税込みとし、端数は切り捨てとしました。',
                    requests: [1],
                    alternatives: [
                        { id: 'halfUp', label: '端数は四捨五入' },
                        { id: 'ceil', label: '端数は切り上げ' },
                    ],
                },
            ],
        },
    });
    await s.voteAssumption('sato', amountRun, 0, 'halfUp');
    await s.voteAssumption('tanaka', amountRun, 0, 'halfUp');
    await s.voteAssumption('takahashi', amountRun, 0, 'ceil');
    await s.pickAlternative(amountRun, 0, 'halfUp', {
        kind: 'reply',
        edit: (root) => writeSource(root, 'billing/amount.dt', rounding('四捨五入')),
        reply: {
            outcome: 'done',
            title: '四捨五入への変更',
            summary: '端数を四捨五入（@{Billing.Rounding}）に変えました。',
            requests: [{ request: 1, status: 'done' }],
        },
    });

    // the assumption left as it was: the message applied again with a note of the facilitator's own
    const address = await s.say('takahashi', '#顧客[1] ごとに請求先の住所を持たせてください', { targets: [s.dt('Sales.Customer', '顧客')], reads: 'request' });
    const addressRun = await s.apply([address], {
        kind: 'reply',
        edit: (root) =>
            writeSource(
                root,
                'sales/billing-address.dt',
                ['context Sales {', '  /// 郵便番号。', '  primitive PostalCode "郵便番号": String { matches(value, "^\\d{3}-?\\d{4}$") }', '}', ''].join('\n'),
            ),
        reply: {
            outcome: 'done',
            title: '請求先の郵便番号',
            summary: '請求先の住所のために @{Sales.PostalCode} を追加しました。',
            requests: [{ request: 1, status: 'done' }],
            assumptions: [{ text: '請求先は顧客につき1つと考えました。', requests: [1], alternatives: [{ id: 'many', label: '複数の請求先から選ぶ' }] }],
        },
    });
    await s.voteAssumption('sato', addressRun, 0);
    await s.voteAssumption('suzuki', addressRun, 0, 'many');
    await s.apply(
        [address],
        {
            kind: 'reply',
            edit: (root) =>
                writeSource(
                    root,
                    'sales/billing-address.dt',
                    [
                        'context Sales {',
                        '  /// ハイフンなし7桁の郵便番号。',
                        '  primitive PostalCode "郵便番号": String { matches(value, "^\\d{7}$") }',
                        '}',
                        '',
                    ].join('\n'),
                ),
            reply: {
                outcome: 'done',
                title: '郵便番号の形式',
                summary: '@{Sales.PostalCode} をハイフンなしの7桁にしました。',
                requests: [{ request: 1, status: 'done' }],
            },
        },
        { note: '前提はこのままで、郵便番号はハイフンなしの7桁にしてください' },
    );
};

const replies = async (s: Ctx): Promise<void> => {
    const reissue = await s.say('sato', '#請求書[1] の再発行を扱えるようにしてください', { targets: [s.dt('Billing.Invoice', '請求書')], reads: 'request' });
    const event = (fields: readonly string[], reasons: boolean): string =>
        [
            'context Billing {',
            ...(reasons ? ['  enum ReissueReason "再発行の理由" { WrongAddressee "宛名の誤り" Lost "紛失" }', ''] : []),
            '  /// 請求書を同じ内容で発行し直した。',
            '  event InvoiceReissued "請求書再発行" {',
            '    invoiceId: InvoiceId',
            ...fields.map((f) => `    ${f}`),
            '  }',
            '}',
            '',
        ].join('\n');
    const first = await s.apply([reissue], {
        kind: 'reply',
        edit: (root) => writeSource(root, 'billing/reissue.dt', event([], false)),
        reply: { outcome: 'done', title: '請求書の再発行', summary: '@{Billing.InvoiceReissued} を追加しました。', requests: [{ request: 1, status: 'done' }] },
    });
    // two replies to the completed run, applied together: their run continues the card
    const count = await s.say('suzuki', 'イベント名は「請求書再発行」で分かりやすいです。再発行の回数も持たせたいです', { replyTo: first, reads: 'request' });
    const reason = await s.say('tanaka', '再発行の理由（宛名の誤り・紛失）も残したいです', { replyTo: first, reads: 'request' });
    const second = await s.apply([count, reason], {
        kind: 'reply',
        edit: (root) => writeSource(root, 'billing/reissue.dt', event(['reason: ReissueReason', 'count: Int "再発行の回数"'], true)),
        reply: {
            outcome: 'done',
            title: '再発行の回数と理由',
            summary: '@{Billing.InvoiceReissued} に回数と理由（@{Billing.ReissueReason}）を足しました。',
            requests: [
                { request: 1, status: 'done' },
                { request: 2, status: 'done' },
            ],
        },
    });
    // a reply to the reply's run
    await s.say('takahashi', '理由が選べるのは良いですね。経理チームにも共有しておきます 👍', { replyTo: second, reads: 'chat' });
};

const reactions = async (s: Ctx): Promise<void> => {
    const wrap = await s.say('sato', '今日の議論はいったんここまでにしましょうか', { reads: 'chat' });
    const diagram = await s.say('suzuki', '#請求書[1] の状態遷移、図で見るとすっきりしてますね', {
        targets: [s.dt('Billing.Invoice', '請求書')],
        reads: 'chat',
    });
    const receipt = await s.say('tanaka', '#支払完了[1] のあとに領収書を発行するイベントも欲しいです', {
        targets: [s.dt('Billing.InvoicePaid', '支払完了')],
        reads: 'request',
    });
    const run = await s.apply([receipt], {
        kind: 'reply',
        edit: (root) =>
            writeSource(
                root,
                'billing/receipt.dt',
                [
                    'context Billing {',
                    '  /// 支払いのあとに領収書を発行した。',
                    '  event ReceiptIssued "領収書発行" {',
                    '    invoiceId: InvoiceId',
                    '  }',
                    '}',
                    '',
                ].join('\n'),
            ),
        reply: { outcome: 'done', title: '領収書の発行', summary: '@{Billing.ReceiptIssued} を追加しました。', requests: [{ request: 1, status: 'done' }] },
    });
    // one emoji by many, mine (the facilitator's) among them
    for (const who of ['sato', 'suzuki', 'tanaka', 'facilitator'] as const) await s.react(who, wrap, '👍');
    await s.react('takahashi', wrap, '🙏');
    await s.react('suzuki', diagram, '❤️');
    await s.react('tanaka', diagram, '👀');
    await s.react('facilitator', diagram, '😂');
    // on the AI's turn
    for (const who of ['sato', 'suzuki', 'tanaka', 'takahashi', 'facilitator'] as const) await s.react(who, run, '🎉');
    await s.react('takahashi', run, '👏');
    await s.react('facilitator', run, '✅');
    // nineteen different emoji on one message: one short of the limit (20)
    const many = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '🔥', '💯', '✅', '🤔', '😮', '👏', '🙌', '💡', '⭐', '🚀', '😅', '🍣', '☕'];
    const who = ['sato', 'suzuki', 'tanaka', 'takahashi', 'facilitator'] as const;
    for (const [i, emoji] of many.entries()) await s.react(who[i % who.length], receipt, emoji);
    await s.react('suzuki', receipt, '🔥');
    await s.react('facilitator', receipt, '👍');
};

const references = async (s: Ctx): Promise<void> => {
    const flow = await s.say('suzuki', '注文から入金までの流れで、関係する要素を挙げて説明してください', {
        targets: [s.es('OrderToCash', 'Invoice', '請求書')],
        reads: 'request',
    });
    await s.apply([flow], {
        kind: 'reply',
        reply: {
            outcome: 'done',
            title: '注文から入金までの流れ',
            summary:
                '@{Sales.Order} が @{Sales.Order#Confirmed} になると @{Billing.Invoice} が発行され（@{es:OrderToCash/InvoiceIssued}）、@{Billing.Invoice:pay} で @{Billing.InvoicePaid} になります。',
            requests: [
                { request: 1, status: 'done', note: '取消は @{Sales.Order:cancel}、返金は @{Sales.RefundRequested} と @{es:Returns/RefundPaid} です。' },
            ],
            assumptions: [
                {
                    text: '\\@{…} は参照ではなく文字どおりの表記です。@{Sales.Shipment} と @{es:Returns/Exchange} はまだモデルにありません。',
                    requests: [1],
                    alternatives: [{ id: 'add', label: '@{Sales.Shipment} を追加する' }],
                },
            ],
        },
    });
    const where = await s.say('tanaka', '支払期限はどこに持たせるのがよいですか？', { reads: 'request' });
    await s.apply([where], {
        kind: 'reply',
        reply: {
            outcome: 'clarification',
            title: '支払期限の持たせ先',
            summary: '持たせる先を選んでください。',
            requests: [{ request: 1, status: 'question' }],
            questions: [
                {
                    id: 'owner',
                    text: '支払期限は @{Sales.Order} と @{Billing.Invoice} のどちらに持たせますか？',
                    requests: [1],
                    multiple: false,
                    options: [
                        { id: 'order', label: '@{Sales.Order}', detail: '@{Sales.Order#Confirmed} のときに決まる' },
                        {
                            id: 'invoice',
                            label: '@{Billing.Invoice}',
                            detail: '@{Billing.Invoice:issue} のときに決まり、@{Billing.Invoice#Open} の間だけ変えられる',
                        },
                    ],
                },
            ],
        },
    });
};

export const SCENARIOS: Record<ScenarioName, (s: Ctx) => Promise<void>> = { chat, runs, questions, assumptions, replies, reactions, references };

const isScenario = (name: string): name is ScenarioName => (SCENARIO_NAMES as readonly string[]).includes(name);

/** The scenarios named on the command line (`all`: every one, in order). */
export function scenariosOf(names: readonly string[]): ScenarioName[] {
    const out: ScenarioName[] = [];
    for (const name of names
        .flatMap((n) => n.split(','))
        .map((n) => n.trim())
        .filter(Boolean)) {
        if (name === 'all') out.push(...SCENARIO_NAMES);
        else if (isScenario(name)) out.push(name);
        else throw new Error(`Unknown scenario ${name}: one of ${SCENARIO_NAMES.join(', ')}, or all`);
    }
    return [...new Set(out)];
}

export type { RunJson };
