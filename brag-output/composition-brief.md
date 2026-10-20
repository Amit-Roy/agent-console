# Hyperframes Composition Brief: agent-console

## Objective
Create a short launch-style brag video for agent-console.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1280x720
- Duration: 18 seconds

## Source Material
- Project root: /home/coder/worktrees/agent-console-issue-79-7b35a172
- Primary files read: public/index.html, public/style.css, README.md, package.json
- Product name: Agent Console
- Tagline / strongest claim: "Your agents. Your machine. No remote desktop."
- Key UI or visual moment to recreate: New thread dialog with three providers, composer with slash commands, file viewer, usage dashboard, context meter compaction
- Copy that must appear verbatim:
  - "Claude Code", "Pi", "Codex"
  - "Run Claude, Pi, and Codex locally. One window, resumable threads, no remote desktop."
  - "Your agents. Your machine. No remote desktop."

## Creative Direction
- Tone preset: polished
- Creative direction: developer's local cockpit, serious but not corporate
- Interpretation: fewer scenes, longer holds. Confidence through restraint. Fast-in-then-hold text pacing.
- Angle: Developer's local cockpit. Three agents — Claude Code, Pi, Codex — running in one window, each in its own resumable thread. The selling point is local-first agent control: you own the session, you pick the model, you control the bypass mode.
- Hook: The new-thread dialog snaps open showing the three agent choices — Claude Code, Pi, Codex — side by side. Cursor selects Pi. No onboarding, no cloud signup. Just: pick your agent, start working.
- Outro / punchline: The context meter hits 70%, compact runs silently, thread keeps going. Tagline: "Your agents. Your machine. No remote desktop."
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign

## Visual Identity
- Background (dark): #0b0b0d
- Text: #ededf0
- Accent: #9aa5ff (purple), #4a43d6 (light mode fill)
- Display font: Inter (UI chrome)
- Body font: Newsreader (conversation text, serif)
- Mono font: JetBrains Mono (code, line references)
- Visual references from the project: context meter arc, three-provider sidebar, composer slash menu, tool cards with diffs, file viewer, usage dashboard charts

## Storyboard
Scene summary:
1. Hook: new thread dialog — 3s — New thread dialog opens center-frame. Provider picker shows Claude Code, Pi, Codex. Cursor hovers over Pi and clicks. Model dropdown expands.
2. Reveal: composer and streaming — 4s — Composer input with `/` slash menu open, listing commands and skills. Agent response streams in with markdown, tool cards showing bash diffs.
3. Highlight 1: file viewer — 4s — Cursor clicks a file path reference in a message (server/threads.ts:360). File viewer opens with syntax highlighting, line number highlighted, copy button visible.
4. Highlight 2: usage dashboard — 4s — /dashboard view. Per-day line chart fills in. Model/tool/thread breakdown rows appear one by one. Weekday-by-hour heatmap renders.
5. Highlight 3: context compaction — 3s — Context meter arcs amber at 70%. Click shows compare continuing vs compacting. Compaction runs — messages condense, meter drops. Thread keeps running.
6. Outro — 2s — Dark background. White text: "Your agents. Your machine. No remote desktop." Agent Console icon beneath.

## Audio
- Audio role: warm corporate bed
- Audio arc: warm bed under hook, steady through highlights, fade under outro
- Music: bundled Hyperframes track (from skill assets)
- Music treatment: start under hook, steady through highlights, fade under outro
- Music cue guidance: bundled track preset available at composition time; target strong cues at hook (Scene 1) and outro (Scene 5); beat-grid windows for sequential reveals in Scene 2-4
- Audio-reactive treatment: subtle; music bass makes hero elements breathe gently
- Audio-coupled moments:
  - Scene 1 — typed slash command with subtle key ticks
  - Scene 2 — slash command typing with key ticks, then card-by-card sequence
  - Scene 3 — simulated click + slide + highlight
  - Scene 4 — sequential reveals matching beat grid
  - Scene 5 — meter fill swell + compaction click + reset thud
  - Scene 6 — final beat on tagline word "desktop"
- SFX selection guidance: sparse; motion-matched key clicks and card pops
- Restraint rule: no chaotic audio — polished restraint matches the visual tone

## Hyperframes Instructions
Load the Hyperframes domain skills — `hyperframes-core` (composition contract + `data-*` timing), `hyperframes-animation` (motion), `hyperframes-creative` (design spec, beats, audio-reactive), `hyperframes-keyframes` (seek-safe keyframes), and `hyperframes-cli` (lint/check/render). /brag is its own workflow: do not enter the `hyperframes` entry-point intent interview and do not route into its generic promo / launch-video workflow. Prefer native Hyperframes conventions over anything in `/brag`.

Requirements:
- Show at least one real UI, copy, or visual element from the source project.
- Keep all text readable in the final render.
- Keep the video within 15-25 seconds.
- Include the planned music/SFX layer unless audio was explicitly disabled or documented as intentionally silent.
- Treat `/brag` audio notes as guidance, not a fixed cue sheet. Choose SFX after the visual animation exists.
- Treat music cue metadata as optional timing hints. Hyperframes decides exact animation timing and should ignore cues that hurt readability, scene pacing, or the product story.
- Major reveals may move toward nearby strong cues within about 0.15s. Smaller entrances may align to nearby beat points within about 0.10s. Use only 1-3 strong cue locks in a 15-25s video unless the edit clearly benefits from more.
- Use SFX to support motion and interaction: card sounds for card-like reveals, short announcement cues for major payoffs, key/click sounds for text or user actions, and restraint when the edit is already busy.
- Honor planned music treatment such as fade-outs, ducking, beat-aligned reveals, or letting a final SFX ring over the music, using the best Hyperframes-supported implementation.
- When music is present and the treatment is not `none`, consider Hyperframes audio-reactive workflow: extract audio data and use RMS/frequency bands for subtle, brand-specific motion. Good targets are glow, depth, background warmth, card presence, title emphasis, or other existing visual elements. Avoid waveform/equalizer visuals, musical-note graphics, generic particle systems, strobing, or heavy pulsing.
- Use local assets for audio and any required runtime/media dependencies when possible.
- Run `hyperframes check` before render — it is brag's single gate.
- Keep creation and rendering local. Remote or publishing workflows require a separate explicit user request.

## Self-review checklist
- [ ] `brag-output/composition-brief.md` exists.
- [ ] The brief clearly identifies the exact product moments to show.
- [ ] The composition uses the current Hyperframes workflow, not a hardcoded `/brag` template.
- [ ] Music file is copied into `brag-output/composition/assets/music/`.
- [ ] At least one visual element subtly reacts to the music (audio-reactive treatment present), or extraction failure is documented.
- [ ] At least 1 major tween is beat-locked to a strong cue within ±0.15s, marked `// beat-locked` (or natural timing was chosen for readability).
- [ ] Sequential events (cards, stats, list items) snap to consecutive `beats[]` timestamps (±0.10s), marked `// beat-grid` (or natural timing was chosen for readability).
- [ ] The composition shows at least one real UI, copy, or visual element from the project.
- [ ] Every factual claim on screen is grounded in the project.
- [ ] Total duration is 15-25 seconds.
- [ ] Hyperframes check passes, or any blocker is documented for the user.