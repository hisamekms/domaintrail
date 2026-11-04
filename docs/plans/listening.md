# Listening to the meeting, a co-facilitating AI, and people's own wording (future, decided 2026-11-04)

Not for 0.7.0. This records what a live Collab test asked for and what was decided, so it can be planned later.

## What the test asked for

- Workshops run while people talk in Teams or Zoom. Typing what was said is a chore; the wish is a Notion-like
  transcript that the AI turns into the storming, steering the session as a facilitator would.
- The facilitator should be helped by the AI (a co-facilitator), not replaced, at first.
- People want to write the stickies' wording themselves.
- Kept as they are, because the test liked them: the sticky's detail kept apart from the sticky, and exceptions in
  views of their own.

## Decisions

### 1. A co-facilitating AI (first)

The human facilitator stays and keeps every approval. The AI acts on its own initiative:

- it posts the guide when the session moves to a new step of the current journey;
- it keeps time for a step (for example "ten minutes left for exceptions");
- it turns a question to people who have not spoken.

Letting the AI approve changes within the journey's scope, and a session without a human facilitator, come later.

### 2. People correct a sticky's wording on the canvas

A sticky the AI wrote can be renamed in place (double-click, edit, Enter); dt writes the label without an AI run. The
AI keeps the tidying: consistent names, exception candidates. Placing and moving stickies on the canvas stay out.

### 3. Listening to the meeting

```text
Teams / Zoom in a Chrome tab ─┐   the facilitator's microphone
                              ▼
     the facilitator's Live View: mixes both, cuts chunks of tens of seconds
                              ▼
     speech to text (local Whisper by default; an external service by setting)
                              ▼
     the session keeps the transcript (on the machine only, never in git)
                              ▼ every few minutes, or at a pause
     the co-facilitating AI, with the current journey and storming:
       a short summary, sticky candidates (events, exceptions, questions), the next thing to ask,
       and a note when the talk leaves the journey's goal
                              ▼
     people check the candidates and apply them (the existing candidates flow)
```

- **Capture:** start with the meeting in a Chrome tab. `getDisplayMedia` with the tab's audio plus `getUserMedia` for
  the microphone, on https or localhost (the Access URL and 127.0.0.1 both qualify). The desktop apps need a macOS
  helper (process audio taps, macOS 14.4+): later.
- **Speech to text:** local Whisper by default (e.g. large-v3-turbo through whisper.cpp). The talk often holds what
  should not leave the organisation, and the cost does not grow with use. It needs a model download (1–2 GB) and an
  Apple Silicon Mac to keep up; an external service can be chosen in the config when it does not.
- **Speakers:** a tab mixes everyone's voice, so speakers are not told apart. Event Storming needs what happened more
  than who said it.
- **Consent and storage:** every page shows that the session is listening; only the facilitator starts and stops it;
  how long the transcript is kept is to be decided.

### Feasibility, roughly

| Part | Outlook |
|---|---|
| Tab audio and microphone in Chrome | can be done |
| Local Whisper, Japanese, near real time on Apple Silicon | likely; to be measured |
| External speech to text | can be done; the audio leaves the machine |
| Telling speakers apart | weak; acceptable |
| The AI's summary and candidates | can be done; reuses the journey and the candidates flow |
| Teams / Zoom desktop apps | later (macOS helper) |

### Before building: a spike

Check three things with a throwaway: Teams in a Chrome tab gives clean audio; local Whisper on mixed meeting audio is
accurate enough for Event Storming, and how far behind it runs on the facilitator's Mac; a few minutes of transcript
give the AI useful summaries and candidates. Write the full plan from what the spike shows.

### Order

1. The co-facilitating AI and the in-place rename.
2. The spike, then the plan for listening.
3. Tab capture, local Whisper, the transcript in the session, the listening indicator.
4. The AI's periodic summary and candidates.
5. External speech to text by setting; then the macOS helper for the desktop apps.
