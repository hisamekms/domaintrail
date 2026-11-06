# Event Storming DSL (`.dtes`) v0.1 — 実装設計書

> 対象: Claude Code / Codex による実装
>
> ステータス: 設計合意事項の統合版（2026-10-31、最終仕様反映版。2026-11-03 に Design Level のみの Event（`level design`、§3.6）と、段階・例外・合流（`stage` / `exception` / `then`、§3.7）を追加。2026-11-06 に関係を Event Storming のデザインレベルの文法そのものに作り直した（ADR 0032：`by` / `reads` / `handledBy` / `emits` / `on` / `issues` / `from`、§3.2、§3.8、§4、§9.1、§11）。v0.1 の `actor` / `target` 関係はエラーで、`dt migrate dtes` が書き換える。同日、`reads` を判断する者の行に書くことにした（ADR 0032 §9：Policy が発行する Command の `reads` は Policy に書く。Policy が発行する Command は1つ）。本書中の **確定** は対話で採用した方針、**提案** は実装を進めるための具体化、**要確認** はリポジトリの現行実装との照合が必要な項目を意味する。
>
> 対象プロジェクト: DomainTrail（`.dt` の既存実装に独立した `.dtes` を追加）。既存のパーサー／型体系／CLI／描画基盤を先に調査して適合させること。**本書の `.dt` サンプルを現行パーサーで動く構文と決めつけない。**

## 1. 目的と非目的

### 1.1 目的【確定】

- AI（Claude Code / Codex）と人間が Event Storming を協働し、Big Picture から Design Level へ段階的に具体化する。
- **UC1**: Event Storming（`.dtes`）から型付き Domain Model（`.dt`）を作る。
- **UC2**: 既存の簡易 `.dt` を元に Event Storming を実施し、ホットスポット・例外・不足を発見して `.dt` を改善する。
- 同一 `.dtes` から **Big Picture / Design Level** と **統合キャンバス / 名前付き timeline フィルタ**を切り替える。
- `.dtes` と `.dt` の対応を明示的・任意の参照で記述し、可能な範囲で静的検査する。
- AI が生成・編集しやすい、明確な局所構文と確定的なバリデーションを優先する。

### 1.2 非目的【確定】

- `.dtes` に座標、ビュー、レイアウト指定、手動配置、描画位置を記述しない。
- Event Storming を実行可能なワークフロー言語や状態遷移の厳密な仕様にはしない。
- `.dtes` の `on` / `issues` / `emits` から実行成功、必須性、順序、リトライ、トランザクションを保証しない。
- `.dt` と `.dtes` を自動的に双方向同期・上書きしない。
- 単一の timeline が全 Event を網羅するとは仮定しない。
- v0.1 に Policy の条件式、AND/時間窓、ガード、排他分岐、補償、分散トランザクションを持ち込まない。

## 2. ファイルとスコープ

- `.dtes` は `.dt` と**独立したテキスト DSL**。【確定】
- `.dt` と同様に、ユーザー指定の **workspace root** 以下を共通コンテキストとして扱う。【確定】
- `storming <ID> "表示名" { ... }` が Event Storming の単位。【確定】
- Event / Command / Policy / Actor / External System / Aggregate / Read Model / Hotspot / Timeline（`exception` を含む）/ Group / Stage の **ローカル ID は storming 内で種別横断の単一名前空間に属し、一意**。異なる種別間の衝突も Error。【確定】
- 異なる storming 間の要素参照は v0.1 では扱わない。【提案】
- `.dtes` には所属 BC の暗黙指定を設けない。【確定】
- `ref` は `ref <BC>.<Model>[.<Member>]` の**完全修飾名**を必ず使う。省略形・名前による暗黙マッチングは禁止。【確定】
- `ref` は任意で、1要素につき最大1件。概念的な対応（一致）を表し、単なる緩い関連ではない。【確定】
- `.dt` 側シンボルが未存在の探索段階では `ref` を省略する。`.dtes` 未参照要素に警告しない。【確定】

## 3. 語彙と意味論

### 3.1 要素

| 要素 | 意味 | 備考 |
|---|---|---|
| `event` | 業務上起こった出来事の型（過去形の事実） | `timeline` から参照される。`level design` で Design Level のみに表示（§3.6） |
| `actor` | Command を発行し得る人・役割 | 複数の Command から参照可 |
| `external` | Command を発行し、処理し、Event を送り得る外部システム | `by`・`handledBy`・Event の `from` の参照先 |
| `command` | 実行を試みる業務上の操作 | 処理するもの（`handledBy`）はちょうど1つ（未決定なら未解決の Hotspot で問う） |
| `policy` | Event に反応して Command を発行し得る業務ルール | **BC 横断可** |
| `aggregate` | Command を処理する整合性境界の候補 | `.dt` Aggregate に任意で `ref` |
| `readmodel` | 発行者が Command を決めるために見る情報 | DB アクセス仕様ではない。`from` で反映元の Event |
| `hotspot` | 未解決/解決済みの疑問・重要事項 | 解決済みは選択的に残す |
| `timeline` | Event 発生の**部分的な時間順序** | 複数個可、Event のみ |
| `group` | 同一ステップの Event 群（内部は順序なし） | timeline 内に記述 |
| `exception` | 本流から分岐する例外の timeline | `timeline` と同じ本体。最後に `then` を書ける（§3.7） |
| `stage` | 流れの時間的な区切り（段階）。本流と例外をまとめる | `after` で順序づける（§3.7） |

### 3.2 関係と多重度【確定した設計方針】

| 所属 | 記述 | 対象 | 多重度 | 意味 |
|---|---|---|---|---|
| Command | `by A` | Actor または External System | 1..N（Policy が `issues` する Command は 0） | 発行し得る主体。複数なら代替的な発行主体であり AND ではない |
| Command | `reads R` | Read Model | 0..N（Policy が `issues` する Command は 0） | 発行者が判断に見る情報。描画は Read Model → 発行者 |
| Command | `handledBy G` | Aggregate または External System | **1** | Command を受けて処理し、結果の Event を生むもの |
| Command | `emits E` | Event | 1..N | 発生し得る結果（処理するものが生む）。必須・排他・全列挙ではない |
| Policy | `on E` | Event | **1..N** | いずれかの Event を契機に Policy が評価され得る（OR） |
| Policy | `reads R` | Read Model | 0..N | Policy が判断に見る情報（ADR 0032 §9）。描画は Read Model → Policy |
| Policy | `issues C` | Command | **1** | 発行し得る Command。実行を保証しない。2つ以上は S031 |
| Event / Aggregate / Command | `ref ...` | `.dt` | **0..1** | 型の合う `.dt` シンボルへの明示対応。他の要素では禁止 |
| Policy | `by A` | Actor | 0..N | 人が手で適用するルールのとき、その人（ADR 0032） |
| Read Model | `from E` | Event | 0..N | 反映元の Event |
| Event | `from X` | External System | 0..N | Command を経ずに外部システムから届く Event |
| Hotspot | `on X` | Hotspot 以外の付箋 | 0..1 | 関連する付箋。因果ではない |
| Event | `level design` | — | 0..1 | Design Level のみに表示する（§3.6）。値は `design` だけ |

関係のキーワードはこの7つだけ（別名なし）。`emits A, B` のようにカンマで並べた一覧は1つの節で、`emits A` と `emits B` に同じ。Command 同士をつなぐのは Policy だけ。Command の多重度（`by` または Policy、`handledBy`、`emits`）を満たさないことは Design Level のエラー（S024）だが、その Command に**未解決の Hotspot が `on` している間は**未決定の問いとして許す（§3.8）。

**複数 `on` を持つ Policy は許可**。**Policy が発行する Command は1つ**（ADR 0032 §9、S031）：複数の Command を出すなら Command ごとに Policy を分け、それぞれが判断に見るものを `reads` に書く。1つの Command を複数の Policy が発行するのは許す。`rule` のネストは v0.1 で導入しない。

**Policy は BC を横断してよい**。Policy 自体の所有 BC を `.dtes` で指定する必要はない。実装上の責任・配置は `.dt` 化やアプリケーション設計で決定する。

### 3.3 `reads` の明確化【確定】

`reads DeliveryDetails` は「判断する者が判断に DeliveryDetails の情報を使う」を意味し、判断する者の行に書く（ADR 0032 §9）。人・外部システムが出す Command では Command に書き（その `by` の全員の付箋へ描く）、Policy が出す Command では Policy に書く（Read Model → Policy の付箋へ描く。Policy が出す Command の `reads` は S030）。Policy に `by` があるときも Policy に書く（当てはめる人が見るもの）。データベースクエリ、Actor が読む UI の実装、Command Handler が読む依存関係を特定しない。複数可。Read Model に `.dt` で対応する型がないことはエラーにしない。

### 3.8 未決定の関係【確定（2026-11-06 追加、ADR 0032）】

Design Level の不完全さ（発行者・処理するもの・結果のない Command、`on` か `issues` のない Policy、どの関係からも名指されない Actor / External / Aggregate / Read Model）はエラーにする（S024、S008、S027）。ただし、分からない関係を**推測で埋めてはならない**。未決定であることは、その要素に `on` する未解決の Hotspot で書く。Hotspot が未解決（`status resolved` でない）の間、その要素の不完全さのエラーは出ない。解決したら関係を書く。Hotspot が問うのはその最初の `on` の要素だけ。問いのまま残っている不完全さは隠さない：`dt check` が一覧を出し、Live View は欠けた発行者・処理するものの位置に破線の空の付箋を描く。Command も Policy もない storming（Big Picture）には不完全さはない。外から届くものは、外のシステムが決めた事実を記録するだけなら `event E { from Ext }`、届いたものについて我々の集約が判断するなら `by Ext` の Command。定期的な処理は時刻の Event と、それに `on` する Policy で書く。

```text
command ReassignByHand "手で配車し直す" {
  by Dispatcher
  emits CarAllocated
}
hotspot WhoReassigns "手配車は何が処理する？" {
  on ReassignByHand
}
```

### 3.4 Timeline の意味【確定】

- 本体には **Event ID の参照のみ**。Command / Policy / Actor / Aggregate / Read Model は含まない。
- `group` 内も Event 参照のみ。group 内は順序を持たず、group の前後との大まかな順序だけを持つ。**同じ group 内での同一 Event ID の重複は Error**。別 group・別ステップでの反復は合法。
- Event 型は複数 timeline や同一 timeline に繰り返し登場してよい。これらは**異なる EventOccurrence**。
- timeline は因果の証明でも完全な履歴でもない。省略可、部分的な時間順序である。
- 異なる timeline の前後関係は統合してグローバルな時刻順にしない。
- `group` に配置・ビューメタデータの意味を与えない。

### 3.5 Hotspot【確定】

- `status open | resolved`。省略時は `open`。
- `resolved` なら `resolution "..."` を必須とする。
- `open` に `resolution` を付けることは禁止（Error）。【確定】
- `resolved` は**業務認識の合意**を意味し、`.dt` に実装済みであることは意味しない。
- 解決済みの重要な例外・境界・不変条件は選択的に残し、些細なものは削除可能。履歴専用 DSL は不要（Git に委ねる）。

### 3.6 Design Level のみの Event【確定（2026-11-03 追加）】

- Event は本体に `level design` を書くと **Design Level のみ**に表示される。仕組み側の細かい出来事（引当・与信・内部の失敗や再試行など）を、Big Picture の業務の流れから外すためのもの。
- 書かなければ両方の抽象度に表示する（従来どおり）。`level big-picture` は書かない（Error）。値は `design` のみ。
- `level` を書けるのは Event だけ（他の要素は Error）。1つの Event に2つ以上は Error。`ref` との順序は自由で、正規の位置は本体の最後（`ref` の後）。`dt fmt` は句を正規の順に並べる（ADR 0032：`ref`・`by`・`reads`・`handledBy`・`emits`・`on`・`issues`・`from`・`status`・`resolution`・`level`。Policy は `on`・`reads`・`issues`・`by`（ADR 0032 §9）。同じキーワードの関係は1つの一覧にまとめる）。
- Big Picture に「昇格」させるときは `level design` を消す。`.dtes` の意味（timeline の順序、関係、`ref`）は変わらず、表示だけが変わる（§6）。

### 3.7 段階・本流・例外・合流【確定（2026-11-03 追加）】

```text
stage Issuance "コンビニでの発行" after Preparation {
  timeline IssuanceFlow "通常" {
    ConvenienceStoreVisited
    GovernmentServiceMenuSelected
    MyNumberCardRead
    PinEntered
    MyNumberCardCollected
  }
  exception PinLocked "暗証番号のロック" {
    MyNumberCardRead
    PinLockedOut
    PinResetAtCityOffice
    then PinEntered
  }
}
```

- **本流と例外は書いて区別する**。`timeline` は本流、`exception` は例外。順序から推測しない。
- **区画（section）** は段階（`stage`）か、段階のない storming のトップレベルの timeline 群。区画の最初の `timeline` を **幹（trunk）** とし、統合キャンバスで一直線に時系列順で描く。幹以外の timeline（別の本流・例外）は先頭ステップで分岐する: その先頭ステップが幹にあればそこから（先頭なら従来どおり prefix を共有）、なければ分岐済みの別の timeline にあればそこから。どこにもなければ **宙に浮いた** timeline（S019）として区画の先頭から別に描く。分岐点の Event は1枚だけ描く（その Occurrence は分岐点のノードに属する）。
- 同じ Event が幹に複数回あるときは最初の出現から分岐する。先頭ステップが単独の Event なら同じ Event か group の要素に、group なら同じ要素集合の group に一致する。
- **合流 `then <Event>`** は例外だけが最後に書ける（本流に書くと S018）。最後のステップの後、本流（`timeline`）のその Event のステップへ戻る。探す順は同じ区画の幹、同じ区画のほかの本流、ほかの区画の本流（時間順）。前の段階（再試行）にも後の段階（郵送で取り寄せた証明書を確かめる）にも戻れる。
- **段階の順序 `after <Stage>`**: 1つまで（2つ目は S004）。自分自身・循環は S017。`after` のない段階は先頭の1つを除き S021（警告）で、それより前に書かれた段階の後に別の始点として描く。`after` は前の段階の幹の最後から、この段階の幹の最初へのエッジになる。
- Event は storming に宣言したまま。段階の中には timeline と exception だけを書く。同じ Event を複数の段階で使ってよい。
- 段階を使う storming では、すべての timeline / exception を段階に入れる（外にあれば S020）。
- 段階も `exception` もない storming は従来どおり（共通 prefix 統合、§8）。`exception` があれば、段階がなくても区画として描く（§8.6）。
- `level design`（§3.6）との関係: Big Picture で分岐点が非表示なら、その直前の見える幹のステップ（なければ区画の先頭）から分岐する。`then` の戻り先が非表示なら、その後の見える最初のステップ（なければ直前）へ戻る。

## 4. `.dtes` サンプル（構文の基準例）

> 以下は新設する `.dtes` の**目標構文**。実装に合わせて表面的なパーサー規則を調整する際は、意味論を変更しないこと。

```text
storming DeliveryCancellation "配送キャンセル" {
  event ShipmentCancelled "配送がキャンセルされた" {
    ref Delivery.ShipmentCancelled
  }
  event BikeReleased "車両割当が解除された" {
    ref Fleet.BikeReleased
  }
  event SlotReleased "配送枠が解放された"
  event ReleaseFailed "車両割当の解放に失敗した"

  actor Customer "顧客"
  external PaymentGateway "決済サービス"
  readmodel DeliveryDetails "配送詳細"

  aggregate Shipment "配送" {
    ref Delivery.Shipment
  }
  aggregate BikeAssignment "車両割当" {
    ref Fleet.BikeAssignment
  }
  aggregate ShipmentSlot "配送枠"

  command CancelShipment "配送キャンセル" {
    ref Delivery.Shipment.cancel
    by Customer
    reads DeliveryDetails
    handledBy Shipment
    emits ShipmentCancelled
  }
  command ReleaseBike "車両割当解除" {
    ref Fleet.BikeAssignment.release
    handledBy BikeAssignment
    emits BikeReleased, ReleaseFailed
  }
  command ReceivePaymentNotice "決済通知受領" {
    by PaymentGateway
  }
  command ReleaseSlot "配送枠解除" {
    handledBy ShipmentSlot
    emits SlotReleased
  }

  policy CleanupAfterCancel "キャンセル後処理" {
    on ShipmentCancelled
    issues ReleaseBike
  }
  policy FreeSlotAfterCancel "キャンセル後に枠を空ける" {
    on ShipmentCancelled
    issues ReleaseSlot
  }

  timeline Normal "通常キャンセル" {
    ShipmentCancelled
    group CleanupResults "後処理" {
      BikeReleased
      SlotReleased
    }
  }

  timeline Failure "車両解放失敗" {
    ShipmentCancelled
    ReleaseFailed
  }

  hotspot NoticeOutcome "決済通知を受けて、どの集約が何をする？" {
    on ReceivePaymentNotice
  }
  hotspot Compensation "車両の解放に失敗した場合、配送キャンセルを補償する？" {
    on ReleaseFailed
    status open
  }
}
```

**注**: `ReceivePaymentNotice` は External System が Command を発行し得ること（`by`）を示す構文例であり、処理するものと結果はまだ決まっていないので Hotspot `NoticeOutcome` で問う（§3.8）。外部システムに処理させる Command は `handledBy` で書く。実際の業務内容に応じて命名する。上記の `ReleaseFailed` は、実際に Event として採用するかを業務で検討した例であり、異常結果の厳密な排他性は DSL から導かない。`group` の `CleanupResults` は表現上の命名で、ビューのレイアウト命令ではない。

Design Level のみの Event（§3.6）は本体の最後に `level design` を書く。

```text
event BikeLocked "車両がロックされた" {
  ref Fleet.BikeLocked
  level design
}
```

## 5. `.dt` 連携と検証範囲

### 5.1 `ref` の解決【確定】

- `event` の `ref` → 対応する `.dt` Domain Event。
- `aggregate` の `ref` → 対応する `.dt` Aggregate。
- `command` の `ref` → 対応する `.dt` Command（Aggregate のメンバーを含む）。
- **Policy / Actor / External System / Read Model / Hotspot / Timeline に `ref` を書くことは禁止（Error）**。`.dt` に偶然似たシンボルがあっても v0.1 では許さない。【確定】
- 全参照は workspace root 内で解決する。

### 5.2 照合の強さ

| 照合 | 既定レベル | 備考 |
|---|---|---|
| 構文、重複 ID、参照先型の誤り、存在しない `ref` | Error | 形式的に確定できる |
| Command `ref` と `handledBy` の Aggregate の `ref` の不整合 | Warning | 探索中の仮説を許容 |
| 両側で `ref` 解決済みの Command `emits` と `.dt` emitted Event の矛盾 | Warning | `.dtes` は発生可能性の部分記述。誤検知を避け、証明できる不一致のみ |
| `.dtes` の Command に `emits` がない | Error（S024。未解決の Hotspot が `on` していれば問いとして許す。ADR 0032） | 推測で埋めない |
| `.dtes` の Read Model に `.dt` 対応がない | 診断なし | 設計段階でよい |
| `.dt` の State / Command / Event が `.dtes` に欠落 | 診断なし | `.dtes` は網羅的でない |
| Policy の BC 横断 | 診断なし | 許可済み |

`emits` に関しては**列挙が一致しないだけで Warning にしない**。`.dtes` が挙げた Event が、`.dt` の網羅的・確定した契約で明確に否定できる場合だけ Warning。現行 `.dt` の `emits` の厳密な契約・完備性をコードから確認すること。【要確認】

### 5.3 自動変更は禁止

- `.dtes` から `.dt` を AI が生成するのは UC1 のワークフローとして可能だが、ツールが確認なしに既存 `.dt` を上書きしない。
- `.dt` の変更で `.dtes` を自動書換えしない。破損した `ref` を診断し、AI/人間が修正する。
- Rename については LSP で参照追従を検討し、Event の分割や概念変更は手動判断とする。

## 6. 表示モード【確定】

**2軸は独立**する。

```typescript
type ViewOptions = {
  level: 'big-picture' | 'design-level'
  timelineId?: string // 省略 = 統合キャンバス
  stageId?: string // 段階ビュー（§3.7。timelineId とは併用しない）
  hideExceptions?: true // 例外を表示しない（統合キャンバスと段階ビューのみ）
}
```

| 要素 | Big Picture | Design Level |
|---|---|---|
| Event | 表示（`level design` の Event は非表示） | 表示 |
| Timeline の順序 | 表示（非表示の Event を飛ばして前後をつなぐ） | 表示 |
| Hotspot | 表示 | 表示 |
| Actor / External System | 非表示（v0.1 の既定） | 表示 |
| Command / Policy / Aggregate / Read Model | 非表示 | 表示 |
| 型レベルの因果関係 | 非表示 | 表示 |
| `.dt ref` | ノード詳細等で参照可 | ノード詳細等で参照可 |

- Big Picture は**詳細を隠した投影**。詳細化前の過去モデルを復元する機能ではない。
- Big Picture では `level design` の Event（§3.6）を、その timeline のステップが書かれていないものとして投影する。順序エッジは前後の Event をつなぎ、全要素が非表示の `group` は描かない。共通 prefix 統合（§8）は表示される列で行う。Hotspot は表示し、非表示の Event への `on` だけを描かない（timeline フィルタでも、その timeline の Event への `on` を持つ Hotspot は表示する）。
- Big Picture に戻しても、Design Level で追加・分割した Event 定義は消さない。
- 名前付き timeline の選択に応じて、その timeline の EventOccurrence と関連要素を抽出。
- 統合キャンバスでは timeline に属さない Event や孤立した要素も表示。
- **使われるごとに描く要素**【確定（2026-11-03 追加）】: Design Level では Actor / External System（Command の発行者、`by`）、Read Model（Command の `reads`）、処理するもの（Command の `handledBy`）を、そのビューで使う Command ごとに1枚ずつ、その Command の隣に描く（線は付箋と Command の間の短い1本。Aggregate からは、その Command の Event への `emits` も出る）。どの Command にも使われないものは従来どおり1枚。表示上の分割で、`.dtes` も意味的なグラフも変わらない。
- **関係の描き方（ADR 0032）**【確定（2026-11-06 改訂）】: 前後の2項目の `actor` は `by`（発行者：Actor か External System）、`target` は `handledBy`（処理するもの：Aggregate か External System）に読み替える。Read Model の付箋はその Command の発行者の付箋へつなぐ（発行者のいない Policy の Command では Command へ）ので、Read Model に導かれる発行者は Command の上に貼らず、Read Model → 発行者 → Command と並ぶ。`handledBy` が External System のときも同じく処理するものの付箋から `emits` を描く。Read Model の `from` は Event → Read Model の点線の矢印、Event の `from` は External System の付箋（その Event の付箋ごとに1枚）→ Event の因果の線。Hotspot はどの付箋にも `on` でき、その付箋（の各コピー）の上に貼る。Big Picture では、Design Level の付箋に `on` する Hotspot は描かない。同じ Event の付箋に至る複数の Command が同じもの（同じ Aggregate、または同じ External System）に処理されるとき、処理するものはその Event の付箋の前に1枚だけ描き（各 Command → その1枚、その1枚 → Event は1本。その線は元の Command の `emits` すべてを表し、ホバーで Command を示す）、Event の付箋をまたいでは合わせない（別ステップの同じ Event には別々に描く）。処理するものが違えば合わせず、発行者は Command ごと。Command は共有しない Event のために自分の処理するものも持つ。グリッドでは合流する Command を隣り合わせ、その行の中央に置く。
- **Event Storming の文法で描く**【確定（2026-11-05 追加）】: Design Level は一般的な Event Storming の読み方で左→右に描く。Read Model → 発行者 → Command → 処理するもの → Event → Policy → Command …。`handledBy` のある Command は処理するものを経て Event に至る（Command → 処理するもの、処理するもの → Event。`emits` の意味的エッジのキーは変えない）。`handledBy` のない Command は Command → Event。Hotspot は `on` の付箋に貼る注記で、流れの1ステップにはしない（その Event の上に置く）。1つのビューで Event が複数のステップに描かれるとき（timeline のビューで繰り返す Event、段階・例外のある storming）は、その Event を `emits` する Command（とその Actor・Read Model・Aggregate）、その Event に `on` する Policy、その Event への Hotspot を、ステップごとに1枚ずつ描く（ID `n:<要素>#<k>`。§7.3・§10.2 の表示上の分割）。Policy の付箋は、自分のステップの次にある Command の付箋へ `issues` を描く（後ろに無ければすべてへ）。統合キャンバス（段階・例外のない storming）は Event を1枚に描くので、この分割はしない。どの付箋を選んでも同じ要素を選び（インスペクタは1つ）、同じ要素のほかの付箋を控えめに示す。変更マーク・参照・在席表示は要素に付くので全部の付箋に出る。チャットやカタログから要素へ飛ぶときは、画面の中央に最も近い付箋を選ぶ。
- 複数 timeline フィルタ／抽象度切替は `.dtes` を変更しない。
- **段階・例外のある storming**（§3.7）: 統合キャンバスは区画を時間順に左→右へ並べ、段階をラベル付きの枠で描く（§8.6）。**段階ビュー**（その段階の本流と例外を同じ描き方で統合）を段階ごとに選べる。名前付き timeline のビューは従来どおり。
- **例外の表示切替**（「例外を表示」）: 統合キャンバスと段階ビューで、例外を描かないこともできる。そのとき例外のステップ、例外にしか現れない Event、それらだけに付いた Hotspot、例外の `then` を描かない。デザインレベルでは、例外にしか現れない Event だけに関わる要素（それだけを emits する Command、それだけに `on` する Policy とそれが issues する Command、それらの Command の横の Actor・外部システム・Read Model・集約のコピー）も描かない。例外そのものの timeline ビューには影響しない。表示状態は閲覧者ごとの UI 状態で、`.dtes` を変更しない。

## 7. グラフの3階層【確定】

### 7.1 Semantic IR

Event、Command、Policy 等の**型レベルのモデルと明示的な関係**。timeline とは独立。

### 7.2 Timeline / EventOccurrence

EventDefinition は storming 内に1つ。timeline 内の参照位置ごとに EventOccurrence を生成する。2 timeline に同じ Event ID が現れても、実世界の同じ発生とは**断定しない**。

### 7.3 Render Graph

ビュー用のノード・エッジ。単一 RenderNode が**同じ Event 型**の複数 Occurrence を代表できる。ただし共有は**純粋な描画上の最適化**。因果的な意味や EventOccurrence の同一性を生成・変更してはならない。

```typescript
// 概念的なインターフェイス。現行コードの型を調査して調整する。
type EventOccurrence = {
  timelineId: string
  stepPath: number[] // group を含む構文位置。一時的識別子
  eventId: string
}

type RenderEventNode = {
  id: string
  eventId: string
  occurrences: EventOccurrence[]
}

type SemanticEdge = {
  sourceId: string
  targetId: string
  kind: 'by' | 'reads' | 'handledBy' | 'emits' | 'on' | 'issues' | 'readmodel-from' | 'event-from' | 'hotspot-on'
}
```

Event 以外の要素は1ビュー1ノードだが、Actor / External System / Read Model / Aggregate は使う Command の付箋ごとのノード（ID `n:<要素>@<Command の付箋>`、要素の ID は共通。§6）になり、Command / Policy / Hotspot はその Event が描かれるステップごとのノード（ID `n:<要素>#<k>`。§6）になり得る。これも描画上の分割で、意味的な関係を増やさない（`emits` は Aggregate の付箋から描いても、同じ意味的エッジの描画である）。

**重要**: 同一 EventOccurrence を2か所に描画する案は将来の高度化として残す。**v0.1 の基本投影では各 EventOccurrence はちょうど1つの Event RenderNode に所属**し、同一 RenderNode 内に同じ timeline の異なる Occurrence を混在させない。

## 8. 共通 prefix 統合【確定】

### 8.1 ルール

- 同じ storming 内の timeline について、**先頭から連続して一致するステップ**を描画上で共有する。
- 最長共通部分列（LCS）や共通 suffix の自動統合は行わない。
- Event 型が一致しないステップは共有しない。
- 同じ timeline の異なる EventOccurrence は共有しない。
- `group` は同一ステップの Event の**集合**として扱う（順序なし、同一 Event ID の重複禁止）。【確定】
- `group` ID や Event 記述順は `group` 同値判定に使用しない。
- `group` と単独 Event は部分統合しない。
- shared prefix は**描画共有**であり、同一業務発生との認定ではない。
- timeline 宣言順や Map 走査順で結果が変わらないようにする。

### 8.2 例

```text
Normal:   Assigned → Started → Completed
Absence:  Assigned → Started → Absent → Returned
Retry:    Returned → Scheduled → Started → Completed
```

`Normal` と `Absence` は `Assigned → Started` を共有。`Retry` の `Started` と `Completed` は共有しない。

```text
A: Assigned → group {Completed, Failed}
B: Assigned → group {Failed, Completed}
```

比較上は同じ prefix group（両者のイベント型集合が等しい）。group に**内部順序エッジを生成しない**。

### 8.3 Trie 実装方針【提案】

1. 各 timeline を `Step = Event(eventId) | Group(sorted unique eventIds)` の列に変換。
2. `root` から同じ StepKey の子を共有する Prefix Trie を構築。
3. 各 EventOccurrence を該当 Trie Node の RenderNode（group の場合はその各 Event 要素の RenderNode）へ紐付ける。
4. 分岐以降は独立ノードを作る。
5. timeline 未所属の Event は独立した表示ノードを作る（統合ビュー）。
6. 必要に応じ、描画上の読みやすさから共有ノードを複製する高度化は v0.1 **非対象**。まず決定的な Trie 表示を実装する。

**group 注意**: group 内で同種 Event が2回現れたら静的 Error。正常入力では各 Event は一度だけ出現する。StepKey の正規化は比較専用であり、元の構文位置を EventOccurrence に保持する。group の個々の Event は相互に順序づけない。

### 8.4 同一 prefix だが別の業務経過の場合

先頭の Event 型系列が一致しても、実際に同じ出来事とは断言できない。v0.1 ではビュー上で共有し、ノード詳細に複数 timeline の所属を示す。**業務同一性を要求する推論や実行保証に使用しない**。明示的な発生共有 DSL は導入しない。

### 8.5 統合キャンバスの描画【確定（v0.1 改訂）】

Render Graph（§7.3、本節 8.1〜8.4）は prefix trie のまま変えない。Live View の**統合キャンバス**だけは、それを次のように描く。

- Event 型ごとに付箋を**1枚**にする（trie の分岐後に同じ Event 型が複数の RenderNode になっても、1枚にまとめる）。
- `group` の枠は描かない。group への順序エッジは、その各 Event への順序エッジとして描く。
- 順序エッジは「A の直後に B」ごとに1本にまとめ、そのエッジを通る timeline を添える。全 timeline が通るエッジには添えない。
- 同じ Event が続くときは、その付箋への自己ループになる。
- 付箋の共有は描画だけの扱いで、EventOccurrence の同一性や SemanticEdge は変えない（§7.2、§8.4）。合流した付箋を経由して、どの timeline にも無い経路が読めてしまうため、timeline 名を添える。

個別 timeline のビューは従来どおり、Occurrence ごとに付箋を置き、`group` を枠で描く。

### 8.6 区画として描く統合キャンバス【確定（2026-11-03 追加）】

段階または `exception` のある storming（§3.7）の統合キャンバスと段階ビューは、prefix trie の代わりに区画ごとの木で描く。

- 区画の木: 幹を先頭から、ほかの timeline を分岐点のノードから挿入する。分岐点の先頭ステップは分岐点のノードを共有し（§8 の prefix 共有と同じ扱い）、その後も同じように続く timeline はステップを共有する。分岐後の共通 suffix は共有しない（§8.1）。
- 配置（**時間順が左→右**）: 1ステップ1列（Design Level では列の組。下記）。区画を時間順に横に並べ、幹の Event は全段階を通る1本の行。ほかの timeline は分岐ステップの下の **レーン** に右へ流れる（重ならないレーンは同じ行を共有し、別の本流を例外より上に置く）。例外は段階の枠の中に収める。Design Level では Event Storming の文法（§6）どおり、各ステップを左から Read Model・Command（その発行者を上に置く）・処理するもの・Event（その Hotspot を上に置く）・Policy の列に分け（そのステップの列で使うものだけ）、要素はその Event のレーンの行の上の帯に置く（例外の Event の要素は例外のレーンの上）。Command・Aggregate・Read Model は1行に並び、複数の Command は帯の中で縦に積む。どこにも属さないものは区画の下に置く（2026-11-05 改訂）。
- 線: 段階の `after` は前の幹の最後から次の幹の最初へ。例外だけの時間順は例外の線（控えめな赤系の破線）で描く。`then` は最後のステップの下から戻り先の下へ入る点線。どの線も付箋と交差しない（列・行の間を通す）。レーンの最初の線にその timeline のラベルを添える。
- 座標は DSL に保存しない。同じ `.dtes`・同じビューなら同じ配置（canonical）。

## 9. 因果関係と timeline の投影【確定＋実装提案】

### 9.1 意味的エッジ

ADR 0032 で、関係は Event Storming のデザインレベルの文法そのもの（Read Model → 発行者 → Command → 処理するもの → Event → Policy → Command）。

- `Event → Policy` (`on`)
- `Policy → Command` (`issues`)
- `Command → Event` (`emits`。描画は `handledBy` があれば処理するもの（Aggregate / External）の付箋から Event へ。§6)
- `Actor / External → Command` (`by`, 関連)
- `Read Model → Command` (Command の `reads`, 関連。描画は Read Model → その Command の発行者の付箋)
- `Read Model → Policy` (Policy の `reads`, 関連。描画は Read Model → その Policy の付箋。ADR 0032 §9)
- `Command → Aggregate / External` (`handledBy`。描画は因果の線: Command が処理するものに至り、それが判断して Event を出す。§6)
- `Event → Read Model` (Read Model の `from`, 反映)
- `External → Event` (Event の `from`, 因果: Command を経ずに届く)
- `Hotspot → 付箋` (`on`, 非因果)

`on / issues / emits` は可能性・候補を表す。Policy に `on` が複数あるとき、**Event → Command の直接因果エッジを推論・生成しない**（Policy の `issues` は1つ：ADR 0032 §9）。Policy 自身を独立ノードとして保持する。

### 9.2 順序エッジ

- timeline 内のステップ間だけ時間的な順序関係を表示。
- group 内の Event 同士に順序を付けない。
- 異なる timeline の EventOccurrence を共有 RenderNode に投影しても、新しい**SemanticEdge は生成しない**。
- 反対順を持つ別々の timeline を一つの全域時間順序に強制しない。
- 型レベルの因果グラフで循環を検出しても、描画可能にする。無限のノード展開をしない。

### 9.3 フィルタ

- **統合**: 全 timeline の Occurrence とすべての定義済み要素を対象とする。
- **個別 timeline**: 選択 timeline の Occurrence を基点とし、**両端の Event が選択 timeline に出現する** `Event → Policy → Command → Event` の1ホップ候補経路だけを抽出する（Policy と Command をそれぞれ1つ経由）。
- **境界**: 選択 timeline に登場しない Event へ無制限にたどらない。Policy の他の `issues` を自動的にすべて表示する必要はない。
- **安全性**: 選択 timeline 内で因果経路が**実際に起きた**と確定的に描かない。因果エッジは「型レベルの可能な関連」として表示する。
- **確定**: 選択 timeline 上の Event を両端とする `Event → Policy → Command → Event` **1ホップ連鎖**に限定する。対象 Command の `by/reads/handledBy` と両端 Event に `on` で結びつく Hotspot を付加する。片端が timeline 外なら経路を投影しない。孤立した timeline Event は常に表示。多段経路は v0.1 で自動展開しない。
- **Event の原因**【確定（2026-11-03 追加）】: 選択 timeline の Event を `emits` する Command は、Policy に発行されていなくても、その Event の原因として描く（統合キャンバスで同じ Event に描くものと同じ）。その Command の `by/reads/handledBy` を付加し（発行者・Read Model・処理するものは §6 の使われるごとに描く）、`emits` は timeline の Event へのものだけを描く。その Command を発行する Policy は、上の1ホップ連鎖に当たるときだけ描く（Command からさかのぼらない）。段階ビューも同じ規則で、その段階の Event を対象にする。Big Picture では Command を描かないので変わらない。
- `emits` で選択 Event に結びつく Command は型レベルの原因として描くが、対応する `Event → Policy → Command` が存在しなければ、Policy を補ってシナリオ上で発火したと推定しない。統合ビューでは型レベルの全関係を表示できる。

### 9.4 視覚表現

| エッジ | 例示スタイル |
|---|---|
| 流れ：付箋どうしの関係すべて（`by`・`reads`・`handledBy`・`emits`・`on`・`issues`・`from`、Policy の `by`） | 細い実線＋矢印、1色（ADR 0032） |
| 時間：Timeline の時系列（Design Level では例外の分かれ目と `then` の戻りだけ） | 破線＋矢印、同じ色。例外を線の色で分けない |
| 問い：Hotspot の `on` | 細い線、**矢印なし**、控えめな色（解決済みはさらに控えめ） |

線を選ぶ・ホバーすると、その意味を DSL のキーワードを使わない平易な文で示し（「配車を組む は 配車組 が処理する」）、選んだ線の両端の付箋以外を薄くする。

Design Level では Event 同士の時間順の線を描かない（配置が左→右で示す。ADR 0032）。描くのは配置で示せないものだけ：例外のレーンへの分岐と `then` の戻り。Big Picture は時間順の線を描く。

付箋はすべて同じ大きさの正方形で描き、ラベルは折り返す（収まらないときは文字を小さくし、下限の大きさでも収まらないときは収まる行までで「…」で切る。全文はホバーとインスペクタで見られる）。付箋の色は Event Storming の慣習に従って種類を表す：イベント付箋はオレンジ、Command 青、Policy 紫、Aggregate 黄、Read Model 緑、Hotspot ピンク（Actor・External System などの割り当ては `docs/live-view.md`）。色は Live View の表示の約束で、`.dtes` の構文や意味論には含めない。種類は付箋のステレオタイプ（«イベント»）と凡例でも示し、色だけに頼らない。視認性・アクセシビリティを確保すること。

## 10. レイアウトと安定性

### 10.1 原則【確定】

- 自動配置、基本は左→右。
- `.dtes` には座標やレイアウト命令なし。
- 同じ `.dtes`・同じフィルタ・同じエンジンで **canonical layout** は決定的になるようにする。
- 更新時は前回の座標をヒントとする増分配置を許可するため、編集履歴によって細かな位置差が生じてもよい。
- UI 状態・座標は DSL に保存しない。配置変更は DSL の差分を作らない。

### 10.2 優先順位

1. timeline の時間順序（同じ timeline 内）を破らない。
2. ノードが重ならない。
3. shared prefix の分岐を読み取れる。
4. 既存ノードの移動を抑える。
5. エッジ交差や折れ曲がりを抑える。

注意: 全 timeline を一つの順序 DAG にマージして順序矛盾を作らない。レイアウトアルゴリズムが制約を両立できないときは、表示上の分岐/複製を使って整合させ、**Semantic Graph を変更しない**。

### 10.3 ID と差分対応

- `EventDefinition.id` は storming ローカルで安定。
- EventOccurrence の `stepPath` / ordinal は**一時的**。途中挿入で変化する。
- Prefix Trie の path-derived Node ID は append に強いが、中途挿入で後続が変わる。
- 増分描画では旧/新 timeline の編集差分・Event ID・周辺系列を比較し、対応可能な EventOccurrence と RenderNode をマッチングする。
- 同種 Event の挿入などで対応が曖昧なら無理に同一視しない。再生成・再配置を許容。
- `ref` 変更のみなら EventDefinition ID を維持し、描画ノードも原則維持。

## 11. 静的診断とセマンティックレビュー

エラー番号は**提案**。既存プロジェクトの診断体系と衝突する場合は振り直してよい。

| 分類 | 条件 | 診断 |
|---|---|---|
| Syntax | 不正なブロック、未知の関係、構文不備、キーワード（`by`・`handledBy`・`from` など）の ID | Error |
| Removed | v0.1 の `actor`・`target` 関係（S023。`by`・`handledBy` に置き換え、`dt migrate dtes` が書き換える） | Error |
| Symbol | storming 内 ID 重複、未定義参照 | Error |
| Kind | `timeline` に Event 以外、`by` 非 Actor/External、`handledBy` 非 Aggregate/External、Command・Policy の `reads` 非 Read Model、`emits` 非 Event（Command を `emits` しない：Policy を挟む）、`issues` 非 Command、Policy の `on` 非 Event、Read Model の `from` 非 Event、Event の `from` 非 External、Hotspot の `on` が Hotspot。ヒントは意図した関係を示す | Error |
| Cardinality | Command に `handledBy` 2つ以上、`ref` 2つ以上、禁止要素の `ref`、同じ関係の重複（S026） | Error |
| Design | 発行者（`by` か Policy）・`handledBy`・`emits` のない Command（S024）、Policy が `issues` する Command の `by`（S025）、どの関係にも名指されない Actor / External / Aggregate / Read Model（S027）、Command が `emits` し外部からも `from` で届く Event（S028）、Policy が `issues` する Command の `reads`（S030。Policy に書く）、2つ以上の Command を `issues` する Policy（S031）。S024・S027・S008 は未解決の Hotspot が `on` している要素では出さない（§3.8） | Error |
| Group | group 内の同じ Event ID の重複 | Error |
| Policy | `on` 0件、`issues` 0件 | Error |
| Hotspot | 不正 status、resolved なのに resolution なし、`on` の対象不正 | Error |
| Level | `level` が `design` 以外（`big-picture` を含む）、Event 以外の `level`、`level` が2つ以上 | Error |
| Stage | `after` が自分自身・循環（S017）、`then` が本流にある／本流にない Event を指す（S018）、段階の外の timeline（S020） | Error |
| Stage | 宙に浮いた timeline（S019）、2つ目の `after` のない段階（S021）、本流のない段階（S022） | Warning |
| `.dt ref` | 完全修飾でない、未解決、種別不一致 | Error |
| `.dt` contract | 有効な `ref` 同士で証明できる不整合 | Warning |
| Graph | Policy→Command→Event→Policy の型レベル循環 | Warning（無限ループ断定禁止） |
| Policy | 2つ以上の Command を `issues`（S031。Command ごとに Policy を分ける。ADR 0032 §9） | Error |
| Timeline | 因果が示唆する順序と逆に見える | **原則診断しない**（Occurrence 対応未確定） |
| Source | Design Level で、どの Command も `emits` せず、`from` もなく、Policy の契機（時刻の Event）でもない Event（S029） | Info |
| Completeness | 未参照 Event、timeline の部分性、Event の再登場、`from` のない Read Model（Big Picture の完全性） | 診断なし |

静的 checker は自然言語の Hotspot resolution を理解したと**主張しない**。AI によるドメインレビューは別レイヤー（不足、例外、責務、実装との差異を指摘する非決定的な支援）として扱う。

## 12. 受け入れテスト（必須）

### 12.1 DSL / 型検査

- [ ] ES01: 正常な Event/Command/Policy/Read Model/Actor/External/Aggregate/Hotspot/Timeline を `.dtes` からパースできる。
- [ ] ES02: `timeline` に Command を書くと Error。
- [ ] ES03: Command `handledBy` が2件だと Error、0件は（未解決の Hotspot がなければ）S024。
- [ ] ES04: `by`（Actor / External System）、`reads`、`emits` が各複数で合法（`emits A, B` の一覧も）。
- [ ] ES05: Policy の `on` は複数で合法、`issues` する Command は1つ（2つ以上は S031）、欠けたら Error。
- [ ] ES06: `.dt ref` は fully qualified、存在・種別整合性を検証。
- [ ] ES07: `.dt ref` 省略は合法、未参照への網羅性警告なし。
- [ ] ES08: `resolved` Hotspot の `resolution` 必須。
- [ ] ES09: BC 横断 Policy は合法。
- [ ] ES10: 逆順 timeline と因果経路があっても、機械的に Error にしない。
- [ ] ES11: group 内の同じ Event ID の重複が Error。異なるステップでの再登場は合法。
- [ ] ES12: 異種要素間でも ID 衝突が Error。
- [ ] ES13: Policy を含む Event/Command/Aggregate 以外の `ref` が Error。
- [ ] ES14: `external` は Command の `by`・`handledBy`、Event の `from`、Hotspot の `on` で合法。`reads`・`emits` など別種の関係では Error。
- [ ] ES15: Event の `level design` は合法（`ref` の前後どちらでも）。`level big-picture` などの他の値、Event 以外の `level`、2つ目の `level` は Error。
- [ ] ES16: `stage … after …`、`exception`、`then` をパース・整形できる。`after` の未定義（S002）・種別違い（S003）・2つ目（S004）・自分自身と循環（S017）、本流の `then` と本流にない `then` の戻り先（S018）、段階の外の timeline（S020）は Error。
- [ ] ES17: どこからも分岐しない timeline（S019）、2つ目の `after` のない段階（S021）、本流のない段階（S022）は Warning。段階も `exception` もない storming の timeline には S019 を出さない。
- [ ] ES18: stage / timeline / exception の ID は storming の単一名前空間（S001）。

### 12.2 投影 / 描画

- [ ] R01: `A B C` と `A B D` の `A B` を表示共有。
- [ ] R02: `A B C` と `X B C` は suffix を共有しない。
- [ ] R03: 同一 timeline の Event 反復は別 Occurrence / 別ノード。
- [ ] R04: 順序の異なる同じ group 集合は比較上同値。group 内順序を生成しない。
- [ ] R05: group と単独 Event を部分統合しない。
- [ ] R06: timeline 宣言順入れ替えで canonical Render Graph が変化しない。
- [ ] R07: append で既存の prefix RenderNode が安定。
- [ ] R08: 中途挿入で対応可能なノードが維持される（曖昧なら再生成許可）。
- [ ] R09: 複数 `on` / `issues` から直接 Event→Command の直積因果エッジを生成しない。
- [ ] R10: 因果グラフ循環で無限ループ・無限ノード展開しない。
- [ ] R11: Big Picture / Design Level を切替可能。DSL は不変。
- [ ] R12: 統合 / timeline フィルタを切替可能。DSL は不変。
- [ ] R13: `.dt ref` を修正しても Semantic ID は変わらない。
- [ ] R14: Big Picture で Command/Policy を隠しても、`level design` のない Event は消えない。
- [ ] R15: 全体ビューに timeline 未所属の Event が現れる。
- [ ] R16: timeline のフィルタは1ホップの Event→Policy→Command→Event のみ（両端が対象 timeline）投影し、多段連鎖は自動展開しない。Design Level では timeline の Event を `emits` する Command（とその `by/reads/handledBy`）も描く。timeline ビュー・例外のビュー・段階ビューで同じ。
- [ ] R17: Big Picture と Design Level のどちらでも同一 `.dtes` を使い、`external` は Design Level に表示する。
- [ ] R18: `level design` の Event は Big Picture で非表示、Design Level で表示。timeline の順序エッジは前後をつなぎ、全要素が非表示の group は描かず、共通 prefix 統合は表示される列で行う。Hotspot は残り、非表示の Event への `on` は描かない。
- [ ] R19: 段階のある統合キャンバスで、幹の付箋の x 座標は全段階を通して狭義単調増加し、y は同じ。段階の枠は重ならない。
- [ ] R20: 例外は分岐ステップより下・右にあり、その段階の枠の中にある。途中から分岐する例外の分岐 Event は1枚で、本流と例外の Occurrence を持つ。
- [ ] R21: `then` は例外の最後のステップから戻り先（同じ段階・前後の段階）へのエッジ。`after` は前の幹の最後から次の幹の最初へのエッジ。
- [ ] R22: 段階ビューはその段階の本流と例外だけを描き、ほかの段階への `then` を描かない。
- [ ] R23: 2つ目の本流は幹から分岐し、例外の線ではなく本流の線で、例外より上のレーンに描く。
- [ ] R24: 例外を表示しないとき、例外のステップ・例外だけの Event・それに付いた Hotspot・`then` を描かない。例外の timeline ビューは変わらない。
- [ ] R25: 段階も `exception` もない storming の描画は従来どおり（examples/shop の payload は変わらない）。Big Picture で分岐点・戻り先が非表示なら最寄りの見えるステップを使う。どの線も付箋と交差しない。

### 12.3 Property / 不変条件

- [ ] 各 EventOccurrence は v0.1 の基本投影でちょうど1つの Event RenderNode に所属。
- [ ] 1 RenderNode に異なる EventDefinition を混在させない。
- [ ] 1 RenderNode に同一 timeline の異なる Occurrence を混在させない。
- [ ] 描画共有で Semantic IR の node / edge 数が変化しない。
- [ ] Render Graph に存在しない SemanticEdge を追加しない（timeline の表示用エッジは別種）。
- [ ] group 内に時間順序を生成しない。
- [ ] canonical projection は入力順序と無関係に決定的。

## 13. 実装順序（Claude Code 向け）【提案】

1. **Repository reconnaissance**: 現行 `.dt` parser、workspace root、type checker、diagnostics、LSP、描画エンジン、CLI、テスト基盤を調査。差分と制約を報告。
2. **Semantic schema**: `.dtes` AST / IR / Symbol Table を実装。既存基盤との共有可能箇所だけ再利用。
3. **Parser / formatter**: `storming`、要素、関係、timeline、group、hotspot、`ref` を実装。AI が編集しやすい決定的フォーマット。
4. **Validator**: 要素型・多重度・timeline・Hotspot・同一スコープ参照を静的検証。
5. **Cross-file linker**: workspace root 以下の `.dt` symbol と完全修飾 `ref` を照合。存在/種別エラーを先行実装、契約 Warning は現行 `.dt` semantics の確認後。
6. **Graph projection**: Semantic Graph / Timeline / Occurrence / Render Graph を分離し、prefix Trie、group handling を実装。
7. **Views**: 統合 / timeline フィルタ、Big Picture / Design Level を独立の UI state として切替。
8. **Layout**: canonical 自動レイアウト、次いで前回位置を使う増分レイアウト。
9. **Developer experience**: CLI check、エラーメッセージ、定義ジャンプ（既存 LSP があれば統合）、README と examples。
10. **Tests / fixtures**: 本書の受け入れテストと property test を実装し、最小実例で UC1/UC2 を通し検証。

### Claude Code に渡す実装上の指示

- 最初にコードを読んで、**実装済み機能と本書の想定の差分を列挙**する。
- `.dt` の文法・検証機能は、**存在確認なしに捏造・改変しない**。
- 合意済み意味論を変える必要が出た場合は、変更内容と理由を ADR または PR で明示し、勝手に DSL 仕様を拡張しない。
- 特に `group` の順序なし、EventDefinition/Occurrence/RenderNode の分離、Policy の非直積解釈、Big Picture 切替をテストで固定する。
- 原則として後方互換性に配慮し、`.dt` を変更せず `.dtes` を追加する。

## 14. 確定済みの判断と実装時の調査事項

**仕様上の未決事項はない。** 会話で採用した判断を以下に固定する。既存コードの調査は必要だが、調査結果を理由に意味論を無断で変更してはならない。

| 項目 | v0.1 の確定ルール |
|---|---|
| 拡張子 | **`.dtes`**。旧 `.es` は採用しない |
| Grammar・字句 | `.dt` の既存字句・コメント・文字列規則を可能な限り共通利用。実装前に既存 parser を調査し、最終 EBNF と lexer テストを追加する。意味論は本書を優先 |
| ローカル ID | storming 内で全要素（`group` ID を含む）の**単一名前空間**。種別をまたぐ重複も Error |
| Policy の `ref` | **禁止**。`ref` を持てるのは Event / Aggregate / Command のみ |
| group 内重複 | **禁止（Error）**。group は順序なし集合で比較する |
| Hotspot `on` | Event のみ、最大1件 |
| External System | **`external` 宣言を導入**。Command の `by` は Actor / External System を参照可能。ADR 0032 で、Command を処理するもの（`handledBy`）と、Command を経ずに届く Event の送り元（Event の `from`）にもなる |
| CLI | 既存 `dt` CLI と workspace root 指定の慣習に合わせる。別 CLI 製品は作らない。正確なサブコマンド・フラグは現行コードを確認して整合する名称を採用 |
| timeline フィルタ | **1ホップ** `Event → Policy → Command → Event` と、timeline の Event を `emits` する Command。多段自動展開なし |
| レイアウト | 既存描画基盤を優先し、決定的 canonical layout と増分レイアウトを実現。ライブラリ名自体は意味論・公開仕様ではない |
| Occurrence ID | **永続 ID の DSL 構文なし**。構文位置 + 編集差分から一時的に対応付ける |

### 実装調査で決める細部（製品仕様を変えない範囲）

1. 既存 `.dt` parser の tokenizer / escaping / comments / ID 字句を確認して `.dtes` に再利用する。再利用できない場合は同等規則を実装し、差分を記録する。
2. 既存 `dt` CLI / workspace / LSP の拡張ポイントを調査し、`.dtes` を読み込む最小の変更を選ぶ。コマンド表記を README に確定記載する。
3. 既存のレンダラー / graph layout / diagnostics コードを調査し、再利用できる範囲を決める。新しい描画ライブラリの導入は比較理由を記録する。
4. `.dt` `emits` 契約が排他的・網羅的と機械的に判断できるか確認する。判断できなければ推測ベースの不一致警告は追加しない。

## 15. Done の定義

- `.dtes` を workspace から読み込んで check できる。
- UC1: Event のみからスタートして Actor / External System / Read Model / Command / Policy / Aggregate を追加し、`.dt` への `ref` を段階的に増やせる。
- UC2: 既存 `.dt` を参照する `.dtes` から例外と Hotspot を追加でき、無関係な `.dt` を自動変更しない。
- Design Level まで記述済みの**同じファイル**から、Big Picture に戻せる。
- 統合 / timeline フィルタを切り替えられる。
- 共有 prefix による描画統合は**意味上の同一 EventOccurrence を作らない**。
- Policy の複数 Event / 複数 Command、BC 横断、反復 Event、group の順序なし・重複禁止を保持できる。
- 必須受け入れテストが通り、利用例と診断がドキュメント化されている。

---

### 付録：最小 UC1 / UC2 プロンプト

**UC1**

> この業務について担当者と Event Storming を行う。まず `.dtes` に Event / timeline / Hotspot だけを記述し、不明点を質問する。合意が得られたら Actor / Read Model / Command / Policy / Aggregate を追加して Design Level にする。最後に対応する `.dt` を提案し、`.dtes` に解決できる完全修飾 `ref` だけを追加する。既存 `.dt` は確認なく変更しない。

**UC2**

> workspace 内の `.dt` を読み、対応する `.dtes` の Event / timeline と既知の Design Level 要素を初期化する。正常系・異常系・再試行・BC 間連携を具体的なシナリオとして検討し、不明点を Hotspot に追加する。`.dt` と `.dtes` の機械的な整合性エラーと業務上の改善提案を区別して報告する。Big Picture と Design Level の両方でレビュー可能にする。
