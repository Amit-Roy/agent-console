import type { TaskInput } from "./schedules.ts";

const TEXT_FIELDS = [
  "title",
  "prompt",
  "provider",
  "model",
  "effort",
  "mode",
  "cwd",
  "repeat",
  "time",
  "tz",
];
const BOOLEAN_FIELDS = ["enabled", "saveOutput"];
const PATCH_FIELDS = [...TEXT_FIELDS, ...BOOLEAN_FIELDS, "day", "limitMin"];

export function positiveInteger(value: unknown, label: string, maximum: number): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > maximum)
    throw new Error(`${label} must be an integer from 1 to ${maximum}.`);
  return number;
}

function validatePatchField(key: string, value: unknown): void {
  if (!PATCH_FIELDS.includes(key)) throw new Error(`Unknown config field: ${key}.`);
  if (TEXT_FIELDS.includes(key) && (typeof value !== "string" || !value.trim()))
    throw new Error(`${key} must be a nonempty string.`);
  if (BOOLEAN_FIELDS.includes(key) && typeof value !== "boolean")
    throw new Error(`${key} must be a boolean.`);
  if (key === "limitMin") {
    if (typeof value !== "number") throw new Error("limitMin must be a number.");
    positiveInteger(value, "limitMin", 1440);
  }
  if (
    key === "day" &&
    !(
      typeof value === "string" ||
      (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6)
    )
  )
    throw new Error("day must be a weekday name or an integer from 0 to 6.");
}

function validateScheduleFields(patch: Record<string, unknown>): void {
  if (
    patch.mode !== undefined &&
    !["plan", "acceptEdits", "bypassPermissions"].includes(String(patch.mode))
  )
    throw new Error("mode must be plan, acceptEdits or bypassPermissions.");
  if (
    patch.repeat !== undefined &&
    !["manual", "hourly", "daily", "weekdays", "weekly"].includes(String(patch.repeat))
  )
    throw new Error("repeat must be manual, hourly, daily, weekdays or weekly.");
  if (patch.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.time)))
    throw new Error("time must be HH:MM, 24-hour.");
  if (
    typeof patch.day === "string" &&
    !/^(?:[0-6]|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)$/i.test(
      patch.day,
    )
  )
    throw new Error("day must be a weekday name or 0–6.");
  if (patch.tz !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: String(patch.tz) });
    } catch {
      throw new Error("tz must be a valid IANA timezone.");
    }
  }
}

export function configPatch(value: unknown): TaskInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Config patch must be a JSON object.");
  const patch = value as Record<string, unknown>;
  if (!Object.keys(patch).length) throw new Error("Config patch must contain at least one field.");
  for (const [key, field] of Object.entries(patch)) validatePatchField(key, field);
  validateScheduleFields(patch);
  return patch as TaskInput;
}
