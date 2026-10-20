# Brag Plan: agent-console

## What is this app?
Browser front-end for Claude, Pi, and Codex agents running locally on your machine. Installable as a PWA — no remote desktop, no cloud proxy between you and your agents.

## The angle
Developer's local cockpit. Three agents — Claude Code, Pi, Codex — running in one window, each in its own resumable thread. The selling point is local-first agent control: you own the session, you pick the model, you control the bypass mode. Tone is polished, not playful — this is a tool for serious local development, not a toy.

## Hook (first 2-3 seconds)
The new-thread dialog snaps open showing the three agent choices — Claude Code, Pi, Codex — side by side. Cursor selects Pi. No onboarding, no cloud signup. Just: pick your agent, start working.

## Key moments (the middle)
- New thread dialog: provider picker (Claude Code / Pi / Codex), folder picker, model dropdown
- Composer: slash command menu (`/`), file attach, queue while agent works, Steer (Alt+Enter) interrupts
- Streaming response: tool cards with diffs, file viewer opening a syntax-highlighted line reference, markdown rendering
- Usage dashboard: per-day token charts, model breakdown, savings heatmap
- Context meter: amber as it fills, click to compare continuing vs compacting

## Outro / punchline
The context meter hits 70%, compact runs silently, thread keeps going. Tagline: "Your agents. Your machine. No remote desktop."

## User flow worth showing
Open new thread → Pick provider (Claude Code / Pi / Codex) → Type message → Agent streams back with tool cards → Click file reference → File viewer opens → Check usage dashboard → Context meter compacts

## Tone
- Preset: polished
- Creative direction: developer's local cockpit, serious but not corporate
- Interpretation: fewer scenes, longer holds. Confidence through restraint. Fast-in-then-hold text pacing.

## Format: landscape — 1280x720
## Duration: 18 seconds

## Visual identity (from the project)
- Background (light): #eeeef2
- Accent: #4a43d6 (purple fill), #9aa5ff (dark mode accent)
- Text: #17171b (light), #ededf0 (dark)
- Display font: Inter (UI chrome)
- Body font: Newsreader (conversation text, serif)
- Mono font: JetBrains Mono (code, line references)
- Strongest visual element: context meter arc + three-provider sidebar

## Share copy (draft)
Run Claude, Pi, and Codex locally. One window, resumable threads, no remote desktop.

## Audio direction
- Role: warm corporate bed
- Music: bundled Hyperframes track, polished tone
- Music treatment: start under hook, steady through highlights, fade under outro
- Music cue guidance: bundled track preset available at composition time; target strong cues at hook (Scene 1) and outro (Scene 5); beat-grid windows for sequential reveals in Scene 3 (three highlights appearing one by one)
- Audio-coupled idea: typed slash command with subtle key ticks, card reveals matching beat, context meter fill with subtle swell
- Audio-reactive treatment: subtle; music bass makes hero elements breathe gently
- SFX posture: sparse; motion-matched key clicks and card pops
- Restraint rule: no chaotic audio — polished restraint matches the visual tone

## Storyboard

### Scene 1 — Hook: new thread dialog — 3s
What's on screen: New thread dialog opens center-frame. Provider picker shows Claude Code, Pi, Codex. Cursor hovers over Pi and clicks. Model dropdown expands.
Sequential/interaction: yes — cursor clicks Pi, then model list appears one by one
Audio intent: crisp, decisive — button clicks and subtle pop
Audio-coupled idea: typed slash command with subtle key ticks
Music: warm bed entering under hook
Transition mood: clean crossfade → Scene 2

### Scene 2 — Reveal: composer and streaming — 4s
What's on screen: Composer input with `/` slash menu open, listing commands and skills. Agent response streams in with markdown, tool cards showing bash diffs.
Sequential/interaction: yes — slash menu items appear one by one, then tool cards stack
Audio intent: responsive, energetic — key clicks, card arrive sounds
Audio-coupled idea: slash command typing with key ticks, then card-by-card sequence
Music: bed continues, slight swell on tool card arrival
Transition mood: hard cut → Scene 3

### Scene 3 — Highlight 1: file viewer — 4s
What's on screen: Cursor clicks a file path reference in a message (server/threads.ts:360). File viewer opens with syntax highlighting, line number highlighted, copy button visible.
Sequential/interaction: yes — click reference → viewer slides in → line reference highlights
Audio intent: precise — click, then viewer slide, then highlight settle
Audio-coupled idea: simulated click + slide + highlight
Music: bed continues steady
Transition mood: clean crossfade → Scene 4

### Scene 4 — Highlight 2: usage dashboard — 4s
What's on screen: /dashboard view. Per-day line chart fills in. Model/tool/thread breakdown rows appear one by one. Weekday-by-hour heatmap renders.
Sequential/interaction: yes — chart line draws, then breakdown rows stack, then heatmap cells fill
Audio intent: data-driven — chart draw sound, row pops, heatmap fade-in
Audio-coupled idea: sequential reveals matching beat grid
Music: bed continues, data reveals on beat
Transition mood: soft fade → Scene 5

### Scene 5 — Highlight 3: context compaction — 3s
What's on screen: Context meter arcs amber at 70%. Click shows compare continuing vs compacting. Compaction runs — messages condense, meter drops. Thread keeps running.
Sequential/interaction: yes — meter fill arc → click → compare graph → compaction → meter drops
Audio intent: satisfying — arc fills, click, compact click, meter resets
Audio-coupled idea: meter fill swell + compaction click + reset thud
Music: bed sustains through compaction, begins fade under outro
Transition mood: soft fade → Scene 6

### Scene 6 — Outro — 2s
What's on screen: Black/dark background. White text: "Your agents. Your machine. No remote desktop." Agent Console icon beneath.
Sequential/interaction: none — static hold
Audio intent: final — clean finish, bed fades out
Audio-coupled idea: final beat on tagline word "desktop"
Music: fade out under tagline
Transition mood: none — end

Music mood for this video: warm polished
Audio summary: warm corporate music bed, sparse key-click and card-pop SFX, compaction swell, fade-out under tagline. No narration.