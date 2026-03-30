export type WorkStatus = "working" | "break" | "lunch" | "manual";

export interface PauseRecord {
  status: Exclude<WorkStatus, "working">;
  startedAt: string;
  endedAt?: string;
  note?: string;
}

export interface ManualAwayNote {
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
  manualAwayNote?: ManualAwayNote;
}

export interface PendingManualInput {
  promptMessageId: number;
  createdAt: string;
}

export interface UserSession {
  chatId: number;
  userId: number;
  displayName: string;
  username?: string;
  shift?: ShiftState;
  pendingManual?: PendingManualInput;
  updatedAt: string;
}

export interface BotState {
  sessions: Record<string, UserSession>;
}
