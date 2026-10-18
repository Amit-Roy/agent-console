/* global acode, editorManager */
(() => {
  const pluginId = "app.agentconsole.files";
  const files = new Map();
  let intent;

  function showError(error) {
    const alert = acode.require("alert");
    alert("Agent Console", error?.message || String(error));
  }

  async function request(endpoint, route, options = {}) {
    const response = await fetch(endpoint + route, {
      ...options,
      credentials: "omit",
      redirect: "error",
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409) {
        throw new Error("This file changed on the server. Your edits remain open. Reopen the file from Agent Console to compare changes.");
      }
      if (response.status === 401 || response.status === 410) {
        throw new Error("Editing access expired. Tap Edit in Agent Console again. Your edits remain open.");
      }
      throw new Error(result.error || result.message || `Request failed (${response.status}).`);
    }
    return result;
  }

  function textOf(file) {
    return file.session.getValue();
  }

  function navigate(payload) {
    const line = Math.max(1, Math.floor(Number(payload.line) || 1));
    const column = Math.max(0, Math.floor(Number(payload.column) || 1) - 1);
    editorManager.editor.gotoLine(line, column);
  }

  async function openFile(value) {
    const payload = JSON.parse(decodeURIComponent(value));
    const url = new URL(payload.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Agent Console requires a plain HTTPS endpoint.");
    }
    const endpoint = url.href.replace(/\/$/, "");
    if (typeof payload.ticket !== "string" || !payload.ticket) {
      throw new Error("The Edit link is missing its access ticket.");
    }
    const grant = await request(endpoint, "/api/acode/exchange", {
      method: "POST",
      body: JSON.stringify({ ticket: payload.ticket }),
    });
    const remote = grant.file || grant;
    if (typeof grant.token !== "string" || typeof remote.content !== "string" || typeof remote.revision !== "string") {
      throw new Error("Agent Console returned an invalid file response.");
    }
    const path = remote.path || remote.name || "file.txt";
    const key = endpoint + "\n" + path;
    const existing = files.get(key);
    if (existing) {
      // Refresh access without replacing any edits already open on the phone.
      existing.token = grant.token;
      existing.file.makeActive();
      if (!existing.file.isUnsaved && !existing.saving) {
        existing.file.session.setValue(remote.content);
        existing.revision = remote.revision;
        if (typeof existing.file.markSaved === "function") existing.file.markSaved();
        else existing.file.isUnsaved = false;
      }
      navigate(payload);
      return;
    }
    const EditorFile = acode.require("editorFile");
    const file = new EditorFile(remote.name || path.split("/").pop(), {
      id: "agent-console:" + key,
      text: remote.content,
      render: true,
      isUnsaved: false,
      persistInSession: false,
    });
    // Do not persist short-lived access credentials in Acode's restored sessions.
    file.persistInSession = false;
    const state = { file, token: grant.token, revision: remote.revision, saving: null };
    files.set(key, state);

    const save = async () => {
      const content = textOf(file);
      const savedVersion = file.docVersion;
      const savedDoc = file.session.doc;
      const result = await request(endpoint, "/api/acode/file", {
        method: "PUT",
        headers: { Authorization: "Bearer " + state.token },
        body: JSON.stringify({ content, revision: state.revision }),
      });
      const updated = result.file || result;
      if (typeof updated.revision !== "string") throw new Error("Save returned no file revision.");
      state.revision = updated.revision;
      if (typeof file.markSaved === "function") {
        file.markSaved({ savedVersion, savedDoc });
      } else if (textOf(file) === content) {
        file.isUnsaved = false;
      }
      return true;
    };
    file.on("save", (event) => {
      event.preventDefault();
      if (!state.saving) {
        state.saving = save().catch((error) => {
          showError(error);
          return false;
        }).finally(() => { state.saving = null; });
      }
      if (typeof event.respondWith === "function") event.respondWith(state.saving);
    });
    file.on("close", () => { files.delete(key); });
    navigate(payload);
  }

  function handler(event) {
    if (event.module !== "agent-console" || event.action !== "edit") return;
    event.preventDefault();
    openFile(event.value).catch(showError);
  }

  acode.setPluginInit(pluginId, () => {
    intent = acode.require("intent");
    if (!intent?.addHandler) throw new Error("Update Acode to use Agent Console Edit links.");
    intent.addHandler(handler);
  });
  acode.setPluginUnmount(pluginId, () => {
    intent?.removeHandler(handler);
    files.clear();
  });
})();
