import cron from "node-cron";
import { cleanText, normalizeVideoRequest, validateTimezone, ValidationError } from "./validation.mjs";

export const AUTOMATION_PUBLISH_MODES = Object.freeze(["review", "auto"]);
export const AUTOMATION_MODES = Object.freeze(["calendar", "quick"]);
export const AUTOMATION_BRIEF_SOURCES = Object.freeze(["suggested", "news"]);
export const AUTOMATION_COLORS = Object.freeze(["#6f4bf3", "#18a7b8", "#e49a38", "#df5f9c", "#49b881", "#4b8cff", "#a65ac7", "#e0674f"]);

export function normalizeAutomationCreate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Automation must be an object.");
  const mode = normalizeChoice(value.mode ?? "quick", AUTOMATION_MODES, "Pipeline mode");
  const briefSource = normalizeChoice(value.briefSource ?? "suggested", AUTOMATION_BRIEF_SOURCES, "Brief source");
  const publishMode = normalizePublishMode(value.publishMode, value.requireReview);
  const template = normalizeVideoRequest(value.template);
  validatePublishMode(publishMode, template.platforms);
  const normalized = {
    name: cleanText(value.name ?? "Scheduled video", "Automation name", 1, 100),
    enabled: value.enabled !== false,
    mode,
    briefSource,
    topicFocus: optionalText(value.topicFocus, "Topic focus", 300),
    color: normalizeColor(value.color),
    cron: value.cron == null || String(value.cron).trim() === "" ? null : normalizeCron(value.cron),
    timezone: validateTimezone(value.timezone),
    template,
    publishMode,
    requireReview: publishMode === "review",
  };
  if (mode === "calendar") Object.assign(normalized, normalizeCalendarRange(value));
  else if (!normalized.cron) throw new ValidationError("Quick Automation requires a cron expression.");
  return normalized;
}

export function normalizeAutomationPatch(current, value) {
  if (!current) throw new ValidationError("Automation not found.", 404);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Automation update must be an object.");
  const patch = {};
  if (typeof value.enabled === "boolean") patch.enabled = value.enabled;
  if (value.name != null) patch.name = cleanText(value.name, "Automation name", 1, 100);
  if (value.mode != null) patch.mode = normalizeChoice(value.mode, AUTOMATION_MODES, "Pipeline mode");
  if (value.briefSource != null) patch.briefSource = normalizeChoice(value.briefSource, AUTOMATION_BRIEF_SOURCES, "Brief source");
  if (value.topicFocus != null) patch.topicFocus = optionalText(value.topicFocus, "Topic focus", 300);
  if (value.color != null) patch.color = normalizeColor(value.color);
  if (value.cron != null) patch.cron = String(value.cron).trim() ? normalizeCron(value.cron) : null;
  if (value.timezone != null) patch.timezone = validateTimezone(value.timezone);
  if (value.template != null) patch.template = normalizeVideoRequest(value.template);
  if (value.publishMode != null || typeof value.requireReview === "boolean") {
    patch.publishMode = normalizePublishMode(value.publishMode, value.requireReview);
    patch.requireReview = patch.publishMode === "review";
  }
  const template = patch.template ?? current.template;
  const mode = patch.mode ?? current.mode ?? "quick";
  if (mode === "calendar" && ["startDate", "endDate", "weekdays", "times"].some((key) => value[key] != null)) {
    Object.assign(patch, normalizeCalendarRange({ ...current, ...value }));
  }
  if (mode === "quick" && !(patch.cron ?? current.cron)) throw new ValidationError("Quick Automation requires a cron expression.");
  const publishMode = patch.publishMode ?? normalizePublishMode(current.publishMode, current.requireReview);
  validatePublishMode(publishMode, template.platforms);
  return patch;
}

export function automationPublishMode(automation) {
  return normalizePublishMode(automation?.publishMode, automation?.requireReview);
}

export function activeAutomationJob(jobs, automationId) {
  return jobs.find((job) => job.trigger?.automationId === automationId
    && (job.state === "queued" || job.state === "running" || job.publishState === "running")) ?? null;
}

export function buildCalendarEntries(automation, now = new Date(), idFactory = () => crypto.randomUUID()) {
  if (automation.mode !== "calendar") return [];
  const { startDate, endDate, weekdays, times } = normalizeCalendarRange(automation);
  const createdAt = now.toISOString();
  const allowedDays = new Set(weekdays);
  const entries = [];
  for (let cursor = parseDate(startDate); cursor <= parseDate(endDate); cursor = new Date(cursor.getTime() + 86_400_000)) {
    if (!allowedDays.has(cursor.getUTCDay())) continue;
    const date = formatDate(cursor);
    for (const time of times) {
      entries.push({
        id: idFactory(),
        automationId: automation.id,
        date,
        time,
        timezone: automation.timezone,
        briefSource: automation.briefSource,
        topicFocus: automation.topicFocus,
        brief: null,
        title: automation.briefSource === "news" ? "Latest news brief pending" : "Suggested idea pending",
        briefState: "pending",
        state: "planned",
        jobId: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  if (!entries.length) throw new ValidationError("The selected date range, weekdays, and times do not create any calendar posts.");
  if (entries.length > 400) throw new ValidationError("A content calendar pipeline can contain at most 400 planned posts. Shorten the date range or reduce daily times.");
  return entries;
}

export function calendarCronExpressions(automation) {
  if (automation.mode !== "calendar") return automation.cron ? [automation.cron] : [];
  const days = automation.weekdays.join(",");
  return automation.times.map((time) => {
    const [hour, minute] = time.split(":").map(Number);
    return `${minute} ${hour} * * ${days}`;
  });
}

export function calendarDateInTimezone(date = new Date(), timezone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizePublishMode(value, requireReview) {
  const mode = value == null ? (requireReview === false ? "auto" : "review") : String(value).trim().toLowerCase();
  if (!AUTOMATION_PUBLISH_MODES.includes(mode)) throw new ValidationError("Publish mode must be review or auto.");
  return mode;
}

function validatePublishMode(mode, platforms) {
  if (mode === "auto" && !platforms.length) throw new ValidationError("Automatic publishing requires at least one platform.");
}

function normalizeCron(value) {
  const expression = cleanText(value, "Cron expression", 5, 100).replace(/\s+/g, " ");
  if (!cron.validate(expression)) throw new ValidationError("Invalid cron expression.");
  return expression;
}

function normalizeCalendarRange(value) {
  const startDate = normalizeDate(value.startDate, "Start date");
  const endDate = normalizeDate(value.endDate, "End date");
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (end < start) throw new ValidationError("End date must be on or after the start date.");
  if ((end.getTime() - start.getTime()) / 86_400_000 > 366) throw new ValidationError("A content calendar date range cannot exceed 366 days.");
  const weekdays = [...new Set((Array.isArray(value.weekdays) ? value.weekdays : [0, 1, 2, 3, 4, 5, 6]).map(Number))].sort();
  if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new ValidationError("Choose at least one valid weekday.");
  const times = [...new Set((Array.isArray(value.times) ? value.times : ["08:30"]).map((time) => normalizeTime(time)))].sort();
  if (!times.length || times.length > 8) throw new ValidationError("Choose between 1 and 8 posting times per day.");
  return { startDate, endDate, weekdays, times };
}

function normalizeDate(value, label) {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parseDate(date).getTime()) || formatDate(parseDate(date)) !== date) throw new ValidationError(`${label} must use YYYY-MM-DD.`);
  return date;
}

function normalizeTime(value) {
  const time = String(value ?? "").trim();
  const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new ValidationError("Posting times must use 24-hour HH:MM.");
  return time;
}

function normalizeColor(value) {
  const color = String(value ?? AUTOMATION_COLORS[0]).trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new ValidationError("Pipeline color must be a six-digit hex color.");
  return color;
}

function normalizeChoice(value, choices, label) {
  const choice = String(value ?? "").trim().toLowerCase();
  if (!choices.includes(choice)) throw new ValidationError(`${label} is not supported.`);
  return choice;
}

function optionalText(value, label, max) {
  if (value == null || String(value).trim() === "") return "";
  return cleanText(String(value), label, 1, max);
}

function parseDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}
