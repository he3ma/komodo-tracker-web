const SCHEME = "komodo-tracker";
const HOST = "pair";

export function encodePairingCode(gistId, token) {
  const g = encodeURIComponent(String(gistId || "").trim());
  const t = encodeURIComponent(String(token || "").trim());
  return `${SCHEME}://${HOST}?v=1&gist=${g}&token=${t}`;
}

export function decodePairingCode(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const prefix = `${SCHEME}://${HOST}`;
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  const qIndex = trimmed.indexOf("?");
  if (qIndex === -1) return null;
  const query = trimmed.slice(qIndex + 1);
  const params = {};
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = decodeURIComponent(part.slice(0, eq).replace(/\+/g, " "));
    const v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    params[k] = v;
  }
  const gistId = (params.gist || "").trim();
  const token = (params.token || "").trim();
  if (!gistId || !token) return null;
  return { gistId, token };
}

/**
 * Identisch zu TaskMergeEngine.kt auf Android:
 * Ermöglicht gemeinsames Arbeiten auf Android + Geschäfts-iPhone unter derselben userId.
 */
export function mergeUserPayloads(local, remote) {
  if (!remote) {
    return {
      schemaVersion: 2,
      user: local.user,
      tasks: [...local.tasks]
    };
  }

  const mergedUser =
    (remote.user?.updatedAt || 0) > (local.user?.updatedAt || 0)
      ? remote.user
      : local.user;

  const byId = new Map();
  for (const task of local.tasks || []) {
    byId.set(task.id, { ...task, isDeleted: Boolean(task.isDeleted) });
  }
  for (const rawRemote of remote.tasks || []) {
    const remoteTask = { ...rawRemote, isDeleted: Boolean(rawRemote.isDeleted) };
    const current = byId.get(remoteTask.id);
    const takeRemote =
      !current ||
      remoteTask.updatedAt > current.updatedAt ||
      (remoteTask.updatedAt === current.updatedAt && remoteTask.isDeleted && !current.isDeleted);
    if (takeRemote) {
      byId.set(remoteTask.id, remoteTask);
    }
  }

  const mergedTasks = Array.from(byId.values()).sort(
    (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
  );

  return {
    schemaVersion: 2,
    user: mergedUser,
    tasks: mergedTasks
  };
}

export function payloadsEqual(a, b) {
  if (!a || !b) return false;
  if (a.user?.id !== b.user?.id || a.user?.name !== b.user?.name || a.user?.updatedAt !== b.user?.updatedAt) {
    return false;
  }
  if ((a.tasks?.length || 0) !== (b.tasks?.length || 0)) return false;
  for (let i = 0; i < a.tasks.length; i++) {
    const t1 = a.tasks[i];
    const t2 = b.tasks[i];
    if (
      t1.id !== t2.id ||
      t1.name !== t2.name ||
      t1.durationValue !== t2.durationValue ||
      t1.durationUnit !== t2.durationUnit ||
      t1.occurrences !== t2.occurrences ||
      t1.frequency !== t2.frequency ||
      t1.updatedAt !== t2.updatedAt ||
      Boolean(t1.isDeleted) !== Boolean(t2.isDeleted)
    ) {
      return false;
    }
  }
  return true;
}

const USER_FILE_REGEX = /^user_.*\.json$/;

function baseHeaders(token, extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${String(token).trim()}`,
    ...extra
  };
}

function mapHttpError(status) {
  if (status === 401) return "GitHub-Token ungültig oder abgelaufen (401).";
  if (status === 403) return "Keine Berechtigung für Gists (403). Bitte 'Gists: Read and write' prüfen.";
  if (status === 404) return "Sync-Gist nicht gefunden oder Token fehlt der Zugriff (404).";
  return `GitHub-Fehler (${status}). Bitte später erneut versuchen.`;
}

export const GitHubGistApi = {
  async createPrivateGist(token, fileName, content) {
    const res = await fetch("https://api.github.com/gists", {
      method: "POST",
      cache: "no-store",
      headers: baseHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        description: "Komodo Tracker Sync (privat)",
        public: false,
        files: { [fileName]: { content } }
      })
    });
    if (!res.ok) throw new Error(mapHttpError(res.status));
    const data = await res.json();
    return data.id;
  },

  async pushUserFile(token, gistId, fileName, content) {
    const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId.trim())}`, {
      method: "PATCH",
      cache: "no-store",
      headers: baseHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        files: { [fileName]: { content } }
      })
    });
    if (!res.ok) throw new Error(mapHttpError(res.status));
  },

  async fetchAllUserFiles(token, gistId) {
    const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId.trim())}`, {
      method: "GET",
      cache: "no-store",
      headers: baseHeaders(token)
    });
    if (!res.ok) throw new Error(mapHttpError(res.status));
    const gist = await res.json();
    const files = {};
    for (const [name, fileObj] of Object.entries(gist.files || {})) {
      if (!USER_FILE_REGEX.test(name)) continue;
      if (fileObj.truncated && fileObj.raw_url) {
        const rawRes = await fetch(fileObj.raw_url, {
          method: "GET",
          cache: "no-store",
          headers: baseHeaders(token)
        });
        if (!rawRes.ok) throw new Error(mapHttpError(rawRes.status));
        files[name] = await rawRes.text();
      } else {
        files[name] = fileObj.content || "";
      }
    }
    return files;
  }
};
