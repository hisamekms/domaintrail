# 変更履歴

[English](CHANGELOG.md)

domaintrail の各バージョンの変更点です。形式は [Keep a Changelog](https://keepachangelog.com/ja/) に、バージョン番号は
[セマンティック バージョニング](https://semver.org/lang/ja/) に従います（1.0.0 より前は、マイナーバージョンでもモデルやコードに
影響する変更があります）。

**domaintrail を更新したら**、更新前から更新後までの各バージョンの **アップグレード手順**を古い順に読み、その手順に
従ってください。このファイルはパッケージに含まれています: `node_modules/domaintrail/CHANGELOG.ja.md`（英語版は
`CHANGELOG.md`）。

## [0.7.0] - 2026-11-04

### 追加

- **イベントストーミング**（`.dtes`、`dt guide storming`、ADR 0024）: `.dt` のモデルの隣に、ストーミングをテキストで
  書けます — イベント、コマンド、ポリシー、アクター、外部システム、集約、リードモデル、ホットスポット、タイムライン、
  グループと、モデルのイベント・集約・コマンドへの `ref`。`level design` でイベントをビッグピクチャーから外し、
  `stage … after …`・`exception`・`then` でストーミングを時間順に並べます（ステージを左から右へ、本流を一直線に、
  例外をその下に）。S001–S022 がストーミングとその `ref` を検査します（`dt guide storming-rules`）。`dt check`・`dt fmt`・
  `dt lsp`（診断、整形、ホバー、アウトライン、定義へ移動）が `.dtes` を扱い、既定の `sources` はこれも見つけます。
  `dt generate ts` が読むのは `.dt` だけです。
- **モード: チャットと AI のある Live View**（`dt guide session`、ADR 0030。AI は Claude Code）:
  - `dt open` — 自分ひとりの Live View。一度だけ使えるリンクでサインインします（`dt open link` で別のリンク）。
    メッセージはすべて AI に届きます。`dt open --host <address>` はチャットのない読み取り専用の Live View を配信します。
  - `dt collab` — コラボのセッション。複数人が同じ Live View を見て、モデルやストーミングの要素についてチャットで話し
    （`#` で要素、`@` で人を指す）、返信・投票・リアクションができます。何を変えるかはファシリテーターが決めます。
    本人確認は `dev`（ループバックで名前を入力）、`access`（Cloudflare Access）、`link` のいずれかです。
    `dt collab --tunnel` は Cloudflare のクイックトンネルを立て、参加者は招待リンク（`dt collab invite`）から申し込み、
    ファシリテーターがひとりずつ入室を許可します。
  - `dt agent` — 動いているセッションの AI を、別の端末やマシンで動かします（`dt collab agent-link` で組にします）。
    `claude` が使えれば `dt open` と `dt collab` は同じプロセスで AI を起動します。
  - AI 宛てのメッセージは仕分けされます: 質問には読み取り専用の回答、依頼は `.dt` / `.dtes` を書き換える実行か、
    ファシリテーターが承認する変更案になります。AI にはそれまでのセッションと、各メッセージを送ったときのビューが
    渡されます。
  - 実行のたびにワークスペースのリビジョンが残ります。ファシリテーターは、作業のカードからその作業だけを打ち消す
    （後の変更は残す）か、コラボのメニューから以前の状態に復元できます。
  - **AI の作業** タブ: 答え待ち・実行中・待ち・終わったもの、実行中の作業がいま何をしているか、作業ごとの変更を
    モデルの言葉で示します。
  - 設定のセクション `open`、`collab`、`agent`、`classifier`（仕分けに使う任意の Cloudflare の分類器）、`templates`
    （`dt guide session-config`）。
- **チャットの `/` コマンド**: `/es:start` と `/model:start` はインタビューを始めます。AI が一問ずつ尋ね、選択肢から
  選べます（単一選択は押すとすぐ送信、複数選択はチェックして送信、「その他」は常にあり。選択肢は全員に見え、答えるのは
  始めた人）。最後にブリーフをまとめ、ファシリテーターが確定します。表示中のストーミングについて、`/es:exceptions`・
  `/es:gaps`・`/es:levels`・`/es:names` が候補（例外、抜けているイベント、レベルを移すイベント、名前を変えるラベル）を
  挙げ、チェックしたものをひとつの実行で反映します。`/es:recap` はセッションをまとめます。`/guide` はブリーフから
  ゴールまでの地図、ファイルからすぐ分かること、AI の助言とその操作を示し、勧めたコマンドには `/` の一覧で星が付きます。
  テンプレート（組み込みとチームのもの）はメッセージの書き出しをコンポーザーに入れます。コマンドは誰でも実行でき、
  ファイルを変えるものはファシリテーターが承認します。
- **ジャーニーファイル**（`domaintrail.journey.json`、`dt guide journey`、スキーマは `schema/journey.schema.json`）:
  ワークスペースでの作業が何のためで、どこまで進んだか — ストーミングごとにひとつのイベントストーミングのジャーニーと、
  名前付きのモデリングのジャーニー（パターン `Whole`、`FromStorming`、`OneContext`、`Review`）を、ブリーフ・ゴール・
  印とともに持ちます。git で管理し、書くのは dt だけです。J001（スキーマどおりに読めること、エラー）、J002・J003
  （ジャーニーが存在しないストーミングやコンテキストを指している、警告）。
  - セッションには現在のジャーニーがひとつあります。アプリバーのチップからジャーニーパネル（ブリーフ、地図、ゴール、
    完了、しまう、ほかのジャーニー）を開きます。参加者の変更はファシリテーターが承認する依頼になります。
  - チャットは人の操作を小さな行で記録します（ゴール、印、ジャーニーの切り替え、依頼とその判断）。ブリーフの確定や
    ジャーニーの完了では、次の一歩とそのボタンを添えたメモが投稿されます。
  - AI の回答・コマンド・実行には現在のジャーニーが渡され、実行はその範囲とレベルの中で行い、越えるときは先に
    尋ねます。
- **Live View の新しいレイアウト**（`docs/live-view.md`）: アプリバー（ドメインモデル / イベントストーミングの
  ワールド切り替え。それぞれ最後のビューを覚える）、現在のジャーニー、問題。左の列はナビゲーターの下に詳細
  （インスペクター）を置き、間をスプリッターで分けます。チャットは右の列。キャンバスの上には、どのビューにも同じ
  ビューバー（ビュー切り替え、対象、レベル、絞り込み、書き出し）。イベントストーミングのワールドには専用の
  ナビゲーター（ストーミング、ステージ、タイムライン）と、ストーミングの要素の詳細があります。文字の大きさの設定
  （4 段階）。空のビューは、そのワールドの始め方を示します。
- **印刷と書き出し**（`docs/live-view.md`）: 印刷では表示中の図だけを 1 ページに収め、見出しの行を付けます。
  ビューバーの書き出しメニューから、印刷と、PNG・ポータブルな SVG（ブラウザ・Figma・Inkscape で開ける、素の図形と
  テキスト）・PDF の保存ができ、見出しと凡例を含めることもできます。「詰めて表示」でどの図も詰めて配置します。
- **`dt export`**（`dt guide export`）: `dt export svg` は Live View の図を、ブラウザなしで同じ SVG に描きます（毎回同じ
  出力。CI で作るドキュメント向け）。`dt export sources` は `.dt`・`.dtes` と設定ファイルをひとつの ZIP にまとめます。
  Live View のメニュー（ソース一式をダウンロード）からも同じものを保存できます。
- **`dt session prune`**: もう存在しないワークスペース（`--older-than <days>` で、使われていないもの）の状態を一覧し、
  `--yes` で削除します。
- **`domaintrail.local.jsonc`**: 設定にマージされる、git で無視するローカルの上書き。AI がワークスペースの外で読む
  パス（`agent.read.paths`）はここからだけ受け付けます。セキュリティに関わる設定が変わると、起動時に承認を求めます
  （`~/.config/domaintrail/trust.json` に記録。端末がなければ `--yes`）。
- **DSL**: 宣言のキーワードをフィールド・引数・用語・コマンド・判別子の名前に、どのキーワードも列挙値や union の
  バリアントの名前に使えます。値オブジェクトと union は、有限の値を持つなら再帰できます（M012）。値オブジェクトも
  フィールドセット（`with`）を取れます。
- **生成される TypeScript**（ADR 0028）: 集約自身の不変条件を一度だけ検査する `check<Aggregate>Common`。契約テストが
  再帰する型の値を作ります（`generate.ts.tests.maxRecursionDepth`、既定 4、型ごとにも指定可）。
  `generate.ts.contexts.<Ctx>.module` で、別のパッケージに生成したコンテキスト同士が import し合えます。
- `dt guide` のトピック: `storming`、`storming-refs`、`storming-views`、`storming-rules`、`storming-practice`、
  `modeling-practice`、`journey`、`export`、`session`（と `session-config`、`session-revisions`、`session-agent`）。
  AI にはこの進め方が渡され、AI は `dt guide` を実行できます。

### 変更

- **生成される TypeScript**（ADR 0028。アップグレード手順を参照）:
  - コマンドは引数を集約の後のひとつのオブジェクトで受け取ります。型は `<Command><Aggregate>Params`
    （`cancel(order, { reason })`）。決定（decision）、要求の検査、契約テストの入力も同じです。
  - `UUID` を基にする ID とドメインプリミティブは形式（RFC 9562）を検査します。`make<Name>` は不変条件 `uuid` 付きの
    `Result<Name, Invalid<Name>>` を返し、その型に独自の不変条件 `uuid` は付けられません（M002）。
  - 式のない集約の不変条件のスロットは `<Aggregate>Common` を受け取ります。
  - 契約テストは支援コードをパッケージのサブパス `domaintrail/testing` から import し、読み込み時に生成した
    domaintrail と合っているかを確かめます。fast-check は任意の peer dependency です。
  - 生成される検査はモデルのように読めます（`A implies B` の違反は `A && !B`、ラムダの名前は `.dt` のまま、文字列は
    `'…'`）。`references` の参照先は `@see {@link …}` になります。
- **M025**（エラー）: コンテキストの説明（`///`）は、そのファイル全体でひとつだけ書けます。これまでは 2 つ目以降が
  ファイル名しだいで黙って捨てられていましたが、今は残した方の場所とともに報告されます。
- **dt のファイルはワークスペースの外に置きます**（`dt guide config`）: セッション、サーバーのアドレス、
  `dt generate ts` の記録は `~/.local/state/domaintrail/<workspace>/`（`$XDG_STATE_HOME`、または
  `DOMAINTRAIL_STATE_DIR`）に、レイアウトは `~/.cache/domaintrail/<workspace>/`（`$XDG_CACHE_HOME`）に置きます。
  Windows では `%LOCALAPPDATA%` の下です。それを使う最初のコマンドが、既存の `.domaintrail/` をそこへ移します。
- Live View のペイロードと `dt show --format json` のモデルの形が変わりました: `{ contexts, elements }` は宣言順の
  リスト、要素は `kind` によるバリアント、列挙値は `{ name, label }`、二項演算子は名前（`eq`、`and` など）です。
  生成される TypeScript はこれでは変わりません。
- Node.js 22.13 以上が必要です（これまでは 22.12）。
- Live View の図を tldraw ではなく React Flow で描くようにし、どの https のオリジンでも図が消えなくなりました。
  ドラッグは常にパン（手のツール `H` はなくなりました）、Shift + ドラッグで範囲選択、tldraw のほかのショートカットは
  なくなりました。`+`、`-`、`Shift+0/1/2` はそのままです。
- Live View に DomainTrail のロゴと、両テーマで一貫した配色を入れました: イベントストーミングの付箋は慣例の色、
  モデルの種類は色相・形・ステレオタイプで示し、選択・差分・診断はノードの色を変えない重ね表示です。
- 凡例の表示はキャンバスごとに切り替え、既定では隠します。
- 名前の表示の既定はラベルです。ラベルがない、または空のときは名前を表示します。

### 削除

- `dt view`: `dt open` を使ってください（`--port`、`--host`、`--base` はそのまま）。実行すると、代わりのコマンドを
  示して失敗します。
- `domaintrail.jsonc` の `view` セクション: `open` になりました。`view` のある設定は、各キーの移り先を示して読み込みを
  拒否します。
- 生成される契約テストの `tests/_testing.ts`（`domaintrail/testing` に置き換え）。以前に書かれたものは
  `dt generate ts` が削除します。

### 修正

- Live View を再読み込みすると、直前のワールド・ストーミング・ビューに戻り、最初のフレームからレイアウトが落ち着いた
  位置に描かれます（列、アプリバー、ビューバーが後から動かなくなりました）。
- 言語サーバーが `dt check` と同じ順（コードポイント順）でソースを読みます。
- Live View のソース表示で、`.` の後のキーワードを名前として色付けします。
- 生成は、書き込むどのディレクトリでもシンボリックリンクを拒否します。
- 内部: コードをコンテキスト、ケイパビリティ、プラットフォーム、共有カーネル、アプリに分け、その境界をテストで
  検査しています（ADR 0025、ADR 0027）。コントリビューターは `CONTRIBUTING.md` を参照してください。

### アップグレード手順

必要なら先に Node.js を更新し（22.13 以上）、次に設定、モデル、生成の順に進め、最後にコードを直します。

1. **`dt view` → `dt open`。** スクリプトやドキュメントで置き換えます。オプションは同じです:

   ```sh
   dt view --port 8080 --base main   # before (0.6.0)
   dt open --port 8080 --base main   # after (0.7.0)
   ```

   `domaintrail.jsonc` の `view` セクションを `open` に改名します（改名するまで dt は古いものを拒否します）:

   ```jsonc
   "view": { "port": 8080 }   // before
   "open": { "port": 8080 }   // after
   ```

   設定で `sources` を指定していて、ストーミングを足すなら、`.dtes` のグロブ（`"**/*.dtes"`）も書きます。既定は両方を
   見つけます。
2. **`.domaintrail/` はワークスペースの外へ移ります。** `dt open` か `dt generate ts` を一度実行すると、
   `Moved .domaintrail/ to ~/.local/state/domaintrail/<workspace>/` と表示し、空になったディレクトリを削除します。
   先に旧バージョンの `dt view` を止めてください。`dt generate ts` の記録は移りません: 次の実行の後、それが
   もう書かない以前の生成ファイル（移した出力ディレクトリ、削除したコンテキスト）は手で削除します。その後
   `.gitignore` の `.domaintrail` の行は消して構いません。CI やコンテナでホームディレクトリに書けないときは、
   `DOMAINTRAIL_STATE_DIR` に書き込めるディレクトリを指定します。
3. **M025。** 複数のファイルに分けたコンテキストで、`context X` の上の `///` が複数のファイルにあれば、ひとつに
   まとめ（コンテキスト全体の型とともに `context.dt` に置く）、ほかは削除します:

   ```dt
   // before: sales/order.dt と sales/customer.dt の両方に
   /// Orders and customers.
   context Sales { ... }
   // after: /// は sales/context.dt だけに置き、ほかのファイルは /// なしで `context Sales { ... }` と書く
   ```

   `dt check` が 0 で終わるまで直します（M011 は、`<Command><Aggregate>Params` のような新しい生成名とぶつかる要素も
   報告します）。
4. `dt generate ts` で**生成し直し**、型検査をしてコードを直します:
   - **コマンドの引数はひとつのオブジェクトです。** 呼び出し側も実装側も、引数を名前で書きます:

     ```ts
     // before (0.6.0)
     orderCommands.cancel(order, reason);
     orderCommands.place(id, customer);
     cancel: decide<Sales.CancelOrderDecision>(Sales.OrderShape, { Draft: (order, reason) => … }),
     // after (0.7.0)
     orderCommands.cancel(order, { reason });
     orderCommands.place({ id, customer });
     cancel: decide<Sales.CancelOrderDecision>(Sales.OrderShape, { Draft: (order, { reason }) => … }),
     ```

     手で書いた要求の検査や、契約テストに渡す例（`[order, { reason }]`）も同じです。
   - **`UUID` を基にする ID とプリミティブは `Result` を返します。** これを扱います。作り方から UUID であることが
     確かな値は取り出してよく、失敗はバグです。フィクスチャやテストでは UUID を使います:

     ```ts
     // before (0.6.0)
     const id = Sales.makeOrderId(crypto.randomUUID());
     // after (0.7.0)
     const made = Sales.makeOrderId(crypto.randomUUID());
     if (!made.ok) throw new Error(`not a UUID: ${made.error.value}`);
     const id = made.value;
     ```

     そのような型に独自の不変条件 `uuid` があれば改名します（M002）。
   - **式のない集約の不変条件**: その実装（`…DeclaredChecks` のスロット）の型を、状態の型ではなく
     `<Aggregate>Common` にします。
   - **契約テスト**: `cases`、`suite`、`Suite`、`TestCase` は `domaintrail/testing` から import します（生成された
     `tests/_testing.ts` や `tests/index.ts` からではなく）。`domaintrail` と `fast-check` は dev dependency のままに
     します。今後 domaintrail を更新したら毎回 `dt generate ts` を実行し直してください: 生成されたテストは、マイナー
     バージョンの違う domaintrail では読み込みに失敗します。
5. **モデルの JSON を読むもの**（`dt show --format json` や Live View のペイロード）は新しい形に合わせます:
   `contexts` と `elements` はリストです（要素はキーではなく `name` と `context` で探す）。要素は `kind` で見分け、
   列挙値は `{ name, label }` です。

## [0.6.0] - 2026-10-28

### 追加

- **Live View を git のリビジョンと比較**（`docs/live-view.md`）: ヘッダーの 比較対象 メニュー、または変更ペインの見出しから、
  追加・変更・削除を何と比べて表示するかを選べます — 前回の保存（既定）か、git のリビジョン（ブランチ、タグ、最近のコミット、
  または入力した任意のリビジョン）です。`dt view --base <ref>` で最初から指定して起動できます。図はノードのフィールドに、
  インスペクターは 構造・状態遷移・振る舞い タブの行に印を付けます（追加、変更、削除は取り消し線、変更されたものは変更前の値も
  表示）。
- **Getting started** を英語と日本語で追加しました（`docs/getting-started.md`、`docs/getting-started.ja.md`）。README は
  それを中心に再構成しました。
- 変更履歴をパッケージに含めました（`node_modules/domaintrail/CHANGELOG.md`、`CHANGELOG.ja.md`）。`dt guide` は、更新後に
  そのアップグレード手順に従うようエージェントに伝えます。

## [0.5.0] - 2026-10-24

### 追加

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

### 変更

- ワークスペースのファイルを集めるすべてのコマンド（`check`、`generate`、`view`、`fmt`、`show`、`lsp`）は、
  `.gitignore`（ルート、そのサブディレクトリ、リポジトリの最上位までの親ディレクトリのもの）と `.git/info/exclude` が
  無視するファイルを読み飛ばします。`"respectGitignore": false` で無効にできます。コマンドラインで指定したファイルは
  読み飛ばしません。
- 言語サーバーが設定ファイルを見つけられないとき、設定を持つディレクトリの下で最初に開いた `.dt` ファイルによって、
  その設定がワークスペースになります。

### 修正

- `Int` や `Decimal` を基にするドメインプリミティブを、`count()` や `length()` が計算する数と比較できるようにしました。

### アップグレード手順

1. モデルの `.dt` ファイルが `.gitignore` で無視されるディレクトリにあると、ワークスペースに含まれなくなります。
   ファイルを移すか、`domaintrail.jsonc` に `"respectGitignore": false` を書いてください。`dt check` を実行し、
   ファイル数が以前と同じか確かめます。
2. M011: `parseDecimal` はランタイムの名前になりました。その名前の要素がモデルにあれば名前を変えてください。
3. `dt generate ts` を実行します。lint のヒントが出たら `dt guide lint` に従い（または `"lintHint": false`）、
   コード中のドメイン型へのキャストを `make<Name>` / `parseDecimal` に置き換えます。
4. 新しい警告が出ることがあります: M022（イベントやエラーのフィールドを値の出どころに合わせて名前を変えるか、
   出どころの名前をフィールドに合わせる）。警告では `dt check` は失敗しません。

## [0.4.0] - 2026-10-24

### 追加

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

### 変更

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

### 削除

- `byState` と `<Command><Aggregate>ByState` 型（0.3.0）: すべてのコマンドを `decide` で実装します。

### アップグレード手順

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

### 追加

- 遷移元の状態ごとのハンドラ: 遷移先が遷移元の状態によって決まるコマンドには `<Command><Aggregate>ByState` も生成され、
  ランタイムの `byState({...})` で実装します（ADR 0015）。
- 状態遷移図は遷移ごとに辺を描き、インスペクタは遷移ごとに行を表示します。

### 変更

- **コマンドは `from … to …` の代わりに遷移を並べます**（ADR 0014）: `Draft -> Confirmed`、
  `Draft | Confirmed -> Cancelled`、`Draft -> Draft, Confirmed -> Confirmed`。ファクトリは遷移元のない遷移を一つ
  持ちます（`-> Draft`）。一つの状態は、コマンドごとに一つの遷移の遷移元になります（M006）。`from` と `to` は
  キーワードではなくなりました。
- 遷移先が遷移元の状態によって決まるコマンドの生成される契約は、入力の状態についてジェネリックになり、`Draft` からは
  `Draft`、`Confirmed` からは `Confirmed` が返ります。

### 修正

- `npm publish` が警告しないよう、パッケージの `bin` のパスの書き方を直しました。

### アップグレード手順

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

### 追加

- **項目セット**（`dt guide field-sets`、ADR 0013）: `fields Name { ... }` で普通のフィールドの集まりを宣言し、集約・
  エンティティ・イベントが `with A, B` でそれを持ちます（M016）。共有コンテキストにも置けます。要素が継承する
  インターフェースが生成されます。
- コンテキストごとに生成される union: `DomainEvent`（すべてのイベント）、`Aggregate`（すべての集約）、
  `<Aggregate>Event`（集約のコマンドが発生させるイベント）。
- M017（警告）: 集約のコマンドが発生させるイベントに、その集約の ID 型のフィールドがない。
- ガイドで、ドメインのフィールドと技術的なフィールドの違いと、技術的なメタデータをエンベロープで付ける方法を説明しました。
- Live View: カタログのフィルタ（テキスト、種類、コンテキスト）。エクスプローラ、カタログ、インスペクタ、構造図での
  項目セットの表示。

### 変更

- Live View: カタログのカードは、バッジを見出しの上に、ラベルを名前の上に置きます。カタログのセクションへのリンクは
  なくなりました（フィルタでセクションを探せます）。

### アップグレード手順

1. M011: `DomainEvent`、`Aggregate`、`<Aggregate>Event` は生成される名前になりました。これらと名前が衝突する
   コンテキストの要素の名前を変え、`dt check` を実行します。
2. `fields` と `with` はキーワードになりましたが、フィールド名や引数名としては引き続き使えます。
3. 新しい M017 の警告には、集約の ID をそのイベントに加えて対応します（`orderId: OrderId`）。

## [0.1.0] - 2026-10-18

最初に公開したバージョンです。

### 追加

- DomainTrail DSL: 境界づけられたコンテキスト、状態を持つ集約、エンティティ、値オブジェクト、ID、ドメインプリミティブ、
  列挙型、union、コマンド（`from … to …`）、イベント（`persistent`）、エラー、共有コンテキスト、ラベルと説明、
  不変条件の式。ルール M001〜M015 と L001〜L003。
- `dt` CLI（`domaintrail` としてもインストールされます。Node.js 22.12 以降）: `dt check`、`dt generate ts`
  （TypeScript の型とコマンドの契約。`generate.ts.contexts` でコンテキストごとの出力先）、`dt view`、`dt guide`。
- `domaintrail.jsonc`（`sources`、`generate.ts`、`view`）と、その JSON Schema `schema/domaintrail.schema.json`。
- Live View（`dt view`）: コンテキストマップ、構造図（3 段階）、カタログ、状態遷移図、ソースを表示するインスペクタ、問題と
  変更の一覧。保存のたびに更新されます。日本語と英語、ライトとダーク。

[0.7.0]: https://github.com/hisamekms/domaintrail/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/hisamekms/domaintrail/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/hisamekms/domaintrail/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hisamekms/domaintrail/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hisamekms/domaintrail/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hisamekms/domaintrail/compare/b9f56885cde82f404bbf6b558f43b8ecb6254dfe...v0.2.0
[0.1.0]: https://github.com/hisamekms/domaintrail/tree/b9f56885cde82f404bbf6b558f43b8ecb6254dfe
