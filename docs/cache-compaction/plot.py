"""Reproduce: python plot.py (requires matplotlib; see README.md)
Illustrative API-equivalent marginal costs, NOT observed usage or subscription charges.
Official sources verified 2026-10-17; see assumptions.md. No provider calls.
"""

import csv
import json
from pathlib import Path

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import StrMethodFormatter

OUT = Path(__file__).resolve().parent
C, S, R, W, IN_PRICE, OUT_PRICE = 100_000, 20_000, 0.10, 4.0, 2.0, 10.0
M = 1_000_000
n = np.arange(1, 61)
compact_warm_call = (C * R + S * OUT_PRICE) / M
# A summary's first user continuation writes the new prefix, even if the prior prefix was warm.
compact_before = compact_warm_call + S * W / M + (n - 1) * S * R / M
keep_warm = n * C * R / M
keep_cold = C * W / M + (n - 1) * C * R / M
assert np.isclose(compact_before[0], 0.29) and np.isclose(keep_cold[0], 0.40)
assert np.isclose(compact_before[35], keep_warm[35])
assert compact_before[36] < keep_warm[36]
with (OUT / "costs.csv").open("w") as f:
    writer = csv.writer(f)
    writer.writerow(
        ["next_requests", "retain_warm_usd", "compact_before_usd", "retain_cold_resume_usd"]
    )
    writer.writerows(zip(n, keep_warm, compact_before, keep_cold, strict=True))
plt.rcParams.update(
    {
        "text.parse_math": False,
        "font.family": "DejaVu Sans",
        "font.size": 11,
        "axes.labelcolor": "#242629",
        "text.color": "#242629",
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.edgecolor": "#8c9299",
        "svg.fonttype": "none",
    }
)
fig, axes = plt.subplots(1, 2, figsize=(13, 7.4), sharey=True)
fig.subplots_adjust(left=0.075, right=0.98, top=0.74, bottom=0.34, wspace=0.15)
blue, orange, grey = "#2466a4", "#b36b13", "#5c636b"
for ax in axes:
    ax.grid(axis="y", color="#e3e6e8", lw=0.8)
    ax.set_axisbelow(True)
    ax.set_xlim(1, 60)
    ax.set_ylim(0, 1.05)
    ax.set_xticks([1, 10, 20, 30, 40, 50, 60])
    ax.yaxis.set_major_formatter(StrMethodFormatter("${x:.2f}"))
    ax.set_xlabel("Next model requests (not user messages)", labelpad=10)
axes[0].plot(n, keep_warm, color=blue, lw=2.4, label="Retain original context")
axes[0].plot(n, compact_before, color=orange, lw=2.4, ls="--", label="Compact while cached")
axes[0].set_title(
    "A  Continue while the original cache is warm",
    loc="left",
    fontsize=12,
    fontweight="bold",
    pad=18,
)
axes[0].set_ylabel("Cumulative context + compaction cost (USD)", labelpad=10)
axes[0].scatter([36], [0.36], color="#242629", s=26, zorder=4)
axes[0].annotate(
    "Equal at 36 requests\nCompaction cheaper from 37",
    xy=(36, 0.36),
    xytext=(23, 0.72),
    arrowprops={"arrowstyle": "-", "color": grey},
    fontsize=10,
)
axes[0].legend(loc="upper left", frameon=False, fontsize=10)
axes[1].plot(n, keep_cold, color=blue, lw=2.4, label="Retain context; cold rewrite")
axes[1].plot(n, compact_before, color=orange, lw=2.4, ls="--", label="Compact before expiry")
axes[1].set_title(
    "B  Resume after the original cache expires", loc="left", fontsize=12, fontweight="bold", pad=18
)
axes[1].legend(loc="upper left", frameon=False, fontsize=10)
axes[1].annotate(
    "First continuation: $0.40 retain\n$0.29 compact before expiry",
    xy=(1, 0.4),
    xytext=(5, 0.17),
    fontsize=10,
)
fig.text(0.075, 0.94, "Compaction versus prompt caching", fontsize=22, fontweight="bold")
fig.text(
    0.075,
    0.885,
    "Illustrative Sonnet 5.5 API-equivalent costs • 100k cached tokens → 20k generated summary",
    fontsize=12,
)
fig.text(
    0.075,
    0.83,
    "Both preserve cache benefits after the first continuation. Compaction pays once to make future reads smaller.",
    fontsize=11,
)
fig.text(
    0.075,
    0.19,
    "Assumptions: fixed reusable context; 20k summary output; one-hour cache writes; full cache hits thereafter.\nCommon new messages, tool work and ordinary output excluded equally. No model-quality or latency estimate.",
    fontsize=10,
    linespacing=1.6,
)
fig.text(
    0.075,
    0.105,
    "Rates / million tokens: input $2 • cache read $0.10 • one-hour write $4 • output $10.\nPrecompact cost includes $0.01 warm input + $0.20 summary output + $0.08 new-prefix write.",
    fontsize=10,
    linespacing=1.6,
)
fig.text(
    0.075,
    0.035,
    "Estimated, not measured; not subscription billing. If you never resume, precompaction spends $0.21 with no continuation benefit.\nSources: platform.claude.com/docs/en/about-claude/pricing • code.claude.com/docs/en/prompt-caching • verified 2026-10-17",
    fontsize=9,
    color=grey,
    linespacing=1.6,
)
for ext in ["png", "svg"]:
    fig.savefig(OUT / f"cache-vs-compaction.{ext}", dpi=180, facecolor="white")
print(
    json.dumps(
        {
            "first_resume": {
                "retain_cold": float(keep_cold[0]),
                "compact_before": float(compact_before[0]),
            },
            "warm_break_even_requests": 36,
            "warm_strictly_cheaper_from": 37,
            "generated": ["cache-vs-compaction.png", "cache-vs-compaction.svg", "costs.csv"],
        }
    )
)
