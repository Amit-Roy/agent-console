const status = document.getElementById("status");
fetch("/api/acode/setup", { cache: "no-store" })
  .then(async (response) => {
    if (!response.ok) throw new Error("Sign in to Agent Console, then reopen this page.");
    const setup = await response.json();
    if (!setup.available || !setup.plugin)
      throw new Error("Acode editing is not configured on this server.");
    const download = document.getElementById("download");
    download.href = setup.plugin;
    download.textContent = `Download Agent Console ${setup.version || ""} plugin ZIP`;
    download.removeAttribute("aria-disabled");
    status.textContent =
      "Version 1.1.2 stops false \u201cfile changed\u201d alerts when Acode looks for missing project files. If already installed, update the plugin with this ZIP.";
  })
  .catch((error) => {
    status.textContent = error.message;
  });
