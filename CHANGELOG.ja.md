# 変更履歴

[English](CHANGELOG.md)

domaintrail の各バージョンの変更点です。形式は [Keep a Changelog](https://keepachangelog.com/ja/) に、バージョン番号は
[セマンティック バージョニング](https://semver.org/lang/ja/) に従います（1.0.0 より前は、マイナーバージョンでもモデルやコードに
影響する変更があります）。

**domaintrail を更新したら**、更新前から更新後までの各バージョンの **アップグレード手順**を古い順に読み、その手順に
従ってください。このファイルはパッケージに含まれています: `node_modules/domaintrail/CHANGELOG.ja.md`（英語版は
`CHANGELOG.md`）。

## [0.13.1] - 2026-11-13

### 修正

- Claude Code または Codex が実行形式エラー（`ENOEXEC`）で起動できない場合、`dt open` はコマンド、起動段階、
  OS、エラーコードとともに、実行ファイルの確認・再インストールや別のエージェント・エージェントなしでの利用を案内します。
  起動前の確認とコールドターンが対象です。Claude のウォームターンの起動失敗でも同じ診断をログに記録します。

## [0.13.0] - 2026-11-13

### 追加

- コマンドを持つコンテキストの生成 TypeScript に `commandErrors` を追加しました。
  `'<Aggregate>.<command>'` から、そのコマンドの `errors` と `requires … else` に宣言されたエラーの
  `type` 値を引ける、リテラル型付きの対応表です。宣言されたエラーがないコマンドには空配列が入ります。
  例えば `Sales.commandErrors['Order.confirm']` で判断時に起こりうるエラーを文書化できます。
  プリミティブのコンストラクターと検証済み型のファクトリーのエラーは含みません。
- `dt knowledge list` で設定済みナレッジストアを検索できます。`--query`、繰り返し指定できる
  `--about`・`--when`・`--kind`・`--origin` に加え、`--perspective`・`--session`・`--bookmarked`・
  `--retired exclude|include|only` で絞り込めます。新しい項目から並び、`--limit` と `--cursor` で
  ページを送れます。`dt knowledge show <id> --history` は項目と取得可能な過去の版を表示します。
  例: `dt knowledge list --query delivery --bookmarked --json`、`dt knowledge show kn_00000001 --json`。
  各コマンドの `--json` は、失敗時のエラーも含め、一つの JSON 文書を出力します。
- `dt knowledge edit <id>` は `VISUAL` または `EDITOR` で JSON 文書を開き、項目の `title`・`text`・
  `labels`・`about` を編集できます。`id` と `version` は変更しないでください。変更した内容の保存時は、
  開いたときの版を原子的に照合します。他の書き込みで項目が変わっていれば古い編集を拒否し、エディターを
  開き直すよう案内します。内容を変更せずに保存した場合、版も監査記録も変わりません。
- `dt knowledge retire <id> --reason replaced --replaced-by <id>` と `unretire` で廃止・復帰できます。
  `proposals`・`approve <proposal-id>`・`dismiss <proposal-id>` で廃止提案を扱えます。
  `delete <id>` は対話時に項目の ID とタイトルを示して確認し、スクリプトでは `--yes` が必要です。
  `restore <id>` はストアによる消去前に削除済み項目を復元できます。書き込みの実行者は files ストアでは
  既定で OS のユーザー名、Cloudflare ストアでは必須の `--actor <name>` で指定します。CLI の実行者名は
  自己申告で `cli:` を付けて記録され、Cloudflare Access で検証された ID ではありません。

### 変更

- ナレッジの修正時に項目の期待する版を指定できるようにしました。files と Cloudflare のストアは、古い版に
  基づく修正を項目や監査記録を変更せず拒否します。Cloudflare API は版の競合に HTTP 409 を返します。
  期待する版を省略した既存の呼び出しの動作は変わりません。

## [0.12.0] - 2026-11-11

### 変更

- 生成されるドメインエラーの `type` に BC 名を含めます（`Sales.EmptyOrder`）。ID やドメインプリミティブの
  `Invalid…` エラーも対象です。エラーの TypeScript インターフェース名は各 BC のモジュール内で従来どおりです。
- 生成イベントの `type` とコマンド結果の `events` のキーを `Sales.OrderPlaced` のような BC 修飾名にしました。
  異なる BC の同名イベントを一つのコマンドから発行できます。

### アップグレード手順

- TypeScript を再生成し、エラー生成、`type` による判定、エラー応答の処理を `EmptyOrder` / `InvalidOrderId` から
  `Sales.EmptyOrder` / `Sales.InvalidOrderId` のような BC 修飾名へ変更してください。生成契約テストも修飾名を
  期待します。コラボレーション API とナレッジ API のドメインエラーも修飾名で送受信します。API 独自のエラー名は
  従来どおりです。
- TypeScript を再生成し、イベントの値、`switch`、購読、コマンド結果のキーを BC 修飾名に変更してください。
  例: `{ 'Sales.OrderPlaced': { type: 'Sales.OrderPlaced', ... } }`。
- DomainTrail 外に保存したイベントは、旧い短い `type` を移行するか、読み取り時に正規化してください。
  DomainTrail の既存セッション outbox は読み取り時に正規化し、新規イベントは修飾名で保存します。

## [0.11.0] - 2026-11-10

### 追加

- `dt check --no-knowledge` は files ストアのナレッジ診断だけを省き、モデル・ストーミング・ジャーニーの検査を
  続けます。`dt check --scope dtes` はイベントストーミングの診断だけを報告しますが、`ref` の解決には `.dt`
  モデルを読みます。モデルの構文エラーで `ref` を検査できない場合や `.dtes` ファイルがない場合は失敗します。
  どちらも JSON 出力で使え、AI エージェントが編集中の範囲の診断を取得できます。

### 変更

- リポジトリの保守: コミットメッセージとステージ済みファイルを検査する commitlint と prek を追加し、`ws` を更新
  しました。

### 修正

- 生成された `_runtime.ts` の選択・リスト・Decimal のヘルパーが、`strict` と
  `noUncheckedIndexedAccess` を有効にした型チェックを通るようにしました。
- 別々のパッケージに生成したコンテキストの契約テストで、`@externalCheck` を持つコンテキストの任意値生成器を
  他のコンテキストから利用しても型チェックが通るようにしました。`contract` に必要な外部チェックは引き続き必須です。

### アップグレード手順

- この型エラーの回避策として `noUncheckedIndexedAccess` を無効にしたり、生成された契約テストを TypeScript の
  検査対象から外したりしていた場合は、domaintrail を更新して `dt generate ts` を再実行し、これらの検査を戻して
  ください。モデルが要求する外部チェックを渡したうえで、生成された契約テストを実行してください。

## [0.10.0] - 2026-11-10

### 追加

- **種類ごとの集約ライフサイクルと名前付きコマンド結果**（`dt guide kind-lifecycles`、ADR 0035）: 必須の
  `readonly` な enum フィールドで `transitions for` のライフサイクルを選べます。`initial` は開始状態を示します。
  `outcome` に名前を付けると、同じ状態へ至る結果にもそれぞれ遷移先・変更・イベントを定義できます。同じ状態から
  複数の結果がある場合は `select` 式で選びます。DSL で表せない判断には理由付きの `@externalCheck` を宣言
  できます。状態ビューは種類ごとに表示でき、`dt show` は有効な状態と結果を示します。
- **生成可能性の検査**: `dt check --for-generation` は、式のない自然言語の `select`・`requires`・
  `invariant` をエラーにします。`dt generate ts` は書き込み前にこの検査を実行します。外部チェックには型付きの
  実装口と生成された契約テストが必要です。
- **共同イベントストーミングの進め方**: 配布できる Big Picture と Design Level の例、任意の
  `dt check --storming-level design-level` の助言、ジャーニーが進んだ後に Design Level の範囲を選ぶ案内を追加
  しました。アクターが発行するコマンドの `on Event` で、ポリシーを置かずに イベント → アクター → コマンド を
  表せます。
- **プロジェクト共有のナレッジのブックマーク**: files と Cloudflare の両ストアで印の付け外しと絞り込みができ
  ます。修正・抽出・廃止後も印は残ります。独立したナレッジ画面では検索できる一覧と操作可能な詳細を並べて
  表示し、キャンバスを見ながら読むためのサイドバーも残します。
- **`dt open`・`dt collab`・`dt agent` で Codex に対応**: `--agent codex` を指定でき、承認済みの外部パス
  の読み取り専用コピーも利用できます。Claude Code 向けの `agent.run.allowedTools` の個別規則は Codex では
  利用できません。
- **AI 向けの `dt init`**: プロジェクトの証拠と未決定事項を含む配置案を、対話なしでテキストまたは版付き JSON
  で返します。`dt init --apply` が `domaintrail.jsonc` を作るのは、既存モデルのない新規の単一パッケージだけ
  です。既存の設定とソースは保持します。モノレポでは生成 TS の所有先を決めてから設定を編集します。独立した
  複数製品は別々のルートが必要です。

### 変更

- チャットでは人の回答が AI の質問の後に、その回答を受けて再開した AI の作業がさらにその後に表示され、
  スレッド線でつながります。メッセージの入力中は、1 文字ごとにページ全体とチャット欄を再描画しなくなりました。
- Design Level では、同じ時点に複数レーンで現れるコマンドやポリシーを一つだけ描き、各レーンのイベントへ
  線をつなぎます。例外の分岐イベントが設計上の線ですでにつながる場合は、重複する分岐線を省き、選択できる
  ラベルは残します。

### 修正

- Solo の AI 作業カードへの返信操作を、そのカードに固定し、ホバー・フォーカス・タッチで見つけられるように
  しました。
- コマンドの処理担当が未決定の場合は「何が処理する？」と尋ねます。発行者については引き続き誰が行うかを
  尋ねます。Codex は、案内に表示される末尾のスラッシュ付きパスでも、承認済み読み取りコピーの一覧を取得
  できます。

### アップグレード手順

1. **生成前にモデルの判断を確認します。** 遷移先が一つの従来のコマンドは引き続き使えます。
   `Pending -> Approved | Rejected` のような複数の遷移先は、結果に名前を付けるまで生成できません。
   コマンド直下の `changes` と `emits … when` を該当する結果へ移し、競合する結果のそれぞれに `select`
   を書きます。例:

   ```dt
   // 変更前
   command review() {
     Pending -> Approved | Rejected
   }
   // 変更後: 実際に使える判断材料をモデルに合わせて指定する
   command review(approved: Bool) {
     outcome approved: Pending -> Approved
       select { approved }
     outcome rejected: Pending -> Rejected
       select { not approved }
   }
   ```

   式のない `requires`・`invariant` には、実行できる式か理由付きの
   `@externalCheck("この判断が外部にある理由")` が必要です。この注釈は検査の義務を示すだけで、検査を実行しません。
   `dt check --for-generation` で残る問題を調べます。種類ごとのライフサイクルには、必須で `readonly` の
   enum セレクター、適用される `initial` 状態、`transitions for` グループを追加します。詳しくは
   `dt guide kind-lifecycles` を参照してください。
2. **外部での検査を実装し、生成されたテストを実行します。** 外部チェックには生成された型付きの実装口が必要
   で、`generate.ts.tests` で契約テストを有効にします。無効な場合は生成が失敗します。モデルの変更後に
   `dt generate ts` を実行し、名前付き結果に合わせて実装を更新して、生成されたテストを実行します。モデルを
   変更していない場合も再生成してください。0.9 で生成された契約テストは、別のマイナーバージョンでは読み
   込めません。
3. **Cloudflare のナレッジストアを使う場合**は、テンプレートの README の Upgrade 節に従い、
   `0004_bookmark.sql` を適用して新しい Worker とページをデプロイします。既存の項目には印が付きません。
   files ストアの移行は不要です。

## [0.9.0] - 2026-11-07

### 追加

- **追う**（`docs/live-view.md`、ADR 0026 の付録）: 読む人のカメラを動かすのは、読む人自身と読む人が追っている相手だけ
  です。AI はアプリバーの AI の状態の左の ○ / ◉ か、参加者の一覧の AI の行から追います。追っている間は、
  実行の変更を（それを描くビューで）画面に入れます。AI への依頼（AI 宛てのメッセージ、回答、選択、ファシリテーター
  の AI に送る、自分の提案の承認）を送ると、送った人のページでだけ AI を追い始めます。参加者はその行から追い、
  その人のいるストーミング・レベル・タイムライン・例外のレイヤーを開いて、その人のキャンバスに映っている範囲に合わせま
  す。読む人自身の操作で追うのをやめます。追う相手は一度にひとりで、その人の色の細い枠で示します。参加者の在席にカメラ
  の範囲が加わりました。
- **解決済みのホットスポットを隠す**（ADR 0032 §10）: イベントストーミングの 絞り込み の「解決済みを表示」で、
  既定はオン、見る人ごとです。オフにすると解決済みのホットスポットとその線を描かず、その場所は空けたままにします — 付
  箋は動きません。それが付いていた付箋の角（「k/n」の左）には緑の ✓ が残り、マウスを乗せると決まったことを示し、
  押すとそのホットスポットを選びます。付箋の詳細は絞り込みにかかわらずそのホットスポットをすべて並べます。
  `dt export svg --resolved-hotspots hide` も同じに描きます。ビューが描いていない要素へ移るとき（パレット、
  `#select=` のリンク、ナレッジ、詳細、チャットの参照、実行の印）は、先にそれを表示してから選びます。
- **ナレッジの廃止**（ADR 0031 §12）: 当てはまらなくなったナレッジは、消さずに廃止します — 本文・出典・版は残ります。
  理由（置き換わった（置き換えるナレッジとともに）、当てはまらなくなった、誤り）は付けても付けなくてもよく、
  10 秒間元に戻す が出て、廃止を取り消す で戻せます。廃止したナレッジは一覧・付箋の詳細・点から外れ（廃止も表示 で薄く
  表示）、AI はもう読みません: 回答役と実行役は `dt mcp --without-retired` を起動し、抽出役には廃止したナレッジの見出
  しと理由だけを渡します。**AI は提案し、人が決めます**: 抽出役と実行の見直し（後述）が、廃止や廃止の取り消しを理由と
  根拠を添えて提案し、ナレッジの一覧の先頭の 廃止の候補 に並べます（承認 / 却下。チャットには出しません）。
  却下した提案は、新しい根拠がない限り再び出ません。AS-IS のナレッジを TO-BE と違うことを理由に提案することはありませ
  ん。Worker のページでも廃止し、候補を決められます。
  `dt mcp` の `knowledge_for_element` と `knowledge_search` は `include_retired` を受け付けます。`files` のストアはナ
  レッジのファイルに `retired:` を書き、提案を `knowledge/proposals/` に置きます。`cloudflare` のストアに
  は Worker の migration 3 が要ります（アップグレード手順を参照）。
- アプリバーの中央の **探す**（`docs/live-view.md`）: 検索欄の形のボタン（🔍 探す ⌘K、Mac 以外は Ctrl K）で、
  どちらの世界でも同じ場所にあり、⌘K と同じパレットを開きます。何も打たなければ選んでいる付箋への操作と最近選ん
  だ 5 件、打てば合う操作と、両方の世界で見つかったもの — すべてのストーミングの付箋と、ドメインモデルのコンテキスト・
  要素・コマンド・状態 — を世界ごとに件数付きで並べます。照合するのはラベルと名前（ID）だけで、一致、前方一致、
  部分一致、名前だけの一致（印を付けて名前を表示）の順です。各 8 件で、残りは「ほか n 件」。`ref` でモデルの要素を指す
  付箋には、その要素を下に吊るします。選ぶとそこへ移り、隠しているもの（レベル、例外、主な流れ、絞り込み、
  絞ったコンテキスト、カタログの絞り込み）を外して、外したことを少しの間示します。
- **実行の終わりの見直し**（`dt guide session`、ADR 0034）: ストーミングを変えた実行は、終わる前に見直します — ま
  ず dt のルールが差分を調べ（付箋はそのままでホットスポットだけ解決した、ホットスポットを開いたまま付箋を変えた、
  前のラベルや名前がほかの付箋に残っている、ほかの付箋と同じラベルの付箋を足した）、続いて同じ実行のもう 1 ターンで、
  変えたものの周り（それへのホットスポット、関係 1 つ先、それについての決定とルール。AS-IS と廃止したものは除く）
  を AI が見て、依頼の範囲で食い違いを直し、直さないものは理由を述べます。実行カードは 見直し — 見つけたもの・直したも
  の・残したもの — を示し、残りがある間はファシリテーターに 見直しを頼む が出ます。見直しがナレッジとの食い違いを見つ
  けると次の抽出に食い違いとして渡し、当てはまらなくなったナレッジは 廃止の候補 にします。改名した付箋のナレッジは新し
  い名前に付け替えます。既定でオンで、`agent.run.review: false` でオフにします。

### 変更

- **`reads` は判断する者の行に書きます**（ADR 0032 §9。アップグレード手順を参照）: ポリシーは見るリードモデル
  を `reads` に書き（「〜が起きたら、〜を見て、〜を出す」）、ポリシーが発行するコマンドには `reads` を書きません
  （**S030**。ヒントがそのポリシーを示すエラー）。ポリシーが発行するコマンドはひとつです（**S031**。エラー: ポリシーを
  コマンドごとに分ける）。`dt fmt` はポリシーの句を `on`、`reads`、`issues`、`by` の順に並べます。
  `dt migrate dtes` は 0.8 の `.dtes` も書き換え、ポリシーが発行するコマンドの `reads` を、コメントとともにそのポリ
  シーへ移します。
- **デザインレベルではリードモデルを、それを見る者の前に描きます**: リードモデル → ポリシーの付箋（どちらのレイアウト
  でも、イベントとポリシーの間にリードモデルの列）で、リードモデル → コマンドではなくなりました。`reads` の線はどれも
  「「B」は「A」を見て判断する」と示します。
- **イベントストーミングのキャンバスはタイムラインを載せ、例外はその上のレイヤーになりました**（ADR 0032 §11、
  `docs/live-view.md`）: パンくずはストーミング › すべて か主な流れ 1 本です（すべての段階を通る幹がひとつの主な流れ。
  主な流れがひとつのストーミングには選ぶものがありません）。主な流れ 1 本は すべて の配置のまま描き、ほかの主な流れと
  そこから分かれる例外はその場所を空けて描きません — 付箋は動きません。何も描かない段階は枠を破線で残します。
  パンくずの横のトグル ↳ 例外（例外のピンクで、件数付き）が例外を含める（既定）か含めないかを決め — これまでの「例外を
  表示」で、絞り込み からは外れました — その ▾ で例外をひとつ強調します: その道筋は濃いまま、ほかは薄くなり、
  何も動きません。キャンバスの例外のレーンのラベルでも強調できます。強調は選択に近いもので、覚えず、追う相手にも伝わら
  ず、印刷もしません。× か 2 度目の Escape か、キャンバスの空いたところを押すと終わります。ナビゲーターの行も同じキャ
  ンバスを示します: 段階の行はその枠を画面に入れ、主な流れの行はそれをキャンバスに載せ、例外の行はそれを強調します。
- **`dt export svg`**（アップグレード手順を参照）: `--timeline <ID>` は主な流れ 1 本を、そのどのタイムラインの ID でも
  受け付け、すべての流れの配置で描きます。`--exceptions include|exclude`（`show` と `hide` も旧名として受け付けま
  す）。見出しは すべて か主な流れと、例外を含む / 例外なし を示します。
- **実行の変更でカメラは動かなくなりました**（AI を追っているときを除く）: 印とバー（「ほかに n 件の変更 →」）
  が場所を示します（これまでは画面に印がひとつもないときに動いていました）。
- **AI** は、ホットスポットに答える決定をしたら、付箋を変え、ホットスポットの解決も書きます。
- **狭いウィンドウのアプリバー**: 40rem より狭いとワークスペースの名前を消し、探す は虫眼鏡だけになります。
  スマートフォンの幅では、ブランドの名前、抽出のスイッチ、AI の状態の文字も消します。

### 削除

- ポリシーが発行するコマンドの `reads`: エラー（S030）になり、`dt migrate dtes` が移します。
- **段階のビューと例外のビュー**: 段階はキャンバスの枠、例外はレイヤーの上で強調するものになりました。
  `dt export svg --stage` はなくなり、`--timeline` は例外を受け付けなくなりました（アップグレード手順を参照）。

### 修正

- 実行中に dt が `domaintrail.journey.json` を書くと（ファシリテーターのジャーニーの操作、依頼の承認、インタビューの要
  旨の確定）、実行がエージェントのエラーで失敗し、再起動するまで以後の実行を受け付けなくなっていました。
  実行がエージェントの変えたファイルを調べるときに、このファイルを除きます。
- ⌘K が付箋をその種類やストーミングで照合しなくなりました: ストーミングの名前の語（「注文から入金まで」の「注文」）
  で、そのストーミングの付箋がすべて出ていました。

### アップグレード手順

ポリシーが発行するコマンドに `reads` がある、またはポリシーが複数のコマンドを発行する 0.8 の `.dtes` は検査を通らなく
なります。各段階をレビューできる差分にするため、先にコミットしておきます。

1. **`reads` をポリシーへ移します:**

   ```sh
   dt migrate dtes --dry-run   # 移すものと残るものを示す
   dt migrate dtes             # その場で書き換える。残るものがあれば 1 で終わる
   ```

   ちょうどひとつのポリシーが発行するコマンドの `reads` を、コメントとともにそのポリシーへ移します:

   ```dtes
   // before (0.8)
   command IssueInvoice "請求書を発行する" {
     reads OrderTotal // 合計を見て請求額を決める
     handledBy Invoice
     emits InvoiceIssued
   }
   policy BillConfirmedOrder "注文が確定したら請求する" {
     on OrderConfirmed
     issues IssueInvoice
   }
   // after (0.9)
   command IssueInvoice "請求書を発行する" {
     handledBy Invoice
     emits InvoiceIssued
   }
   policy BillConfirmedOrder "注文が確定したら請求する" {
     on OrderConfirmed
     reads OrderTotal // 合計を見て請求額を決める
     issues IssueInvoice
   }
   ```

   残ったと示されるものは手で直し、もう一度実行します:
   - **S031**。複数のコマンドを発行するポリシー（そのコマンドの `reads` はそのまま残ります）: コマンドごとのポリシーに
     分け、それぞれ同じイベントに `on` します。

     ```dtes
     // before: S031
     policy BillConfirmedOrder {
       on OrderConfirmed
       issues IssueInvoice, RequestShipment
     }
     // after
     policy BillConfirmedOrder {
       on OrderConfirmed
       issues IssueInvoice
     }
     policy ShipConfirmedOrder {
       on OrderConfirmed
       issues RequestShipment
     }
     ```

   - **S030**。複数のポリシーが発行するコマンドの `reads`（それぞれには写しません）: それを見るポリシー — どれも見るな
     らそれぞれ — に書き、コマンドから消します。

     ```dtes
     // before: S030
     command RemindPayment {
       reads Unpaid
       handledBy Invoice
       emits PaymentReminded
     }
     policy RemindWhenOverdue {
       on PaymentOverdue
       issues RemindPayment
     }
     // after（RemindPayment を発行するもうひとつのポリシーも Unpaid を見るなら、そちらにも同じく）
     command RemindPayment {
       handledBy Invoice
       emits PaymentReminded
     }
     policy RemindWhenOverdue {
       on PaymentOverdue
       reads Unpaid
       issues RemindPayment
     }
     ```

   0.8.0 と同じく、誰も決めていないことは推測しません: そのポリシーに開いたホットスポットを付けて尋ねます。
2. **`dt fmt` を一度実行し**、別にコミットします: ポリシーの句を `on`、`reads`、`issues`、`by` の順に並べます（アク
   ターの `by` を持つポリシーは `by` が最後になります）。
3. **`dt export svg --stage <ID>`** はエラーになります: 外せば段階の枠を含むすべての流れを描きます。主な流れを描くな
   ら `--timeline <ID>` にします。例外の ID を `--timeline` に渡すのもエラーです: すべての流れ（既定で例外を含む）
   を描きます。`--exceptions hide` / `show` はそのまま使えますが、`exclude` / `include` と書きます。
4. **ナレッジの `cloudflare` ストア**: Worker の migration `0003_retirement.sql` を当て、新しい Worker をデプロイし直
   します。手順は Worker の README（`dist/knowledge-worker/README.md`）の Upgrade のとおりです: 新しい `worker.js`・
   `page/`・`migrations/` を写し、`npx wrangler d1 migrations apply knowledge --remote`、`npx wrangler deploy`。
   デプロイするまで 廃止する と廃止の候補は 404 になります。`files` のストアは何もしなくてかまいません。
5. `dt generate ts` で**生成し直します**: 生成された契約テストは、マイナーバージョンの違う domaintrail では読み込みに
   失敗します。
6. **設定**: 変えるものはありません。`agent.run.review` が新しくでき、既定でオンです（ストーミングを変えた実行
   に 1 ターン加わります）。見直しをやめるなら `false` にします。Live View が覚えているストーミングの表示の選び方は読
   み替えます: 段階はすべての流れ、例外のタイムラインは例外を含むすべての流れ、「例外を表示」のオフは例外を含めない、
   として読みます。

## [0.8.1] - 2026-11-06

### 修正

- 実行中に `files` のナレッジストアが `knowledge/` に書き込むと（抽出、人による修正や削除、掃除）、実行がエージェントの
  エラーで失敗し、再起動するまで以後の実行を受け付けなくなっていました。実行がエージェントの変えたファイルを調べるときに
  このディレクトリを除き、エージェントには編集させません: エージェントはナレッジを dt を通して読みます。

## [0.8.0] - 2026-11-06

### 追加

- **セッションのナレッジ**（`dt guide knowledge`、ADR 0031）: セッションで話されたこと・わかったこと（なぜか、どの
  くらいの頻度か、誰が言ったか、AI が調べてわかったこと）を、`.dtes` や `.dt` とは別に 1 件ずつ、関係する付箋に
  結び付けて残します。1 件のナレッジは見出し（短い 1 行）、Markdown の本文（画像も）、ラベル（`when` AS-IS /
  TO-BE、`kind`、`origin` 発言 / 合意 / 調査 / 推測、任意の `perspective`）、関係する付箋（`about`）、各メッセージの
  短い引用を添えた出典、版、食い違うナレッジを持ちます。
  - **セッション中の抽出**: AI の 3 つ目の役割、抽出役（`agent.extract`: `model`・`gateModel`・`timeout`・`effort`。
    ツールなし）が、話のすぐ後にナレッジにします。人のメッセージの後 30 秒発言がないとき、AI が答えるたび、終わる
    ときで、多くても 1 分に 1 回です。強いモデルは抽出することがあるときだけ動くよう 3 段階で進めます: 明らかに何も
    ないメッセージだけならモデルを使わずに止め、次に軽いモデル（既定は Haiku）が発見があるかを判断します。新しい
    ナレッジと出典の追加はすぐに反映し、更新と食い違いは次の抽出が同じ判断をするか話が落ち着くまで保留して、
    終わるときに残っていれば捨てます。抽出ごとに各段階の結果とコストを記録します。
    `knowledge.extraction.enabled` を有効にしない限りオフで、ファシリテーターは Live View のアプリバーの 💡 で
    セッションごとに切り替えます。
  - **2 つのストア**（設定のセクション `knowledge`: `store`・`project`・`url`・`extraction`）: `files`（既定）は
    ワークスペースの `knowledge/` に 1 件 1 ファイルの Markdown で、git に残ります。`cloudflare` はパッケージに同梱の
    テンプレート（`dist/knowledge-worker/`: D1・R2・Cloudflare Access。その README がデプロイとアップグレードの
    手順書）からデプロイする Worker で、個人情報が話に出うるプロジェクト向けです。dt は Access のサービストークンを
    `DOMAINTRAIL_KNOWLEDGE_CLIENT_ID` と `DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET` から送り、`knowledge.url` と
    `knowledge.project` は承認の要るセキュリティ上の設定です。`dt check` は読めないナレッジのファイル（K001）と、
    どのストーミングにもない付箋についてのナレッジ（K002、警告）を報告します。
  - **Live View で**（`docs/live-view.md`）: ナレッジのある付箋に点、食い違いには印。付箋の詳細にそのナレッジを
    新しい順か種類の順で並べ、1 件を開くと引用・ほかの付箋・版・画像が出ます。ナレッジタブで検索と絞り込み。
    直す・画像を付ける・消す。食い違いは左右に並べ、ホットスポットにする と 食い違いではない を選べます。
  - **消す**: 消したナレッジはすぐに全員から見えなくなり、10 秒間 元に戻す が出ます。その後ストアの掃除が版と画像を
    すべて消し、出典のメッセージをプロジェクトの消去ログに載せます。プロジェクトの各 dt はそのログを追って、自分の
    セッションのデータベースからそのメッセージを消します。`files` では git の履歴に残ります。
  - **`dt mcp`**（`dt guide mcp`）: Claude Code 向けの stdio の MCP サーバーで、読み取り専用です:
    `knowledge_for_element`（付箋か、それを `ref` する付箋を通じた `.dt` の要素）、`knowledge_search`、
    `knowledge_get`。
  - **`dt publish`**（`dt guide publish`）: 各ストーミングの公開用の形（付箋・つながり・配置と、図のコミットと日付）を
    `cloudflare` の Worker に送ります。`main` が変わったときに CI で実行し、送り先は `DOMAINTRAIL_PUBLISH_URL` と
    `DOMAINTRAIL_PUBLISH_PROJECT` で固定します。`--prune` はワークスペースにもうないストーミングを消し、`--out` は
    ファイルに書き出します。Worker は同じ Access の後ろで **読み取り専用のページ** を配信します: 公開された
    ストーミングのキャンバスとナレッジ、ナレッジの一覧、図にない付箋についてのナレッジ、セッションと同じ直す・消す。
- **人が付箋をその場で直す**（ADR 0033、`docs/live-view.md`）: AI の実行なしで。選んだ付箋への操作をひとつにまとめ、
  ツールバー、「…」/ 右クリックのメニュー、キー（Enter、F2、Esc、⌘⇧C）、⌘K のパレットから同じものを使えます —
  チャットに追加、編集、ナレッジを見る、ドメインモデルで見る、このタイムラインで見る、ホットスポットを付ける、
  解決を書く / 解決を直す、リンクをコピー（`#select=` のリンク）。編集 は付箋のラベルと名前（すべての関係を含め、
  それを指す箇所も書き換える）か、ホットスポットの問いを変えます。解決を書く はホットスポットの解決を書きます（空に
  すると再び開きます）。新しいホットスポットはすぐに書かれ、軽いモデルが裏で名前を付けます。dt は `.dtes` の該当する
  トークンだけを書き換えます。参加者は誰でも直せます。直したものは人の版として AI の作業 とチャットに並び、戻すことが
  でき、キャンバスに印が付きます。実行中に直したものを実行が落としたときは直しを当て直し、実行が同じ文言を別に
  書き換えたときは AI の文言のまま か 人の文言にする を選びます。AI には人の直しが渡され、その文言を保ちます。
  ドメインモデルで見る と このタイムラインで見る からは、詳細の戻るボタンとブラウザーの戻るで戻れます。
- **実行が変えたところをイベントストーミングのキャンバスに**（`docs/live-view.md`）: ストーミングを変えた実行の後、
  足した付箋と変えた付箋に 新 / 変 の輪（変えたものは前のラベルを取り消し線で）、消した付箋には 削除 の付いた破線の
  影が、次のそうした実行か 印を消す まで残ります。バーが件数を示し、見えていないものへ案内します（ほかに n 件の変更 →）。
  実行の変更（チャットと AI の作業）の 図で見る は、その実行の印を表示します。印は見る人ごとです。
- **`.dtes`**: `readmodel R { from <event> }`（リードモデルに反映されるイベント）、`event E { from <external> }`
  （こちらのコマンドなしに外から来るイベント）、どの付箋にも（イベントだけでなく）付けられるホットスポットの `on`、
  アクターの `by` を持つポリシー（人が手で当てはめるルール）、外部システムを `handledBy` にするコマンド（変更を参照）。
- **`dt migrate dtes`**（`--dry-run`、または対象のファイル）: 0.7.0 の `.dtes` を新しい関係に書き換え、書き換えられ
  なかったものと、`dt check` がまだ報告するエラーを示します（アップグレード手順を参照）。
- **デザインレベルのルール**（`dt guide storming-rules`）。ヒントに直し方を示すエラーです: S023（0.7.0 の `actor` /
  `target`）、S024（発行者・`handledBy`・`emits` のないコマンド）、S025（ポリシーが発行するコマンドの `by`）、S026
  （同じ関係を 2 度書いた）、S027（どの関係にも名前の出ないアクター・外部システム・集約・リードモデル）、S028（コマンドが
  発生させ、かつ外部システムから `from` で来るイベント）。開いたホットスポットが `on` で付いている要素では S024・S027・
  S008 は出ません。`dt check` はそうした要素を一覧し、Live View は決まっていない発行者や処理者を破線の付箋
  「誰が処理する？」で描きます。S029 は何も生み出さないイベントを示します。
- **インフォ**: エラーと警告に並ぶ 3 つ目の重大度（S029）で、終了コードを変えません。`dt check --format json` では
  `info` と `summary.infos`、言語サーバーでは Information です。
- **`dt check` の警告**: どのバリアントもフィールドを持たない `union`（M026: `enum` にする）と、ID 型や集約があるのに
  `String`・`UUID`・ID 型の基の型で書いた `…Id` / `…Ids` という名前のフィールドや引数（M027: ID 型か `references`
  にする）。
- `dt guide` のトピック `dsl-quick` と `dtes-quick`: `.dt` と `.dtes` の構文を 1 画面に収めた、検査済みの例です。AI が
  それらのファイルを扱うときにも渡されます。
- `dt guide` のトピック `knowledge`（`mcp` と `publish` を含む）。

### 変更

- **`.dtes` の関係はイベントストーミングの文法に従います**（ADR 0032。アップグレード手順を参照）: コマンドはその行の
  すべてを持ちます。`by`（発行する者: アクターか外部システム）、`reads`（発行者が見るリードモデル）、`handledBy`
  （受けて処理し、イベントを生み出す者: 集約か外部システムで、ちょうどひとつ）、`emits` です。`actor` は `by` に、
  `target` は `handledBy` になりました。`by`・`handledBy`・`from` はキーワードになり、ID には使えません。構文エラーは
  意図したキーワードを示します（`handledby` → `handledBy`）。S003 と S006 は意図した関係をヒントに示します（集約を
  `by` → `handledBy`、イベントを `reads` → それから `from` で作るリードモデル、など）。
- **`dt fmt` が本体の句を並べ替えます**（`ref`、`by`、`reads`、`handledBy`、`emits`、`on`、`issues`、`from`、
  `status`、`resolution`、`level` の順に、それぞれのコメントとともに）。いくつもの句に書いた同じ関係は、どれかに
  コメントがない限りひとつのリストにまとめます（`emits A` + `emits B` → `emits A, B`）。
- **デザインレベルを文法のとおりに描きます**（`docs/live-view.md`）。どちらのレイアウトでも、リードモデル → 発行者 →
  コマンド → 処理者 → イベント → ポリシー → コマンドの順で、アクターはコマンドの傍らに置き、同じ要素が処理して同じ
  イベントに至るコマンドには処理者の付箋をひとつだけ描きます。線は 3 種類の見た目 — 流れ（実線の矢印）、時間（破線の
  矢印）、問い（ホットスポットの線、矢じりなし）— です。デザインレベルの時間の順は配置で示し、線を引くのは例外の
  分かれ目と `then` だけです。
- **イベントストーミングのキャンバスの選択と線**（`docs/live-view.md`）: 付箋を選んでも、ほかを暗くしなく
  なりました。同じ付箋のコピーには「k/n」の番号が付き、画面の外のコピーは画面の端の矢印で指します（押すとそこへ
  移ります）。詳細の「同じ付箋 n 件 ‹ k/n ›」でコピーを順に移れます。線にマウスを乗せるか押すと、両端の付箋（種類の
  色と名前。押すとそこへ移ります）と、関係の意味を平易な言葉で示します。これまでの線の説明（ツールチップ）はこれに
  置き換わりました。未解決のホットスポットの「未決定」の枠から、そのコマンドへ問いの線を引きます。
- **AI** が DSL の慣用に従います（決まった値の集合は `enum`、ほかの集約はその ID 型で指す、集約とエンティティはそれぞれ
  自分の ID 型を持つ）。誰も示していない `.dtes` の関係は推測せず、その要素へのホットスポットで尋ねます。
- **Live View の左の列**（`docs/live-view.md`）: ツリーの下に詳細を置き、間に仕切りがあります。ツリーは読む人が
  畳みます（見出し行の ▾、仕切りを上端までドラッグ、仕切りで ↑ / ↓）。畳んでいる間は選んでいるものを見出し行に
  示します。自動では畳まず、ほかの寸法と同じく覚えます。問題 と 差分 には詳細を出しません。詳細は閉じなくなりました
  （閉じるボタンとレールはなくなりました）。列はウィンドウの半分まで広げられます（これまでは 560px まで）。
- 実行カードの AI の文章（回答、要約、選択肢なしの質問）を、回答役のメッセージと同じく Markdown で表示します。
- 見えていないところの更新を知らせるチャットの表示（「…」が更新されました、AI が回答しました）に、移動せずに閉じる ×
  を付けました。

### 削除

- `.dtes` の本体の関係 `actor` と `target`: エラー（S023）になり、`dt migrate dtes` が書き換えます。

### 修正

- 詳細の戻るボタンが、ラベルを表示しているときはストーミングの要素をラベルで示します（ID を示していました）。

### アップグレード手順

コマンドのある 0.7.0 の `.dtes` は検査を通らなくなります: 書き換えてから、`dt check` が尋ねることを決めます。
各段階をレビューできる差分にするため、先にコミットしておきます。

1. **関係を書き換えます:**

   ```sh
   dt migrate dtes --dry-run   # 書き換えるものと残るものを示す
   dt migrate dtes             # その場で書き換える。書き換えられないものがあれば 1 で終わる
   ```

   各コマンドでキーワードだけを変え、コメントと配置は保ちます:

   ```dtes
   // before (0.7.0)
   command ConfirmOrder "注文を確定する" {
     actor Customer
     target Order
     emits OrderConfirmed
   }
   // after (0.8.0)
   command ConfirmOrder "注文を確定する" {
     by Customer
     handledBy Order
     emits OrderConfirmed
   }
   ```

   書き換えられなかったと示されるもの: コマンド以外の要素の `actor` / `target`（それが属するコマンドに移すか、
   消す）と、読めないファイル。後者はたいてい `by`・`handledBy`・`from` という名前の要素があるためです（それと参照を
   改名して、もう一度実行する）。
2. **`dt check` を実行し、残ったものを決めます。** これは書き換えではなく設計の判断です。わかっていることを書き、
   **誰も決めていないことは推測しません** — エラーを消すためにアクター・集約・イベントを作り出さず、その要素に開いた
   ホットスポットを付けて尋ねます。
   - S024。`handledBy` のない（書き換えの後に最も多い）、発行者のない、`emits` のないコマンド:

     ```dtes
     // before: S024
     command ConfirmOrder {
       by Customer
       emits OrderConfirmed
     }
     // after: 処理者がわかっているとき
     command ConfirmOrder {
       by Customer
       handledBy Order
       emits OrderConfirmed
     }
     // after: わからないとき（エラーのヒントが示すホットスポット）。開いている間 S024 は出ない
     hotspot ConfirmOrderOpen "誰が処理する？" {
       on ConfirmOrder
     }
     ```

     ポリシーが `issues` するコマンドに `by` は要りません。
   - S025: ポリシーが発行するコマンドから `by` を消します。手でも発行する人がいれば、その人を `by` にした別の
     コマンドにします（またはポリシーをその人の `by` にします）。
   - S026: 繰り返した関係を消します。S027: その要素が関わる関係に名前を書くか、消すか、ホットスポットを付けます。
     S028: 外部システムから `from` で来るイベントを、コマンドでも発生させません（そのコマンドを外部システムの
     `handledBy` にするか、イベントを 2 つにする）。
   - S003 / S006: ヒントに従います（集約を `by` → `handledBy`、イベントを `reads` → `readmodel { from … }`）。
   - S029 はインフォで、直す必要はありません。残るのが警告とインフォだけなら `dt check` は 0 で終わります。
3. **`dt fmt` を一度実行し**、別にコミットします: 句を並べ替え、繰り返した関係をまとめます。
4. **`dt check --format json` を読むもの**は、重大度 `info` と `summary.infos` を受け付けるようにします。
5. **`.dt` のモデル**に警告 M026 と M027 が出ることがあります:

   ```dt
   // before: M026, M027
   union Status { Draft {} Sent {} }
   customerId: String
   // after（警告のヒントのとおり）
   enum Status { Draft Sent }
   references customer: CustomerId -> Customer
   ```

6. `dt generate ts` で**生成し直します**: 生成された契約テストは、マイナーバージョンの違う domaintrail では読み込みに
   失敗します。
7. **設定**: 変えるものはありません。`knowledge` と `agent.extract` のセクションが新しくできました。ナレッジの抽出は
   `knowledge.extraction.enabled` を設定するまで（またはファシリテーターがセッションで 💡 で有効にするまで）オフです。

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

[0.13.1]: https://github.com/hisamekms/domaintrail/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/hisamekms/domaintrail/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/hisamekms/domaintrail/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/hisamekms/domaintrail/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/hisamekms/domaintrail/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/hisamekms/domaintrail/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/hisamekms/domaintrail/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/hisamekms/domaintrail/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/hisamekms/domaintrail/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/hisamekms/domaintrail/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/hisamekms/domaintrail/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hisamekms/domaintrail/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hisamekms/domaintrail/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hisamekms/domaintrail/compare/b9f56885cde82f404bbf6b558f43b8ecb6254dfe...v0.2.0
[0.1.0]: https://github.com/hisamekms/domaintrail/tree/b9f56885cde82f404bbf6b558f43b8ecb6254dfe
