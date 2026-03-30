import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BotState, UserSession } from "./types.js";

const INITIAL_STATE: BotState = { sessions: {} };

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
        sessions: parsed.sessions ?? {}
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }

      this.state = { sessions: {} };
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
