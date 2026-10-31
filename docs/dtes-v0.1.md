# Event Storming DSL (`.dtes`) v0.1 — 実装設計書

> 対象: Claude Code / Codex による実装
>
> ステータス: 設計合意事項の統合版（2026-10-31、最終仕様反映版）。本書中の **確定** は対話で採用した方針、**提案** は実装を進めるための具体化、**要確認** はリポジトリの現行実装との照合が必要な項目を意味する。
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
- Event / Command / Policy / Actor / External System / Aggregate / Read Model / Hotspot / Timeline / Group の **ローカル ID は storming 内で種別横断の単一名前空間に属し、一意**。異なる種別間の衝突も Error。【確定】
- 異なる storming 間の要素参照は v0.1 では扱わない。【提案】
- `.dtes` には所属 BC の暗黙指定を設けない。【確定】
- `ref` は `ref <BC>.<Model>[.<Member>]` の**完全修飾名**を必ず使う。省略形・名前による暗黙マッチングは禁止。【確定】
- `ref` は任意で、1要素につき最大1件。概念的な対応（一致）を表し、単なる緩い関連ではない。【確定】
- `.dt` 側シンボルが未存在の探索段階では `ref` を省略する。`.dtes` 未参照要素に警告しない。【確定】

## 3. 語彙と意味論

### 3.1 要素

| 要素 | 意味 | 備考 |
|---|---|---|
| `event` | 業務上起こった出来事の型（過去形の事実） | `timeline` から参照される |
| `actor` | Command を発行し得る人・役割 | 複数の Command から参照可 |
| `external` | Command を発行し得る外部システム | `actor` 関係の参照先として使用可。外部呼び出し先を表すものではない |
| `command` | 実行を試みる業務上の操作 | 主対象 Aggregate は最大1つ |
| `policy` | Event に反応して Command を発行し得る業務ルール | **BC 横断可** |
| `aggregate` | 操作対象の整合性境界の候補 | `.dt` Aggregate に任意で `ref` |
| `readmodel` | Command の判断に必要な情報のモデル | DB アクセス仕様ではない |
| `hotspot` | 未解決/解決済みの疑問・重要事項 | 解決済みは選択的に残す |
| `timeline` | Event 発生の**部分的な時間順序** | 複数個可、Event のみ |
| `group` | 同一段階の Event 群（内部は順序なし） | timeline 内に記述 |

### 3.2 関係と多重度【確定した設計方針】

| 所属 | 記述 | 対象 | 多重度 | 意味 |
|---|---|---|---|---|
| Command | `actor A` | Actor または External System | 0..N | 発行し得る主体。複数なら代替的な発行主体であり AND ではない |
| Command | `reads R` | Read Model | 0..N | Command の判断に必要な情報。人間かプログラムかは規定しない |
| Command | `target G` | Aggregate | **0..1** | 主たる操作対象。未確定時は省略可能 |
| Command | `emits E` | Event | 0..N | 発生し得る結果。必須・排他・全列挙ではない |
| Policy | `on E` | Event | **1..N** | いずれかの Event を契機に Policy が評価され得る（OR） |
| Policy | `issues C` | Command | **1..N** | 発行し得る Command。順序/必須性/全部実行を保証しない |
| Event / Aggregate / Command | `ref ...` | `.dt` | **0..1** | 型の合う `.dt` シンボルへの明示対応。他の要素では禁止 |
| Hotspot | `on E` | Event | 0..1 | 関連 Event。因果ではない |

**複数 `on` と複数 `issues` を持つ Policy は許可**。ただし、任意の Event が任意の Command を必ず起動するという**直積の意味を与えてはならない**。個別の対応条件が異なるなら AI は Policy を分割するよう推奨する。`rule` のネストは v0.1 で導入しない。

**Policy は BC を横断してよい**。Policy 自体の所有 BC を `.dtes` で指定する必要はない。実装上の責任・配置は `.dt` 化やアプリケーション設計で決定する。

### 3.3 `reads` の明確化【確定】

`reads DeliveryDetails` は「この Command を行う判断に DeliveryDetails の情報が利用される」を意味し、データベースクエリ、Actor が読む UI の実装、Command Handler が読む依存関係を特定しない。複数可。Read Model に `.dt` で対応する型がないことはエラーにしない。

### 3.4 Timeline の意味【確定】

- 本体には **Event ID の参照のみ**。Command / Policy / Actor / Aggregate / Read Model は含まない。
- `group` 内も Event 参照のみ。group 内は順序を持たず、group の前後との大まかな順序だけを持つ。**同じ group 内での同一 Event ID の重複は Error**。別 group・別段階での反復は合法。
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
    actor Customer
    reads DeliveryDetails
    target Shipment
    emits ShipmentCancelled
  }
  command ReleaseBike "車両割当解除" {
    ref Fleet.BikeAssignment.release
    target BikeAssignment
    emits BikeReleased
    emits ReleaseFailed
  }
  command ReceivePaymentNotice "決済通知受領" {
    actor PaymentGateway
  }
  command ReleaseSlot "配送枠解除" {
    target ShipmentSlot
    emits SlotReleased
  }

  policy CleanupAfterCancel "キャンセル後処理" {
    on ShipmentCancelled
    issues ReleaseBike
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

  hotspot Compensation "車両の解放に失敗した場合、配送キャンセルを補償する？" {
    on ReleaseFailed
    status open
  }
}
```

**注**: `ReceivePaymentNotice` は External System が Command を発行し得ることを示す構文例であり、外部システムを呼び出す意味ではない。実際の業務内容に応じて命名する。上記の `ReleaseFailed` は、実際に Event として採用するかを業務で検討した例であり、異常結果の厳密な排他性は DSL から導かない。`group` の `CleanupResults` は表現上の命名で、ビューのレイアウト命令ではない。

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
| Command `ref` と `target.ref` の Aggregate 不整合 | Warning | 探索中の仮説を許容 |
| 両側で `ref` 解決済みの Command `emits` と `.dt` emitted Event の矛盾 | Warning | `.dtes` は発生可能性の部分記述。誤検知を避け、証明できる不一致のみ |
| `.dtes` の Command に `emits` がない | 診断なし | 未確定でよい |
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
}
```

| 要素 | Big Picture | Design Level |
|---|---|---|
| Event | 表示 | 表示 |
| Timeline の順序 | 表示 | 表示 |
| Hotspot | 表示 | 表示 |
| Actor / External System | 非表示（v0.1 の既定） | 表示 |
| Command / Policy / Aggregate / Read Model | 非表示 | 表示 |
| 型レベルの因果関係 | 非表示 | 表示 |
| `.dt ref` | ノード詳細等で参照可 | ノード詳細等で参照可 |

- Big Picture は**詳細を隠した投影**。詳細化前の過去モデルを復元する機能ではない。
- Big Picture に戻しても、Design Level で追加・分割した Event 定義は消さない。
- 名前付き timeline の選択に応じて、その timeline の EventOccurrence と関連要素を抽出。
- 統合キャンバスでは timeline に属さない Event や孤立した要素も表示。
- 複数 timeline フィルタ／抽象度切替は `.dtes` を変更しない。

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
  kind: 'on' | 'issues' | 'emits' | 'target' | 'actor' | 'reads' | 'hotspot-on'
}
```

**重要**: 同一 EventOccurrence を2か所に描画する案は将来の高度化として残す。**v0.1 の基本投影では各 EventOccurrence はちょうど1つの Event RenderNode に所属**し、同一 RenderNode 内に同じ timeline の異なる Occurrence を混在させない。

## 8. 共通 prefix 統合【確定】

### 8.1 ルール

- 同じ storming 内の timeline について、**先頭から連続して一致するステップ**を描画上で共有する。
- 最長共通部分列（LCS）や共通 suffix の自動統合は行わない。
- Event 型が一致しないステップは共有しない。
- 同じ timeline の異なる EventOccurrence は共有しない。
- `group` は同一段階の Event の**集合**として扱う（順序なし、同一 Event ID の重複禁止）。【確定】
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

## 9. 因果関係と timeline の投影【確定＋実装提案】

### 9.1 意味的エッジ

- `Event → Policy` (`on`)
- `Policy → Command` (`issues`)
- `Command → Event` (`emits`)
- `Actor → Command` (`actor`, 関連)
- `Read Model → Command` (`reads`, 関連)
- `Command → Aggregate` (`target`, 関連)
- `Hotspot → Event` (`on`, 非因果)

`on / issues / emits` は可能性・候補を表す。Policy に `on` と `issues` が複数あるとき、**Event → Command の直積の直接因果エッジを推論・生成しない**。Policy 自身を独立ノードとして保持する。

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
- **確定**: 選択 timeline 上の Event を両端とする `Event → Policy → Command → Event` **1ホップ連鎖**に限定する。対象 Command の `actor/reads/target` と両端 Event に `on` で結びつく Hotspot を付加する。片端が timeline 外なら経路を投影しない。孤立した timeline Event は常に表示。多段経路は v0.1 で自動展開しない。
- `emits` で選択 Event に結びつく Command が存在しても、対応する `Event → Policy → Command` が存在しなければ、それをシナリオ上で発火したと推定しない。統合ビューでは型レベルの全関係を表示できる。

### 9.4 視覚表現

| エッジ | 例示スタイル |
|---|---|
| 型レベル因果エッジ | 実線＋方向 |
| Timeline の時系列 | 破線＋方向、またはレイアウト方向で表現 |
| 非因果関連 | 点線・細線 |

イベント付箋はオレンジ、Command 青、Policy 紫、Aggregate 黄、Read Model 緑、Hotspot ピンクを既定値の候補とする。**色は意味論ではない**。視認性・アクセシビリティを確保すること。

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
| Syntax | 不正なブロック、未知の関係、構文不備 | Error |
| Symbol | storming 内 ID 重複、未定義参照 | Error |
| Kind | `timeline` に Event 以外、`target` 非 Aggregate、`reads` 非 Read Model、`actor` 非 Actor/External、`issues` 非 Command 等 | Error |
| Cardinality | Command に `target` 2つ以上、`ref` 2つ以上、禁止要素の `ref` | Error |
| Group | group 内の同じ Event ID の重複 | Error |
| Policy | `on` 0件、`issues` 0件 | Error |
| Hotspot | 不正 status、resolved なのに resolution なし、`on` の対象不正 | Error |
| `.dt ref` | 完全修飾でない、未解決、種別不一致 | Error |
| `.dt` contract | 有効な `ref` 同士で証明できる不整合 | Warning |
| Graph | Policy→Command→Event→Policy の型レベル循環 | Warning（無限ループ断定禁止） |
| Policy | 2つ以上の `on` と2つ以上の `issues` | Info（任意、直積意味ではない旨をレビュー） |
| Timeline | 因果が示唆する順序と逆に見える | **原則診断しない**（Occurrence 対応未確定） |
| Completeness | 未参照 Event、未リンク要素、timeline の部分性、Event の再登場 | 診断なし |

静的 checker は自然言語の Hotspot resolution を理解したと**主張しない**。AI によるドメインレビューは別レイヤー（不足、例外、責務、実装との差異を指摘する非決定的な支援）として扱う。

## 12. 受け入れテスト（必須）

### 12.1 DSL / 型検査

- [ ] ES01: 正常な Event/Command/Policy/Read Model/Actor/External/Aggregate/Hotspot/Timeline を `.dtes` からパースできる。
- [ ] ES02: `timeline` に Command を書くと Error。
- [ ] ES03: Command `target` が2件だと Error、0件は合法。
- [ ] ES04: `actor`（Actor / External System）、`reads`、`emits` が各複数で合法。
- [ ] ES05: Policy の `on` と `issues` が各複数で合法、欠けたら Error。
- [ ] ES06: `.dt ref` は fully qualified、存在・種別整合性を検証。
- [ ] ES07: `.dt ref` 省略は合法、未参照への網羅性警告なし。
- [ ] ES08: `resolved` Hotspot の `resolution` 必須。
- [ ] ES09: BC 横断 Policy は合法。
- [ ] ES10: 逆順 timeline と因果経路があっても、機械的に Error にしない。
- [ ] ES11: group 内の同じ Event ID の重複が Error。異なるステップでの再登場は合法。
- [ ] ES12: 異種要素間でも ID 衝突が Error。
- [ ] ES13: Policy を含む Event/Command/Aggregate 以外の `ref` が Error。
- [ ] ES14: `external` は Command の `actor` 参照で合法。`reads/target` など別種の関係では Error。

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
- [ ] R14: Big Picture で Command/Policy を隠しても Event は消えない。
- [ ] R15: 全体ビューに timeline 未所属の Event が現れる。
- [ ] R16: timeline のフィルタは1ホップの Event→Policy→Command→Event のみ（両端が対象 timeline）投影し、多段連鎖は自動展開しない。
- [ ] R17: Big Picture と Design Level のどちらでも同一 `.dtes` を使い、`external` は Design Level に表示する。

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
| External System | **`external` 宣言を導入**。`command.actor` は Actor / External System を参照可能。外部呼び出し関係は導入しない |
| CLI | 既存 `dt` CLI と workspace root 指定の慣習に合わせる。別 CLI 製品は作らない。正確なサブコマンド・フラグは現行コードを確認して整合する名称を採用 |
| timeline フィルタ | **1ホップ** `Event → Policy → Command → Event` のみ。多段自動展開なし |
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
