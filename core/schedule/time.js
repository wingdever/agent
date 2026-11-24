"use strict";

// Schedule timing rules: strict-enough parsing plus bounded next/previous
// occurrence arithmetic. This is intentionally dependency-free. It follows the
// DSH Schedule vocabulary (at / after / every / daily / weekly / cron / rrule)
// and keeps the same wall-clock semantics: invalid local times are skipped,
// ambiguous local times use the earlier instant, and recurring calculations are
// bounded instead of enumerating an unbounded backlog.

const MIN_EVERY_INTERVAL_SECONDS = 60;
const MAX_RRULE_STEPS = 100000;
const MAX_TIMER_DELAY_MS = 2147483647;
const MAX_DAILY_SEARCH_DAYS = 4000;
const DAY_MS = 86400000;

const WEEKDAYS = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

function timingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

function canonicalZone(zone) {
  if (typeof zone !== "string" || !zone.trim()) {
    throw timingError("invalid_time_zone", "time_zone must be UTC or a valid IANA Area/Location name");
  }
  const value = zone.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch (_) {
    throw timingError("invalid_time_zone", "time_zone must be UTC or a valid IANA Area/Location name");
  }
  return value;
}

function civilMs(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

function civilParts(ms) {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}

function daysInMonth(year, month) {
  return new Date(civilMs(year, month + 1, 0)).getUTCDate();
}

function addDaysParts(parts, days) {
  return civilParts(civilMs(parts.year, parts.month, parts.day + days));
}

function weekdayIso(parts) {
  const weekday = new Date(civilMs(parts.year, parts.month, parts.day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

const zoneFormatters = new Map();

function formatterFor(zone) {
  let formatter = zoneFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(zone, formatter);
  }
  return formatter;
}

function zonedParts(ms, zone) {
  const values = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const hour = Number(values.hour) === 24 ? 0 : Number(values.hour);
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour,
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function zoneOffsetMs(ms, zone) {
  const parts = zonedParts(ms, zone);
  return civilMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second) - ms;
}

// Convert a local wall time to UTC. A second pass settles zones whose offset
// changes around the candidate; a mismatch means the wall time does not exist
// (the DST gap) and the caller skips that date.
function localToUtc(parts, zone) {
  const wall = civilMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = wall;
  for (let i = 0; i < 4; i += 1) {
    const offset = zoneOffsetMs(candidate, zone);
    const next = wall - offset;
    if (next === candidate) break;
    candidate = next;
  }
  const check = zonedParts(candidate, zone);
  if (
    check.year !== parts.year ||
    check.month !== parts.month ||
    check.day !== parts.day ||
    check.hour !== parts.hour ||
    check.minute !== parts.minute ||
    check.second !== parts.second
  ) {
    return null;
  }
  return candidate;
}

function parseTimeOfDay(value) {
  if (typeof value !== "string") throw timingError("invalid_time", "time must be HH:mm or HH:mm:ss");
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/u.exec(value.trim());
  if (!match) throw timingError("invalid_time", "time must be HH:mm or HH:mm:ss with optional milliseconds");
  const second = Number(match[3] || 0);
  const millisecond = Number((match[4] || "").padEnd(3, "0") || 0);
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
    second,
    millisecond,
    text: `${pad(match[1])}:${pad(match[2])}:${pad(second)}.${pad(millisecond, 3)}`,
  };
}

function parseAt(value, timeZone) {
  if (typeof value === "string") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value.trim())) {
      throw timingError("invalid_at", "at must be an RFC 3339 instant with an explicit offset");
    }
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw timingError("invalid_at", "at must be an RFC 3339 instant with an explicit offset");
    return { ms, iso: new Date(ms).toISOString() };
  }
  if (!isRecord(value) || typeof value.date !== "string" || typeof value.time !== "string") {
    throw timingError("invalid_at", "at must be an RFC 3339 string or {date, time, time_zone}");
  }
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.date.trim());
  if (!dateMatch) throw timingError("invalid_at", "at.date must be YYYY-MM-DD");
  const time = parseTimeOfDay(value.time);
  const zone = canonicalZone(value.time_zone || timeZone);
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (day > daysInMonth(year, month)) throw timingError("invalid_at", "at.date is not a real calendar date");
  const ms = localToUtc({ year, month, day, hour: time.hour, minute: time.minute, second: time.second }, zone);
  if (ms == null) throw timingError("invalid_at", "at is a nonexistent local time");
  return { ms, iso: new Date(ms).toISOString() };
}

function expandCronField(value, min, max, { dayOfWeek = false } = {}) {
  const field = value.trim();
  if (!field) throw timingError("invalid_cron", "cron fields must be non-empty");
  const wildcard = field.startsWith("*");
  const values = new Set();
  for (const part of field.split(",")) {
    if (!part) throw timingError("invalid_cron", "cron list contains an empty item");
    const stepSplit = part.split("/");
    if (stepSplit.length > 2) throw timingError("invalid_cron", "invalid cron step");
    const base = stepSplit[0];
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
    if (!Number.isInteger(step) || step < 1) throw timingError("invalid_cron", "invalid cron step");
    let start;
    let end;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw timingError("invalid_cron", "invalid cron range");
      start = Number(range[0]);
      end = Number(range[1]);
    } else {
      if (stepSplit.length === 2) throw timingError("invalid_cron", "cron steps require * or a range");
      start = Number(base);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw timingError("invalid_cron", "cron value is out of range");
    }
    for (let item = start; item <= end; item += step) {
      values.add(dayOfWeek && item === 7 ? 0 : item);
    }
  }
  return { values: [...values].sort((a, b) => a - b), wildcard };
}

function parseCron(expression) {
  if (typeof expression !== "string") throw timingError("invalid_cron", "cron expression must be a string");
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) throw timingError("invalid_cron", "cron must have exactly five fields: minute hour day-of-month month day-of-week");
  return {
    minute: expandCronField(fields[0], 0, 59),
    hour: expandCronField(fields[1], 0, 23),
    dayOfMonth: expandCronField(fields[2], 1, 31),
    month: expandCronField(fields[3], 1, 12),
    dayOfWeek: expandCronField(fields[4], 0, 7, { dayOfWeek: true }),
  };
}

function cronDateMatches(cron, parts) {
  if (!cron.month.values.includes(parts.month)) return false;
  const dom = cron.dayOfMonth.values.includes(parts.day);
  const dow = cron.dayOfWeek.values.includes(weekdayIso(parts) % 7);
  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) return true;
  if (cron.dayOfMonth.wildcard) return dow;
  if (cron.dayOfWeek.wildcard) return dom;
  return dom || dow;
}

function cronCandidatesForDate(cron, dateParts, zone) {
  const result = [];
  for (const hour of cron.hour.values) {
    for (const minute of cron.minute.values) {
      const ms = localToUtc({ ...dateParts, hour, minute, second: 0 }, zone);
      if (ms != null) result.push(ms);
    }
  }
  return result.sort((a, b) => a - b);
}

function nextCron(cron, zone, afterMs, strict) {
  const start = zonedParts(afterMs, zone);
  for (let offset = 0; offset <= MAX_DAILY_SEARCH_DAYS; offset += 1) {
    const date = addDaysParts(start, offset);
    if (!cronDateMatches(cron, date)) continue;
    for (const candidate of cronCandidatesForDate(cron, date, zone)) {
      if (candidate > afterMs || (!strict && candidate === afterMs)) return candidate;
    }
  }
  return null;
}

function previousCron(cron, zone, beforeMs) {
  const start = zonedParts(beforeMs, zone);
  for (let offset = 0; offset <= MAX_DAILY_SEARCH_DAYS; offset += 1) {
    const date = addDaysParts(start, -offset);
    if (!cronDateMatches(cron, date)) continue;
    const candidates = cronCandidatesForDate(cron, date, zone);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (candidates[i] <= beforeMs) return candidates[i];
    }
  }
  return null;
}

function nextDaily(time, zone, afterMs, strict, weekdays) {
  const start = zonedParts(afterMs, zone);
  const daySet = weekdays ? new Set(weekdays) : null;
  for (let offset = 0; offset <= MAX_DAILY_SEARCH_DAYS; offset += 1) {
    const date = addDaysParts(start, offset);
    if (daySet && !daySet.has(weekdayIso(date))) continue;
    const candidate = localToUtc({ ...date, hour: time.hour, minute: time.minute, second: time.second }, zone);
    if (candidate != null && (candidate > afterMs || (!strict && candidate === afterMs))) return candidate;
  }
  return null;
}

function previousDaily(time, zone, beforeMs, weekdays) {
  const start = zonedParts(beforeMs, zone);
  const daySet = weekdays ? new Set(weekdays) : null;
  for (let offset = 0; offset <= MAX_DAILY_SEARCH_DAYS; offset += 1) {
    const date = addDaysParts(start, -offset);
    if (daySet && !daySet.has(weekdayIso(date))) continue;
    const candidate = localToUtc({ ...date, hour: time.hour, minute: time.minute, second: time.second }, zone);
    if (candidate != null && candidate <= beforeMs) return candidate;
  }
  return null;
}

function parseRRule(text) {
  if (typeof text !== "string") throw timingError("invalid_rrule", "rrule must be a string");
  const lines = text.trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 2) throw timingError("invalid_rrule", "rrule must contain exactly a DTSTART line and a RRULE line");
  const dtLine = /^DTSTART(?:;TZID=([^:]+))?:(\d{8}T\d{6})(Z)?$/u.exec(lines[0]);
  if (!dtLine) throw timingError("invalid_rrule", "DTSTART must be DTSTART:YYYYMMDDTHHMMSSZ or DTSTART;TZID=Zone:YYYYMMDDTHHMMSS");
  const [, tzid, stamp, utc] = dtLine;
  if (utc && tzid) throw timingError("invalid_rrule", "DTSTART cannot combine TZID and Z");
  const zone = utc ? "UTC" : canonicalZone(tzid);
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(9, 11));
  const minute = Number(stamp.slice(11, 13));
  const second = Number(stamp.slice(13, 15));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) {
    throw timingError("invalid_rrule", "DTSTART is not a real local time");
  }
  const dtstartMs = localToUtc({ year, month, day, hour, minute, second }, zone);
  if (dtstartMs == null) throw timingError("invalid_rrule", "DTSTART is a nonexistent local time");
  const dtstart = { year, month, day, hour, minute, second };

  if (!lines[1].startsWith("RRULE:")) throw timingError("invalid_rrule", "the second line must be RRULE:...");
  const fields = new Map();
  for (const item of lines[1].slice(6).split(";")) {
    const pair = item.split("=");
    if (pair.length !== 2 || !pair[0] || !pair[1]) throw timingError("invalid_rrule", "invalid RRULE field");
    const key = pair[0].toUpperCase();
    if (fields.has(key)) throw timingError("invalid_rrule", `duplicate RRULE field ${key}`);
    fields.set(key, pair[1]);
  }
  if (fields.has("WKST") && fields.get("WKST").toUpperCase() !== "MO") {
    throw timingError("invalid_rrule", "this implementation only supports WKST=MO");
  }
  const freq = (fields.get("FREQ") || "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
    throw timingError("invalid_rrule", "supported FREQ values are DAILY, WEEKLY, MONTHLY, and YEARLY");
  }
  const interval = fields.has("INTERVAL") ? Number(fields.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1) throw timingError("invalid_rrule", "INTERVAL must be a positive integer");
  let count;
  if (fields.has("COUNT")) {
    count = Number(fields.get("COUNT"));
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw timingError("invalid_rrule", "COUNT must be 1 through 1000");
  }
  let until;
  if (fields.has("UNTIL")) {
    const value = fields.get("UNTIL");
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(value);
    if (!match) throw timingError("invalid_rrule", "UNTIL must be an absolute UTC date-time ending in Z");
    const parsed = Number(match[1]);
    const parsedMonth = Number(match[2]);
    const parsedDay = Number(match[3]);
    const parsedHour = Number(match[4]);
    const parsedMinute = Number(match[5]);
    const parsedSecond = Number(match[6]);
    if (parsedMonth < 1 || parsedMonth > 12 || parsedDay < 1 || parsedDay > daysInMonth(parsed, parsedMonth)
      || parsedHour > 23 || parsedMinute > 59 || parsedSecond > 59) {
      throw timingError("invalid_rrule", "UNTIL is not a real UTC time");
    }
    until = civilMs(parsed, parsedMonth, parsedDay, parsedHour, parsedMinute, parsedSecond);
  }
  if (count != null && until != null) throw timingError("invalid_rrule", "COUNT and UNTIL cannot be combined");

  const byDay = fields.has("BYDAY") ? fields.get("BYDAY").split(",").map((value) => {
    const weekday = WEEKDAYS[value.toUpperCase()];
    if (!weekday) throw timingError("invalid_rrule", "BYDAY supports MO,TU,WE,TH,FR,SA,SU without ordinals");
    return weekday;
  }) : [];
  const byMonthDay = fields.has("BYMONTHDAY") ? fields.get("BYMONTHDAY").split(",").map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) throw timingError("invalid_rrule", "BYMONTHDAY supports 1 through 31");
    return parsed;
  }) : [];
  const byMonth = fields.has("BYMONTH") ? fields.get("BYMONTH").split(",").map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) throw timingError("invalid_rrule", "BYMONTH supports 1 through 12");
    return parsed;
  }) : [];
  const byHour = fields.has("BYHOUR") ? fields.get("BYHOUR").split(",").map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) throw timingError("invalid_rrule", "BYHOUR supports 0 through 23");
    return parsed;
  }) : [];
  const byMinute = fields.has("BYMINUTE") ? fields.get("BYMINUTE").split(",").map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 59) throw timingError("invalid_rrule", "BYMINUTE supports 0 through 59");
    return parsed;
  }) : [];
  const bySecond = fields.has("BYSECOND") ? fields.get("BYSECOND").split(",").map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 59) throw timingError("invalid_rrule", "BYSECOND supports 0 through 59");
    return parsed;
  }) : [];
  const unsupported = ["BYSETPOS", "BYWEEKNO", "BYYEARDAY", "BYDAY"].filter((key) => {
    if (key === "BYDAY") return fields.has(key) && /[+-]?\d/u.test(fields.get(key));
    return fields.has(key);
  });
  if (unsupported.length) throw timingError("invalid_rrule", "unsupported RRULE fields: " + unsupported.join(", "));
  if (freq === "MONTHLY" || freq === "YEARLY") {
    if (byDay.length) throw timingError("invalid_rrule", "BYDAY is not supported for MONTHLY or YEARLY in this implementation");
  }
  const canonical = lines[0] + "\n" + lines[1];
  return {
    kind: "rrule",
    rrule: canonical,
    freq,
    interval,
    count,
    until,
    byDay,
    byMonthDay,
    byMonth,
    byHour: byHour.length ? byHour : [dtstart.hour],
    byMinute: byMinute.length ? byMinute : [dtstart.minute],
    bySecond: bySecond.length ? bySecond : [dtstart.second],
    dtstart,
    dtstartMs,
    zone,
  };
}

function rruleTimeCandidates(rule, dateParts) {
  const result = [];
  for (const hour of rule.byHour) {
    for (const minute of rule.byMinute) {
      for (const second of rule.bySecond) {
        const candidate = localToUtc({ ...dateParts, hour, minute, second }, rule.zone);
        if (candidate != null) result.push(candidate);
      }
    }
  }
  return result.sort((a, b) => a - b);
}

function rruleOccurrences(rule, maxMs, visit) {
  let count = 0;
  let stopped = false;
  const emitDate = (dateParts) => {
    if (stopped) return;
    for (const candidate of rruleTimeCandidates(rule, dateParts)) {
      if (candidate < rule.dtstartMs) continue;
      if (rule.until != null && candidate > rule.until) { stopped = true; return; }
      if (candidate > maxMs) { stopped = true; return; }
      count += 1;
      if (rule.count != null && count > rule.count) { stopped = true; return; }
      if (visit(candidate, count) === false) { stopped = true; return; }
      if (rule.count != null && count === rule.count) { stopped = true; return; }
    }
  };

  if (rule.freq === "DAILY") {
    for (let offset = 0; offset < MAX_RRULE_STEPS && !stopped; offset += 1) {
      const date = addDaysParts(rule.dtstart, offset * rule.interval);
      if (rule.byMonth.length && !rule.byMonth.includes(date.month)) continue;
      if (rule.byMonthDay.length && !rule.byMonthDay.includes(date.day)) continue;
      if (rule.byDay.length && !rule.byDay.includes(weekdayIso(date))) continue;
      emitDate(date);
    }
  } else if (rule.freq === "WEEKLY") {
    const anchorWeekStart = addDaysParts(rule.dtstart, 1 - weekdayIso(rule.dtstart));
    const days = rule.byDay.length ? rule.byDay : [weekdayIso(rule.dtstart)];
    for (let offset = 0; offset < MAX_RRULE_STEPS && !stopped; offset += 1) {
      const weekStart = addDaysParts(anchorWeekStart, offset * rule.interval * 7);
      for (const day of days) emitDate(addDaysParts(weekStart, day - 1));
    }
  } else if (rule.freq === "MONTHLY") {
    const days = rule.byMonthDay.length ? rule.byMonthDay : [rule.dtstart.day];
    for (let offset = 0; offset < MAX_RRULE_STEPS && !stopped; offset += 1) {
      const total = rule.dtstart.year * 12 + (rule.dtstart.month - 1) + offset * rule.interval;
      const year = Math.floor(total / 12);
      const month = total % 12 + 1;
      if (rule.byMonth.length && !rule.byMonth.includes(month)) continue;
      for (const day of days) {
        if (day > daysInMonth(year, month)) continue;
        emitDate({ year, month, day });
      }
    }
  } else if (rule.freq === "YEARLY") {
    const months = rule.byMonth.length ? rule.byMonth : [rule.dtstart.month];
    const days = rule.byMonthDay.length ? rule.byMonthDay : [rule.dtstart.day];
    for (let offset = 0; offset < MAX_RRULE_STEPS && !stopped; offset += 1) {
      const year = rule.dtstart.year + offset * rule.interval;
      for (const month of months) {
        for (const day of days) {
          if (day > daysInMonth(year, month)) continue;
          emitDate({ year, month, day });
        }
      }
    }
  }
}

function nextRRule(rule, afterMs, strict) {
  let found;
  rruleOccurrences(rule, Number.MAX_SAFE_INTEGER, (candidate) => {
    if (candidate > afterMs || (!strict && candidate === afterMs)) {
      found = candidate;
      return false;
    }
    return true;
  });
  return found == null ? null : found;
}

function previousRRule(rule, beforeMs) {
  let latest;
  rruleOccurrences(rule, beforeMs, (candidate) => {
    if (candidate <= beforeMs) latest = candidate;
    return true;
  });
  return latest == null ? null : latest;
}

function normalizeTiming(input, nowMs) {
  if (!isRecord(input)) throw timingError("invalid_timing", "timing must be an object");
  const kind = input.kind;
  if (kind === "at" || kind === "after") {
    let target;
    if (kind === "after") {
      const seconds = Number(input.after_seconds);
      if (!Number.isInteger(seconds) || seconds < 1) throw timingError("invalid_timing", "after_seconds must be a positive integer");
      target = nowMs + seconds * 1000;
    } else {
      target = parseAt(input.at, input.time_zone).ms;
    }
    if (target <= nowMs) throw timingError("not_future", "the scheduled time must be strictly in the future");
    return { timing: { kind, ...(kind === "after" ? { afterSeconds: Number(input.after_seconds) } : {}), scheduledAt: new Date(target).toISOString() }, nextAt: target };
  }
  if (kind === "every") {
    const seconds = Number(input.every_seconds);
    if (!Number.isInteger(seconds) || seconds < MIN_EVERY_INTERVAL_SECONDS) {
      throw timingError("invalid_timing", `every_seconds must be an integer of at least ${MIN_EVERY_INTERVAL_SECONDS}`);
    }
    const anchorAt = new Date(nowMs).toISOString();
    return {
      timing: { kind, everySeconds: seconds, anchorAt },
      nextAt: nowMs + seconds * 1000,
    };
  }
  if (kind === "daily" || kind === "weekly") {
    const time = parseTimeOfDay(input.time);
    const timeZone = canonicalZone(input.time_zone);
    let weekdays = [];
    if (kind === "weekly") {
      if (!Array.isArray(input.weekdays) || !input.weekdays.length) throw timingError("invalid_timing", "weekly requires weekdays");
      weekdays = [...new Set(input.weekdays.map(Number))].sort((a, b) => a - b);
      if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw timingError("invalid_timing", "weekdays are ISO weekday numbers 1 through 7");
    }
    const nextAt = nextDaily(time, timeZone, nowMs, true, kind === "weekly" ? weekdays : undefined);
    if (nextAt == null) throw timingError("not_future", "the recurrence has no future occurrence");
    return { timing: { kind, time: time.text, timeZone, ...(kind === "weekly" ? { weekdays } : {}) }, nextAt };
  }
  if (kind === "cron") {
    const expression = typeof input.expression === "string" ? input.expression.trim() : "";
    const cron = parseCron(expression);
    const timeZone = canonicalZone(input.time_zone);
    const nextAt = nextCron(cron, timeZone, nowMs, true);
    if (nextAt == null) throw timingError("not_future", "the cron rule has no future occurrence");
    return { timing: { kind, expression, timeZone }, nextAt };
  }
  if (kind === "rrule") {
    const rule = parseRRule(input.rrule);
    const nextAt = nextRRule(rule, nowMs, true);
    if (nextAt == null) throw timingError("not_future", "the rrule has no future occurrence");
    return { timing: { kind, rrule: rule.rrule }, nextAt };
  }
  throw timingError("invalid_timing", "unsupported timing kind " + JSON.stringify(kind));
}

function nextOccurrence(timing, afterMs, strict = true) {
  if (timing.kind === "at" || timing.kind === "after") {
    const target = Date.parse(timing.scheduledAt);
    return target > afterMs || (!strict && target === afterMs) ? target : null;
  }
  if (timing.kind === "every") {
    const anchor = Date.parse(timing.anchorAt);
    const interval = timing.everySeconds * 1000;
    if (anchor > afterMs) return strict ? anchor : null;
    const base = anchor + Math.floor((afterMs - anchor) / interval) * interval;
    return strict ? base + interval : base;
  }
  if (timing.kind === "daily") {
    return nextDaily(parseTimeOfDay(timing.time), timing.timeZone, afterMs, strict);
  }
  if (timing.kind === "weekly") {
    return nextDaily(parseTimeOfDay(timing.time), timing.timeZone, afterMs, strict, timing.weekdays);
  }
  if (timing.kind === "cron") {
    return nextCron(parseCron(timing.expression), timing.timeZone, afterMs, strict);
  }
  if (timing.kind === "rrule") {
    return nextRRule(parseRRule(timing.rrule), afterMs, strict);
  }
  return null;
}

function latestOccurrence(timing, beforeMs) {
  if (timing.kind === "at" || timing.kind === "after") {
    const target = Date.parse(timing.scheduledAt);
    return target <= beforeMs ? target : null;
  }
  if (timing.kind === "every") {
    const anchor = Date.parse(timing.anchorAt);
    if (anchor > beforeMs) return null;
    const interval = timing.everySeconds * 1000;
    return anchor + Math.floor((beforeMs - anchor) / interval) * interval;
  }
  if (timing.kind === "daily") {
    return previousDaily(parseTimeOfDay(timing.time), timing.timeZone, beforeMs);
  }
  if (timing.kind === "weekly") {
    return previousDaily(parseTimeOfDay(timing.time), timing.timeZone, beforeMs, timing.weekdays);
  }
  if (timing.kind === "cron") {
    return previousCron(parseCron(timing.expression), timing.timeZone, beforeMs);
  }
  if (timing.kind === "rrule") {
    return previousRRule(parseRRule(timing.rrule), beforeMs);
  }
  return null;
}

function isRecurring(timing) {
  return ["every", "daily", "weekly", "cron", "rrule"].includes(timing.kind);
}

function describeTiming(timing) {
  if (timing.kind === "at") return "at " + timing.scheduledAt;
  if (timing.kind === "after") return "after " + timing.afterSeconds + "s";
  if (timing.kind === "every") return "every " + timing.everySeconds + "s";
  if (timing.kind === "daily") return "daily " + timing.time + " " + timing.timeZone;
  if (timing.kind === "weekly") return "weekly " + timing.weekdays.join(",") + " " + timing.time + " " + timing.timeZone;
  if (timing.kind === "cron") return "cron " + timing.expression + " " + timing.timeZone;
  if (timing.kind === "rrule") return timing.rrule;
  return String(timing.kind);
}

const __exports = {
  MIN_EVERY_INTERVAL_SECONDS,
  MAX_TIMER_DELAY_MS,
  normalizeTiming,
  nextOccurrence,
  latestOccurrence,
  isRecurring,
  describeTiming,
  parseCron,
  parseRRule,
};
export {
  MIN_EVERY_INTERVAL_SECONDS,
  MAX_TIMER_DELAY_MS,
  normalizeTiming,
  nextOccurrence,
  latestOccurrence,
  isRecurring,
  describeTiming,
  parseCron,
  parseRRule,
};
export default __exports;
