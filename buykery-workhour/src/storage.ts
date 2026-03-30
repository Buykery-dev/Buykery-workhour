import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BotState, CompletedShiftRecord, UserSession } from "./types.js";

const INITIAL_STATE: BotState = { sessions: {}, completedShifts: [], weeklyReports: {} };

export class FileStateStore {
  private readonly filePath: string;
  private state: BotState = INITIAL_STATE;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as BotState;
      this.state = {
        sessions: parsed.sessions ?? {},
        completedShifts: (parsed.completedShifts ?? []).map((record) => ({
          ...record,
          pauses: record.pauses ?? []
        })),
        weeklyReports: parsed.weeklyReports ?? {}
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }

      this.state = { sessions: {}, completedShifts: [], weeklyReports: {} };
      await this.save();
    }
  }

  getSession(key: string): UserSession | undefined {
    const session = this.state.sessions[key];
    return session ? structuredClone(session) : undefined;
  }

  getSessionsByChat(chatId: number): UserSession[] {
    return Object.values(this.state.sessions)
      .filter((session) => session.chatId === chatId)
      .map((session) => structuredClone(session));
  }

  getCompletedShiftsByChat(chatId: number): CompletedShiftRecord[] {
    return this.state.completedShifts
      .filter((record) => record.chatId === chatId)
      .map((record) => structuredClone(record));
  }

  getKnownChatIds(): number[] {
    const values = new Set<number>();

    for (const session of Object.values(this.state.sessions)) {
      values.add(session.chatId);
    }

    for (const record of this.state.completedShifts) {
      values.add(record.chatId);
    }

    return [...values];
  }

  async appendCompletedShift(record: CompletedShiftRecord): Promise<void> {
    this.state.completedShifts.push(structuredClone(record));
    await this.save();
  }

  getWeeklyReportMarker(chatId: number, weekKey: string): string | undefined {
    return this.state.weeklyReports[`${chatId}:${weekKey}`];
  }

  async markWeeklyReportSent(chatId: number, weekKey: string, sentAt: string): Promise<void> {
    this.state.weeklyReports[`${chatId}:${weekKey}`] = sentAt;
    await this.save();
  }

  async upsertSession(key: string, session: UserSession): Promise<void> {
    this.state.sessions[key] = structuredClone(session);
    await this.save();
  }

  async deleteSession(key: string): Promise<void> {
    delete this.state.sessions[key];
    await this.save();
  }

  private async save(): Promise<void> {
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
  }
}
