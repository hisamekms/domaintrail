# はじめに

[English](getting-started.md)

このページでは、DomainTrail が何かを知るところから、AI エージェントがドメインモデルとコードを書き、人がそのモデルを
ブラウザでレビューする、という一巡を動かすところまでを案内します。人に向けたページです。エージェントが読むリファレンス
（必要なときに人も引けます）はガイドで、ターミナルの `dt guide` と [guide.md](guide.md) は同じ内容です。

DomainTrail はドメインモデルを書くための言語（`.dt` ファイル）と、その CLI `dt` です。モデルにはドメインの**構造と
契約**——境界づけられたコンテキスト、集約とその状態、要件とイベントを持つコマンド、不変条件——を書き、モデルがそれらの
唯一の正となります。`dt check` がモデルを検査し、`dt view` がブラウザにライブで表示し、`dt generate ts` が
TypeScript の型・コマンドの契約・不変条件のチェック・実装のための契約テストを生成します。ビジネスロジックは生成しません。
ロジックは生成された型に対して人（またはエージェント）が書き、コンパイラとテストがそれをモデルに沿わせます。

## AI エージェントと進める

DomainTrail はこの使い方を前提にしています。とにかく始めたいなら、インストールし（`npm i -D domaintrail`、
[インストール](#インストール)を参照）、下のブロックをエージェントの指示ファイルに加え、`npx dt view` を起動して、
エージェントに何かをモデリングするよう頼んでください。このページの残りは、エージェントがすることを手で追っていくので、
エージェントの作業を理解しながら見守れるようになります。

### 役割分担

- **エージェント**は `.dt` ファイルを編集し、モデルが通るまで `dt fmt` と `dt check` を回します。そのあと TypeScript
  を生成してコマンドを実装し、コンパイラ・リンター・生成された契約テストが通るまで続けます。
- **人**はエージェントの作業中、Live View でモデルを見ます。構造、状態と遷移、各コマンドが何を要件とし何を発生させるか。
  レビューのために `.dt` ファイルや生成コードを読む必要はありません。フィードバックはモデルについて伝え、`.dt`
  ファイルを変えるのはエージェントです。
- **モデル**は人とエージェントが合意する場所です。実装とモデルが食い違ったら、まずモデルを変え、コードはそれに従います。

### エージェントへの指示

エージェントが毎回セッションの最初に読むファイル——Claude Code なら `CLAUDE.md`、それを読むエージェントなら
`AGENTS.md`——に次のブロックを入れ、パスとスクリプトをプロジェクトに合わせてください（このページの構成に合わせて
あります）。`dt guide` もエラーメッセージも英語なので、ブロックも英語のままにしています。

```markdown
## Domain model (DomainTrail)

The domain model is in `domain/**/*.dt` (DomainTrail DSL). It is the single source of truth for the domain's
structure and contracts; `generated/domain` is generated from it.

- Before working on the model, run `npx dt guide` and read it. Run `npx dt guide <topic>` (e.g. `npx dt guide requires`)
  for the details of what you are about to write.
- After every change to `.dt` files, run `npx dt fmt`, then `npx dt check` until it reports 0 errors.
- Then run `npx dt generate ts`, implement each command with `decide` against its generated
  `<Command><Aggregate>Decision` type, and run `npm run typecheck`, `npm run lint` and `npm test` (the generated
  contract tests) until they pass.
- Never edit generated files: change the `.dt` sources and generate again.
- When the contract and the implementation disagree, follow `@see` on the generated type to the declaration and
  change the DSL, not the implementation: never emit an event or set a field only to satisfy the types. Say what you
  changed in the model and why.
- Never cast to a domain type (`as X`): make values with `make<Name>`, `parseDecimal` or a verified type's factory.
- To look up one element, run `npx dt show <name>` (e.g. `npx dt show Booking.Reservation.confirm`) instead of reading
  the `.dt` files. Use `--format json` with `check`, `generate ts` and `show` when you parse the output.
- People watch the model in the Live View (`npx dt view`). Do not wait for it: it runs until stopped.
- After upgrading domaintrail, read the Upgrading steps in `node_modules/domaintrail/CHANGELOG.md` of every version
  since the previous one, and follow them.
```

`dt guide` は 1 画面ほどのクイックリファレンス（作業の流れ、DSL の概要、コマンド）とトピックの一覧を表示します。
エージェントはガイド全体ではなく、必要になったトピックだけを読みます。`dt --help` もエージェントにここを案内します。

### セッションの始め方

自分のターミナルで Live View を起動し、ブラウザで開きます。

```bash
npx dt view
```

そのうえで、ドメインの言葉で一歩ずつ頼みます。コードに進む前、`.dt` ファイルを書いたところで止めてもらうと、
モデルをレビューしやすくなります。

- 「会議室予約をモデリングして。予約は部屋と時間帯を指定して申し込まれ、部屋が人数に足りれば確定する。今は `.dt`
  ファイルだけでいい。」
- 「Reservation にコマンド `cancel` を追加して。申込み中でも確定済みでも、理由を添えて取り消せる。」
- 「モデルはこれでいい。TypeScript を生成して Booking のコマンドを実装し、契約テストを通して。」

Live View は保存のたびに追従します。追加・変更された要素は強調され、削除された要素は薄く残り、エージェントが直している
あいだのモデルの問題は画面下部に並びます。

### Live View からのフィードバック

話題にしたい要素を左のエクスプローラーか図で選び、右のインスペクターで見ます。フィールドと不変条件（構造）、
その集約の状態と遷移（状態遷移）、コマンドの要件・変更・発生させるイベント（振る舞い）、使っている箇所（参照）、
ソース（ソース）。ソースタブでは、強調された宣言のコピーボタンでそのコードをコピーできます。それを会話に貼って何を
変えたいかを書くか、要素の名前（`Reservation.confirm`。ヘッダーの 名前 / 両方 の切り替えでラベルの横に名前が出ます）
で伝えます。

> `command confirm(capacity: Headcount, at: Timestamp) "確定する"` — 誰が確定したかも記録したい。

エージェントは `dt show`（と、それが宣言ごとに出す `// file:line`）で宣言を見つけてモデルを変え、`dt check` を通し、
人は Live View で変化を確かめます。エージェントが「実装がモデルに従えない」——いつも発生させられるとは限らない
イベント、決して返せないエラー——と言ってきたら、話し合って変えるのはモデルであり、生成された型ではありません。

### エージェント向けの道具

- `dt show <name>` は要素・状態・コマンドを 1 つ、解決した形で表示します。フィールドセットのフィールドは展開され、
  ラベルとその出どころ、各コマンドの遷移と要件、結果ごとに設定・引き継ぎ・破棄されるフィールド、イベントとエラー、
  そしてその要素を使っている箇所が出ます。コンテキスト内で一意なら、名前のコンテキスト部分は省けます。
- `--format json` を付けると、`check`、`generate ts`、`show` は JSON ドキュメントを 1 つ出力します（診断のスキーマは
  パッケージの `schema/diagnostics.schema.json`）。
- `dt lsp` は言語サーバーです。編集のたびの `dt check` と同じ診断、定義・参照、ホバー、リネーム。Claude Code では
  プラグインを使うと、`.dt` ファイルを編集するたびに Claude が診断を受け取ります（[Claude Code](#claude-code) を参照）。

## インストールと最初のモデル

ここでは、エージェントがするのと同じように、小さなモデルを手で作ります。境界づけられたコンテキスト 1 つに集約 1 つです。

### インストール

Node.js 22.12 以降が必要です。プロジェクトにインストールします。

```bash
npm i -D domaintrail
```

同じコマンドが `dt` と `domaintrail`（`dt` が別のコマンドと衝突するとき用）の 2 つの名前で入ります。`npx dt` で
実行するか、package.json のスクリプトから `dt` として呼びます。インストールせずに `npx domaintrail <command>` でも
動きます。

### プロジェクトの設定

プロジェクトのルートに置く `domaintrail.jsonc` で、モデルの場所を `dt` に伝えます。キーはすべて省略可能で、
ファイルがなければカレントディレクトリ以下のすべての `.dt` ファイルがモデルになります。

```jsonc
{
  "$schema": "./node_modules/domaintrail/schema/domaintrail.schema.json",
  "sources": ["domain/**/*.dt"]
}
```

推奨の構成は、境界づけられたコンテキストごとに 1 ディレクトリ、集約ごとに 1 ファイルです。

```text
domaintrail.jsonc
domain/
  booking/
    context.dt           the context's label, description and terms (when it has them)
    reservation.dt       an aggregate, with its ID and what only it uses
generated/domain/        written by dt generate ts: never edited
src/                     your code: the command implementations and the application
```

`dt` にとってファイル名に意味はありません。この構成は、モデルが大きくなっても迷わないための約束事です
（`dt guide layout`）。

### ステップ 1: コンテキスト、ID、集約

`domain/booking/reservation.dt` を作ります。

```dt
// domain/booking/reservation.dt
context Booking "会議室予約" {
  id ReservationId: UUID

  aggregate Reservation "予約" {
    id: ReservationId
  }
}
```

`context` は境界づけられたコンテキストです。`id ReservationId: UUID` は ID 型を宣言し、集約はどれも自分の ID 型の
`id` フィールドを持ちます。名前のあとの文字列はラベル（表示名）で、Live View と生成される JSDoc に表示されます。
言語は問わず、省略もできます。

```bash
npx dt check
```

```text
1 file(s) checked: 0 error(s), 0 warning(s).
```

### ステップ 2: 値と不変条件

予約は、部屋・時間帯・人数に対して行います。

```dt
// domain/booking/reservation.dt
context Booking "会議室予約" {
  id ReservationId: UUID
  id RoomId: UUID
  primitive Headcount "人数": Int { value in 1..50 }
  value Slot "時間帯" {
    start: Timestamp
    hours: Int
    invariant withinDay "1〜8時間" { hours >= 1 and hours <= 8 }
  }

  aggregate Reservation "予約" {
    id: ReservationId
    room: RoomId
    owns slot: Slot
    attendees: Headcount
  }
}
```

- `primitive Headcount: Int { value in 1..50 }` はドメインプリミティブ、つまり制約付きの単一の値です。`Headcount`
  はどこで使われても 1 以上 50 以下です。
- `value Slot` は値オブジェクトで、まとまって意味を持つ値を、全フィールドで比較します。その `invariant` はすべての
  時間帯で成り立ちます。
- `room: RoomId` は部屋を ID だけで参照し、`owns slot: Slot` は値を集約の中に持ちます。

### ステップ 3: 状態、コマンド、イベント

予約はまず申し込まれ、そのあと確定します。集約を作ったり変えたりする手段はコマンドだけです。

```dt
// domain/booking/reservation.dt
context Booking "会議室予約" {
  id ReservationId: UUID
  id RoomId: UUID
  primitive Headcount "人数": Int { value in 1..50 }
  value Slot "時間帯" {
    start: Timestamp
    hours: Int
    invariant withinDay "1〜8時間" { hours >= 1 and hours <= 8 }
  }

  aggregate Reservation "予約" {
    id: ReservationId
    room: RoomId
    owns slot: Slot
    attendees: Headcount

    state Requested "申込み"
    state Confirmed "確定" {
      confirmedAt: Timestamp
    }

    create command request(id: ReservationId, room: RoomId, slot: Slot, attendees: Headcount) "申し込む"
      -> Requested
      emits ReservationRequested
  }

  event ReservationRequested "予約申込み" {
    reservationId: ReservationId
    room: RoomId
    slot: Slot
  }
}
```

- `state Confirmed { confirmedAt: Timestamp }` は自分のフィールドを持つ状態です。予約が `confirmedAt` を持つのは
  確定してからです。
- `create command request(…) -> Requested` は新しい予約を `Requested` 状態で作ります。新しい ID は引数で受け取ります。
  コマンドは純粋関数なので、ID も時刻も外から渡します。
- `emits ReservationRequested` は契約です。コマンドは成功するたびに、そのイベントをちょうど 1 つ発生させます。

### ステップ 4: 要件のあるコマンド

確定には、部屋が人数に足りることが必要です。部屋の定員は別の集約のデータなので、引数で受け取ります。

```dt
// domain/booking/reservation.dt
context Booking "会議室予約" {
  id ReservationId: UUID
  id RoomId: UUID
  primitive Headcount "人数": Int { value in 1..50 }
  value Slot "時間帯" {
    start: Timestamp
    hours: Int
    invariant withinDay "1〜8時間" { hours >= 1 and hours <= 8 }
  }

  aggregate Reservation "予約" {
    id: ReservationId
    room: RoomId
    owns slot: Slot
    attendees: Headcount

    state Requested "申込み"
    state Confirmed "確定" {
      confirmedAt: Timestamp
    }

    create command request(id: ReservationId, room: RoomId, slot: Slot, attendees: Headcount) "申し込む"
      -> Requested
      emits ReservationRequested
    command confirm(capacity: Headcount, at: Timestamp) "確定する"
      Requested -> Confirmed
      requires roomFits "部屋に収まる" { attendees <= capacity } else RoomTooSmall
      emits ReservationConfirmed
  }

  event ReservationRequested "予約申込み" {
    reservationId: ReservationId
    room: RoomId
    slot: Slot
  }
  event ReservationConfirmed "予約確定" {
    reservationId: ReservationId
    confirmedAt: Timestamp
  }
  error RoomTooSmall "部屋が狭い"
}
```

- `Requested -> Confirmed` は遷移です。`confirm` は申込み中の予約を受け取って確定した予約を作り、新しい状態の
  `confirmedAt` を設定します。
- `requires roomFits { attendees <= capacity } else RoomTooSmall`：式が成り立つときだけコマンドは受け付けられ、
  成り立たなければエラー `RoomTooSmall` を返し、イベントは発生させません。
- イベントのフィールドは値の出どころにちなんで名付けます（状態 `Confirmed` の `confirmedAt`）。実装が推測しなくて
  済むようにするためです。

このページのモデルはこれで全部です。言語にはほかに、ユニオン、共有コンテキスト、フィールドセット、`changes`、
条件付きのイベント、検証済み型、ポリシーがあり、`dt guide` で一覧できます。

### うまくいかないとき

`confirm` に `attendee <= capacity` と `emits ReservationConfirm` の 2 つのタイプミスがあったとします。`dt check` は
場所と内容を、ヒントがあればそれも添えて示します。

```text
domain/booking/reservation.dt:28:36 - error M001: Cannot resolve name 'attendee'.
  hint: did you mean 'attendees'?
domain/booking/reservation.dt:29:13 - error M007: Cannot resolve event 'ReservationConfirm' in this context (use Context.Name for other contexts).
  hint: did you mean 'ReservationConfirmed'?
1 file(s) checked: 2 error(s), 0 warning(s).
```

エラーがある間は終了コード 1 で終わります。警告では失敗しません。診断にはルール名が付いていて、`dt guide M001`
でそのルールと、説明しているトピックが出ます。`dt check --format json` は同じ内容を JSON で出力します。

`dt fmt` はすべての `.dt` ファイルを、コメントを保ったまま 1 つの決まったレイアウトに書き直します。差分には変わった
ところだけが出ます。`dt fmt --check` は何も変えず、整形されていないファイルがあれば失敗します（CI 用）。

```text
domain/booking/reservation.dt
1 file(s) checked: 1 not formatted. Run `dt fmt` to format them.
```

### Live View で見る

```bash
npx dt view
```

```text
Config: domaintrail.jsonc
Live View: http://127.0.0.1:4321/
```

表示されたアドレスをブラウザで開きます。Ctrl+C まで動き続けます（ポートは `--port` で変更）。このモデルで見るところ:

- **Structure**（メインのビュー）: コンテキスト `Booking` と `Reservation`、それが持つ値 `Slot`、参照している ID。
- `Reservation` を選び、インスペクターの **状態遷移** へ。`request` が `Requested` の予約を作り、`confirm` が
  `Confirmed` へ進めます。
- `confirm` を選び、**振る舞い** へ。要件 `roomFits`、エラー `RoomTooSmall`、イベントが出ます。
- ファイルを変えて保存すると表示が追従します。わざと壊すと問題が画面下部に出て、最後に正しかった図は残ります。

ペイン、ビュー、設定の詳細は [Live View](live-view.md)（英語）にあります。

## 生成、実装、テスト

### TypeScript を生成する

`domaintrail.jsonc` に `generate` を加えます。`tests` があると、`dt generate ts` は契約テストも書き出します。ここでは
vitest 用です。

```jsonc
{
  "$schema": "./node_modules/domaintrail/schema/domaintrail.schema.json",
  "sources": ["domain/**/*.dt"],
  "generate": {
    "ts": {
      "out": "generated/domain",
      "tests": { "runner": "vitest" } // bun / vitest / jest / node。出力先は generated/domain/tests
    }
  }
}
```

```bash
npx dt generate ts
```

```text
1 file(s) checked: 0 error(s), 0 warning(s).
TypeScript written to generated/domain, generated/domain/tests
hint: no lint rule against casts to domain types found (no-unsafe-type-assertion); see dt guide lint
```

まずモデルを検査し、エラーがあれば何も書き出しません。ヒントは、後述の lint ルールを設定すると消えます。
`generated/domain/Booking.ts` にはコンテキストの型——`Reservation` は `RequestedReservation | ConfirmedReservation`
——、各コマンドの契約、生成されたチェック、ID とドメインプリミティブのコンストラクタが入ります。どの宣言の JSDoc も
`@see domain/booking/reservation.dt:…` で終わり、モデルのどこから来たかを示します。これらのファイルは編集せず、
モデルを変えたら生成し直します（`examples/shop` は `.gitignore` で git の管理外にしています）。

自分のコードに必要なものをインストールし、エージェントへの指示に出てくるスクリプトを `package.json` に加えます。

```bash
npm i -D typescript fast-check vitest oxlint oxlint-tsgolint
```

```json
{
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint --type-aware",
    "test": "vitest run"
  }
}
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "generated"]
}
```

### decide でコマンドを実装する

コマンドは**決定**（decision）として実装します。結果ごとに、設定するフィールド（`set`）と `events` を返すものです。
生成されたランタイムの `decide` がそこから集約を作り、ほかのフィールドは入力から引き継ぎます。コンパイラはすべての
結果を契約と照らし合わせます。イベントの不足、契約にないイベント、コマンドが変えてはいけないフィールドは、名前を挙げた
コンパイルエラーになります。

```ts
// src/reservation-commands.ts
import { Booking, decide, err, ok } from '../generated/domain/index.js';

export const reservationCommands: Booking.ReservationCommands = {
    request: decide<Booking.RequestReservationDecision>(Booking.ReservationShape, (id, room, slot, attendees) =>
        ok({
            Requested: {
                set: { id, room, slot, attendees },
                events: { ReservationRequested: { type: 'ReservationRequested', reservationId: id, room, slot } },
            },
        }),
    ),

    confirm: decide<Booking.ConfirmReservationDecision>(Booking.ReservationShape, {
        Requested: (reservation, capacity, at) => {
            // 要件の式は DSL のものを使う: 生成されたチェックが評価する
            if (Booking.checkConfirmReservationRequires(reservation, capacity, at)) return err({ type: 'RoomTooSmall' });
            return ok({
                Confirmed: {
                    set: { confirmedAt: at },
                    events: { ReservationConfirmed: { type: 'ReservationConfirmed', reservationId: reservation.id, confirmedAt: at } },
                },
            });
        },
    }),
};
```

`confirm` の決定は遷移元の状態ごとにハンドラーを 1 つ持ちます（ここでは `Requested` だけ）。複数の状態で動くコマンドも
同じ形で書けるようにするためです。結果の形は `dt guide decide` で説明しています。

### ドメインの値を作る

ドメインの型はブランド型です。`Headcount` はコンパイラが区別する `number` で、作れるのは `makeHeadcount` だけです。
生成されたコンストラクタで作り、キャストは使いません。

```ts
// src/request.ts
import { Booking } from '../generated/domain/index.js';
import { reservationCommands } from './reservation-commands.js';

/** 素の入力からドメインの値を作り、コマンドを実行する。 */
export function requestReservation(input: { room: string; start: Date; hours: number; attendees: number }) {
    const attendees = Booking.makeHeadcount(input.attendees); // Result: 値か InvalidHeadcount
    if (!attendees.ok) return attendees;
    const slot: Booking.Slot = { start: input.start, hours: input.hours };
    if (Booking.checkSlot(slot).length > 0) throw new Error('a slot is 1 to 8 hours');
    const id = Booking.makeReservationId(crypto.randomUUID()); // ID には不変条件がないので失敗しない
    return reservationCommands.request(id, Booking.makeRoomId(input.room), slot, attendees.value);
}
```

- `make<Name>` はすべての ID とドメインプリミティブにあります。不変条件がある型（`makeHeadcount`）では `Result` を、
  ない型（`makeReservationId`）では値そのものを返します。
- `check<Name>` は値が破っている不変条件を返します（`checkSlot`）。値オブジェクトはただのオブジェクトです。
- `Decimal` はランタイムの `parseDecimal(text)` で作ります（数でない文字列なら `undefined`）。
- ID や時刻をどこから得るかはアプリケーションが決めます。コマンドは受け取るだけです。

### 契約テストをつなぐ

生成されたテストは、型では確かめられないこと、つまり値を検査します。fast-check で入力を生成し、生成されたチェックを
正解として使います。コンストラクタがちょうど正しい値だけを受け付けること、コマンドが成り立たない最初の要件のエラーを
返すこと、コマンドが作った集約がその状態の不変条件を満たすこと、コマンドが純粋であること。テストファイル 1 つで登録します。

```ts
// src/contract.test.ts
import { Booking as Domain } from '../generated/domain/index.js';
import { Booking, register } from '../generated/domain/tests/index.js';
import { reservationCommands } from './reservation-commands.js';

register(
    Booking.contract({
        make: { ReservationId: Domain.makeReservationId, RoomId: Domain.makeRoomId, Headcount: Domain.makeHeadcount },
        Reservation: reservationCommands,
    }),
);
```

```text
$ npx vitest run

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

`"runner": "bun"` なら、同じファイルが `bun test` で動きます（`tsconfig.json` に `"types": ["bun"]` を
加えます）。もし `confirm` が要件の確認を忘れていたら、テストは縮小した反例を添えてそう伝えます。

```text
Got error: Reservation.confirm({"state":"Requested",…,"attendees":2}, 1, new Date("2000-01-01T00:00:00.000Z")) succeeded, but requirement 'roomFits' does not hold: expected the error RoomTooSmall.
```

コマンドの周り——読み込み、保存、イベントの発行——は生成されたテストの範囲外で、自分のテストで確かめます
（`dt guide tests`）。

### キャストを lint で防ぐ

キャスト（`'x' as Booking.RoomId`、`5 as Booking.Headcount`）はコンストラクタを通さずにドメインの値を作るので、
何も検査されません。型を狭めるキャストをリンターに報告させ、生成ディレクトリは対象外にします（ドメインの型を作る側
なので、キャストしています）。

```jsonc
// .oxlintrc.json — `oxlint --type-aware` で実行する
{
  "plugins": ["typescript"],
  "rules": { "typescript/no-unsafe-type-assertion": "error" },
  "ignorePatterns": ["generated/**"]
}
```

```text
src/bad.ts:2:35: error typescript(no-unsafe-type-assertion): Unsafe type assertion: type 'RoomId' is more narrow than the original type. …
```

typescript-eslint では、型情報付きで `@typescript-eslint/no-unsafe-type-assertion` を使います。両方の設定は
`dt guide lint` にあります。正当なキャストはファクトリー（自分で書く `Make<Name>`、検証済み型のファクトリー）の中だけで、
それぞれ理由を書いた無効化コメントを付けます。

### このモデルの先

集約と外の世界をつなぐ機能が 2 つあります。どちらもガイドで説明していて、`examples/shop` で使っています。

**検証済み型**（`dt guide verified`）は、純粋なコマンドにはできない確認——ほかの顧客が使っていないメールアドレス——
をしたことの証拠です。そのファクトリーは自分で書き、型をアサートしてよいのはそこだけです。

```ts
// examples/shop/src/app/verifications.ts
export function verifications(customers: CustomerRepository): Verifications {
    return {
        // `customer` is the one whose email changes, so that keeping one's own address is not "taken"; none on register.
        async makeAvailableEmail(email, customer) {
            const holder = await customers.find((c) => c.email === email && c.id !== customer);
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the check above is the evidence
            return holder ? err({ type: 'EmailTaken', email }) : ok(email as Sales.AvailableEmail);
        },
    };
}
```

**ポリシー**（`dt guide reactions`）は「このイベントが起きたら、いずれあのコマンドが実行される」を表します。その
ハンドラーは自分で書き、イベントからコマンドの入力を計算します。

```ts
// examples/shop/src/app/policies.ts
export function billingPolicies({ loadOrder, newInvoiceId }: PolicyDeps): Billing.BillingPolicyHandlers {
    return {
        // a confirmed order is billed for its total
        BillConfirmedOrder: async (event) => {
            const order = await loadOrder(event.orderId);
            if (order?.state !== 'Confirmed') throw new Error(`order ${event.orderId} is ${order ? order.state : 'not found'}, not Confirmed`);
            return { id: newInvoiceId(), order: order.id, billedAmount: orderTotal(order) };
        },
    };
}
```

### 全体像

[examples/shop](../examples/shop/README.md) は完全なプロジェクトです。3 つのコンテキストのモデル、生成コード、そして
それに対して AI エージェントが書いたコード——コマンド、リポジトリ・イベントストア・コンテキストをまたぐポリシーを
備えた小さなアプリケーション層——に、契約テスト、アプリケーションのテスト、デモが揃っています。README（英語）では、
何をなぜ書いたかと、実装がモデルに従えなかったためにモデルを変えた 2 つの場面を説明しています。

## エディター

エディターの支援は、stdio で動く言語サーバー `dt lsp` が提供します。保存前の内容を含めた `dt check` と同じ診断、
定義へのジャンプ、参照の検索、ホバー、アウトライン、補完、リネーム、整形。ワークスペースは、プロジェクトの
ディレクトリから `dt check` が見つけるものと同じです。

### Zed

[`editors/zed`](../editors/zed) の拡張は `.dt` ファイルをハイライトし、アウトラインを出し、`dt lsp` を起動します。
まだ Zed の拡張レジストリにはないので、このリポジトリをクローンし、*zed: install dev extension* で `editors/zed`
ディレクトリを選んでインストールします。ビルドには rustup で入れた Rust が必要です。言語サーバーは次のうち最初に
見つかったものを使います: Zed の設定の `lsp.domaintrail.binary`、`PATH` 上の `dt`、なければ拡張が固定している
バージョンの domaintrail（拡張自身のディレクトリにインストール）。設定で指定しない限り、プロジェクトの
`node_modules/.bin/dt` は実行しません（`dt guide editors`）。

### Claude Code

Claude Code のプラグインは、プラグインのルートに置いた `.lsp.json` で言語サーバーを宣言できます。プラグインは
`claude --plugin-dir <plugin directory>` で読み込みます。これで Claude は `dt check` を実行しなくても、`.dt`
ファイルを編集するたびに診断を受け取ります。

```json
{
  "domaintrail": {
    "command": "dt",
    "args": ["lsp"],
    "extensionToLanguage": { ".dt": "domaintrail" }
  }
}
```

`dt` が `PATH` 上にあることが前提です。なければ `"command": "npx", "args": ["dt", "lsp"]` にします。

### そのほかのエディター

どの LSP クライアントでも、コマンド `dt lsp`（または `npx dt lsp`）、トランスポート stdio、拡張子 `.dt` で使えます。
VS Code の拡張はまだありませんが、汎用の LSP クライアント拡張からサーバーを起動できます。tree-sitter でハイライトする
エディター（Neovim、Helix、Emacs）は [`tree-sitter-domaintrail`](../tree-sitter-domaintrail) の文法を使えます。

## 次に読むもの

- `dt guide` と [guide.md](guide.md)（英語）: 言語と CLI のリファレンス。トピックごとに読めます。
- [examples/shop](../examples/shop/README.md)（英語）: 実装まで含めた完全な例。
- [Live View](live-view.md)（英語）: `dt view` のすべてのペインとビュー。
- [CHANGELOG.ja.md](../CHANGELOG.ja.md): バージョンごとの変更点と、モデルとコードを更新する手順（アップグレード手順）。パッケージにも
  含まれ、エージェントは更新後にそれを読みます（指示のブロックの最後の項目）。
- [docs/adr](adr): 言語の背後にある設計判断。
