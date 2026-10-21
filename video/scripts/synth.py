"""Synthesize the agent-console feature-tour soundtrack: 128 BPM, 48 bars (90 s), A minor.

Usage: python3 -I synth.py <out-dir>
Writes music.wav (bed) and sfx.wav (hits/tick/chime) as 48 kHz stereo 24-bit.
"""
import sys, wave
import numpy as np

SR = 48000
BPM = 128
BEAT = 60 / BPM
BAR = BEAT * 4
BARS = 48
DUR = BAR * BARS
N = int(DUR * SR) + SR  # 1 s tail headroom, trimmed later
rng = np.random.default_rng(7)


def t_(n):
    return np.arange(n) / SR


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def lp(x, fc):
    """One-pole lowpass; fc scalar or per-sample array."""
    fc = np.broadcast_to(np.asarray(fc, float), x.shape)
    a = np.exp(-2 * np.pi * fc / SR)
    y = np.empty_like(x)
    s = 0.0
    for i in range(len(x)):
        s = (1 - a[i]) * x[i] + a[i] * s
        y[i] = s
    return y


def lp2(x, fc):
    return lp(lp(x, fc), fc)


def hp(x, fc):
    return x - lp(x, fc)


def env_adsr(n, a, d, s, r, hold=None):
    hold = n / SR if hold is None else hold
    t = t_(n)
    e = np.where(t < a, t / max(a, 1e-6), 1.0)
    dec = np.clip((t - a) / max(d, 1e-6), 0, 1)
    e = np.where(t >= a, 1 - (1 - s) * dec, e)
    rel = np.clip((t - hold) / max(r, 1e-6), 0, 1)
    return e * (1 - rel)


def saw(f, n, detune=0.0):
    t = t_(n)
    out = np.zeros(n)
    for d in (-detune, 0, detune) if detune else (0,):
        ph = (t * f * (1 + d) + rng.random()) % 1.0
        out += 2 * ph - 1
    return out / (3 if detune else 1)


def tri(f, n):
    ph = (t_(n) * f) % 1.0
    return 4 * np.abs(ph - 0.5) - 1


def place(buf, sig, start, gain=1.0, pan=0.0):
    i = int(start * SR)
    if i >= len(buf):
        return
    sig = sig[: len(buf) - i]
    l = np.cos((pan + 1) * np.pi / 4)
    r = np.sin((pan + 1) * np.pi / 4)
    buf[i : i + len(sig), 0] += sig * gain * l * np.sqrt(2)
    buf[i : i + len(sig), 1] += sig * gain * r * np.sqrt(2)


def reverb(x, seconds=2.2, mix=0.25, pre=0.02):
    n = int(seconds * SR)
    ir = rng.standard_normal((n, 2)) * np.exp(-6.9 * t_(n) / seconds)[:, None]
    ir[: int(pre * SR)] = 0
    ir[:, 0] = lp(ir[:, 0], 6000)
    ir[:, 1] = lp(ir[:, 1], 6000)
    ir /= np.sqrt((ir ** 2).sum(axis=0))
    m = len(x) + n
    nfft = 1 << (m - 1).bit_length()
    wet = np.stack(
        [np.fft.irfft(np.fft.rfft(x[:, c], nfft) * np.fft.rfft(ir[:, c], nfft), nfft)[: len(x)] for c in range(2)],
        axis=1,
    )
    return x * (1 - mix) + wet * mix


# ---- instruments -------------------------------------------------------------

def kick():
    n = int(0.42 * SR)
    t = t_(n)
    f = 46 + 110 * np.exp(-t * 38)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7.5)
    click = lp(rng.standard_normal(n), 3500) * np.exp(-t * 300) * 0.35
    return np.tanh((body + click) * 1.6) * 0.9


def clap():
    n = int(0.3 * SR)
    t = t_(n)
    noise = hp(lp(rng.standard_normal(n), 5200), 900)
    e = np.zeros(n)
    for k, d in enumerate((0, 0.011, 0.022)):
        i = int(d * SR)
        e[i:] += np.exp(-t[: n - i] * (90 if k < 2 else 16))
    return noise * e * 0.5


def hat(open_=False):
    n = int((0.22 if open_ else 0.06) * SR)
    t = t_(n)
    x = hp(rng.standard_normal(n), 7000)
    return x * np.exp(-t * (14 if open_ else 70)) * 0.22


def bass_note(m, length):
    n = int(length * SR)
    x = saw(midi(m), n, 0.004) * 0.7 + np.sin(2 * np.pi * midi(m - 12) * t_(n)) * 0.6
    cut = 220 + 900 * np.exp(-t_(n) * 9)
    y = lp2(x, cut)
    return y * env_adsr(n, 0.004, 0.12, 0.75, 0.05, length - 0.05) * 0.55


def pluck(m, length=0.32):
    n = int(length * SR)
    x = saw(midi(m), n, 0.006) * 0.6 + tri(midi(m + 12), n) * 0.25
    y = lp(x, 900 + 4200 * np.exp(-t_(n) * 18))
    return y * np.exp(-t_(n) * 9) * 0.32


def pad(notes, length, bright=1.0):
    n = int(length * SR)
    x = sum(saw(midi(m), n, 0.008) for m in notes) / len(notes)
    y = lp2(x, 700 * bright)
    return y * env_adsr(n, 0.35, 0.4, 0.85, 0.6, length - 0.6) * 0.33


# chord per bar: Am F C G (MIDI roots and voicings)
CHORDS = [
    (45, [57, 60, 64, 69]),
    (41, [57, 60, 65, 69]),
    (48, [55, 60, 64, 67]),
    (43, [55, 59, 62, 67]),
]
ARP = [0, 2, 3, 1, 2, 3, 1, 2]  # indices into voicing, 8th notes

music = np.zeros((N, 2))
# Section per bar. Chapters are 4 bars; breakdowns sit under the lid scene, the scheduled-task clock and session search.
INTRO = {0, 1}
BREAK = {6, 7, 22, 23, 38, 39}
FINAL = 47
# second-half chapters move to Am Em F G and add a lead line so 90 s does not loop the same 4 bars
PROG_B = set(range(26, 38)) | set(range(40, 47))
LEAD = set(range(10, 22)) | set(range(26, 38)) | set(range(40, 47))
CHORDS_B = [
    (45, [57, 60, 64, 69]),
    (40, [55, 59, 64, 67]),
    (41, [57, 60, 65, 69]),
    (43, [55, 59, 62, 67]),
]
# lead motif per chord: (8th-note step, semitone offset over chord root + 24, length in 8ths)
MOTIF = [(0, 0, 2), (3, 7, 1), (4, 12, 2), (6, 10, 2)]


def lead(m, length):
    n = int(length * SR)
    x = saw(midi(m), n, 0.003) * 0.5 + np.sin(2 * np.pi * midi(m) * t_(n)) * 0.5
    y = lp2(x, 1400 + 2600 * np.exp(-t_(n) * 6))
    return y * env_adsr(n, 0.01, 0.15, 0.6, 0.08, length - 0.08) * 0.16


for bar in range(BARS):
    t0 = bar * BAR
    root, voicing = (CHORDS_B if bar in PROG_B else CHORDS)[bar % 4]
    intro = bar in INTRO
    breakdown = bar in BREAK
    final = bar == FINAL
    if not final:
        place(music, pad(voicing, BAR + 0.6, 0.6 if intro else (0.8 if breakdown else 1.4)), t0, 0.9)
    if final:
        place(music, pad([57, 60, 64, 69, 72], BAR + 1.0, 1.2), t0, 1.0)
        place(music, kick(), t0, 1.0)
        place(music, bass_note(root, BAR * 0.9), t0, 1.0)
        continue
    for k in range(8):
        if intro and k % 2:
            continue
        m = voicing[ARP[k]] + 12
        place(music, pluck(m), t0 + k * BEAT / 2, 1.1 if intro else 0.8, pan=(-0.35 if k % 2 else 0.35))
    if intro:
        place(music, bass_note(root, BAR), t0, 0.8)
        continue
    for k in range(8):
        if breakdown and k % 4:
            continue
        m = root + (12 if k % 2 else 0)
        length = BEAT / 2 * (4 if breakdown else 0.9)
        place(music, bass_note(m, length), t0 + k * BEAT / 2, 0.9 if breakdown else 1.0)
    if breakdown:
        continue
    if bar in LEAD and bar % 2 == 0:
        for step, off, ln in MOTIF:
            place(music, lead(root + 24 + off, ln * BEAT / 2), t0 + step * BEAT / 2, 1.0, pan=-0.1)
    for b in range(4):
        place(music, kick(), t0 + b * BEAT, 1.0)
        if b in (1, 3):
            place(music, clap(), t0 + b * BEAT, 0.9, pan=0.05)
        place(music, hat(open_=(b == 3)), t0 + b * BEAT + BEAT / 2, 0.9, pan=0.25)
        for s in (1, 3):
            place(music, hat(), t0 + b * BEAT + s * BEAT / 4, 0.45, pan=-0.25)


def riser(length):
    n = int(length * SR)
    t = t_(n)
    x = hp(rng.standard_normal(n), 400)
    y = lp(x, 500 + 9000 * (t / length) ** 2)
    return y * (t / length) ** 2.2 * 0.35


# risers into every drop out of the intro or a breakdown
for b in (1, 7, 23, 39):
    place(music, riser(BAR), b * BAR, 0.9)

duck = np.ones(N)
for bar in range(BARS):
    if bar in INTRO or bar in BREAK or bar == FINAL:
        continue
    for b in range(4):
        i = int((bar * BAR + b * BEAT) * SR)
        n = int(BEAT * SR)
        tt = t_(n)
        duck[i : i + n] = np.minimum(duck[i : i + n], 1 - 0.35 * np.exp(-tt * 14))
music *= duck[:, None]

music = reverb(music, 2.4, 0.22)
music = np.stack([lp2(music[:, c], 11000) for c in range(2)], axis=1)

# ---- sfx (separate stem so it can be retimed later) ------------------------

sfx = np.zeros((N, 2))


def stamp(m):
    """Low, short, in-key body thump for type slams."""
    n = int(0.5 * SR)
    t = t_(n)
    f = midi(m) * (1 + 0.6 * np.exp(-t * 40))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
    tick = lp(rng.standard_normal(n), 2400) * np.exp(-t * 160) * 0.25
    return (body + tick) * 0.6


def tick():
    n = int(0.03 * SR)
    return hp(rng.standard_normal(n), 3000) * np.exp(-t_(n) * 220) * 0.18


def chime():
    n = int(1.6 * SR)
    t = t_(n)
    x = np.zeros(n)
    for m, d, g in ((76, 0.0, 1.0), (81, 0.11, 0.9)):
        i = int(d * SR)
        tt = t[: n - i]
        x[i:] += g * (np.sin(2 * np.pi * midi(m) * tt) + 0.25 * np.sin(2 * np.pi * midi(m + 12) * tt)) * np.exp(-tt * 4.5)
    return x * 0.22


def tap():
    n = int(0.05 * SR)
    t = t_(n)
    return np.sin(2 * np.pi * 1760 * t) * np.exp(-t * 160) * 0.12 + lp(rng.standard_normal(n), 3000) * np.exp(-t * 300) * 0.05


SFX_TIMES = dict(
    stamps=[(0.12, 45), (0.12 + 2 * BEAT, 41), (0.12 + 4 * BEAT, 48), (6 * BEAT, 33)],
    # chapter title slams: models, files, Acode, schedules, triage, usage, host, search, recap
    chapters=[(b * BAR, m) for b, m in ((10, 45), (14, 41), (18, 48), (22, 43), (26, 45), (30, 40), (34, 41), (38, 43), (40, 45))],
    ticks=[11.25 + k * BEAT / 2 for k in range(14)] + [22 * BAR + k * BEAT / 2 for k in range(14)],
    chime=[14.2, 23.6 * BAR],
)
for t0, m in SFX_TIMES["stamps"]:
    place(sfx, stamp(m), t0, 0.9)
for t0, m in SFX_TIMES["chapters"]:
    place(sfx, stamp(m), t0 + 0.02, 0.7)
for t0 in SFX_TIMES["ticks"]:
    place(sfx, tick(), t0, 0.8, pan=0.2)
for t0 in SFX_TIMES["chime"]:
    place(sfx, chime(), t0, 0.9)
sfx = reverb(sfx, 1.6, 0.18)


def finish(x, peak_db=-1.0):
    x = x[: int(DUR * SR)]
    fade = int(0.01 * SR)
    x[:fade] *= np.linspace(0, 1, fade)[:, None]
    tail = int(1.2 * SR)
    x[-tail:] *= np.linspace(1, 0, tail)[:, None] ** 1.5
    x = np.tanh(x * 1.1) / np.tanh(1.1)
    x *= 10 ** (peak_db / 20) / max(np.abs(x).max(), 1e-9)
    return x


def write(path, x):
    pcm = (np.clip(x, -1, 1) * (2 ** 23 - 1)).astype(np.int32)
    b = np.zeros((pcm.shape[0], 2, 3), np.uint8)
    for k in range(3):
        b[:, :, k] = (pcm >> (8 * k)) & 0xFF
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(3)
        w.setframerate(SR)
        w.writeframes(b.tobytes())


out = sys.argv[1]
write(f"{out}/music.wav", finish(music, -1.5))
write(f"{out}/sfx.wav", finish(sfx, -6.0))
print(f"duration {DUR:.3f}s, bar {BAR:.4f}s, beat {BEAT:.4f}s")
