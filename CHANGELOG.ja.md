# 変更履歴

[English](CHANGELOG.md)

domaintrail の各バージョンの変更点です。形式は [Keep a Changelog](https://keepachangelog.com/ja/) に、バージョン番号は
[セマンティック バージョニング](https://semver.org/lang/ja/) に従います（1.0.0 より前は、マイナーバージョンでもモデルやコードに
影響する変更があります）。

**domaintrail を更新したら**、更新前から更新後までの各バージョンの **Upgrading**（アップグレード手順）を古い順に読み、その手順に
従ってください。このファイルはパッケージに含まれています: `node_modules/domaintrail/CHANGELOG.ja.md`（英語版は
`CHANGELOG.md`）。

## [0.5.0] - 2026-10-24

### Added

- **ポリシー**（`dt guide reactions`、ADR 0022）: `policy P when Event -> Aggregate.command` — イベントが起きたら、
  ポリシーを宣言したコンテキスト自身のコマンドがいずれ実行される、という反応を書けます。M023 がイベント・集約・コマンドを
  検査し、同じ反応の重複を警告します。ポリシーごとに、イベントからコマンドの入力（`<Command><Aggregate>Input`）を作る
  ハンドラの型が生成されます。`generate.ts.policies: "required"`（既定は `"optional"`、`generate.ts.contexts` で
  コンテキストごとにも指定可）にすると `<Context>PolicyHandlers` が生成され、契約テストがそれを受け取り、どのイベントも
  コマンドが受け付ける入力になることを検査します。コンテキストマップはポリシーをイベントによる依存として数えます。
- **検証済み型**（`dt guide verified`、ADR 0023）: `verified X of T for C? errors E` — 集約の外で行った検査（他の誰も
  使っていないメールアドレスなど）の証拠です。作れるのは利用者が書く非同期ファクトリ `Make<Name>` だけで、コマンドは
  それを引数として受け取ります。M024 は検証済み型をコマンドの引数に限ります。
- **ペイロードの名前**（ADR 0021）: イベントやエラーのフィールドが、名前の違う値（引数、そのフィールド、コマンド前後の
  集約のフィールド）から値を取っていそうなときに M022 が警告します。
- **Zed 拡張**（`editors/zed`）と **tree-sitter 文法**（`tree-sitter-domaintrail`）: Zed でのハイライト、アウトライン、
  `dt lsp`。tree-sitter を使う他のエディタ向けの文法（`dt guide editors`）。
- **キャストを防ぐ lint**（`dt guide lint`）: どのドメイン型も `as` を使わずに作る方法と、oxlint または
  typescript-eslint で `no-unsafe-type-assertion` を有効にする方法。oxlint / ESLint の設定がこのルールに触れていないとき、
  `dt generate ts` がヒントを表示します（`--format json` では `hints`）。`"lintHint": false` で止められます。ID、
  ドメインプリミティブ、検証済み型の JSDoc に、それぞれの作り方を書きました。
- 生成されるランタイムに `parseDecimal(text)`: `Decimal` を作る唯一の場所です。
- `dt guide policies`: 変わりうる方針（ポリシー）に依存するルールの書き方。
- `examples/shop` を完全なプロジェクトにしました: すべての集約の実装、アプリケーション層（ユースケース、リポジトリ、
  イベントストア、ポリシー、検証済み型のファクトリ）、テスト、デモ。README で説明しています。
- 言語サーバー: コマンドの名前を変更（リネーム）できます。

### Changed

- ワークスペースのファイルを集めるすべてのコマンド（`check`、`generate`、`view`、`fmt`、`show`、`lsp`）は、
  `.gitignore`（ルート、そのサブディレクトリ、リポジトリの最上位までの親ディレクトリのもの）と `.git/info/exclude` が
  無視するファイルを読み飛ばします。`"respectGitignore": false` で無効にできます。コマンドラインで指定したファイルは
  読み飛ばしません。
- 言語サーバーが設定ファイルを見つけられないとき、設定を持つディレクトリの下で最初に開いた `.dt` ファイルによって、
  その設定がワークスペースになります。

### Fixed

- `Int` や `Decimal` を基にするドメインプリミティブを、`count()` や `length()` が計算する数と比較できるようにしました。

### Upgrading

1. モデルの `.dt` ファイルが `.gitignore` で無視されるディレクトリにあると、ワークスペースに含まれなくなります。
   ファイルを移すか、`domaintrail.jsonc` に `"respectGitignore": false` を書いてください。`dt check` を実行し、
   ファイル数が以前と同じか確かめます。
2. M011: `parseDecimal` はランタイムの名前になりました。その名前の要素がモデルにあれば名前を変えてください。
3. `dt generate ts` を実行します。lint のヒントが出たら `dt guide lint` に従い（または `"lintHint": false`）、
   コード中のドメイン型へのキャストを `make<Name>` / `parseDecimal` に置き換えます。
4. 新しい警告が出ることがあります: M022（イベントやエラーのフィールドを値の出どころに合わせて名前を変えるか、
   出どころの名前をフィールドに合わせる）。警告では `dt check` は失敗しません。

## [0.4.0] - 2026-10-24

### Added

- コマンドの **`requires`**（`dt guide requires`、ADR 0017）: `requires name { expr } else Error` — 式が成り立つときだけ
  コマンドを受け付け、成り立たなければそのエラーを返します（M019）。
- コマンドの **`changes`**（`dt guide changes`、ADR 0019）: コマンドが変更してよいフィールド（M021）。
- **多重度と `when` を持つ `emits`**（`dt guide events`、ADR 0018）: `X?`、`X[0..*]`、`X[1..*]`、`X[n..m]`、
  一部の結果でだけ発生するイベントには `X when Draft ->` / `X when -> Completed`。
- 式の **`unique` と `contains`**、および式を持たず言葉だけで書く不変条件（M018、ADR 0016）。
- **決定（decision）と `decide`**（`dt guide decide`）: 各コマンドは `<Command><Aggregate>Decision` として実装します —
  遷移元の状態ごとに、結果の `set` と `events` を返し、ランタイムの `decide(<Aggregate>Shape, decision)` が集約を
  作ります。足りないイベント、余分なイベント、変更してはいけないフィールドを、コンパイラが名前を挙げて報告します。
- **生成される検査とコンストラクタ**（ADR 0020）: 不変条件と要件の式から `check<Name>` /
  `check<Command><Aggregate>Requires`、すべての ID とドメインプリミティブに `make<Name>`。
- **生成される契約テスト**（`dt guide tests`）: `generate.ts.tests`（`runner`: `bun`、`vitest`、`jest`、`node`。
  `out`）を指定すると、`dt generate ts` がコンテキストごとに fast-check のスイートを書き出し、コンストラクタ、要件、
  各コマンド後の不変条件、イベント、純粋性を検査します。プロジェクトに `fast-check` が必要です。
- **`dt fmt`**: `.dt` ファイルを、コメントを保ったまま一つの正規のレイアウトに整形します（CI 向けに `--check`）。
  LSP の整形にも使われます。
- **`dt show <name>`**: 要素・状態・コマンド・コンテキストを一つ、解決した形で、使っている側とともに表示します
  （`--format json`）。
- **`dt lsp`**: `dt check` の診断、定義へ移動、参照、ホバー、アウトライン、補完、リネームを提供する言語サーバー。
- 診断の**ヒント**（「もしかして …」や、何を変えればよいか）と、`check` と `generate ts` の `--format json`
  （スキーマは `schema/diagnostics.schema.json`）。
- 生成されるすべての宣言に、DSL の位置を指す `@see <file>:<line>`。
- どのコマンドも扱うコード向けのランタイムヘルパー `outcome(value)`（`{ to, aggregate, events }`）と
  `eventList(events)`。
- M020（警告）: 集約の ID 型の引数を持たない `create command`。

### Changed

- **`emits X` は、コマンドが成功したときにちょうど 1 つの `X`** を意味します（以前は「発生させうる」）。エラーのときは
  何も発生させません。
- **コマンドの結果は結果（遷移先）ごとのキーを持つ形**になりました: タプル `[aggregate, events[]]` の代わりに
  `{ Confirmed: { aggregate, events: { OrderConfirmed } } }`。イベントは名前をキーとし、順序を持ちません。イベントの
  ないコマンドは `NoEvents` です。
- コマンドは純粋関数です: ID と時刻は引数として受け取ります（ファクトリは自分の ID を受け取ります）。
- `ok` は契約からだけ型を推論するので、リテラル中の余分なイベントが報告されます。
- `changes` のないコマンドは、共通フィールドを変更しません。
- 生成されるモジュールが値（`<Aggregate>Shape`）をエクスポートします: `import type` ではなく値として import します。
- `dt guide` はクイックリファレンスとトピック一覧を表示します。`dt guide <topic>` で 1 節、`dt guide <rule>` で 1 ルール、
  `dt guide --all` でガイド全体。
- `[0..1]` は `?` と、`[1..1]` は多重度なしと同じ意味になりました。
- Live View は各イベントの多重度と `when`、`requires` と `changes`、問題ペインのヒントを表示します。

### Removed

- `byState` と `<Command><Aggregate>ByState` 型（0.3.0）: すべてのコマンドを `decide` で実装します。

### Upgrading

まずモデルを変え、次に生成し、最後にコードを直します。規則の詳細は `dt guide events`、`dt guide changes`、
`dt guide decide` にあります。

1. **イベント。** `emits X` は、成功するたびにちょうど 1 つの `X` になりました。`emits` の各項目について、そのイベントが
   いつ発生するかを決めて、そのとおりに書きます:

   ```dt
   // 変更前（0.3.0）: 「発生させうる」
   command changeNote(note: String?)
     Draft -> Draft, Confirmed -> Confirmed
     emits NoteChanged
   command cancel(reason: CancelReason)
     Draft | Confirmed -> Cancelled
     emits OrderCancelled, RefundRequested
   // 変更後（0.4.0）
   command changeNote(note: String?)
     Draft -> Draft, Confirmed -> Confirmed
     changes note
     emits NoteChanged?                    // 高々 1 つ。いくつでもなら X[0..*]
   command cancel(reason: CancelReason)
     Draft | Confirmed -> Cancelled
     emits OrderCancelled,
           RefundRequested when Confirmed -> // Confirmed からのときだけ
   ```

2. **ファクトリは ID を、コマンドは時刻を受け取ります。** 各 `create command` に集約の ID 型の引数を加え（加えるまで
   M020 が警告します）、実装が時計を読んでいたところには `Timestamp` の引数を加えます:

   ```dt
   create command place(customer: CustomerId) -> Draft            // 変更前
   create command place(id: OrderId, customer: CustomerId) -> Draft // 変更後
   ```

   ID は呼び出し側が作って（`make<Name>(crypto.randomUUID())`）渡します。
3. **`changes`。** 遷移元と遷移先の状態に共通するフィールド（状態のない集約ではすべてのフィールド）を変更するコマンドに、
   `changes f1, f2` を加えます。書かないと、生成される決定の型がそのフィールドの設定を許しません。
4. **必要なら `requires`。** 何かを変える前にエラーを返す検査は `requires name { expr } else Error` にできます。生成される
   `check<Command><Aggregate>Requires` と契約テストがそれを検査します。
5. **予約された名前（M011）。** `decide`、`Decide`、`Shape`、`NoChanges`、`outcome`、`eventList`、`NoEvents`、
   `Outcome`、`EventOf`、`sameOptional`、`sameList`、`distinct` はランタイムの名前に、`<Command><Aggregate>Decision`、
   `<Aggregate>Shape` は生成される名前になりました: 衝突する要素の名前を変えます。`dt check` が 0 で終わるまで直します。
6. **生成し直し、すべてのコマンドを `decide` で書き直します。** 結果の `set`（`changes` のフィールドと遷移先の状態で
   新しく持つフィールド。ファクトリはすべてのフィールドを設定し、省略可能なものは `undefined`）と `events` を、遷移先の
   状態をキーにして返します（状態のない集約では集約名がキー）。遷移元が一つでも、遷移元の状態ごとにハンドラを書きます。
   ファクトリは一つの関数です:

   ```ts
   // 変更前（0.3.0）
   import { byState, ok, type Sales } from '../generated/domain/index.js';
   export const orderCommands: Sales.OrderCommands = {
       place: (customer) => {
           const order: Sales.DraftOrder = { state: 'Draft', id: crypto.randomUUID() as Sales.OrderId, items: [], customer };
           return ok([order, [{ type: 'OrderPlaced', orderId: order.id }]] as const);
       },
       confirm: (order, at) =>
           ok([{ ...order, state: 'Confirmed', confirmedAt: at }, [{ type: 'OrderConfirmed', orderId: order.id, confirmedAt: at }]] as const),
       changeNote: byState<Sales.ChangeNoteOrderByState>({
           Draft: (order, note) => ok([{ ...order, note }, []] as const),
           Confirmed: (order, note) => ok([{ ...order, note }, []] as const),
       }),
   };

   // 変更後（0.4.0）
   import { Sales, decide, ok } from '../generated/domain/index.js';
   export const orderCommands: Sales.OrderCommands = {
       place: decide<Sales.PlaceOrderDecision>(Sales.OrderShape, (id, customer) =>
           ok({ Draft: { set: { id, items: [], customer, note: undefined }, events: { OrderPlaced: { type: 'OrderPlaced', orderId: id } } } }),
       ),
       confirm: decide<Sales.ConfirmOrderDecision>(Sales.OrderShape, {
           Draft: (order, at) =>
               ok({ Confirmed: { set: { confirmedAt: at }, events: { OrderConfirmed: { type: 'OrderConfirmed', orderId: order.id, confirmedAt: at } } } }),
       }),
       changeNote: decide<Sales.ChangeNoteOrderDecision>(Sales.OrderShape, {
           Draft: (order, note) => ok({ Draft: { set: { note }, events: {} } }), // `emits NoteChanged?` なら、備考が変わったときに渡す
           Confirmed: (order, note) => ok({ Confirmed: { set: { note }, events: {} } }),
       }),
   };
   ```

7. **呼び出し側**はキー付きの結果を読みます: `result.value.Confirmed.aggregate` / `.events.OrderConfirmed`。どのコマンドも
   扱うコードでは `outcome(result.value)` → `{ to, aggregate, events }` と `eventList(events)` を使います。
8. 型検査します（`tsc --noEmit`）。契約と実装が食い違うとき — いつも発生させられるとは限らないイベント、変更が必要な
   フィールド — は、実装ではなく DSL を変えます（`X?`、`changes`）。
9. 必要なら契約テストを有効にし（`generate.ts.tests`、`dt guide tests`）、一度 `dt fmt` を実行します。

## [0.3.0] - 2026-10-19

### Added

- 遷移元の状態ごとのハンドラ: 遷移先が遷移元の状態によって決まるコマンドには `<Command><Aggregate>ByState` も生成され、
  ランタイムの `byState({...})` で実装します（ADR 0015）。
- 状態遷移図は遷移ごとに辺を描き、インスペクタは遷移ごとに行を表示します。

### Changed

- **コマンドは `from … to …` の代わりに遷移を並べます**（ADR 0014）: `Draft -> Confirmed`、
  `Draft | Confirmed -> Cancelled`、`Draft -> Draft, Confirmed -> Confirmed`。ファクトリは遷移元のない遷移を一つ
  持ちます（`-> Draft`）。一つの状態は、コマンドごとに一つの遷移の遷移元になります（M006）。`from` と `to` は
  キーワードではなくなりました。
- 遷移先が遷移元の状態によって決まるコマンドの生成される契約は、入力の状態についてジェネリックになり、`Draft` からは
  `Draft`、`Confirmed` からは `Confirmed` が返ります。

### Fixed

- `npm publish` が警告しないよう、パッケージの `bin` のパスの書き方を直しました。

### Upgrading

1. 各コマンドの `from … to …` を遷移に書き換えます:

   ```dt
   // 変更前（0.2.0）
   create command place(customer: CustomerId) to Draft
   command confirm(at: Timestamp) from Draft to Confirmed emits OrderConfirmed
   command changeNote(note: String?) from Draft | Confirmed to Draft | Confirmed
   // 変更後（0.3.0）
   create command place(customer: CustomerId) -> Draft
   command confirm(at: Timestamp) Draft -> Confirmed emits OrderConfirmed
   command changeNote(note: String?) Draft -> Draft, Confirmed -> Confirmed // どの遷移元がどこへ行くかを書く
   ```

   どの遷移元からどの遷移先へも行けるなら、`from A | B to C | D` は `A | B -> C | D` になります。できるだけ正確な
   遷移を書いてください。
2. `dt check`、続いて `dt generate ts` を実行します。遷移先が遷移元の状態によって決まるコマンドは契約がジェネリックに
   なります: 型アサーションの代わりに
   `byState<Ctx.<Command><Aggregate>ByState>({ Draft: (…) => …, Confirmed: (…) => … })` で実装します。

## [0.2.0] - 2026-10-18

### Added

- **項目セット**（`dt guide field-sets`、ADR 0013）: `fields Name { ... }` で普通のフィールドの集まりを宣言し、集約・
  エンティティ・イベントが `with A, B` でそれを持ちます（M016）。共有コンテキストにも置けます。要素が継承する
  インターフェースが生成されます。
- コンテキストごとに生成される union: `DomainEvent`（すべてのイベント）、`Aggregate`（すべての集約）、
  `<Aggregate>Event`（集約のコマンドが発生させるイベント）。
- M017（警告）: 集約のコマンドが発生させるイベントに、その集約の ID 型のフィールドがない。
- ガイドで、ドメインのフィールドと技術的なフィールドの違いと、技術的なメタデータをエンベロープで付ける方法を説明しました。
- Live View: カタログのフィルタ（テキスト、種類、コンテキスト）。エクスプローラ、カタログ、インスペクタ、構造図での
  項目セットの表示。

### Changed

- Live View: カタログのカードは、バッジを見出しの上に、ラベルを名前の上に置きます。カタログのセクションへのリンクは
  なくなりました（フィルタでセクションを探せます）。

### Upgrading

1. M011: `DomainEvent`、`Aggregate`、`<Aggregate>Event` は生成される名前になりました。これらと名前が衝突する
   コンテキストの要素の名前を変え、`dt check` を実行します。
2. `fields` と `with` はキーワードになりましたが、フィールド名や引数名としては引き続き使えます。
3. 新しい M017 の警告には、集約の ID をそのイベントに加えて対応します（`orderId: OrderId`）。

## [0.1.0] - 2026-10-18

最初に公開したバージョンです。

### Added

- DomainTrail DSL: 境界づけられたコンテキスト、状態を持つ集約、エンティティ、値オブジェクト、ID、ドメインプリミティブ、
  列挙型、union、コマンド（`from … to …`）、イベント（`persistent`）、エラー、共有コンテキスト、ラベルと説明、
  不変条件の式。ルール M001〜M015 と L001〜L003。
- `dt` CLI（`domaintrail` としてもインストールされます。Node.js 22.12 以降）: `dt check`、`dt generate ts`
  （TypeScript の型とコマンドの契約。`generate.ts.contexts` でコンテキストごとの出力先）、`dt view`、`dt guide`。
- `domaintrail.jsonc`（`sources`、`generate.ts`、`view`）と、その JSON Schema `schema/domaintrail.schema.json`。
- Live View（`dt view`）: コンテキストマップ、構造図（3 段階）、カタログ、状態遷移図、ソースを表示するインスペクタ、問題と
  変更の一覧。保存のたびに更新されます。日本語と英語、ライトとダーク。

[0.5.0]: https://github.com/hisamekms/domaintrail/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hisamekms/domaintrail/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hisamekms/domaintrail/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hisamekms/domaintrail/compare/b9f56885cde82f404bbf6b558f43b8ecb6254dfe...v0.2.0
[0.1.0]: https://github.com/hisamekms/domaintrail/tree/b9f56885cde82f404bbf6b558f43b8ecb6254dfe
