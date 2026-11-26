import {
  DurationUnit,
  TaskFrequency,
  weeklyMinutes,
  formatHoursAndMinutes,
  formatNumberDe,
  formatTaskRule,
  parseLocalizedDouble,
  pad2,
  todayIso,
  nowTimeMinutes,
  totalMlForDate,
  sanitizeAmountInput,
  parseAmountMl,
  formatTimeDe,
  formatDatePopupDe,
  formatDateLongDe,
  formatDateShortDe,
  formatLastFeedAgo
} from "./calculator.js";
import {
  encodePairingCode,
  decodePairingCode,
  mergeUserPayloads,
  payloadsEqual,
  GitHubGistApi
} from "./sync.js";

const STORAGE_KEY = "komodo_tracker_pwa_v1";

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function savePersistedState(stateObj) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stateObj));
}

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

const persisted = loadPersistedState() || {
  localUser: null,
  partnerUsers: [],
  tasks: [],
  milkEntries: [],
  themeMode: "LIGHT",
  gistId: null,
  token: null,
  lastSyncedAt: null
};
if (!Array.isArray(persisted.tasks)) persisted.tasks = [];
if (!Array.isArray(persisted.milkEntries)) persisted.milkEntries = [];
if (!Array.isArray(persisted.partnerUsers)) persisted.partnerUsers = [];

const ui = {
  currentTab: "MILK",
  selectedMilkDateIso: todayIso(),
  evalFilter: "ALL",
  evalSort: "WEEKLY_DESC",
  isSyncing: false,
  syncError: null,
  editorTaskId: null,
  editorOpen: false,
  draft: { name: "", durationValue: "30", durationUnit: DurationUnit.MINUTES, occurrences: "1", frequency: TaskFrequency.WEEK },
  milkDialogOpen: false,
  editingMilkId: null,
  milkDraft: { dateIso: todayIso(), timeMinutes: nowTimeMinutes(), amountInput: "" },
  calendarModal: null, // null | { target: 'DAY' | 'DRAFT', year: number, month: number }
  timePickerOpen: false,
  pasteDialogOpen: false,
  pasteInput: "",
  pasteNameDraft: "",
  scannerOpen: false,
  scannerNameDraft: "",
  disconnectDialogOpen: false,
  profileSelection: null,
  showToken: false,
  tokenInput: "",
  nameEditInput: persisted.localUser?.name || ""
};

let activeStream = null;
let scanRafId = null;
let syncInFlight = false;

function persist() {
  savePersistedState(persisted);
}

function applyTheme() {
  const dark = persisted.themeMode === "DARK";
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const meta = document.getElementById("metaThemeColor");
  if (meta) meta.setAttribute("content", dark ? "#111614" : "#2E6B5E");
}

function showToast(msg) {
  const host = document.getElementById("toastHost");
  if (!host) return;
  host.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    host.innerHTML = "";
  }, 3200);
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isConnected() {
  return Boolean(persisted.gistId && persisted.token);
}

function activeTasks() {
  return (persisted.tasks || []).filter((t) => !t.isDeleted);
}

function activeMilkEntries() {
  return (persisted.milkEntries || []).filter((e) => !e.isDeleted);
}

function ownAllTasksIncludingDeleted(userId) {
  return (persisted.tasks || []).filter((t) => t.ownerId === userId);
}

function ownAllMilkIncludingDeleted(userId) {
  return (persisted.milkEntries || []).filter((e) => e.ownerId === userId);
}

function userFileName(userId) {
  return `user_${userId}.json`;
}

function parsePayloads(filesMap) {
  const list = [];
  for (const content of Object.values(filesMap || {})) {
    try {
      const parsed = JSON.parse(content);
      if (parsed && parsed.user && Array.isArray(parsed.tasks)) {
        list.push(parsed);
      }
    } catch {
      // ignore malformed file
    }
  }
  return list;
}

async function syncNow({ silent = false } = {}) {
  if (!isConnected() || syncInFlight) return;
  syncInFlight = true;
  ui.isSyncing = true;
  ui.syncError = null;
  render();

  try {
    const files = await GitHubGistApi.fetchAllUserFiles(persisted.token, persisted.gistId);
    const payloads = parsePayloads(files);

    if (persisted.localUser) {
      const localUser = persisted.localUser;
      const localPayload = {
        schemaVersion: 3,
        user: localUser,
        tasks: ownAllTasksIncludingDeleted(localUser.id),
        milkEntries: ownAllMilkIncludingDeleted(localUser.id)
      };
      const remoteOwn = payloads.find((p) => p.user.id === localUser.id) || null;
      const merged = mergeUserPayloads(localPayload, remoteOwn);

      persisted.localUser = merged.user;
      ui.nameEditInput = merged.user.name;

      const nonLocalTasks = (persisted.tasks || []).filter((t) => t.ownerId !== merged.user.id);
      persisted.tasks = [...nonLocalTasks, ...merged.tasks.map((t) => ({ ...t, ownerId: merged.user.id }))];

      const nonLocalMilk = (persisted.milkEntries || []).filter((e) => e.ownerId !== merged.user.id);
      persisted.milkEntries = [
        ...nonLocalMilk,
        ...merged.milkEntries.map((e) => ({ ...e, ownerId: merged.user.id }))
      ];

      if (!remoteOwn || !payloadsEqual(merged, remoteOwn)) {
        await GitHubGistApi.pushUserFile(
          persisted.token,
          persisted.gistId,
          userFileName(merged.user.id),
          JSON.stringify(merged, null, 2)
        );
      }
    }

    const localId = persisted.localUser?.id || "";
    const partnerPayloads = payloads.filter((p) => p.user.id !== localId);
    persisted.partnerUsers = partnerPayloads.map((p) => p.user);

    const ownTasks = (persisted.tasks || []).filter((t) => t.ownerId === localId);
    const partnerTasks = partnerPayloads.flatMap((p) =>
      (p.tasks || []).map((t) => ({ ...t, ownerId: p.user.id, isDeleted: Boolean(t.isDeleted) }))
    );
    persisted.tasks = [...ownTasks, ...partnerTasks];

    const ownMilk = (persisted.milkEntries || []).filter((e) => e.ownerId === localId);
    const partnerMilk = partnerPayloads.flatMap((p) =>
      (p.milkEntries || []).map((e) => ({ ...e, ownerId: p.user.id, isDeleted: Boolean(e.isDeleted) }))
    );
    persisted.milkEntries = [...ownMilk, ...partnerMilk];

    persisted.lastSyncedAt = Date.now();
    persist();
  } catch (err) {
    ui.syncError = err.message || "Synchronisation fehlgeschlagen.";
    if (!silent) showToast(ui.syncError);
  } finally {
    syncInFlight = false;
    ui.isSyncing = false;
    render();
  }
}

async function createPrivateGistFromToken(tokenInput) {
  const token = tokenInput.trim();
  if (!token) {
    showToast("Bitte gib ein GitHub-Token ein.");
    return;
  }
  if (!persisted.localUser) return;
  ui.isSyncing = true;
  ui.syncError = null;
  render();
  try {
    const payload = {
      schemaVersion: 3,
      user: persisted.localUser,
      tasks: ownAllTasksIncludingDeleted(persisted.localUser.id),
      milkEntries: ownAllMilkIncludingDeleted(persisted.localUser.id)
    };
    const gistId = await GitHubGistApi.createPrivateGist(
      token,
      userFileName(persisted.localUser.id),
      JSON.stringify(payload, null, 2)
    );
    persisted.gistId = gistId;
    persisted.token = token;
    persisted.lastSyncedAt = Date.now();
    ui.tokenInput = "";
    persist();
    showToast("Privates Sync-Gist erstellt.");
  } catch (err) {
    ui.syncError = err.message;
    showToast(err.message);
  } finally {
    ui.isSyncing = false;
    render();
  }
}

async function inspectCodeAndPrompt(rawCode, suggestedNewName = "") {
  const creds = decodePairingCode(rawCode);
  if (!creds) {
    showToast("Ungültiger Einladungs- oder QR-Code.");
    return;
  }
  ui.isSyncing = true;
  ui.syncError = null;
  render();
  try {
    const files = await GitHubGistApi.fetchAllUserFiles(creds.token, creds.gistId);
    const payloads = parsePayloads(files).sort((a, b) =>
      a.user.name.localeCompare(b.user.name, "de")
    );
    const suggested = (suggestedNewName || persisted.localUser?.name || "").trim();

    if (payloads.length === 0) {
      await completeCreateNewProfile(creds.gistId, creds.token, suggested || "Ich");
    } else {
      ui.profileSelection = {
        gistId: creds.gistId,
        token: creds.token,
        existingProfiles: payloads,
        newNameInput: suggested,
        isSwitchMode: false
      };
    }
  } catch (err) {
    ui.syncError = err.message;
    showToast(err.message);
  } finally {
    ui.isSyncing = false;
    render();
  }
}

async function openSwitchProfileModal() {
  if (!isConnected()) return;
  ui.isSyncing = true;
  render();
  try {
    const files = await GitHubGistApi.fetchAllUserFiles(persisted.token, persisted.gistId);
    const payloads = parsePayloads(files).sort((a, b) =>
      a.user.name.localeCompare(b.user.name, "de")
    );
    if (payloads.length === 0) {
      showToast("Keine Profile im Gist gefunden.");
      return;
    }
    ui.profileSelection = {
      gistId: persisted.gistId,
      token: persisted.token,
      existingProfiles: payloads,
      newNameInput: persisted.localUser?.name || "",
      isSwitchMode: true
    };
  } catch (err) {
    showToast(err.message);
  } finally {
    ui.isSyncing = false;
    render();
  }
}

async function completeUseExistingProfile(profilePayload) {
  const sel = ui.profileSelection;
  if (!sel) return;
  ui.profileSelection = null;
  persisted.gistId = sel.gistId;
  persisted.token = sel.token;
  persisted.localUser = { ...profilePayload.user };
  ui.nameEditInput = profilePayload.user.name;

  const nonOwnTasks = (persisted.tasks || []).filter((t) => t.ownerId !== profilePayload.user.id);
  const chosenTasks = (profilePayload.tasks || []).map((t) => ({
    ...t,
    ownerId: profilePayload.user.id,
    isDeleted: Boolean(t.isDeleted)
  }));
  persisted.tasks = [...nonOwnTasks, ...chosenTasks];

  const nonOwnMilk = (persisted.milkEntries || []).filter((e) => e.ownerId !== profilePayload.user.id);
  const chosenMilk = (profilePayload.milkEntries || []).map((e) => ({
    ...e,
    ownerId: profilePayload.user.id,
    isDeleted: Boolean(e.isDeleted)
  }));
  persisted.milkEntries = [...nonOwnMilk, ...chosenMilk];

  persist();
  await syncNow();
  showToast(`Profil „${profilePayload.user.name}“ aktiviert.`);
}

async function completeCreateNewProfile(gistId, token, rawName) {
  const cleanName = String(rawName || "").trim();
  if (!cleanName) {
    showToast("Bitte gib einen Namen ein.");
    return;
  }
  ui.profileSelection = null;
  persisted.gistId = gistId;
  persisted.token = token;
  if (!persisted.localUser) {
    persisted.localUser = { id: uuid(), name: cleanName, updatedAt: Date.now() };
  } else {
    persisted.localUser = { ...persisted.localUser, name: cleanName, updatedAt: Date.now() };
  }
  ui.nameEditInput = cleanName;
  persist();
  await syncNow();
  showToast(`Profil „${cleanName}“ gekoppelt.`);
}

function icon(name, size = 18) {
  const s = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  switch (name) {
    case "list": return `<svg ${s}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>`;
    case "chart": return `<svg ${s}><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>`;
    case "user": return `<svg ${s}><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>`;
    case "sync": return `<svg ${s}><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`;
    case "plus": return `<svg ${s}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    case "edit": return `<svg ${s}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
    case "lock": return `<svg ${s}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
    case "qr": return `<svg ${s}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3z"/><path d="M20 14v3h-1"/><path d="M14 20h6"/></svg>`;
    case "copy": return `<svg ${s}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    case "sun": return `<svg ${s}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
    case "moon": return `<svg ${s}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
    case "cloud": return `<svg ${s}><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;
    case "cal": return `<svg ${s}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
    case "clock": return `<svg ${s}><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;
    case "chev": return `<svg ${s}><polyline points="9 18 15 12 9 6"/></svg>`;
    case "x": return `<svg ${s}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    default: return "";
  }
}

function syncStatusText() {
  if (ui.isSyncing) return "Synchronisiert gerade …";
  if (!isConnected()) return "Offline · Sync nicht eingerichtet";
  if (!persisted.lastSyncedAt) return "Verbunden · Noch nicht synchronisiert";
  const mins = Math.max(0, Math.floor((Date.now() - persisted.lastSyncedAt) / 60000));
  if (mins < 1) return "Synchronisiert · gerade eben";
  if (mins < 60) return `Synchronisiert · vor ${mins} Min.`;
  return "Synchronisiert · " + new Date(persisted.lastSyncedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function renderOnboarding() {
  return `
    <div class="onboarding-wrap">
      <div style="text-align:center; padding-top:18px;">
        <div class="badge-logo">🦎🦎</div>
        <h1 class="header-title" style="font-size:24px;">Willkommen beim Komodo Tracker</h1>
        <p style="color:var(--muted); font-size:14px; line-height:1.5; margin-top:8px;">
          Erfasst gemeinsam eure wiederkehrenden Tasks und vergleicht euren wöchentlichen Zeitaufwand.
        </p>
      </div>

      <div class="stack-md">
        <div class="card">
          <label class="field-label" for="onboardingName">Wie heißt du?</label>
          <input id="onboardingName" class="input" type="text" placeholder="z. B. Markus oder Anna" autocomplete="name" />
          <p style="font-size:12px; color:var(--muted); margin:8px 0 0;">
            Dieser Name erscheint in der gemeinsamen Auswertung neben deinen Tasks.
          </p>
        </div>
        <button id="btnOnboardingStart" class="btn btn-primary" style="width:100%; height:50px;">
          Loslegen &amp; erste Tasks erfassen
        </button>
      </div>

      <div class="card-muted stack-sm">
        <div style="display:flex; align-items:center; gap:12px;">
          <div style="width:42px; height:42px; border-radius:12px; background:var(--p2-soft); color:var(--p2); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            ${icon("qr", 20)}
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-size:14px; font-weight:700;">Zweites Smartphone koppeln?</div>
            <div style="font-size:12px; color:var(--muted);">Partner-QR-Code direkt scannen</div>
          </div>
          <button id="btnOnboardingScan" class="btn btn-soft" style="padding:9px 14px;">Scannen</button>
        </div>
        <button id="btnOnboardingPaste" class="btn btn-text" style="align-self:flex-end;">Oder Einladungs-Code einfügen</button>
      </div>
    </div>
  `;
}

function renderMilk() {
  const me = persisted.localUser;
  const partner = (persisted.partnerUsers || [])[0] || null;
  const userMap = new Map();
  if (me) userMap.set(me.id, me.name);
  for (const p of persisted.partnerUsers || []) userMap.set(p.id, p.name);

  const allMilk = activeMilkEntries();
  const currentToday = todayIso();
  const lastFeedAgo = formatLastFeedAgo(allMilk);

  const dayEntries = allMilk
    .filter((e) => e.dateIso === ui.selectedMilkDateIso)
    .map((e) => {
      const isMe = e.ownerId === me?.id;
      return {
        ...e,
        isMe,
        ownerName: userMap.get(e.ownerId) || (isMe ? "Ich" : partner?.name || "Partner")
      };
    })
    .sort((a, b) => (b.timeMinutes - a.timeMinutes) || ((b.createdAt || 0) - (a.createdAt || 0)));

  const dayTotal = totalMlForDate(allMilk, ui.selectedMilkDateIso);

  return `
    <div class="header-row" style="align-items:flex-start;">
      <div>
        <h1 class="header-title">🍼 Milch</h1>
        <p class="header-sub">${esc(formatDateLongDe(ui.selectedMilkDateIso, currentToday))}</p>
        ${lastFeedAgo ? `<p style="margin:3px 0 0; font-size:12px; font-weight:700; color:var(--p1);">${esc(lastFeedAgo)}</p>` : ""}
      </div>
      ${isConnected()
        ? `<button id="btnMilkSync" class="icon-btn" title="Jetzt synchronisieren">${icon("sync", 16)}</button>`
        : `<button id="btnMilkSetup" class="btn btn-text">Sync einrichten</button>`
      }
    </div>

    <div class="main-scroll stack-sm" style="padding-bottom:110px;">
      ${dayEntries.length === 0 ? `
        <div class="card" style="text-align:center; padding:32px 20px; margin-top:20px;">
          <div style="font-size:34px; margin-bottom:8px;">🍼</div>
          <div style="font-size:16px; font-weight:700;">Keine Einträge für diesen Tag</div>
          <p style="font-size:13px; color:var(--muted); margin:6px 0 0;">
            Tippe unten rechts auf „+ Milch“, um ein Fläschchen einzutragen.
          </p>
        </div>
      ` : dayEntries.map((e) => `
        <div class="task-card" data-milk-entry="${esc(e.id)}" data-is-me="${e.isMe ? "1" : "0"}" data-owner-name="${esc(e.ownerName)}">
          <div style="display:flex; align-items:center; gap:12px; min-width:0; flex:1;">
            <div style="width:40px; height:40px; border-radius:12px; background:${e.isMe ? "var(--p1-soft)" : "var(--p2-soft)"}; display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0;">
              🍼
            </div>
            <div style="min-width:0; flex:1;">
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:14px; font-weight:800; font-variant-numeric:tabular-nums;">${esc(formatTimeDe(e.timeMinutes))}</span>
                <span class="owner-badge ${e.isMe ? "p1" : "p2"}">${esc(e.ownerName)}</span>
              </div>
              <div class="task-rule">${e.isMe ? "Antippen zum Bearbeiten" : "Vom Partner eingetragen"}</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
            <span class="task-hours" style="font-size:15px; color:${e.isMe ? "var(--p1)" : "var(--p2)"};">${e.amountMl} ml</span>
            <span style="color:var(--muted);">${icon(e.isMe ? "edit" : "lock", 15)}</span>
          </div>
        </div>
      `).join("")}
    </div>

    <div class="milk-bottom-bar">
      <button id="btnMilkDayPicker" class="milk-total-card">
        <div style="display:flex; align-items:center; gap:10px; min-width:0;">
          <div style="width:36px; height:36px; border-radius:10px; background:var(--p1-soft); color:var(--p1); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            ${icon("cal", 17)}
          </div>
          <div style="min-width:0;">
            <div style="font-size:11px; color:var(--muted); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${esc(formatDateShortDe(ui.selectedMilkDateIso, currentToday))} · ${dayEntries.length}×
            </div>
            <div style="font-size:16px; font-weight:800; color:var(--p1); font-variant-numeric:tabular-nums;">
              ${dayTotal} ml
            </div>
          </div>
        </div>
        <span style="color:var(--muted); flex-shrink:0;">${icon("chev", 16)}</span>
      </button>

      <button id="btnAddMilk" class="milk-fab">
        ${icon("plus", 17)}<span>Milch</span>
      </button>
    </div>
  `;
}

function renderMyTasks() {
  const me = persisted.localUser;
  const mine = activeTasks()
    .filter((t) => t.ownerId === me.id)
    .map((t) => ({ ...t, wm: weeklyMinutes(t.durationValue, t.durationUnit, t.occurrences, t.frequency) }))
    .sort((a, b) => b.wm - a.wm);
  const sum = mine.reduce((acc, t) => acc + t.wm, 0);

  return `
    <div class="header-row">
      <div>
        <h1 class="header-title">Meine Tasks</h1>
        <p class="header-sub">Profil: ${esc(me.name)} · ${mine.length} Einträge</p>
      </div>
      <span class="pill">${esc(formatHoursAndMinutes(sum))} / Wo.</span>
    </div>

    <div class="main-scroll stack-sm">
      ${mine.length === 0 ? `
        <div class="card" style="text-align:center; padding:32px 20px; margin-top:24px;">
          <div style="font-size:32px; margin-bottom:8px;">🦎</div>
          <div style="font-size:16px; font-weight:700;">Noch keine Tasks erfasst</div>
          <p style="font-size:13px; color:var(--muted); margin:6px 0 0;">
            Tippe unten rechts auf „+ Task“, um Aufgaben mit Dauer, Häufigkeit und Frequenz anzulegen.
          </p>
        </div>
      ` : mine.map((t) => `
        <div class="task-card" data-edit-task="${esc(t.id)}">
          <div style="min-width:0; flex:1;">
            <div class="task-title">${esc(t.name)}</div>
            <div class="task-rule">${esc(formatTaskRule(t))}</div>
          </div>
          <div style="text-align:right; flex-shrink:0;">
            <div class="task-hours" style="color:var(--p1);">${esc(formatHoursAndMinutes(t.wm))}</div>
            <div style="font-size:10px; color:var(--muted);">pro Woche</div>
          </div>
          <span style="color:var(--muted);">${icon("edit", 16)}</span>
        </div>
      `).join("")}
    </div>

    <button id="fabAddTask" class="fab">${icon("plus", 18)}<span>Task</span></button>
  `;
}

function renderEvaluation() {
  const me = persisted.localUser;
  const partner = (persisted.partnerUsers || [])[0] || null;
  const userMap = new Map();
  if (me) userMap.set(me.id, me.name);
  for (const p of persisted.partnerUsers || []) userMap.set(p.id, p.name);

  const enriched = activeTasks().map((t) => {
    const isMe = t.ownerId === me?.id;
    return {
      ...t,
      isMe,
      ownerName: userMap.get(t.ownerId) || (isMe ? "Ich" : "Partner"),
      wm: weeklyMinutes(t.durationValue, t.durationUnit, t.occurrences, t.frequency)
    };
  });

  const meSum = enriched.filter((t) => t.isMe).reduce((a, b) => a + b.wm, 0);
  const partnerSum = enriched.filter((t) => !t.isMe).reduce((a, b) => a + b.wm, 0);
  const total = meSum + partnerSum;
  const mePct = total > 0 ? Math.round((meSum / total) * 100) : 50;
  const partnerPct = 100 - mePct;

  const filtered = enriched.filter((t) => {
    if (ui.evalFilter === "MINE") return t.isMe;
    if (ui.evalFilter === "PARTNER") return !t.isMe;
    return true;
  });

  filtered.sort((a, b) =>
    ui.evalSort === "WEEKLY_DESC"
      ? b.wm - a.wm
      : a.name.localeCompare(b.name, "de")
  );

  return `
    <div class="header-row">
      <div>
        <h1 class="header-title">Auswertung</h1>
        <p class="header-sub">
          <span class="dot" style="background:${isConnected() ? "var(--p1)" : "var(--muted)"}"></span>
          <span>${esc(syncStatusText())}</span>
        </p>
      </div>
      ${isConnected()
        ? `<button id="btnEvalSync" class="icon-btn" title="Jetzt synchronisieren">${icon("sync", 16)}</button>`
        : `<button id="btnEvalSetup" class="btn btn-text">Sync einrichten</button>`
      }
    </div>

    <div class="main-scroll stack-md">
      <div class="card stack-md">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:11px; font-weight:800; letter-spacing:0.06em; color:var(--muted);">DAUER PRO WOCHE</span>
          <span style="font-size:12px; font-weight:700; color:var(--muted);">Gesamt: ${esc(formatHoursAndMinutes(total))}</span>
        </div>

        <div class="hero-grid">
          <div class="person-tile p1">
            <div style="display:flex; align-items:center; gap:6px; font-size:12px; font-weight:700;">
              <span class="dot" style="background:var(--p1);"></span>
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(me?.name || "Ich")}</span>
            </div>
            <div class="person-big">${esc(formatHoursAndMinutes(meSum))}</div>
            <div style="font-size:11px; opacity:0.85; margin-top:3px;">${mePct} % Anteil</div>
          </div>

          <div class="person-tile p2">
            <div style="display:flex; align-items:center; gap:6px; font-size:12px; font-weight:700;">
              <span class="dot" style="background:var(--p2);"></span>
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(partner?.name || "Partner")}</span>
            </div>
            <div class="person-big">${esc(formatHoursAndMinutes(partnerSum))}</div>
            <div style="font-size:11px; opacity:0.85; margin-top:3px;">${partner ? `${partnerPct} % Anteil` : "Noch nicht gekoppelt"}</div>
          </div>
        </div>

        <div class="split-bar">
          ${total > 0 ? `
            <div style="width:${mePct}%; background:var(--p1); height:100%;"></div>
            <div style="width:${partnerPct}%; background:var(--p2); height:100%;"></div>
          ` : ""}
        </div>
      </div>

      <div class="chip-row">
        <div class="chips">
          <button class="chip ${ui.evalFilter === "ALL" ? "active-p1" : ""}" data-filter="ALL">Alle${ui.evalFilter === "ALL" ? ` (${filtered.length})` : ""}</button>
          <button class="chip ${ui.evalFilter === "MINE" ? "active-p1" : ""}" data-filter="MINE">${esc(me?.name || "Ich")}</button>
          ${partner ? `<button class="chip ${ui.evalFilter === "PARTNER" ? "active-p2" : ""}" data-filter="PARTNER">${esc(partner.name)}</button>` : ""}
        </div>
        <button id="btnToggleSort" class="btn btn-text" style="font-size:12px; color:var(--muted);">
          ${ui.evalSort === "WEEKLY_DESC" ? "Aufwand" : "A–Z"}
        </button>
      </div>

      <div class="stack-sm">
        ${filtered.length === 0 ? `
          <div class="card" style="color:var(--muted); font-size:13px;">Keine Tasks für diesen Filter vorhanden.</div>
        ` : filtered.map((t) => `
          <div class="task-card" data-eval-task="${esc(t.id)}" data-is-me="${t.isMe ? "1" : "0"}" data-owner-name="${esc(t.ownerName)}">
            <div style="min-width:0; flex:1;">
              <div style="display:flex; align-items:center; gap:6px;">
                <span class="owner-badge ${t.isMe ? "p1" : "p2"}">${esc(t.ownerName)}</span>
                <span class="task-title">${esc(t.name)}</span>
              </div>
              <div class="task-rule">${esc(formatTaskRule(t))}</div>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
              <span class="task-hours" style="color:${t.isMe ? "var(--p1)" : "var(--p2)"};">${esc(formatHoursAndMinutes(t.wm))}</span>
              ${!t.isMe ? `<span style="color:var(--muted);" title="Nur lesbar">${icon("lock", 14)}</span>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderSettingsSync() {
  const me = persisted.localUser;
  const partner = (persisted.partnerUsers || [])[0] || null;
  const initial = (me?.name || "K").trim().charAt(0).toUpperCase() || "K";
  const pairingCode = isConnected() ? encodePairingCode(persisted.gistId, persisted.token) : null;

  return `
    <div class="header-row">
      <div>
        <h1 class="header-title">Profil &amp; Sync</h1>
        <p class="header-sub">Geräte-Profil, Darstellung &amp; privates GitHub Gist</p>
      </div>
    </div>

    <div class="main-scroll stack-md">
      <div class="card stack-sm">
        <span class="field-label" style="margin:0;">Dein Benutzerprofil</span>
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="width:42px; height:42px; border-radius:999px; background:var(--p1); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:800; flex-shrink:0;">
            ${esc(initial)}
          </div>
          <input id="profileNameInput" class="input" type="text" value="${esc(ui.nameEditInput)}" />
        </div>
        <button id="btnSaveName" class="btn btn-primary" style="align-self:flex-end; padding:9px 14px;">Namen speichern</button>
      </div>

      <div class="card stack-sm">
        <span class="field-label" style="margin:0;">Darstellung</span>
        <div class="segmented segmented-2">
          <button class="seg-btn ${persisted.themeMode === "LIGHT" ? "active" : ""}" data-theme-choice="LIGHT">
            ${icon("sun", 14)} Hell
          </button>
          <button class="seg-btn ${persisted.themeMode === "DARK" ? "active" : ""}" data-theme-choice="DARK">
            ${icon("moon", 14)} Dunkel
          </button>
        </div>
      </div>

      ${ui.syncError ? `
        <div style="background:var(--p2-soft); color:var(--p2-text); padding:12px 14px; border-radius:14px; font-size:13px; font-weight:600;">
          ${esc(ui.syncError)}
        </div>
      ` : ""}

      ${!isConnected() ? `
        <div class="card stack-md">
          <div style="font-size:14px; font-weight:700;">Gerät 1: Privates GitHub Gist erstellen</div>
          <p style="font-size:12px; color:var(--muted); margin:0; line-height:1.45;">
            Erstelle auf github.com unter Settings → Developer settings → Personal access tokens ein Token mit <strong>Gists: Read and write</strong>.
          </p>
          <input id="tokenInput" class="input" type="${ui.showToken ? "text" : "password"}" placeholder="GitHub Personal Access Token" value="${esc(ui.tokenInput)}" />
          <div style="display:flex; gap:8px;">
            <button id="btnToggleToken" class="btn btn-outline" style="padding:10px 12px;">${ui.showToken ? "Verbergen" : "Anzeigen"}</button>
            <button id="btnCreateGist" class="btn btn-primary" style="flex:1;" ${ui.isSyncing ? "disabled" : ""}>
              ${ui.isSyncing ? "Wird erstellt …" : "Privates Sync-Gist erstellen"}
            </button>
          </div>
        </div>

        <div class="card stack-sm">
          <div style="font-size:14px; font-weight:700;">Gerät 2: Mit bestehendem Gist koppeln</div>
          <p style="font-size:12px; color:var(--muted); margin:0;">
            Scanne den QR-Code vom anderen Smartphone oder füge den Einladungs-Code ein.
          </p>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:4px;">
            <button id="btnSyncScanQr" class="btn btn-accent">${icon("qr", 16)} QR scannen</button>
            <button id="btnSyncPasteCode" class="btn btn-outline">Code einfügen</button>
          </div>
        </div>
      ` : `
        <div class="card stack-md">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <div style="width:38px; height:38px; border-radius:12px; background:var(--p1-soft); color:var(--p1); display:flex; align-items:center; justify-content:center;">
                ${icon("cloud", 18)}
              </div>
              <div>
                <div style="font-size:14px; font-weight:700;">GitHub Gist verbunden</div>
                <div style="font-size:12px; color:var(--muted);">${partner ? `Partner: ${esc(partner.name)} · aktiv` : "Warte auf Partner-Gerät"}</div>
              </div>
            </div>
            <span class="pill" style="font-size:11px; padding:4px 10px;">OK</span>
          </div>
          <button id="btnSyncNow" class="btn btn-outline" style="color:var(--p1);" ${ui.isSyncing ? "disabled" : ""}>
            ${icon("sync", 15)} ${ui.isSyncing ? "Synchronisiert …" : "Jetzt synchronisieren"}
          </button>
        </div>

        <div class="card stack-md" style="text-align:center;">
          <div>
            <div style="font-size:14px; font-weight:700;">Weiteres Gerät oder Partner einladen</div>
            <div style="font-size:12px; color:var(--muted); margin-top:4px;">QR-Code auf einem weiteren Handy scannen, um dasselbe Sync-Gist zu nutzen.</div>
          </div>
          <div style="display:flex; justify-content:center;">
            <div id="qrCanvasBox" class="qr-box"></div>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
            <button id="btnCopyCode" class="btn btn-outline" data-code="${esc(pairingCode)}">${icon("copy", 15)} Code kopieren</button>
            <button id="btnSyncScanQr" class="btn btn-accent">${icon("qr", 15)} QR scannen</button>
          </div>
        </div>

        <div style="display:flex; justify-content:center; gap:12px;">
          <button id="btnSwitchProfile" class="btn btn-text">Profil wechseln</button>
          <button id="btnDisconnect" class="btn btn-danger-text">Sync trennen</button>
        </div>
      `}
    </div>
  `;
}

function renderNav() {
  const tabs = [
    { id: "MILK", label: "Milch", emoji: "🍼" },
    { id: "MY_TASKS", label: "Tasks", iconName: "list" },
    { id: "EVALUATION", label: "Auswertung", iconName: "chart" },
    { id: "PROFILE_SYNC", label: "Profil", iconName: "user" }
  ];
  return `
    <nav class="bottom-nav">
      ${tabs.map((t) => `
        <button class="nav-item ${ui.currentTab === t.id ? "active" : ""}" data-tab="${t.id}">
          <span class="nav-pill" style="font-size:17px; line-height:1;">
            ${t.emoji ? t.emoji : icon(t.iconName, 17)}
          </span>
          <span class="nav-label">${t.label}</span>
        </button>
      `).join("")}
    </nav>
  `;
}

const MONTHS_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

function renderCalendarModalHtml(cal) {
  const activeIso = cal.target === "DAY" ? ui.selectedMilkDateIso : ui.milkDraft.dateIso;
  const currentToday = todayIso();
  const daysWithEntries = new Set(activeMilkEntries().map((e) => e.dateIso));
  const firstDay = new Date(cal.year, cal.month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // Montag = 0
  const daysInMonth = new Date(cal.year, cal.month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return `
    <div class="modal-backdrop center" style="z-index:60;">
      <div class="dialog stack-md">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase;">
              ${cal.target === "DAY" ? "Tag für Gesamtmenge wählen" : "Datum auswählen"}
            </div>
            <div style="font-size:16px; font-weight:800; margin-top:2px;">${MONTHS_DE[cal.month]} ${cal.year}</div>
          </div>
          <div style="display:flex; gap:4px;">
            <button id="btnCalPrev" class="icon-btn" style="width:32px; height:32px;">‹</button>
            <button id="btnCalNext" class="icon-btn" style="width:32px; height:32px;">›</button>
          </div>
        </div>

        <div class="cal-grid" style="font-size:11px; font-weight:700; color:var(--muted);">
          <span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span>Sa</span><span>So</span>
        </div>

        <div class="cal-grid">
          ${cells.map((day) => {
            if (!day) return `<div></div>`;
            const iso = `${cal.year}-${pad2(cal.month + 1)}-${pad2(day)}`;
            const isSel = iso === activeIso;
            const isToday = iso === currentToday;
            const hasDot = daysWithEntries.has(iso);
            return `
              <button class="cal-cell ${isSel ? "selected" : ""} ${isToday ? "today" : ""}" data-cal-iso="${iso}">
                <span>${day}</span>
                ${hasDot ? `<span class="cal-dot"></span>` : ""}
              </button>
            `;
          }).join("")}
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; padding-top:4px;">
          <button id="btnCalToday" class="btn btn-text">Heute</button>
          <button id="btnCalClose" class="btn btn-text" style="color:var(--muted);">Abbrechen</button>
        </div>
      </div>
    </div>
  `;
}

function renderTimePickerModalHtml() {
  const h = Math.floor(ui.milkDraft.timeMinutes / 60);
  const m = ui.milkDraft.timeMinutes % 60;
  return `
    <div class="modal-backdrop center" style="z-index:60;">
      <div class="dialog stack-md">
        <div style="font-size:17px; font-weight:800;">Uhrzeit auswählen</div>
        <div style="display:flex; justify-content:center; align-items:center; gap:12px;">
          <div style="display:flex; flex-direction:column; align-items:center; gap:6px;">
            <button id="btnHourPlus" class="btn btn-outline" style="padding:6px 18px;">+</button>
            <input id="tpHourInput" class="input" type="text" inputmode="numeric" maxlength="2" value="${pad2(h)}"
              style="width:78px; height:58px; text-align:center; font-size:26px; font-weight:800; background:var(--p1-soft); color:var(--p1-text);" />
            <button id="btnHourMinus" class="btn btn-outline" style="padding:6px 18px;">−</button>
            <span style="font-size:11px; color:var(--muted); font-weight:700;">Stunde</span>
          </div>
          <span style="font-size:28px; font-weight:800; padding-bottom:22px;">:</span>
          <div style="display:flex; flex-direction:column; align-items:center; gap:6px;">
            <button id="btnMinPlus" class="btn btn-outline" style="padding:6px 18px;">+</button>
            <input id="tpMinInput" class="input" type="text" inputmode="numeric" maxlength="2" value="${pad2(m)}"
              style="width:78px; height:58px; text-align:center; font-size:26px; font-weight:800;" />
            <button id="btnMinMinus" class="btn btn-outline" style="padding:6px 18px;">−</button>
            <span style="font-size:11px; color:var(--muted); font-weight:700;">Minute</span>
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button id="btnTpDone" class="btn btn-primary">Übernehmen</button>
        </div>
      </div>
    </div>
  `;
}

function renderModals() {
  const parts = [];

  if (ui.milkDialogOpen) {
    const d = ui.milkDraft;
    const valid = parseAmountMl(d.amountInput) !== null;
    parts.push(`
      <div class="modal-backdrop center" id="milkBackdrop">
        <div class="dialog stack-md">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="font-size:19px; font-weight:800;">${ui.editingMilkId ? "Milch bearbeiten" : "Milch eintragen"}</div>
            <button id="btnCloseMilkDialog" class="icon-btn" style="width:32px; height:32px; color:var(--muted);">${icon("x", 16)}</button>
          </div>

          <button id="btnMilkPickDate" class="task-card" style="width:100%; background:var(--bg);">
            <div style="display:flex; align-items:center; gap:10px;">
              <span style="color:var(--p1);">${icon("cal", 18)}</span>
              <div style="text-align:left;">
                <div style="font-size:11px; color:var(--muted); font-weight:600;">Datum</div>
                <div style="font-size:14px; font-weight:700;">${esc(formatDatePopupDe(d.dateIso))}</div>
              </div>
            </div>
            <span style="font-size:12px; font-weight:700; color:var(--p1);">Ändern</span>
          </button>

          <button id="btnMilkPickTime" class="task-card" style="width:100%; background:var(--bg);">
            <div style="display:flex; align-items:center; gap:10px;">
              <span style="color:var(--p1);">${icon("clock", 18)}</span>
              <div style="text-align:left;">
                <div style="font-size:11px; color:var(--muted); font-weight:600;">Uhrzeit</div>
                <div style="font-size:14px; font-weight:700; font-variant-numeric:tabular-nums;">${esc(formatTimeDe(d.timeMinutes))}</div>
              </div>
            </div>
            <span style="font-size:12px; font-weight:700; color:var(--p1);">Ändern</span>
          </button>

          <div style="display:flex; align-items:center; gap:10px; padding-top:4px;">
            <label for="milkAmountInput" style="font-size:16px; font-weight:800;">Menge:</label>
            <input id="milkAmountInput" class="input" type="text" inputmode="numeric" maxlength="3" placeholder="150"
              value="${esc(d.amountInput)}" style="width:108px; text-align:center; font-size:18px; font-weight:800;" />
            <span style="font-size:16px; font-weight:700; color:var(--muted);">ml</span>
          </div>

          <div style="display:flex; justify-content:flex-end; align-items:center; gap:8px; padding-top:4px;">
            ${ui.editingMilkId ? `<button id="btnDeleteMilk" class="btn btn-text" style="color:var(--p2); margin-right:auto;">Löschen</button>` : ""}
            <button id="btnCancelMilk" class="btn btn-text" style="color:var(--muted);">Abbrechen</button>
            <button id="btnSaveMilk" class="btn btn-primary" ${valid ? "" : "disabled"}>Speichern</button>
          </div>
        </div>
      </div>
    `);
  }

  if (ui.calendarModal) {
    parts.push(renderCalendarModalHtml(ui.calendarModal));
  }

  if (ui.timePickerOpen) {
    parts.push(renderTimePickerModalHtml());
  }

  if (ui.editorOpen) {
    const d = ui.draft;
    const dur = parseLocalizedDouble(d.durationValue);
    const occ = parseLocalizedDouble(d.occurrences);
    const preview = dur && occ ? weeklyMinutes(dur, d.durationUnit, occ, d.frequency) : 0;

    parts.push(`
      <div class="modal-backdrop" id="editorBackdrop">
        <div class="sheet stack-md">
          <div class="sheet-handle"></div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="font-size:18px; font-weight:800;">${ui.editorTaskId ? "Task bearbeiten" : "Neuen Task erfassen"}</div>
            <button id="btnCloseEditor" class="icon-btn" style="width:32px; height:32px; color:var(--muted);">${icon("x", 16)}</button>
          </div>

          <div>
            <label class="field-label" for="edName">Name des Tasks</label>
            <input id="edName" class="input" type="text" placeholder="z. B. Fenster putzen" value="${esc(d.name)}" />
          </div>

          <div>
            <label class="field-label">Dauer pro Ausführung</label>
            <div style="display:flex; gap:8px; align-items:center;">
              <input id="edDuration" class="input" type="text" inputmode="decimal" style="width:96px; text-align:center; font-weight:700;" value="${esc(d.durationValue)}" />
              <div class="segmented segmented-2" style="flex:1;">
                <button class="seg-btn ${d.durationUnit === "MINUTES" ? "active" : ""}" data-ed-unit="MINUTES">Minuten</button>
                <button class="seg-btn ${d.durationUnit === "HOURS" ? "active" : ""}" data-ed-unit="HOURS">Stunden</button>
              </div>
            </div>
          </div>

          <div class="stack-sm">
            <label class="field-label" style="margin:0;">Häufigkeit &amp; Frequenz</label>
            <div style="display:flex; gap:10px; align-items:center;">
              <input id="edOccurrences" class="input" type="text" inputmode="decimal" style="width:96px; text-align:center; font-weight:700;" value="${esc(d.occurrences)}" />
              <span style="font-size:14px; color:var(--muted);">mal pro …</span>
            </div>
            <div class="segmented segmented-4">
              ${["DAY", "WEEK", "MONTH", "YEAR"].map((f) => `
                <button class="seg-btn ${d.frequency === f ? "active" : ""}" data-ed-freq="${f}">
                  ${f === "DAY" ? "Tag" : f === "WEEK" ? "Woche" : f === "MONTH" ? "Monat" : "Jahr"}
                </button>
              `).join("")}
            </div>
          </div>

          <div style="background:var(--p1-soft); color:var(--p1-text); border-radius:14px; padding:12px 14px; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; font-weight:700;">Umgerechnet pro Woche:</span>
            <span id="edPreview" style="font-size:16px; font-weight:800;">${esc(formatHoursAndMinutes(preview))}</span>
          </div>

          <div style="display:flex; gap:8px;">
            ${ui.editorTaskId ? `<button id="btnDeleteTask" class="btn btn-outline" style="color:var(--p2);">Löschen</button>` : ""}
            <button id="btnSaveTask" class="btn btn-primary" style="flex:1;">Speichern</button>
          </div>
        </div>
      </div>
    `);
  }

  if (ui.pasteDialogOpen) {
    parts.push(`
      <div class="modal-backdrop center">
        <div class="dialog stack-md">
          <div style="font-size:17px; font-weight:800;">Einladungs-Code einfügen</div>
          <textarea id="pasteCodeArea" class="input" rows="3" placeholder="komodo-tracker://pair?...">${esc(ui.pasteInput)}</textarea>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button id="btnPasteCancel" class="btn btn-text" style="color:var(--muted);">Abbrechen</button>
            <button id="btnPasteSubmit" class="btn btn-primary">Übernehmen</button>
          </div>
        </div>
      </div>
    `);
  }

  if (ui.scannerOpen) {
    parts.push(`
      <div class="modal-backdrop center">
        <div class="dialog stack-md">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="font-size:17px; font-weight:800;">Partner-QR-Code scannen</div>
            <button id="btnCloseScanner" class="icon-btn" style="width:32px; height:32px; color:var(--muted);">${icon("x", 16)}</button>
          </div>
          <video id="qrVideo" class="scanner-video" autoplay playsinline muted></video>
          <p id="scannerHint" style="font-size:12px; color:var(--muted); margin:0; text-align:center;">
            Halte die Kamera auf den QR-Code der Komodo-App.
          </p>
        </div>
      </div>
    `);
  }

  if (ui.profileSelection) {
    const sel = ui.profileSelection;
    parts.push(`
      <div class="modal-backdrop center">
        <div class="dialog stack-md">
          <div style="font-size:18px; font-weight:800;">Profil auswählen</div>
          <p style="font-size:13px; color:var(--muted); margin:0;">
            Im Sync-Gist gibt es bereits Profile. Wähle dein Profil aus, um es auf diesem iPhone mitzunutzen, oder lege ein neues Profil an.
          </p>
          <div class="stack-sm">
            ${sel.existingProfiles.map((p, idx) => {
              const taskCount = (p.tasks || []).filter((t) => !t.isDeleted).length;
              const milkCount = (p.milkEntries || []).filter((e) => !e.isDeleted).length;
              return `
                <button class="task-card" data-pick-profile="${idx}" style="width:100%; text-align:left;">
                  <div>
                    <div class="task-title">${esc(p.user.name)}</div>
                    <div class="task-rule">${taskCount} Tasks · ${milkCount} Fläschchen</div>
                  </div>
                  <span style="font-size:13px; font-weight:700; color:var(--p1);">Wählen</span>
                </button>
              `;
            }).join("")}
          </div>
          ${!sel.isSwitchMode ? `
            <div class="stack-sm" style="padding-top:4px;">
              <label class="field-label" style="margin:0;" for="newProfileNameInput">Oder neues Profil anlegen:</label>
              <input id="newProfileNameInput" class="input" type="text" placeholder="Dein Name" value="${esc(sel.newNameInput)}" />
              <button id="btnCreateNewProfileChoice" class="btn btn-primary">Als neues Profil anlegen</button>
            </div>
          ` : ""}
          <button id="btnCancelProfilePick" class="btn btn-text" style="align-self:flex-end; color:var(--muted);">Abbrechen</button>
        </div>
      </div>
    `);
  }

  if (ui.disconnectDialogOpen) {
    parts.push(`
      <div class="modal-backdrop center">
        <div class="dialog stack-md">
          <div style="font-size:17px; font-weight:800;">Sync trennen?</div>
          <p style="font-size:13px; color:var(--muted); margin:0;">
            Deine lokalen Einträge bleiben gespeichert, aber die Verbindung zum GitHub Gist wird von diesem iPhone entfernt.
          </p>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button id="btnDiscCancel" class="btn btn-text" style="color:var(--muted);">Abbrechen</button>
            <button id="btnDiscConfirm" class="btn btn-danger-text">Trennen</button>
          </div>
        </div>
      </div>
    `);
  }

  return parts.join("");
}

function renderQrCanvas() {
  const box = document.getElementById("qrCanvasBox");
  if (!box || !isConnected() || typeof window.qrcode !== "function") return;
  const code = encodePairingCode(persisted.gistId, persisted.token);
  const qr = window.qrcode(0, "M");
  qr.addData(code);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
  const svgEl = box.querySelector("svg");
  if (svgEl) {
    svgEl.setAttribute("width", "176");
    svgEl.setAttribute("height", "176");
  }
}

function stopScanner() {
  if (scanRafId) {
    cancelAnimationFrame(scanRafId);
    scanRafId = null;
  }
  if (activeStream) {
    for (const track of activeStream.getTracks()) track.stop();
    activeStream = null;
  }
}

async function startScanner(nameDraft = "") {
  ui.scannerNameDraft = nameDraft;
  ui.scannerOpen = true;
  render();

  const video = document.getElementById("qrVideo");
  const hint = document.getElementById("scannerHint");
  if (!navigator.mediaDevices?.getUserMedia || typeof window.jsQR !== "function") {
    if (hint) hint.textContent = "Kamera-Scanner nicht verfügbar. Nutze bitte „Einladungs-Code einfügen“.";
    return;
  }

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      if (!ui.scannerOpen) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = window.jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert"
        });
        if (found?.data) {
          stopScanner();
          ui.scannerOpen = false;
          render();
          inspectCodeAndPrompt(found.data, ui.scannerNameDraft);
          return;
        }
      }
      scanRafId = requestAnimationFrame(tick);
    };
    scanRafId = requestAnimationFrame(tick);
  } catch {
    if (hint) hint.textContent = "Kamerazugriff verweigert. Nutze bitte „Einladungs-Code einfügen“.";
  }
}

function openCalendarFor(target, baseIso) {
  const parts = /^(\d{4})-(\d{2})/.exec(baseIso || todayIso());
  const y = parts ? Number(parts[1]) : new Date().getFullYear();
  const m = parts ? Number(parts[2]) - 1 : new Date().getMonth();
  ui.calendarModal = { target, year: y, month: m };
  render();
}

function bindEvents() {
  // Onboarding
  const startBtn = document.getElementById("btnOnboardingStart");
  if (startBtn) {
    startBtn.onclick = () => {
      const name = document.getElementById("onboardingName")?.value.trim();
      if (!name) return showToast("Bitte gib deinen Namen ein.");
      persisted.localUser = { id: uuid(), name, updatedAt: Date.now() };
      ui.nameEditInput = name;
      persist();
      render();
    };
  }
  const onbScan = document.getElementById("btnOnboardingScan");
  if (onbScan) onbScan.onclick = () => startScanner(document.getElementById("onboardingName")?.value || "");
  const onbPaste = document.getElementById("btnOnboardingPaste");
  if (onbPaste) {
    onbPaste.onclick = () => {
      ui.pasteNameDraft = document.getElementById("onboardingName")?.value || "";
      ui.pasteDialogOpen = true;
      render();
    };
  }

  // Bottom Nav
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.onclick = () => {
      ui.currentTab = btn.getAttribute("data-tab");
      render();
    };
  });

  // Milk Tab
  const milkSync = document.getElementById("btnMilkSync");
  if (milkSync) milkSync.onclick = () => syncNow();
  const milkSetup = document.getElementById("btnMilkSetup");
  if (milkSetup) milkSetup.onclick = () => { ui.currentTab = "PROFILE_SYNC"; render(); };

  const addMilkBtn = document.getElementById("btnAddMilk");
  if (addMilkBtn) {
    addMilkBtn.onclick = () => {
      ui.editingMilkId = null;
      ui.milkDraft = {
        dateIso: ui.selectedMilkDateIso,
        timeMinutes: nowTimeMinutes(),
        amountInput: ""
      };
      ui.milkDialogOpen = true;
      render();
    };
  }

  const dayPickerBtn = document.getElementById("btnMilkDayPicker");
  if (dayPickerBtn) {
    dayPickerBtn.onclick = () => openCalendarFor("DAY", ui.selectedMilkDateIso);
  }

  document.querySelectorAll("[data-milk-entry]").forEach((card) => {
    card.onclick = () => {
      if (card.getAttribute("data-is-me") === "1") {
        const id = card.getAttribute("data-milk-entry");
        const entry = activeMilkEntries().find((e) => e.id === id);
        if (!entry) return;
        ui.editingMilkId = entry.id;
        ui.milkDraft = {
          dateIso: entry.dateIso,
          timeMinutes: entry.timeMinutes,
          amountInput: String(entry.amountMl)
        };
        ui.milkDialogOpen = true;
        render();
      } else {
        showToast(`Einträge von ${card.getAttribute("data-owner-name")} sind schreibgeschützt.`);
      }
    };
  });

  // Milk Entry Dialog
  const closeMilk = document.getElementById("btnCloseMilkDialog");
  if (closeMilk) closeMilk.onclick = () => { ui.milkDialogOpen = false; render(); };
  const cancelMilk = document.getElementById("btnCancelMilk");
  if (cancelMilk) cancelMilk.onclick = () => { ui.milkDialogOpen = false; render(); };
  const milkBackdrop = document.getElementById("milkBackdrop");
  if (milkBackdrop) {
    milkBackdrop.onclick = (e) => {
      if (e.target === milkBackdrop) { ui.milkDialogOpen = false; render(); }
    };
  }
  const pickMilkDate = document.getElementById("btnMilkPickDate");
  if (pickMilkDate) pickMilkDate.onclick = () => openCalendarFor("DRAFT", ui.milkDraft.dateIso);
  const pickMilkTime = document.getElementById("btnMilkPickTime");
  if (pickMilkTime) pickMilkTime.onclick = () => { ui.timePickerOpen = true; render(); };

  const milkAmountEl = document.getElementById("milkAmountInput");
  if (milkAmountEl) {
    milkAmountEl.oninput = (e) => {
      const cleaned = sanitizeAmountInput(e.target.value);
      e.target.value = cleaned;
      ui.milkDraft.amountInput = cleaned;
      const saveBtn = document.getElementById("btnSaveMilk");
      if (saveBtn) saveBtn.disabled = parseAmountMl(cleaned) === null;
    };
  }

  const saveMilkBtn = document.getElementById("btnSaveMilk");
  if (saveMilkBtn) {
    saveMilkBtn.onclick = () => {
      const amountMl = parseAmountMl(ui.milkDraft.amountInput);
      if (amountMl === null) return showToast("Bitte gib eine Menge zwischen 1 und 999 ml ein.");
      const now = Date.now();
      if (ui.editingMilkId) {
        persisted.milkEntries = (persisted.milkEntries || []).map((e) =>
          e.id === ui.editingMilkId && e.ownerId === persisted.localUser.id
            ? { ...e, dateIso: ui.milkDraft.dateIso, timeMinutes: ui.milkDraft.timeMinutes, amountMl, updatedAt: now, isDeleted: false }
            : e
        );
      } else {
        persisted.milkEntries.push({
          id: uuid(),
          ownerId: persisted.localUser.id,
          dateIso: ui.milkDraft.dateIso,
          timeMinutes: ui.milkDraft.timeMinutes,
          amountMl,
          createdAt: now,
          updatedAt: now,
          isDeleted: false
        });
      }
      ui.selectedMilkDateIso = ui.milkDraft.dateIso;
      ui.milkDialogOpen = false;
      persist();
      render();
      syncNow({ silent: true });
    };
  }

  const delMilkBtn = document.getElementById("btnDeleteMilk");
  if (delMilkBtn) {
    delMilkBtn.onclick = () => {
      const now = Date.now();
      persisted.milkEntries = (persisted.milkEntries || []).map((e) =>
        e.id === ui.editingMilkId && e.ownerId === persisted.localUser.id
          ? { ...e, isDeleted: true, updatedAt: now }
          : e
      );
      ui.milkDialogOpen = false;
      persist();
      showToast("Milcheintrag gelöscht.");
      render();
      syncNow({ silent: true });
    };
  }

  // Calendar Modal
  const calPrev = document.getElementById("btnCalPrev");
  if (calPrev) {
    calPrev.onclick = () => {
      ui.calendarModal.month -= 1;
      if (ui.calendarModal.month < 0) { ui.calendarModal.month = 11; ui.calendarModal.year -= 1; }
      render();
    };
  }
  const calNext = document.getElementById("btnCalNext");
  if (calNext) {
    calNext.onclick = () => {
      ui.calendarModal.month += 1;
      if (ui.calendarModal.month > 11) { ui.calendarModal.month = 0; ui.calendarModal.year += 1; }
      render();
    };
  }
  const calClose = document.getElementById("btnCalClose");
  if (calClose) calClose.onclick = () => { ui.calendarModal = null; render(); };
  const calToday = document.getElementById("btnCalToday");
  if (calToday) {
    calToday.onclick = () => {
      const today = todayIso();
      if (ui.calendarModal?.target === "DAY") ui.selectedMilkDateIso = today;
      else ui.milkDraft.dateIso = today;
      ui.calendarModal = null;
      render();
    };
  }
  document.querySelectorAll("[data-cal-iso]").forEach((btn) => {
    btn.onclick = () => {
      const iso = btn.getAttribute("data-cal-iso");
      if (ui.calendarModal?.target === "DAY") ui.selectedMilkDateIso = iso;
      else ui.milkDraft.dateIso = iso;
      ui.calendarModal = null;
      render();
    };
  });

  // TimePicker Modal
  const stepTp = (deltaH, deltaM) => {
    let h = Math.floor(ui.milkDraft.timeMinutes / 60);
    let m = ui.milkDraft.timeMinutes % 60;
    h = (h + deltaH + 24) % 24;
    m = (m + deltaM + 60) % 60;
    ui.milkDraft.timeMinutes = h * 60 + m;
    render();
  };
  const hPlus = document.getElementById("btnHourPlus");
  if (hPlus) hPlus.onclick = () => stepTp(1, 0);
  const hMinus = document.getElementById("btnHourMinus");
  if (hMinus) hMinus.onclick = () => stepTp(-1, 0);
  const mPlus = document.getElementById("btnMinPlus");
  if (mPlus) mPlus.onclick = () => stepTp(0, 1);
  const mMinus = document.getElementById("btnMinMinus");
  if (mMinus) mMinus.onclick = () => stepTp(0, -1);

  const tpHour = document.getElementById("tpHourInput");
  if (tpHour) {
    tpHour.oninput = (e) => {
      const n = Number(e.target.value.replace(/[^0-9]/g, ""));
      if (Number.isInteger(n) && n >= 0 && n <= 23) {
        ui.milkDraft.timeMinutes = n * 60 + (ui.milkDraft.timeMinutes % 60);
      }
    };
  }
  const tpMin = document.getElementById("tpMinInput");
  if (tpMin) {
    tpMin.oninput = (e) => {
      const n = Number(e.target.value.replace(/[^0-9]/g, ""));
      if (Number.isInteger(n) && n >= 0 && n <= 59) {
        ui.milkDraft.timeMinutes = Math.floor(ui.milkDraft.timeMinutes / 60) * 60 + n;
      }
    };
  }
  const tpDone = document.getElementById("btnTpDone");
  if (tpDone) tpDone.onclick = () => { ui.timePickerOpen = false; render(); };

  // My Tasks
  const fab = document.getElementById("fabAddTask");
  if (fab) {
    fab.onclick = () => {
      ui.editorTaskId = null;
      ui.draft = { name: "", durationValue: "30", durationUnit: DurationUnit.MINUTES, occurrences: "1", frequency: TaskFrequency.WEEK };
      ui.editorOpen = true;
      render();
    };
  }
  document.querySelectorAll("[data-edit-task]").forEach((card) => {
    card.onclick = () => {
      const id = card.getAttribute("data-edit-task");
      const task = activeTasks().find((t) => t.id === id);
      if (!task) return;
      ui.editorTaskId = task.id;
      ui.draft = {
        name: task.name,
        durationValue: formatNumberDe(task.durationValue),
        durationUnit: task.durationUnit,
        occurrences: formatNumberDe(task.occurrences),
        frequency: task.frequency
      };
      ui.editorOpen = true;
      render();
    };
  });

  // Evaluation
  const evalSync = document.getElementById("btnEvalSync");
  if (evalSync) evalSync.onclick = () => syncNow();
  const evalSetup = document.getElementById("btnEvalSetup");
  if (evalSetup) evalSetup.onclick = () => { ui.currentTab = "PROFILE_SYNC"; render(); };
  document.querySelectorAll("[data-filter]").forEach((chip) => {
    chip.onclick = () => { ui.evalFilter = chip.getAttribute("data-filter"); render(); };
  });
  const sortBtn = document.getElementById("btnToggleSort");
  if (sortBtn) {
    sortBtn.onclick = () => {
      ui.evalSort = ui.evalSort === "WEEKLY_DESC" ? "NAME_ASC" : "WEEKLY_DESC";
      render();
    };
  }
  document.querySelectorAll("[data-eval-task]").forEach((card) => {
    card.onclick = () => {
      if (card.getAttribute("data-is-me") === "1") {
        const id = card.getAttribute("data-eval-task");
        const task = activeTasks().find((t) => t.id === id);
        if (!task) return;
        ui.editorTaskId = task.id;
        ui.draft = {
          name: task.name,
          durationValue: formatNumberDe(task.durationValue),
          durationUnit: task.durationUnit,
          occurrences: formatNumberDe(task.occurrences),
          frequency: task.frequency
        };
        ui.editorOpen = true;
        render();
      } else {
        showToast(`Tasks von ${card.getAttribute("data-owner-name")} sind schreibgeschützt.`);
      }
    };
  });

  // Settings & Sync
  const nameInput = document.getElementById("profileNameInput");
  if (nameInput) nameInput.oninput = (e) => { ui.nameEditInput = e.target.value; };
  const saveNameBtn = document.getElementById("btnSaveName");
  if (saveNameBtn) {
    saveNameBtn.onclick = () => {
      const clean = ui.nameEditInput.trim();
      if (!clean) return showToast("Der Name darf nicht leer sein.");
      persisted.localUser = { ...persisted.localUser, name: clean, updatedAt: Date.now() };
      persist();
      showToast("Benutzername gespeichert.");
      render();
      syncNow({ silent: true });
    };
  }
  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.onclick = () => {
      persisted.themeMode = btn.getAttribute("data-theme-choice");
      persist();
      applyTheme();
      render();
    };
  });
  const tokenEl = document.getElementById("tokenInput");
  if (tokenEl) tokenEl.oninput = (e) => { ui.tokenInput = e.target.value; };
  const toggleTok = document.getElementById("btnToggleToken");
  if (toggleTok) toggleTok.onclick = () => { ui.showToken = !ui.showToken; render(); };
  const createGist = document.getElementById("btnCreateGist");
  if (createGist) createGist.onclick = () => createPrivateGistFromToken(ui.tokenInput);
  const scanBtn = document.getElementById("btnSyncScanQr");
  if (scanBtn) scanBtn.onclick = () => startScanner();
  const pasteBtn = document.getElementById("btnSyncPasteCode");
  if (pasteBtn) pasteBtn.onclick = () => { ui.pasteNameDraft = ""; ui.pasteDialogOpen = true; render(); };
  const syncNowBtn = document.getElementById("btnSyncNow");
  if (syncNowBtn) syncNowBtn.onclick = () => syncNow();
  const copyBtn = document.getElementById("btnCopyCode");
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const code = copyBtn.getAttribute("data-code");
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        showToast("Einladungs-Code kopiert.");
      } catch {
        showToast("Kopieren fehlgeschlagen.");
      }
    };
  }
  const switchBtn = document.getElementById("btnSwitchProfile");
  if (switchBtn) switchBtn.onclick = () => openSwitchProfileModal();
  const discBtn = document.getElementById("btnDisconnect");
  if (discBtn) discBtn.onclick = () => { ui.disconnectDialogOpen = true; render(); };

  // Task Editor Modal
  const closeEd = document.getElementById("btnCloseEditor");
  if (closeEd) closeEd.onclick = () => { ui.editorOpen = false; render(); };
  const edBackdrop = document.getElementById("editorBackdrop");
  if (edBackdrop) {
    edBackdrop.onclick = (e) => {
      if (e.target === edBackdrop) { ui.editorOpen = false; render(); }
    };
  }
  const updatePreview = () => {
    const dur = parseLocalizedDouble(ui.draft.durationValue);
    const occ = parseLocalizedDouble(ui.draft.occurrences);
    const preview = dur && occ ? weeklyMinutes(dur, ui.draft.durationUnit, occ, ui.draft.frequency) : 0;
    const el = document.getElementById("edPreview");
    if (el) el.textContent = formatHoursAndMinutes(preview);
  };
  const edName = document.getElementById("edName");
  if (edName) edName.oninput = (e) => { ui.draft.name = e.target.value; };
  const edDur = document.getElementById("edDuration");
  if (edDur) edDur.oninput = (e) => { ui.draft.durationValue = e.target.value; updatePreview(); };
  const edOcc = document.getElementById("edOccurrences");
  if (edOcc) edOcc.oninput = (e) => { ui.draft.occurrences = e.target.value; updatePreview(); };

  document.querySelectorAll("[data-ed-unit]").forEach((btn) => {
    btn.onclick = () => { ui.draft.durationUnit = btn.getAttribute("data-ed-unit"); render(); };
  });
  document.querySelectorAll("[data-ed-freq]").forEach((btn) => {
    btn.onclick = () => { ui.draft.frequency = btn.getAttribute("data-ed-freq"); render(); };
  });

  const saveTask = document.getElementById("btnSaveTask");
  if (saveTask) {
    saveTask.onclick = () => {
      const name = ui.draft.name.trim();
      const dur = parseLocalizedDouble(ui.draft.durationValue);
      const occ = parseLocalizedDouble(ui.draft.occurrences);
      if (!name || !dur || !occ) {
        showToast("Bitte Name, Dauer (> 0) und Häufigkeit (> 0) angeben.");
        return;
      }
      const now = Date.now();
      if (ui.editorTaskId) {
        persisted.tasks = (persisted.tasks || []).map((t) =>
          t.id === ui.editorTaskId && t.ownerId === persisted.localUser.id
            ? { ...t, name, durationValue: dur, durationUnit: ui.draft.durationUnit, occurrences: occ, frequency: ui.draft.frequency, updatedAt: now, isDeleted: false }
            : t
        );
      } else {
        persisted.tasks.push({
          id: uuid(),
          ownerId: persisted.localUser.id,
          name,
          durationValue: dur,
          durationUnit: ui.draft.durationUnit,
          occurrences: occ,
          frequency: ui.draft.frequency,
          createdAt: now,
          updatedAt: now,
          isDeleted: false
        });
      }
      ui.editorOpen = false;
      persist();
      render();
      syncNow({ silent: true });
    };
  }

  const delTask = document.getElementById("btnDeleteTask");
  if (delTask) {
    delTask.onclick = () => {
      const now = Date.now();
      persisted.tasks = (persisted.tasks || []).map((t) =>
        t.id === ui.editorTaskId && t.ownerId === persisted.localUser.id
          ? { ...t, isDeleted: true, updatedAt: now }
          : t
      );
      ui.editorOpen = false;
      persist();
      showToast("Task gelöscht.");
      render();
      syncNow({ silent: true });
    };
  }

  // Paste Code Modal
  const pasteCancel = document.getElementById("btnPasteCancel");
  if (pasteCancel) pasteCancel.onclick = () => { ui.pasteDialogOpen = false; render(); };
  const pasteSubmit = document.getElementById("btnPasteSubmit");
  if (pasteSubmit) {
    pasteSubmit.onclick = () => {
      const val = document.getElementById("pasteCodeArea")?.value || "";
      ui.pasteDialogOpen = false;
      render();
      inspectCodeAndPrompt(val, ui.pasteNameDraft);
    };
  }

  // Scanner Modal
  const closeScan = document.getElementById("btnCloseScanner");
  if (closeScan) closeScan.onclick = () => { stopScanner(); ui.scannerOpen = false; render(); };

  // Profile Selection Modal
  document.querySelectorAll("[data-pick-profile]").forEach((card) => {
    card.onclick = () => {
      const idx = Number(card.getAttribute("data-pick-profile"));
      const profile = ui.profileSelection?.existingProfiles?.[idx];
      if (profile) completeUseExistingProfile(profile);
    };
  });
  const createNewChoice = document.getElementById("btnCreateNewProfileChoice");
  if (createNewChoice) {
    createNewChoice.onclick = () => {
      const val = document.getElementById("newProfileNameInput")?.value || "";
      const sel = ui.profileSelection;
      if (sel) completeCreateNewProfile(sel.gistId, sel.token, val);
    };
  }
  const cancelPick = document.getElementById("btnCancelProfilePick");
  if (cancelPick) cancelPick.onclick = () => { ui.profileSelection = null; render(); };

  // Disconnect Modal
  const discCancel = document.getElementById("btnDiscCancel");
  if (discCancel) discCancel.onclick = () => { ui.disconnectDialogOpen = false; render(); };
  const discConfirm = document.getElementById("btnDiscConfirm");
  if (discConfirm) {
    discConfirm.onclick = () => {
      ui.disconnectDialogOpen = false;
      persisted.gistId = null;
      persisted.token = null;
      persisted.lastSyncedAt = null;
      ui.syncError = null;
      persist();
      showToast("Sync-Verbindung getrennt.");
      render();
    };
  }
}

function render() {
  applyTheme();
  const app = document.getElementById("app");
  if (!persisted.localUser) {
    app.innerHTML = renderOnboarding();
  } else {
    let screen = "";
    if (ui.currentTab === "MILK") screen = renderMilk();
    else if (ui.currentTab === "MY_TASKS") screen = renderMyTasks();
    else if (ui.currentTab === "EVALUATION") screen = renderEvaluation();
    else screen = renderSettingsSync();
    app.innerHTML = screen + renderNav();
  }

  document.getElementById("modalHost").innerHTML = renderModals();
  renderQrCanvas();
  bindEvents();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isConnected()) {
    syncNow({ silent: true });
  }
});

setInterval(() => {
  if (ui.currentTab === "MILK" && persisted.localUser && !ui.milkDialogOpen && !ui.calendarModal && !ui.timePickerOpen) {
    render();
  }
}, 30000);

render();
if (isConnected()) {
  syncNow({ silent: true });
}
