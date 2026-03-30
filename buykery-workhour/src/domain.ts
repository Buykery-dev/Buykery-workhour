import type { AwayWindow, CompletedShiftRecord, ManualAwayNote, PauseRecord, ShiftState, UserSession, WorkStatus } from "./types.js";

export interface ShiftSummary {
  totalElapsedMs: number;
  totalPausedMs: number;
  workedMs: number;
}

export interface WeeklyMemberSummary {
  chatId: number;
  userId: number;
  displayName: string;
  username?: string;
  workedMs: number;
}

function intersectMs(startA: number, endA: number, startB: number, endB: number): number {
  const start = Math.max(startA, startB);
  const end = Math.min(endA, endB);
  return Math.max(0, end - start);
}

export function calculateWorkedMsInRange(
  startedAtIso: string,
  endedAtIso: string,
  pauses: PauseRecord[],
  awayWindows: AwayWindow[],
  rangeStart: Date,
  rangeEnd: Date
): number {
  const shiftStart = new Date(startedAtIso).getTime();
  const shiftEnd = new Date(endedAtIso).getTime();
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();
  const grossMs = intersectMs(shiftStart, shiftEnd, rangeStartMs, rangeEndMs);

  if (grossMs === 0) {
    return 0;
  }

  const pausedMs = pauses.reduce((sum, pause) => {
    const pauseStart = new Date(pause.startedAt).getTime();
    const pauseEnd = pause.endedAt ? new Date(pause.endedAt).getTime() : shiftEnd;
    return sum + intersectMs(pauseStart, pauseEnd, rangeStartMs, rangeEndMs);
  }, 0);
  const awayMs = awayWindows.reduce((sum, window) => {
    return sum + intersectMs(new Date(window.from).getTime(), new Date(window.to).getTime(), rangeStartMs, rangeEndMs);
  }, 0);

  return Math.max(0, grossMs - pausedMs - awayMs);
}

const MINUTE_MS = 60_000;

function cloneShift(shift: ShiftState): ShiftState {
  return {
    ...shift,
    pauses: shift.pauses.map((pause) => ({ ...pause })),
    manualAwayNote: shift.manualAwayNote ? { ...shift.manualAwayNote } : undefined,
    awayWindows: shift.awayWindows.map((window) => ({ ...window }))
  };
}

export function createSessionKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

export function createShift(now: Date): ShiftState {
  return {
    startedAt: now.toISOString(),
    currentStatus: "working",
    totalPausedMs: 0,
    pauses: [],
    awayWindows: []
  };
}

export function startOrResumeShift(existing: ShiftState | undefined, now: Date): { shift: ShiftState; mode: "started" | "resumed" | "noop" } {
  if (!existing) {
    return {
      shift: createShift(now),
      mode: "started"
    };
  }

  if (existing.currentStatus === "working") {
    return {
      shift: cloneShift(existing),
      mode: "noop"
    };
  }

  const shift = cloneShift(existing);

  if (shift.pauseStartedAt) {
    shift.totalPausedMs += Math.max(0, now.getTime() - new Date(shift.pauseStartedAt).getTime());
    const lastPause = shift.pauses[shift.pauses.length - 1];
    if (lastPause && !lastPause.endedAt) {
      lastPause.endedAt = now.toISOString();
    }
  }

  shift.currentStatus = "working";
  delete shift.pauseStartedAt;
  delete shift.manualAwayNote;

  return { shift, mode: "resumed" };
}

export function setPausedStatus(
  existing: ShiftState | undefined,
  status: Exclude<WorkStatus, "working">,
  now: Date,
  note?: string
): { shift?: ShiftState; mode: "paused" | "switched" | "noop" | "missing" } {
  if (!existing) {
    return { mode: "missing" };
  }

  const shift = cloneShift(existing);

  if (shift.currentStatus === status) {
    return { shift, mode: "noop" };
  }

  if (shift.currentStatus === "working") {
    shift.pauseStartedAt = now.toISOString();
    shift.pauses.push({
      status,
      startedAt: now.toISOString(),
      note
    });
    shift.currentStatus = status;
    return { shift, mode: "paused" };
  }

  const lastPause = shift.pauses[shift.pauses.length - 1];
  if (lastPause) {
    lastPause.status = status;
    if (note) {
      lastPause.note = note;
    }
  } else {
    shift.pauses.push({
      status,
      startedAt: shift.pauseStartedAt ?? now.toISOString(),
      note
    });
  }

  shift.currentStatus = status;
  return { shift, mode: "switched" };
}

export function attachManualAwayNote(shift: ShiftState, manualAwayNote: ManualAwayNote): ShiftState {
  return {
    ...cloneShift(shift),
    manualAwayNote
  };
}

export function addAwayWindow(shift: ShiftState, awayWindow: AwayWindow): ShiftState {
  const next = cloneShift(shift);
  next.awayWindows.push({ ...awayWindow });
  next.awayWindows.sort((left, right) => new Date(left.from).getTime() - new Date(right.from).getTime());
  next.manualAwayNote = {
    from: awayWindow.from,
    to: awayWindow.to,
    note: awayWindow.note,
    createdAt: awayWindow.createdAt
  };
  return next;
}

export function trimActiveAwayWindow(shift: ShiftState, now: Date): ShiftState {
  const next = cloneShift(shift);
  const nowMs = now.getTime();

  next.awayWindows = next.awayWindows.map((window) => {
    const from = new Date(window.from).getTime();
    const to = new Date(window.to).getTime();

    if (from <= nowMs && nowMs < to) {
      return {
        ...window,
        to: now.toISOString()
      };
    }

    return window;
  });

  const upcoming = next.awayWindows.find((window) => new Date(window.to).getTime() > nowMs);
  next.manualAwayNote = upcoming
    ? {
        from: upcoming.from,
        to: upcoming.to,
        note: upcoming.note,
        createdAt: upcoming.createdAt
      }
    : undefined;

  return next;
}

function calculateExcludedMsInRange(
  startedAtIso: string,
  endedAtIso: string,
  pauses: PauseRecord[],
  awayWindows: AwayWindow[],
  rangeStart: Date,
  rangeEnd: Date
): number {
  const grossMs = intersectMs(
    new Date(startedAtIso).getTime(),
    new Date(endedAtIso).getTime(),
    rangeStart.getTime(),
    rangeEnd.getTime()
  );
  const workedMs = calculateWorkedMsInRange(startedAtIso, endedAtIso, pauses, awayWindows, rangeStart, rangeEnd);
  return Math.max(0, grossMs - workedMs);
}

export function summarizeShift(shift: ShiftState, now: Date): ShiftSummary {
  const totalElapsedMs = Math.max(0, now.getTime() - new Date(shift.startedAt).getTime());
  const workedMs = calculateWorkedMsInRange(shift.startedAt, now.toISOString(), shift.pauses, shift.awayWindows, new Date(shift.startedAt), now);
  const totalPausedMs = calculateExcludedMsInRange(
    shift.startedAt,
    now.toISOString(),
    shift.pauses,
    shift.awayWindows,
    new Date(shift.startedAt),
    now
  );

  return {
    totalElapsedMs,
    totalPausedMs,
    workedMs
  };
}

export function endShift(existing: ShiftState | undefined, now: Date): { summary?: ShiftSummary; shift?: ShiftState } {
  if (!existing) {
    return {};
  }

  const shift = cloneShift(existing);
  if (shift.pauseStartedAt) {
    shift.totalPausedMs += Math.max(0, now.getTime() - new Date(shift.pauseStartedAt).getTime());
    const lastPause = shift.pauses[shift.pauses.length - 1];
    if (lastPause && !lastPause.endedAt) {
      lastPause.endedAt = now.toISOString();
    }
    delete shift.pauseStartedAt;
  }

  return {
    shift,
    summary: summarizeShift(shift, now)
  };
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / MINUTE_MS));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}분`;
  }

  if (minutes === 0) {
    return `${hours}시간`;
  }

  return `${hours}시간 ${minutes}분`;
}

export function getStatusLabel(status: WorkStatus): string {
  switch (status) {
    case "working":
      return "근무 중";
    case "break":
      return "잠시 자리 비움";
    case "lunch":
      return "식사 중";
    case "manual":
      return "일정상 부재";
    default:
      return "상태 확인 중";
  }
}

export function getStatusEmoji(status: WorkStatus): string {
  switch (status) {
    case "working":
      return "🟢";
    case "break":
      return "☕";
    case "lunch":
      return "🍽️";
    case "manual":
      return "📅";
    default:
      return "ℹ️";
  }
}

export function getActiveAwayWindow(shift: ShiftState, now: Date): AwayWindow | undefined {
  const nowMs = now.getTime();
  return shift.awayWindows.find((window) => {
    const from = new Date(window.from).getTime();
    const to = new Date(window.to).getTime();
    return from <= nowMs && nowMs < to;
  });
}

export function getEffectiveStatus(shift: ShiftState, now: Date): WorkStatus {
  return getActiveAwayWindow(shift, now) ? "manual" : shift.currentStatus;
}

export function isManualInputReply(session: UserSession, replyToMessageId?: number): boolean {
  return Boolean(session.pendingManual && replyToMessageId === session.pendingManual.promptMessageId);
}

export interface ParsedManualInput {
  from: Date;
  to: Date;
  note?: string;
}

function withTimeOnDate(baseDate: Date, timeText: string): Date | undefined {
  const match = timeText.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return undefined;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    return undefined;
  }

  const value = new Date(baseDate);
  value.setHours(hours, minutes, 0, 0);
  return value;
}

function parseDateTime(input: string, baseDate: Date): Date | undefined {
  const normalized = input.trim();
  if (/^\d{1,2}:\d{2}$/.test(normalized)) {
    return withTimeOnDate(baseDate, normalized);
  }

  const isoLike = normalized.replace(" ", "T");
  const date = new Date(isoLike);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date;
}

export function parseManualInput(input: string, now: Date): ParsedManualInput | undefined {
  const trimmed = input.trim();
  const fullDateMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})\s*(?:-|~|to)\s*(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})(?:\s+(.*))?$/i
  );
  const sameDayMatch = trimmed.match(
    /^(\d{1,2}:\d{2})\s*(?:-|~|to)\s*(\d{1,2}:\d{2})(?:\s+(.*))?$/i
  );

  const groups = fullDateMatch ?? sameDayMatch;
  if (!groups) {
    return undefined;
  }

  const from = parseDateTime(groups[1], now);
  const to = parseDateTime(groups[2], now);
  const note = groups[3]?.trim() || undefined;

  if (!from || !to) {
    return undefined;
  }

  if (to.getTime() <= from.getTime()) {
    return undefined;
  }

  return { from, to, note };
}

export function sortSessionsForTeamView(sessions: UserSession[]): UserSession[] {
  return [...sessions].sort((left, right) => {
    const leftWeight = left.shift?.currentStatus === "working" ? 0 : 1;
    const rightWeight = right.shift?.currentStatus === "working" ? 0 : 1;

    if (leftWeight !== rightWeight) {
      return leftWeight - rightWeight;
    }

    return left.displayName.localeCompare(right.displayName, "ko");
  });
}

export function findOpenPause(shift: ShiftState): PauseRecord | undefined {
  return [...shift.pauses].reverse().find((pause) => !pause.endedAt);
}

function getSeoulDateParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short"
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: weekdayMap[map.weekday] ?? 0
  };
}

function seoulDateKey(date: Date): string {
  const parts = getSeoulDateParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function startOfSeoulWeek(date: Date): Date {
  const parts = getSeoulDateParts(date);
  const daysFromMonday = (parts.weekday + 6) % 7;
  const anchorUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  const startUtc = anchorUtc - daysFromMonday * 24 * 60 * 60 * 1000;
  return new Date(startUtc);
}

export function getWeeklyReportContext(now: Date): {
  shouldSend: boolean;
  weekKey: string;
  windowStart: Date;
  windowEnd: Date;
} {
  const parts = getSeoulDateParts(now);
  const shouldSend = parts.weekday === 0 && parts.hour === 23 && parts.minute === 59;
  const windowStart = startOfSeoulWeek(now);
  const windowEnd = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999));

  return {
    shouldSend,
    weekKey: seoulDateKey(windowStart),
    windowStart,
    windowEnd
  };
}

export function aggregateWeeklyTotals(
  completedShifts: CompletedShiftRecord[],
  sessions: UserSession[],
  windowStart: Date,
  windowEnd: Date
): WeeklyMemberSummary[] {
  const totals = new Map<string, WeeklyMemberSummary>();

  const include = (chatId: number, userId: number, displayName: string, username: string | undefined, workedMs: number): void => {
    if (workedMs <= 0) {
      return;
    }

    const key = `${chatId}:${userId}`;
    const current = totals.get(key);
    if (current) {
      current.workedMs += workedMs;
      current.displayName = displayName;
      current.username = username;
      return;
    }

    totals.set(key, {
      chatId,
      userId,
      displayName,
      username,
      workedMs
    });
  };

  for (const record of completedShifts) {
    const workedMs = calculateWorkedMsInRange(record.startedAt, record.endedAt, record.pauses, record.awayWindows, windowStart, windowEnd);
    if (workedMs <= 0) {
      continue;
    }

    include(record.chatId, record.userId, record.displayName, record.username, workedMs);
  }

  for (const session of sessions) {
    if (!session.shift) {
      continue;
    }

    const startedAt = new Date(session.shift.startedAt);
    if (startedAt > windowEnd) {
      continue;
    }

    const cappedNow = windowEnd < new Date() ? windowEnd : new Date();
    const workedMs = calculateWorkedMsInRange(
      session.shift.startedAt,
      cappedNow.toISOString(),
      session.shift.pauses,
      session.shift.awayWindows,
      windowStart,
      windowEnd
    );
    include(session.chatId, session.userId, session.displayName, session.username, workedMs);
  }

  return [...totals.values()].sort((left, right) => {
    if (right.workedMs !== left.workedMs) {
      return right.workedMs - left.workedMs;
    }

    return left.displayName.localeCompare(right.displayName, "ko");
  });
}
