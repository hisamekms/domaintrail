# UI rules

Two rules for the Live View's page (`apps/web`): a button's look says what pressing it does, and space says what
belongs together. Tests read the source and the CSS to hold both.

## Buttons: six kinds, by what a press does

Every text button is an `<Act kind="…">` (`apps/web/shared/act.tsx`). The kind is required and gives the look; a
`className` is only a layout hook (width, position), never a look.

| Kind | What a press does | Look | Examples |
|---|---|---|---|
| `decide` | files or the session change now | brand fill | 確定 / 承認 a brief, 採用したものを反映, 承認 a request, 完了にする, the current goal in ゴールを変える |
| `decide-sub` | a secondary decision beside the main one | grey outline | しまう, このジャーニーにする, 戻す, the other goals |
| `send` | a message goes to the chat and the AI acts | pale brand wash | an interview's choice (single: sent at once), 送る for several, 聞くことをメモ, 回答を送る, 送り直す |
| `insert` | a command goes into the composer only; the person sends it | brand outline, ↵ (added by `Act`), the code font | `/es:start`, `/es:exceptions`, the journeys panel's new journeys, the completion note's command, ブリーフを見直す |
| `see` | moves to a place; nothing changes | brand text and its icon, no border, underlined on hover | 👁 見る, ガイドを見る, チャットで見る, the detail's 見る: 構造図 and この BC だけを構造図で見る |
| `open` | opens or closes a menu, the composer, a form, a dialog or a panel | grey outline | ゴールを変える ▾, 編集して確定, その他（自分で書く）, ジャーニーを開く, 変更を見る, 閉じる |
| `stop` | stops or cancels | grey outline, muted text | 中止, キャンセル, 取り下げ, 実行を中止 |
| `danger` | refuses, or cannot be undone | red outline | 却下, a run's 打ち消す, ending the collab (終える) |

- **One `decide` per place.** A place (a card, a request's row, the current journey, a dialog) has at most one filled
  button: its main decision. Other decisions there are `decide-sub`.
- **Choose by the press, not by the label.** ブリーフを見直す reads like an interview but only fills the composer with
  `/es:start`: it is `insert`.
- **Icon-only buttons** stay on `icon-button` (or their own shape: the chat's send arrow, ♡, a chip's ✕), with an
  `aria-label` and a tooltip.
- **Menus of actions** are `<ActionMenu>` (`apps/web/shared/menu.tsx`): `role="menu"` with `menuitem`s in groups,
  each with its icon and key; the arrow keys, Home and End move, Escape and Tab close it and give the focus back. The
  stickies' actions (ADR 0033) and their command palette (`shared/palette.tsx`, ⌘K) are drawn from one list
  (`apps/web/stickies/registry.ts`); a `see` action there has the eye.
- **The ✓ of the journey's map** is `<MarkToggle>`: a checkbox with 済み / 済みにする. It is a decide (the journey file
  changes), drawn as a checkbox because it toggles.

## Space: the rhythm

| Token | Value | Between |
|---|---|---|
| `--gap-inside` | 8px (`--space-2`) | the parts of one group: a step's title, reason, actions; a brief's head; a row's buttons |
| `--gap-between` | 16px (`--space-4`), at least twice the inside | groups: the guide card's map, what is known at once, the advice; the steps of the advice; a brief's head, lines and actions; the journeys panel's sections |
| `--gap-turn` | 24px (`--space-5`) | a change of turn in the chat stream |

Inside a group stays at or under `--gap-inside`; groups are at least `--gap-between` apart. Write spacing with the
tokens (`var(--gap-*)` for the rhythm, `var(--space-*)` for the steps of the scale), `0`, `auto`, a 1px or 2px
hairline, or `calc()` of tokens.

## How the tests hold them

`apps/web/ui-rules.test.ts` reads `apps/web/**/*.tsx` and `apps/web/styles.css`:

- **Raw buttons.** Every `<button` outside `shared/act.tsx` and the tests is icon-only (`icon-button`) or listed in
  `RAW_BUTTONS` by file and key (its role, else its first class), with its count and a reason: tabs, menu items and
  listbox options, segmented view settings, the view toolbar and canvas controls, whole rows and cards, references in
  running text, chips and badges, icon-only shapes of their own. A new raw button fails, and so does one more of a
  listed key.
- **Old classes.** No button carries `chat-small`, `primary`, `ghost`, `danger`, `small`, `guide-command`, `guide-go`,
  `guide-ask`, `interview-choice`, `cancel-dialog-button` or `answer-other-button`, and `styles.css` no longer styles
  them (`interview-choice` stays on the checkboxes' labels of a multiple-choice question).
- **One decide per place.** Render tests count the kinds in the guide card, the brief, the journeys panel and its
  requests, the goal menu, the completion note and the candidates (`actKinds` and `decides` in
  `apps/web/test-helpers.ts`).
- **Spacing.** Each `margin`, `padding` and `gap` value of `styles.css` is on the rhythm, or counted in `OFF_RHYTHM`
  by value with a reason. The counts are today's; the list only shrinks.

### Adding an exception

When something fits none of the six kinds (a view setting such as the filter menu's クリア, a row whose whole box is
the target), keep the raw `<button>` and add its `file key` to `RAW_BUTTONS` with the count and a sentence saying
why. For spacing, prefer a token; a value that must stay (a bleed, a size from the text, the print page's millimetres)
goes into `OFF_RHYTHM` with its reason. When you move a value onto the tokens, lower its count.
