export type WorkStatus = "working" | "break" | "lunch" | "manual" | "meeting" | "focus" | "outside";

export interface PauseRecord {
  status: Exclude<WorkStatus, "working">;
  startedAt: string;
  endedAt?: string;
  note?: string;
}

export interface FocusWindow {
  startedAt: string;
  endedAt?: string;
}

export interface ManualAwayNote {
  from: string;
  to: string;
  note?: string;
  createdAt: string;
}

export interface AwayWindow {
  from: string;
  to: string;
  note?: string;
  createdAt: string;
}

export interface ShiftState {
  startedAt: string;
  currentStatus: WorkStatus;
  pauseStartedAt?: string;
  totalPausedMs: number;
  pauses: PauseRecord[];
  focusWindows: FocusWindow[];
  manualAwayNote?: ManualAwayNote;
  awayWindows: AwayWindow[];
}

export interface PendingManualInput {
  promptMessageId: number;
  createdAt: string;
}

export interface PendingEditInput {
  step: "date" | "worked" | "start" | "end" | "break";
  promptMessageId: number;
  createdAt: string;
  selectedDate?: string;
  startTime?: string;
  endTime?: string;
}

export interface UserSession {
  chatId: number;
  userId: number;
  displayName: string;
  username?: string;
  shift?: ShiftState;
  lastStatusMessageId?: number;
  focusPraiseMessageId?: number;
  focusPraiseLastHour?: number;
  pendingManual?: PendingManualInput;
  pendingEdit?: PendingEditInput;
  updatedAt: string;
}

export interface CompletedShiftRecord {
  chatId: number;
  userId: number;
  displayName: string;
  username?: string;
  startedAt: string;
  endedAt: string;
  workedMs: number;
  focusMs: number;
  pausedMs: number;
  pauses: PauseRecord[];
  focusWindows: FocusWindow[];
  awayWindows: AwayWindow[];
}

export interface BotState {
  sessions: Record<string, UserSession>;
  completedShifts: CompletedShiftRecord[];
  weeklyReports: Record<string, string>;
  deploymentNotices: Record<string, string>;
}
