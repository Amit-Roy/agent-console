// Store binary drafts outside localStorage so large files never block typing.
export function attachmentDraftStore(onError) {
  let database;
  const opened = new Promise((resolve, reject) => {
    const request = indexedDB.open("ac_composer", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("attachments", { keyPath: "key" });
    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Draft storage is blocked by another tab."));
  }).catch(error => { onError(error); return null; });
  async function transact(mode, operation) {
    const db = await opened;
    if (!db) return;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("attachments", mode);
      const request = operation(transaction.objectStore("attachments"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || request.error);
    }).catch(error => { onError(error); });
  }
  return {
    load: async () => (await transact("readonly", store => store.getAll()) || []).sort((a, b) => (a.order || 0) - (b.order || 0)),
    save: p => transact("readwrite", store => store.put({
      key: p.key, thread: p.thread, name: p.name, kind: p.kind, size: p.size, order: p.order,
      n: p.n, id: p.id, prepared: p.prepared, labelPending: p.labelPending, ...(!p.id ? { blob: p.blob } : {}),
    })),
    remove: key => transact("readwrite", store => store.delete(key)),
  };
}
