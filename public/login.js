const f = document.getElementById("f"), err = document.getElementById("err");
f.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.textContent = "";
  const r = await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: document.getElementById("pw").value }) });
  if (r.ok) location.href = "/";
  else err.textContent = (await r.json().catch(() => ({}))).error || "Sign-in failed.";
});
