const $ = (id) => document.getElementById(id);
let busy = false;
let report = null;
const statusLabels = {
  ok: "Ready",
  warning: "Needs attention",
  error: "Not working",
  fixed: "Repaired",
  deferred: "Pending",
  manual: "Needs attention",
};

function row(label, detail, status) {
  const item = document.createElement("li");
  item.className = "doctor-check";
  const content = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = label;
  const description = document.createElement("p");
  description.textContent = detail;
  const badge = document.createElement("span");
  badge.className = `doctor-badge ${status}`;
  badge.textContent = statusLabels[status] || "Needs attention";
  content.append(title, description);
  item.append(content, badge);
  return item;
}

function controls() {
  $("doctor-check").disabled = busy;
  $("doctor-repair").disabled = busy || !report?.checks?.some((check) => check.repairable);
  $("doctor-check").textContent = busy ? "Checking…" : "Check again";
}

function render(data) {
  report = data;
  const issues = data.checks.filter((check) => check.status !== "ok");
  $("doctor-title").textContent = issues.length
    ? "Your setup needs attention"
    : "Your setup is ready";
  $("doctor-status").textContent = issues.length
    ? `${issues.length} ${issues.length === 1 ? "check needs" : "checks need"} attention. Review the details below.`
    : "All setup checks passed.";
  $("doctor-checks").replaceChildren(
    ...data.checks.map((check) => row(check.label, check.detail, check.status)),
  );
  const checkedAt = new Date(data.checkedAt);
  $("doctor-checked").textContent = Number.isNaN(checkedAt.getTime())
    ? ""
    : `Checked ${checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  if (data.repairs) {
    $("doctor-repairs").hidden = data.repairs.length === 0;
    $("doctor-repair-results").replaceChildren(
      ...data.repairs.map((repair) =>
        row(
          data.checks.find((check) => check.id === repair.id)?.label || "Setup repair",
          repair.detail,
          repair.status,
        ),
      ),
    );
  }
}

async function run(repair = false) {
  if (busy) return;
  busy = true;
  controls();
  $("doctor-checks").setAttribute("aria-busy", "true");
  $("doctor-status").textContent = repair
    ? "Repairing setup issues and checking the result…"
    : "Checking connections, sign-ins, and agent processes…";
  $("doctor-repair").textContent = repair ? "Repairing…" : "Repair setup";
  try {
    const response = await fetch("/api/doctor", {
      method: repair ? "POST" : "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      ...(repair ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
    });
    if (response.status === 401)
      throw new Error("Your sign-in expired. Return to the console and sign in again.");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Doctor returned HTTP ${response.status}.`);
    render(data);
  } catch (error) {
    $("doctor-title").textContent = "Doctor could not finish";
    $("doctor-status").textContent =
      error.name === "TimeoutError"
        ? "The check timed out. Try again; no server restart was requested."
        : error.message || "The console could not be reached. Try again.";
  } finally {
    busy = false;
    $("doctor-repair").textContent = "Repair setup";
    $("doctor-checks").setAttribute("aria-busy", "false");
    controls();
  }
}

$("doctor-check").onclick = () => run();
$("doctor-repair").onclick = () => run(true);
run();
