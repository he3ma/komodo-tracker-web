export const DurationUnit = {
  MINUTES: "MINUTES",
  HOURS: "HOURS"
};

export const TaskFrequency = {
  DAY: "DAY",
  WEEK: "WEEK",
  MONTH: "MONTH",
  YEAR: "YEAR"
};

export const DURATION_LABELS = {
  MINUTES: "Minuten",
  HOURS: "Stunden"
};

export const DURATION_SHORT = {
  MINUTES: "Min.",
  HOURS: "Std."
};

export const FREQUENCY_LABELS = {
  DAY: "Tag",
  WEEK: "Woche",
  MONTH: "Monat",
  YEAR: "Jahr"
};

export const FREQUENCY_PER_PERIOD = {
  DAY: "pro Tag",
  WEEK: "pro Woche",
  MONTH: "im Monat",
  YEAR: "im Jahr"
};

/**
 * Kalenderformel: Tag * 7, Woche * 1, Monat * 12 / 52, Jahr / 52.
 */
export function weeklyMinutes(durationValue, durationUnit, occurrences, frequency) {
  if (!(durationValue > 0) || !(occurrences > 0)) return 0;
  const singleMinutes = durationUnit === DurationUnit.HOURS ? durationValue * 60 : durationValue;
  switch (frequency) {
    case TaskFrequency.DAY:
      return singleMinutes * occurrences * 7;
    case TaskFrequency.WEEK:
      return singleMinutes * occurrences;
    case TaskFrequency.MONTH:
      return (singleMinutes * occurrences * 12) / 52;
    case TaskFrequency.YEAR:
      return (singleMinutes * occurrences) / 52;
    default:
      return 0;
  }
}

export function formatHoursAndMinutes(totalMinutes) {
  const rounded = Math.max(0, Math.round(totalMinutes));
  if (rounded === 0) return "0 Std.";
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  if (minutes === 0) return `${hours} Std.`;
  return `${hours}:${String(minutes).padStart(2, "0")} Std.`;
}

export function formatNumberDe(value) {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, "").replace(".", ",");
}

export function formatTaskRule(task) {
  const dur = `${formatNumberDe(task.durationValue)} ${DURATION_SHORT[task.durationUnit] || "Min."}`;
  const freq = `${formatNumberDe(task.occurrences)}× ${FREQUENCY_PER_PERIOD[task.frequency] || "pro Woche"}`;
  return `${dur} · ${freq}`;
}

export function parseLocalizedDouble(input) {
  const normalized = String(input ?? "").trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

// --- Milch-Funktionen ---

export function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, "0");
}

export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function nowTimeMinutes(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes();
}

export function totalMlForDate(entries, dateIso) {
  return (entries || [])
    .filter((e) => !e.isDeleted && e.dateIso === dateIso)
    .reduce((sum, e) => sum + (Number(e.amountMl) || 0), 0);
}

export function sanitizeAmountInput(raw) {
  return String(raw ?? "").replace(/[^0-9]/g, "").slice(0, 3);
}

export function parseAmountMl(raw) {
  const cleaned = sanitizeAmountInput(raw);
  if (!cleaned) return null;
  const val = Number(cleaned);
  if (!Number.isInteger(val) || val < 1 || val > 999) return null;
  return val;
}

export function formatTimeDe(timeMinutes) {
  const clamped = Math.max(0, Math.min(1439, Math.floor(timeMinutes || 0)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${pad2(h)}:${pad2(m)} Uhr`;
}

const SHORT_WEEKDAYS_DE = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];

function parseIsoParts(dateIso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso || ""));
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return { y, m, d, dt };
}

export function formatDatePopupDe(dateIso) {
  const p = parseIsoParts(dateIso);
  if (!p) return String(dateIso || "");
  return `${SHORT_WEEKDAYS_DE[p.dt.getDay()]}, ${pad2(p.d)}.${pad2(p.m)}.${p.y}`;
}

export function formatDateLongDe(dateIso, currentTodayIso = todayIso()) {
  const p = parseIsoParts(dateIso);
  if (!p) return String(dateIso || "");
  const prefix = dateIso === currentTodayIso ? "Heute, " : "";
  return `${prefix}${SHORT_WEEKDAYS_DE[p.dt.getDay()]} ${pad2(p.d)}.${pad2(p.m)}.${p.y}`;
}

export function formatDateShortDe(dateIso, currentTodayIso = todayIso()) {
  const p = parseIsoParts(dateIso);
  if (!p) return String(dateIso || "");
  if (dateIso === currentTodayIso) return `Heute (${pad2(p.d)}.${pad2(p.m)}.)`;
  return `${pad2(p.d)}.${pad2(p.m)}.${p.y}`;
}

export function formatLastFeedAgo(entries, nowMs = Date.now()) {
  let latestMs = null;
  for (const entry of entries || []) {
    if (entry.isDeleted) continue;
    const p = parseIsoParts(entry.dateIso);
    if (!p) continue;
    const clamped = Math.max(0, Math.min(1439, Math.floor(entry.timeMinutes || 0)));
    const dt = new Date(p.y, p.m - 1, p.d, Math.floor(clamped / 60), clamped % 60, 0, 0);
    const ms = dt.getTime();
    if (ms <= nowMs && (latestMs === null || ms > latestMs)) {
      latestMs = ms;
    }
  }
  if (latestMs === null) return null;

  const diffMin = Math.max(0, Math.floor((nowMs - latestMs) / 60000));
  if (diffMin < 1) return "Letzte vor < 1 Min.";
  if (diffMin < 60) return `Letzte vor ${diffMin} Min.`;
  if (diffMin < 24 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m === 0 ? `Letzte vor ${h} Std.` : `Letzte vor ${h} Std. ${m} Min.`;
  }
  const days = Math.floor(diffMin / (24 * 60));
  return `Letzte vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
}
