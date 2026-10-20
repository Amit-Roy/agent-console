# Agent Console launch video

The 22.5-second, 1920 × 1080 film uses a technical print aesthetic inspired by mexicat/pdoom: ink, bone, signal orange, drafting lines, condensed type, and a moving spark. It shows laptop and Android interactions in the real app with fictional threads on an isolated mock server. The notification and running clock are illustrations.

## Render locally

Node.js 22 or newer and FFmpeg are required. From this directory:

```sh
npm run check
npm run dev
npm run render -- --quality delivery --fps 30 --output /tmp/agent-console-render.mp4
bash scripts/finalize.sh /tmp/agent-console-render.mp4 ../docs/brag
```

All fonts, GSAP, recordings, and audio are local assets. Rendering does not upload the film to HeyGen. HyperFrames is pinned in `package.json`. The finalizer extracts the poster at 10.4 seconds and replaces frame zero with it without changing audio timing.

The soundtrack is original synthesized audio at 128 BPM in A minor. To regenerate both 48 kHz stereo stems, install NumPy and run:

```sh
python3 scripts/synth.py assets/audio
```

`brag-plan.md` records the scene timings and `share-copy.txt` contains the post caption. The delivery poster and MP4 live in `../docs/brag/`.
