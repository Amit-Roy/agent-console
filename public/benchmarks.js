/* Cached benchmark exploration. Upstream refreshes happen only through the server. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const money = value => value === null ? 'Unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 0 }).format(value);
  const unitPrice = value => value === null ? 'Unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
  const format = value => value === null ? 'Unknown' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Unknown';
  let data = null, chart = null, selected = null, pending = false;
  let rows = [];
  const text = (id, value) => { $(id).textContent = value; };
  function error(message) { text('error', message || ''); $('error').hidden = !message; }
  function validValue(id, minimum, maximum) {
    const input = $(id);
    const value = input.value.trim() === '' ? null : Number(input.value);
    return Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
  }
  function modelCost(model, usage, activeHours, useCache) {
    const categories = ['fresh', 'cacheRead', 'cacheWrite', 'output'];
    if (!(activeHours > 0) || categories.some(key => number(usage[key]) === null || usage[key] < 0)) return null;
    let cost = 0;
    for (const key of categories) {
      const tokens = usage[key];
      if (!tokens) continue;
      let price = key === 'output' ? number(model.outputPrice) : number(model.inputPrice);
      if (useCache && key === 'cacheRead' && number(model.cacheReadPrice) !== null) price = model.cacheReadPrice;
      if (useCache && key === 'cacheWrite' && number(model.cacheWritePrice) !== null) price = model.cacheWritePrice;
      if (price === null || price < 0) return null;
      cost += tokens * price / 1e6;
    }
    return Number.isFinite(cost / activeHours) ? cost / activeHours : null;
  }
  function updateRefresh() {
    const due = data?.refreshAllowedAt ? new Date(data.refreshAllowedAt).getTime() : 0;
    $('refresh').disabled = pending || !!data?.refreshing || (Number.isFinite(due) && due > Date.now());
    $('refresh').title = due > Date.now() ? `Next allowed refresh: ${date(due)}` : 'Fetch one new benchmark snapshot';
    $('weekly').disabled = pending || !data;
  }
  function selectModel(id) {
    selected = id;
    const model = rows.find(row => row.id === id);
    if (!model) return;
    text('selection', `${model.name}: ${format(model.score)} ${$('score').selectedOptions[0].textContent.toLowerCase()} score; ${money(model.monthly)}/month; ${format(number(model.speed))} output tokens/s; ${format(number(model.latency))} seconds to first answer token. ${model.frontier ? 'On the cost frontier.' : 'Outside the cost frontier.'}`);
    document.querySelectorAll('#models tr').forEach(row => { row.dataset.selected = String(row.dataset.id === String(id)); });
  }
  function renderChart() {
    if (chart) { chart.destroy(); chart = null; }
    const scope = $('scope').value;
    let points = rows.filter(row => row.monthly !== null && (scope !== 'qualified' || row.qualified));
    if (scope === 'leaders') points = [...points].sort((a, b) => b.score - a.score).slice(0, 20);
    $('comparison-chart').hidden = !points.length || !window.Chart;
    $('chart-empty').hidden = points.length > 0 && !!window.Chart;
    if (!points.length || !window.Chart) {
      text('chart-empty', !points.length ? 'A cost plot needs measured token usage and active hours. Scores remain available in the table.' : 'Chart could not load. Exact values remain available in the table.');
      return;
    }
    const style = getComputedStyle(document.body), accent = style.getPropertyValue('--accent').trim(), neutral = style.getPropertyValue('--t2').trim(), edge = style.getPropertyValue('--edge').trim();
    chart = new Chart($('comparison-chart'), {
      type: 'scatter',
      data: { datasets: [{ label: 'Models', data: points.map(row => ({ x: row.monthly, y: row.score, model: row })), pointStyle: points.map(row => row.frontier ? 'rectRot' : 'circle'), pointRadius: points.map(row => row.frontier ? 6 : 4), pointHoverRadius: 8, backgroundColor: points.map(row => row.qualified ? accent : 'transparent'), borderColor: points.map(row => row.qualified ? accent : neutral), borderWidth: 1.5 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, onClick: (_event, hits) => { if (hits.length) selectModel(points[hits[0].index].id); }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${context.raw.model.name}: ${money(context.parsed.x)}/month · score ${format(context.parsed.y)}` } } }, scales: { x: { type: 'linear', min: 0, title: { display: true, text: 'Projected API cost / month (USD)', color: neutral }, ticks: { color: neutral, callback: value => money(value) }, grid: { color: edge } }, y: { title: { display: true, text: `${$('score').selectedOptions[0].textContent} score`, color: neutral }, ticks: { color: neutral }, grid: { color: edge } } } }
    });
  }
  function renderTable() {
    const scope = $('scope').value;
    let shown = rows.filter(row => scope !== 'qualified' || row.qualified);
    shown = scope === 'leaders' ? [...shown].sort((a, b) => b.score - a.score).slice(0, 20) : [...shown].sort((a, b) => (a.monthly ?? Infinity) - (b.monthly ?? Infinity) || b.score - a.score);
    $('models').replaceChildren();
    for (const model of shown) {
      const row = document.createElement('tr'); row.dataset.id = model.id; row.dataset.selected = String(selected === model.id);
      const name = document.createElement('td'), button = document.createElement('button'); button.type = 'button'; button.className = 'model-button'; button.textContent = model.name; button.addEventListener('click', () => selectModel(model.id)); name.append(button);
      const creator = document.createElement('span'); creator.className = 'model-creator'; creator.textContent = model.creator || 'Creator unknown'; name.append(creator);
      if (model.frontier) { const marker = document.createElement('span'); marker.className = 'frontier-label'; marker.textContent = 'Cost frontier'; name.append(marker); }
      row.append(name);
      for (const value of [format(model.score), money(model.monthly), money(model.weekly), unitPrice(number(model.inputPrice)), unitPrice(number(model.outputPrice)), format(number(model.speed))]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      $('models').append(row);
    }
    text('table-count', `${shown.length} shown · ${rows.length} models with a ${$('score').selectedOptions[0].textContent.toLowerCase()} score. ${scope === 'leaders' ? 'Sorted by score.' : 'Sorted by projected cost, lowest first.'}`);
    $('table-empty').hidden = shown.length > 0;
    text('table-empty', 'No models match this view. Lower the quality floor or show all scored models.');
  }
  function render() {
    if (!data) return;
    const usage = data.usage || {}, snapshot = data.snapshot || {}, scoreKey = $('score').value;
    const hours = validValue('hours', .1, 24), days = validValue('days', 1, 7), quality = validValue('quality', 0, 100);
    const override = $('active-hours').value.trim() !== '', activeHours = override ? validValue('active-hours', .01, Infinity) : number(usage.activeHours);
    const budget = $('budget').value.trim() === '' ? null : validValue('budget', 0, Infinity);
    const valid = hours !== null && days !== null && quality !== null && (!override || activeHours !== null) && ($('budget').value.trim() === '' || budget !== null);
    if (!valid || !$('controls').checkValidity()) { text('recommendation-title', 'Check your comparison settings'); text('recommendation-detail', 'Enter values within the displayed limits to update this comparison.'); text('recommendation-cost', ''); rows = []; renderTable(); renderChart(); text('leader', ''); text('selection', ''); text('formula', ''); text('usage-note', 'Correct the settings to update usage and cost assumptions.'); return; }
    rows = (snapshot.models || []).filter(model => number(model[scoreKey]) !== null).map((model, index) => {
      const hourly = modelCost(model, usage, activeHours, $('cache').value === 'known');
      return { ...model, id: model.id ?? model.slug ?? `model-${index}`, score: model[scoreKey], hourly, weekly: hourly === null ? null : hourly * hours * days, monthly: hourly === null ? null : hourly * hours * days * 52 / 12 };
    });
    const bestScore = rows.length ? Math.max(...rows.map(row => row.score)) : null;
    const floor = bestScore === null ? null : bestScore * quality / 100;
    rows.forEach(row => { row.qualified = row.score >= floor; row.frontier = row.monthly !== null && !rows.some(other => other.monthly !== null && other.monthly <= row.monthly && other.score >= row.score && (other.monthly < row.monthly || other.score > row.score)); });
    const eligible = rows.filter(row => row.qualified && row.monthly !== null && (budget === null || row.monthly <= budget)).sort((a, b) => a.monthly - b.monthly || b.score - a.score);
    const recommendation = eligible[0];
    const complete = number(usage.turns) !== null && number(usage.measuredTurns) !== null && usage.turns > 0 && usage.measuredTurns === usage.turns;
    const partial = !complete;
    if (recommendation) {
      text('recommendation-title', recommendation.name);
      text('recommendation-detail', `Lowest estimated cost at ≥${format(floor)} score (${quality}% of the best ${scoreKey} score)${budget === null ? '' : ` within ${money(budget)}/month`}. ${$('cache').value === 'known' ? 'Assumes your observed cache mix continues.' : 'All input is priced at standard rates.'} ${partial ? 'Partial usage coverage: this estimate may understate your full burn.' : 'Assumes the measured token mix and activity rate continue.'}`);
      $('recommendation-cost').replaceChildren(document.createTextNode(`${money(recommendation.monthly)}/mo`)); const small = document.createElement('small'); small.textContent = `${money(recommendation.weekly)}/week · ${money(recommendation.hourly)}/active hour`; $('recommendation-cost').append(small);
    } else {
      text('recommendation-title', !rows.length ? 'No benchmark snapshot available' : rows.every(row => row.monthly === null) ? 'More usage measurement needed' : 'No priced model meets your settings');
      text('recommendation-detail', !rows.length ? 'Use Refresh benchmarks to fetch a snapshot when the API quota allows.' : rows.every(row => row.monthly === null) ? 'Cost projections need positive active hours and complete token categories. An observed active hours override can supply your own denominator.' : 'Raise the budget or lower the quality floor. Models with unknown costs cannot qualify for a budget recommendation.'); text('recommendation-cost', '');
    }
    const leader = [...rows].sort((a, b) => b.score - a.score)[0];
    text('leader', leader ? `Highest ${scoreKey} score: ${leader.name} · ${format(leader.score)} · ${money(leader.monthly)}/month.` : `No ${scoreKey} scores in this snapshot. Try another benchmark.`);
    text('usage-note', `${partial ? 'Partial measurements' : 'Measured coverage'}: ${format(number(usage.measuredTurns))} / ${format(number(usage.turns))} turns · ${format(number(usage.activeHours))} measured active hours${override ? `; using your ${format(activeHours)} hour override` : ''}. ${date(usage.from)} to ${date(usage.to)}. Active time is the union of agent activity, not a sum of concurrent agents.`);
    text('formula', `Hourly cost = observed token costs ÷ ${format(activeHours)} active hours. Weekly = hourly × ${hours} × ${days}. Monthly = weekly × 52 ÷ 12. All prices are USD per million tokens; projections use the same workload across models.`);
    text('assumptions', Array.isArray(usage.assumptions) && usage.assumptions.length ? usage.assumptions.join(' ') : 'Token accounting and active time may be incomplete. Different models can need different token counts and retries for the same task.');
    text('cache-note', $('cache').value === 'known' ? 'Cache scenario: known cache read/write prices are applied independently; missing cache prices fall back to standard input prices. Cache eligibility and hit rates may change by provider.' : 'Standard input scenario: fresh input, cache reads and cache writes are all charged at standard input prices. Output uses the listed output price. Actual cache writes can cost more than standard input.');
    text('freshness', snapshot.fetchedAt ? `Snapshot ${date(snapshot.fetchedAt)}${snapshot.indexVersion ? ` · Index ${snapshot.indexVersion}` : ''}${snapshot.tier ? ` · ${snapshot.tier} tier` : ''}` : 'No snapshot available');
    const quota = snapshot.quota || data.quota || {};
    text('quota', `Benchmark API quota: ${format(number(quota.remaining))} remaining / ${format(number(quota.limit))}${quota.resetAt ? ` · Resets ${date(quota.resetAt)}` : ''}. Viewing and adjusting this page uses cached data.`);
    text('schedule', `${data.weekly ? 'Weekly refresh enabled.' : 'Weekly refresh disabled.'}${data.nextRefreshAt ? ` Next scheduled refresh: ${date(data.nextRefreshAt)}.` : ''}${data.refreshAllowedAt && data.refreshAllowedAt > Date.now() ? ` On-demand refresh available ${date(data.refreshAllowedAt)}.` : ''}`);
    $('weekly').checked = !!data.weekly;
    renderTable(); renderChart(); updateRefresh();
    if (selected && rows.some(row => row.id === selected)) selectModel(selected); else text('selection', '');
  }
  async function request(path, options) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}). Try again later.`);
    return body;
  }
  async function load(refresh = false) {
    if (pending) return;
    pending = true; updateRefresh(); $('benchmark-main').setAttribute('aria-busy', 'true'); text('load-status', refresh ? 'Fetching one benchmark snapshot…' : 'Loading cached benchmarks and measured usage…'); error('');
    try { data = await request(refresh ? '/api/benchmarks/refresh' : '/api/benchmarks', refresh ? { method: 'POST' } : undefined); render(); if (data.error) error(data.error); text('load-status', refresh ? 'Benchmark snapshot updated.' : 'Cached data loaded.'); }
    catch (err) {
      // Read the cache after a rejected refresh to pick up the server's quota cooldown.
      if (refresh) { try { data = await request('/api/benchmarks'); render(); } catch {} }
      error(`${err.message} ${data ? 'Showing the last loaded snapshot.' : 'Reload this page to retry cached data.'}`); text('load-status', '');
    }
    finally { pending = false; updateRefresh(); $('benchmark-main').setAttribute('aria-busy', 'false'); }
  }
  $('controls').addEventListener('submit', event => event.preventDefault());
  $('controls').addEventListener('input', render);
  $('scope').addEventListener('change', () => { renderTable(); renderChart(); });
  $('refresh').addEventListener('click', () => load(true));
  $('weekly').addEventListener('change', async () => {
    if (pending) return;
    const weekly = $('weekly').checked; pending = true; updateRefresh(); error('');
    try { const settings = await request('/api/benchmarks/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekly }) }); data = settings; render(); }
    catch (err) { error(`Could not save weekly refresh: ${err.message}`); $('weekly').checked = !!data.weekly; }
    finally { pending = false; updateRefresh(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateRefresh(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (data) renderChart(); });
  load();
})();
