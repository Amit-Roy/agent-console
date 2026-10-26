// Longest-first shard plan: heaviest file goes to the least-loaded shard.
export function planShards(files, weights, total) {
  const known = files.map((file) => weights[file]).filter((value) => Number.isFinite(value));
  known.sort((a, b) => a - b);
  const mid = known.length >> 1;
  const fallback = !known.length
    ? 1
    : known.length % 2
      ? known[mid]
      : (known[mid - 1] + known[mid]) / 2;
  const weightOf = (file) => (Number.isFinite(weights[file]) ? weights[file] : fallback);
  const ordered = [...files].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] }));
  for (const file of ordered) {
    let best = shards[0];
    for (const shard of shards) if (shard.load < best.load) best = shard;
    best.files.push(file);
    best.load += weightOf(file);
  }
  return shards.map((shard) => shard.files);
}
