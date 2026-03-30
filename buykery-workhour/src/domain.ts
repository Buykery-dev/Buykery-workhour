import type { ManualAwayNote, PauseRecord, ShiftState, UserSession, WorkStatus } from "./types.js";

export interface ShiftSummary {
  totalElapsedMs: number;
  totalPausedMs: number;
  workedMs: number;
}

const MINUTE_MS = 60_000;

function cloneShift(shift: ShiftState): ShiftState {
  return {
    ...shift,
    pauses: shift.pauses.map((pause) => ({ ...pause })),
    manualAwayNote: shift.manualAwayNote ? { ...shift.manualAwayNote } : undefined
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
    pauses: []
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

export function summarizeShift(shift: ShiftState, now: Date): ShiftSummary {
  const startedAt = new Date(shift.startedAt).getTime();
  const currentPauseMs = shift.pauseStartedAt ? Math.max(0, now.getTime() - new Date(shift.pauseStartedAt).getTime()) : 0;
  const totalElapsedMs = Math.max(0, now.getTime() - startedAt);
  const totalPausedMs = shift.totalPausedMs + currentPauseMs;
  const workedMs = Math.max(0, totalElapsedMs - totalPausedMs);

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
