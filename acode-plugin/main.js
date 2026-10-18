/* global acode, editorManager */
(() => {
  const pluginId = "app.agentconsole.files";
  const files = new Map();
  const projects = new Map();
  const projectKeys = new Map();
  let nextProject = 0;
  let constructingFile = false;
  let intent;
  let fs;
  const accepts = (uri) => typeof uri === "string" && uri.startsWith("agentconsole://project/");

  function projectUri(project, path = "") {
    return `agentconsole://project/${project.id}/` + path.split("/").map(encodeURIComponent).join("/");
  }

  function resolveUri(uri) {
    const parsed = new URL(uri);
    const parts = parsed.pathname.split("/").slice(1);
    const project = projects.get(parts.shift());
    if (!project) throw new Error("Project access expired. Tap Edit in Agent Console again.");
    return { project, path: parts.map(decodeURIComponent).join("/") };
  }

  async function projectFile(project, path) {
    let remote = project.loaded.get(path);
    if (!remote) {
      try {
        remote = await request(project.endpoint, "/api/acode/open", {
          method: "POST",
          headers: { Authorization: "Bearer " + project.token },
          body: JSON.stringify({ path }),
        });
      } catch (error) {
        showError(error);
        throw error;
      }
      if (typeof remote.token !== "string" || typeof remote.content !== "string" || typeof remote.revision !== "string") {
        throw new Error("Agent Console returned an invalid file response.");
      }
      project.loaded.set(path, remote);
    }
    return remote;
  }

  function provider(uri) {
    const locate = () => resolveUri(uri);
    const unsupported = async () => { throw new Error("Use Agent Console to create, rename, move, or delete files."); };
    return {
      async lsDir() {
        const { project, path } = locate();
        const entries = [];
        let cursor;
        do {
          const page = await request(project.endpoint, "/api/acode/tree?path=" + encodeURIComponent(path)
            + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), {
            headers: { Authorization: "Bearer " + project.token },
          });
          for (const entry of page.entries) {
            project.entries.set(entry.path, entry);
            const url = projectUri(project, entry.path);
            entries.push({ name: entry.name, url, uri: url, isFile: entry.type === "file", isDirectory: entry.type === "directory", isLink: false });
          }
          if (page.next && page.next === cursor) throw new Error("Invalid directory page. Tap Edit again.");
          cursor = page.next;
        } while (cursor);
        return entries;
      },
      async stat() {
        const { project, path } = locate();
        const directory = !path || project.entries.get(path)?.type === "directory";
        const remote = directory ? null : await projectFile(project, path);
        return { name: directory ? (project.entries.get(path)?.name || project.name) : remote.name,
          url: uri, uri, isDirectory: directory, isFile: !directory, isLink: false,
          canRead: true, canWrite: !directory, size: remote ? new TextEncoder().encode(remote.content).length : 0 };
      },
      async exists() { await this.stat(); return true; },
      async readFile(encoding) {
        const { project, path } = locate();
        const remote = await projectFile(project, path);
        return encoding ? remote.content : new TextEncoder().encode(remote.content).buffer;
      },
      writeFile: unsupported, delete: unsupported, createFile: unsupported, createDirectory: unsupported,
      copyTo: unsupported, moveTo: unsupported, renameTo: unsupported,
    };
  }

  function mountProject(endpoint, grant) {
    const access = grant.project;
    if (!access || typeof access.token !== "string" || typeof access.root !== "string" || typeof access.name !== "string") return null;
    const key = endpoint + "\n" + access.root;
    let project = projectKeys.get(key);
    if (!project) {
      project = { id: String(++nextProject), endpoint, root: access.root, name: access.name,
        token: access.token, loaded: new Map(), entries: new Map() };
      projectKeys.set(key, project);
      projects.set(project.id, project);
    } else {
      project.token = access.token;
      project.loaded.clear();
    }
    const folders = acode.require("addedfolder");
    const uri = projectUri(project);
    if (!folders.some((folder) => folder.url === uri)) {
      acode.require("openfolder")(uri, { name: project.name, saveState: false, listFiles: false });
    }
    return project;
  }

  function onNewFile(file) {
    if (constructingFile || !accepts(file.uri)) return;
    file.persistInSession = false;
    const { project, path } = resolveUri(file.uri);
    const remote = project.loaded.get(path);
    if (remote) attachFile(project.endpoint, remote, remote.token, file);
  }

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
    const project = mountProject(endpoint, grant);
    if (project && remote.path.startsWith(project.root.replace(/\/$/, "") + "/")) {
      const relative = remote.path.slice(project.root.replace(/\/$/, "").length + 1);
      project.loaded.set(relative, { ...remote, token: grant.token });
      remote.uri = projectUri(project, relative);
    }
    attachFile(endpoint, remote, grant.token);
    navigate(payload);
  }

  function attachFile(endpoint, remote, token, openedFile) {
    const path = remote.path || remote.name || "file.txt";
    const key = endpoint + "\n" + path;
    const existing = files.get(key);
    if (existing) {
      // Refresh access without replacing any edits already open on the phone.
      existing.token = token;
      if (remote.uri && existing.file.uri !== remote.uri) existing.file.uri = remote.uri;
      existing.file.makeActive();
      if (!existing.file.isUnsaved && !existing.saving) {
        existing.file.session.setValue(remote.content);
        existing.revision = remote.revision;
        if (typeof existing.file.markSaved === "function") existing.file.markSaved();
        else existing.file.isUnsaved = false;
      }
      return;
    }
    const EditorFile = acode.require("editorFile");
    constructingFile = true;
    const file = openedFile || new EditorFile(remote.name || path.split("/").pop(), {
      id: "agent-console:" + key,
      uri: remote.uri,
      text: remote.content,
      render: true,
      isUnsaved: false,
      persistInSession: false,
    });
    constructingFile = false;
    // Do not persist short-lived access credentials in Acode's restored sessions.
    file.persistInSession = false;
    const state = { file, token, revision: remote.revision, saving: null };
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
    file.on("close", () => {
      files.delete(key);
      if (accepts(file.uri) && projects.size) {
        const { project, path: relative } = resolveUri(file.uri);
        project.loaded.delete(relative);
      }
    });
  }

  function handler(event) {
    if (event.module !== "agent-console" || event.action !== "edit") return;
    event.preventDefault();
    openFile(event.value).catch(showError);
  }

  acode.setPluginInit(pluginId, () => {
    intent = acode.require("intent");
    if (!intent?.addHandler) throw new Error("Update Acode to use Agent Console Edit links.");
    fs = acode.require("fs");
    fs.extend(accepts, provider);
    editorManager.on("new-file", onNewFile);
    intent.addHandler(handler);
  });
  acode.setPluginUnmount(pluginId, () => {
    intent?.removeHandler(handler);
    editorManager.off("new-file", onNewFile);
    fs?.remove(accepts);
    for (const folder of [...acode.require("addedfolder")]) {
      if (accepts(folder.url)) folder.remove();
    }
    files.clear();
    projects.clear();
    projectKeys.clear();
  });
})();
