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
