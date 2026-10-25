#!/usr/bin/env node
/** Build one initial-request / observed-session-usage sample per canonical session. */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsoleSessions, writePrivateSessionJson } from "./triage-console-sessions.ts";
import { buildNativeSessions } from "./triage-native-sessions.ts";

type Json = Record<string, any>;
const unique = (values: string[]) => [...new Set(values)];
const nativeIds = (task: Json): string[] =>
  unique(
    (task.provenance?.nativeSessionIds || []).filter(
      (value: unknown) => typeof value === "string" && value,
    ),
  );

type Component = { console: Json[]; native: Json[]; links: Json[] };
type Selection = { selected: Json[]; linkedIds: string[]; nativeComplete: boolean };

function createIdentityForest() {
  const parents = new Map<string, string>();
  const find = (id: string): string => {
    if (!parents.has(id)) parents.set(id, id);
    const parent = parents.get(id)!;
    if (parent !== id) parents.set(id, find(parent));
    return parents.get(id)!;
  };
  const join = (left: string, right: string) => parents.set(find(right), find(left));
  return { find, join };
}
type Forest = ReturnType<typeof createIdentityForest>;

function linkIdentities(forest: Forest, links: Json[], nativeTasks: Json[], consoleTasks: Json[]) {
  for (const link of links) {
    const node = `console:${link.threadId}`;
    forest.find(node);
    for (const nativeId of link.nativeSessionIds || []) forest.join(node, `native:${nativeId}`);
  }
  for (const task of nativeTasks) {
    const node = `task:${task.id}`;
    forest.find(node);
    for (const nativeId of nativeIds(task)) forest.join(node, `native:${nativeId}`);
  }
  for (const task of consoleTasks) forest.find(task.id);
}

function groupComponents(forest: Forest, links: Json[], consoleTasks: Json[], nativeTasks: Json[]) {
  const components = new Map<string, Component>();
  const component = (node: string) => {
    const root = forest.find(node);
    if (!components.has(root)) components.set(root, { console: [], native: [], links: [] });
    return components.get(root)!;
  };
  for (const link of links) component(`console:${link.threadId}`).links.push(link);
  for (const task of consoleTasks) component(task.id).console.push(task);
  for (const task of nativeTasks) component(`task:${task.id}`).native.push(task);
  return components;
}

function selectSources(value: Component): Selection {
  const covered = new Set(value.native.flatMap(nativeIds));
  const linkedIds = unique(value.links.flatMap((link) => link.nativeSessionIds || []));
  const nativeComplete =
    value.native.length > 0 &&
    (!value.console.length || linkedIds.every((linkedId) => covered.has(linkedId)));
  return { selected: nativeComplete ? value.native : value.console, linkedIds, nativeComplete };
}

/** Native-only probe/test sessions teach the model nothing about user requests. */
function isNonUserOrigin(value: Component) {
  if (value.links.length || value.console.length) return false;
  return !value.native.some((task) => task.provenance?.userOrigin === true);
}

function sumField(selected: Json[], field: string) {
  const valid = selected.every(
    (task) => typeof task[field] === "number" && Number.isFinite(task[field]) && task[field] >= 0,
  );
  return valid ? selected.reduce((total, task) => total + task[field], 0) : null;
}

function linkSampleIdentity(
  forest: Forest,
  sampleId: string,
  value: Component,
  selection: Selection,
) {
  const { selected, linkedIds } = selection;
  forest.find(`sample:${sampleId}`);
  for (const source of [...selected, ...value.native])
    forest.join(`sample:${sampleId}`, `cohort:${source.group}`);
  for (const identity of unique([...selected.flatMap(nativeIds), ...linkedIds]))
    forest.join(`sample:${sampleId}`, `lineage:${identity}`);
  for (const lineage of unique(value.links.flatMap((link) => link.lineageNativeSessionIds || [])))
    forest.join(`sample:${sampleId}`, `lineage:${lineage}`);
}

function buildSampleTask(forest: Forest, value: Component, selection: Selection) {
  const { selected, nativeComplete } = selection;
  const initial = [...selected, ...value.console].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  )[0];
  const consoleIdentity = [...value.links].sort((left, right) =>
    left.threadId.localeCompare(right.threadId),
  )[0];
  const sampleId = consoleIdentity ? `console:${consoleIdentity.threadId}` : initial.id;
  const request = initial.request.slice(0, 12_000);
  linkSampleIdentity(forest, sampleId, value, selection);
  return {
    id: sampleId,
    group: consoleIdentity ? sampleId : initial.group,
    request,
    preworkContext: [],
    startedAt: selected.reduce(
      (time, task) => (task.startedAt < time ? task.startedAt : time),
      initial.startedAt,
    ),
    completedAt: [...selected, ...value.console].reduce(
      (time, task) => (task.completedAt > time ? task.completedAt : time),
      initial.completedAt,
    ),
    provider: unique(selected.flatMap((task) => String(task.provider).split("+")))
      .sort()
      .join("+"),
    inputTokens: sumField(selected, "inputTokens"),
    outputTokens: sumField(selected, "outputTokens"),
    cacheReadTokens: sumField(selected, "cacheReadTokens"),
    nonCachedInputTokens: sumField(selected, "nonCachedInputTokens"),
    toolCalls: sumField(selected, "toolCalls"),
    toolRounds: sumField(selected, "toolRounds"),
    provenance: {
      scope: "completed-session",
      source: nativeComplete ? "native-canonical" : "console-ledger-fallback",
      nativeSessionIds: unique(selected.flatMap(nativeIds)),
      consoleThreads: value.links.map((link) => link.threadId),
      sourceSessions: selected.map((task) => ({ id: task.id, provenance: task.provenance })),
      initialRequestTruncated:
        initial.request.length > request.length || !!initial.provenance?.initialRequestTruncated,
      inputNote:
        "Only initial user messages before the first agent response are predictors. Later messages are never features.",
      outcomeNote:
        "Recorded usage across the whole inactive session, including later follow-ups. Native usage and its Console mirror are never added together. Future resumption can change this observed snapshot.",
    },
  };
}

function newCanonicalAudit(componentCount: number) {
  return {
    identityComponents: componentCount,
    selectedSessions: 0,
    activeComponents: 0,
    unavailableComponents: 0,
    nonUserOrigin: 0,
    nativeCanonicalSessions: 0,
    consoleFallbackSessions: 0,
    duplicateConsoleMirrors: 0,
    mergedNativeRoots: 0,
    firstRequestTruncated: 0,
  };
}

function recordSelection(
  audit: ReturnType<typeof newCanonicalAudit>,
  value: Component,
  selection: Selection,
  task: Json,
) {
  audit.selectedSessions++;
  if (selection.nativeComplete) {
    audit.nativeCanonicalSessions++;
    audit.mergedNativeRoots += selection.selected.length - 1;
    audit.duplicateConsoleMirrors += value.console.length;
  } else audit.consoleFallbackSessions++;
  if (task.provenance.initialRequestTruncated) audit.firstRequestTruncated++;
}

/** Identity links deduplicate backend transcripts; token totals are never added to their Console mirror. */
export function canonicalSessionSamples(consoleSource: Json, nativeSource: Json) {
  const forest = createIdentityForest();
  const consoleTasks = consoleSource.tasks || [],
    nativeTasks = nativeSource.tasks || [];
  const links = consoleSource.sessionLinks || [];
  linkIdentities(forest, links, nativeTasks, consoleTasks);
  const components = groupComponents(forest, links, consoleTasks, nativeTasks);
  const tasks: Json[] = [];
  const audit = newCanonicalAudit(components.size);
  for (const value of components.values()) {
    if (value.links.some((link) => link.active)) {
      audit.activeComponents++;
      continue;
    }
    if (isNonUserOrigin(value)) {
      audit.nonUserOrigin++;
      continue;
    }
    const selection = selectSources(value);
    if (!selection.selected.length) {
      audit.unavailableComponents++;
      continue;
    }
    const task = buildSampleTask(forest, value, selection);
    tasks.push(task);
    recordSelection(audit, value, selection, task);
  }
  for (const task of tasks) task.group = forest.find(`sample:${task.id}`);
  tasks.sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
  );
  return { tasks, audit };
}

export function buildSessionHistory(opts: {
  dataDir: string;
  claudeDir?: string;
  codexDir?: string;
  piDir?: string;
}) {
  const consoleSource = buildConsoleSessions({ dataDir: opts.dataDir });
  const production =
    path.resolve(opts.dataDir) === path.join(os.homedir(), ".config", "agent-console");
  const nativeSource = buildNativeSessions({
    claudeDir:
      opts.claudeDir ?? (production ? path.join(os.homedir(), ".claude", "projects") : undefined),
    codexDir:
      opts.codexDir ?? (production ? path.join(os.homedir(), ".codex", "sessions") : undefined),
    piDir:
      opts.piDir ?? (production ? path.join(os.homedir(), ".pi", "agent", "sessions") : undefined),
    activeNativeSessionIds: consoleSource.activeNativeSessionIds,
  });
  const canonical = canonicalSessionSamples(consoleSource, nativeSource);
  const { exclusions: excludedNativeSessions, ...nativeAudit } = nativeSource.audit;
  return {
    version: 2,
    scope: "completed-session",
    tasks: canonical.tasks,
    excludedNativeSessions,
    audit: {
      console: consoleSource.audit,
      native: nativeAudit,
      canonical: canonical.audit,
      exclusions: { nonUserOrigin: canonical.audit.nonUserOrigin },
      selectedSessions: canonical.tasks.length,
      independentGroups: new Set(canonical.tasks.map((task) => task.group)).size,
      limitation:
        "A log file is not necessarily an independent user session. Child logs attach to parents; mirrored logs and ledger records are deduplicated. Initial request predicts an observed whole-session usage snapshot, including later scope changes.",
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    flag = (name: string, fallback?: string) => {
      const at = args.indexOf(name);
      return at < 0 ? fallback : args[at + 1];
    };
  const output = flag("--output");
  if (!output) throw Error("Use --output with an absolute private JSON path");
  const result = buildSessionHistory({
    dataDir: flag("--data", path.join(os.homedir(), ".config", "agent-console"))!,
    claudeDir: flag("--claude"),
    codexDir: flag("--codex"),
    piDir: flag("--pi"),
  });
  writePrivateSessionJson(output, result);
  console.log(JSON.stringify(result.audit));
}
