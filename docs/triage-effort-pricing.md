# Complexity-based effort pricing

Task facts determine estimated work. Estimated work then determines the token quote. Historical token totals never determine task complexity.

The model quotes one observed direct-agent delivery run. It does not establish human hours, full-issue iterations, subscription charges, or complete child-agent usage.

## Learned work equation

The small model extracts four pre-work features, each from 0 to 3 with an exact supporting quote: breadth, behavior complexity, uncertainty, and risk. Unsupported features remain unknown. Historical extraction can use bounded conversation context that existed before the run; it excludes current-run answers, tools, results, realized diffs, commit titles, and usage.

The offline fit learns nonnegative complexity weights against observed logged tool actions:

```text
z(x) = intercept + Σ beta[j] * feature[j] / scale[j]
                 + Σ missingBeta[j] * isUnknown[j]
predicted actions = max(0, exp(z(x)) - 1)
```

Missing values use training-only medians. Missingness has separate learned coefficients. Nonnegative feature coefficients make increasing known complexity monotone. The regularization strength is selected using older completed thread groups. No fitted target uses request length, cached-input totals, generated-token totals, or old effort labels as task complexity.

The initial context-v2 fit learned:

```text
log1p(actions) = 2.687009
              + 0.280696 * breadth
              + 0.066230 * behavior_complexity
              + approximately 0 * uncertainty
              + 0.048338 * risk
              + learned missingness terms
```

The feature scales are 1 for this fit. The effectively zero uncertainty coefficient means this small sample did not identify an independent effect. It does not establish that uncertainty is free.

## Token quote and uncertainty reserve

Older-group, out-of-fold predictions provide paired residual scenarios. For historical run `i`:

```text
r_i = log1p(observed_actions_i) - log1p(out_of_fold_prediction_i)
scenario_actions_i(x) = max(0, exp(z(x) + r_i) - 1)
scenario_output_i(x) = scenario_actions_i(x) * observed_output_i / observed_actions_i
```

Non-cached input and cached replay use separate observed per-action yields from the same scenarios. Total input adds these paired channels before taking quantiles, so cache reads are never added twice. A channel with incomplete telemetry remains unavailable.

Each quote shows P50, P80, and P95 scenarios. The P80 risk premium is `P80(output) - P50(output)`. This resembles a reserve for uncertain overruns; it is an empirical effort quote rather than an options-market valuation. Percentile names describe model scenarios, not guaranteed completion probabilities.

Effort routing uses historical action terciles. Complete, in-range scope uses P50 activity. Unknown or extrapolated scope uses P95 activity and recommends the P95 token reserve. This conservative routing is an explicit policy, not an invented model coefficient or a claim of better accuracy.

## Initial evidence: 2026-10-19

The source contained 27 verified delivery runs. One credential-suspect request was refused before external feature extraction. The resulting dataset has 26 runs in 14 thread groups. Pre-work features were known in 18 runs for breadth, 16 for behavior complexity, 20 for uncertainty, and 10 for risk.

The fit uses 22 runs in 11 groups. Four runs in three newer groups remain held out. Nineteen older-group out-of-fold scenarios calibrate the quote. Training outcomes must complete before target requests start; no group crosses a split. The context-v2 feature definition was chosen to recover available pre-work plans before inspecting its held-out outcomes.

| Check | Complexity model | Global-median baseline |
| --- | ---: | ---: |
| Held-out work MAE, logged actions | 66.89 | 71.50 |
| Held-out generated-token MAE | 9,568.75 | 11,853.25 |
| Generated-token P80 hit rate | 50% | Not applicable |
| Generated-token P95 hit rate | 75% | Not applicable |
| Work P80 hit rate | 25% | Not applicable |
| Work P95 hit rate | 50% | Not applicable |

The model is **experimental**. Four held-out runs are insufficient to establish accuracy. The intervals under-cover held-out outcomes; P80/P95 must not be read as 80%/95% completion probabilities.

For illustration, the fitted model produces these fully specified feature scenarios. They are model outputs, not additional historical observations:

| All four feature levels | P50 logged actions | P50 generated tokens | P80 generated tokens |
| --- | ---: | ---: | ---: |
| 0 | 10.01 | 4,092 | 5,561 |
| 1 | 15.35 | 6,142 | 8,393 |
| 3 | 35.05 | 13,705 | 18,976 |

Initial effort cutoffs are 12 and 26 logged actions. These are relative routing tiers, not universal definitions of software difficulty. Tool wrappers, batching, provider behavior, retries, and context policy influence observed activity and token yields.

The [aggregate fitted report](triage-effort-report.json) records the fixed initial cohort's coefficients, feature coverage, versions, selection diagnostics, and held-out checks. It contains no source requests or scenario identities. The reviewed initial model uses this fixed cohort; later daily fits can change the cohort and diagnostics as work completes. The preceding [historical usage baseline](triage-calibration.md) remains an audit reference and is no longer the active effort equation.

## Operation and reproduction

Calibration uses maintained numerical libraries: SciPy bounded least squares for nonnegative ridge, with NumPy preprocessing and quantiles. See [SciPy's bounded solver](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.lsq_linear.html). Runtime inference uses the exported coefficients and scenarios in Node; it needs no Python process.

Install the pinned offline environment once:

```sh
uv venv --managed-python --python 3.13 ~/.local/share/agent-console/triage-venv
uv pip install --python ~/.local/share/agent-console/triage-venv/bin/python -r requirements-triage.txt
bin/github-triage calibrate
npm run test:triage
npm run test:effort-fit
```

`AGENT_CONSOLE_TRIAGE_PYTHON` overrides the fitter interpreter. `AGENT_CONSOLE_TRIAGE_EFFORT_MODEL` overrides the private artifact path. The default artifact is `~/.config/agent-console/triage-effort-model.json`, mode 0600. Source history, contextual feature cache, and calibration reports remain private local files. Credential refusal is conservative pattern-based filtering, not universal secret detection.

The matching numerical training snapshot is retained as `~/.config/agent-console/triage-effort-training.json`, mode 0600. Refit that snapshot with `scripts/triage-effort-fit.py --dataset ... --output ... --report ...` to reproduce an installed model without collecting a different cohort. A full `calibrate` command intentionally refreshes source history and can include newly completed work.

The production watchdog checks receiver health before scheduling offline work. Daily calibration runs detached, with an exclusive process lock and cached feature extraction. Failed attempts retain the last usable model and retry at most hourly. Scratch instances do not scan production history. A missing model fails before any triage model call.

GitHub comments keep their existing identity. They show scope evidence, work quantiles, generated-token quotes, cached replay separately, risk premium, selected routing quantile, model status, and measured coverage.
