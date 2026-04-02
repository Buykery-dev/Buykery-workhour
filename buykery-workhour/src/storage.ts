import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSeoulDateKey } from "./domain.js";
import type { BotState, CompletedShiftRecord, UserSession } from "./types.js";

const INITIAL_STATE: BotState = { sessions: {}, completedShifts: [], weeklyReports: {} };

type EventOperation = "upsert" | "delete";
type EventEntity = "session" | "completed_shift" | "weekly_report";

interface CsvEventRow {
  occurredAt: string;
  entity: EventEntity;
  entityKey: string;
  operation: EventOperation;
  payloadJson: string;
}

function escapeCsv(value: string): string {
  const escaped = value.replaceAll("\"", "\"\"");
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inQuotes) {
      if (char === "\"" && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function completedShiftKey(record: CompletedShiftRecord): string {
  return `${record.chatId}:${record.userId}:${getSeoulDateKey(new Date(record.startedAt))}`;
}

function eventRowToLine(row: CsvEventRow): string {
  return [
    row.occurredAt,
    row.entity,
    row.entityKey,
    row.operation,
    row.payloadJson
  ]
    .map(escapeCsv)
    .join(",");
}

function lineToEventRow(line: string): CsvEventRow | undefined {
  const values = parseCsvLine(line);
  if (values.length !== 5) {
    return undefined;
  }

  return {
    occurredAt: values[0],
    entity: values[1] as EventEntity,
    entityKey: values[2],
    operation: values[3] as EventOperation,
    payloadJson: values[4]
  };
}

function normalizeSession(session: UserSession): UserSession {
  return {
    ...session,
    shift: session.shift
      ? {
          ...session.shift,
          awayWindows: session.shift.awayWindows ?? []
        }
      : undefined,
    pendingEdit: session.pendingEdit ? { ...session.pendingEdit } : undefined
  };
}

function normalizeCompletedShift(record: CompletedShiftRecord): CompletedShiftRecord {
  return {
    ...record,
    pauses: record.pauses ?? [],
    awayWindows: record.awayWindows ?? []
  };
}

export class FileStateStore {
  private readonly filePath: string;
  private readonly legacyJsonPath: string;
  private state: BotState = INITIAL_STATE;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.legacyJsonPath = path.join(path.dirname(filePath), "state.json");
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.state = this.rebuildState(raw);
      return;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }

    const migrated = await this.tryMigrateLegacyJson();
    if (migrated) {
      return;
    }

    this.state = { sessions: {}, completedShifts: [], weeklyReports: {} };
    await this.flushAll();
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
    const normalized = normalizeCompletedShift(record);
    this.state.completedShifts.push(structuredClone(normalized));
    await this.appendEvent({
      occurredAt: new Date().toISOString(),
      entity: "completed_shift",
      entityKey: completedShiftKey(normalized),
      operation: "upsert",
      payloadJson: JSON.stringify(normalized)
    });
  }

  async upsertCompletedShift(
    matcher: (record: CompletedShiftRecord) => boolean,
    nextRecord: CompletedShiftRecord
  ): Promise<void> {
    const normalized = normalizeCompletedShift(nextRecord);
    const index = this.state.completedShifts.findIndex(matcher);
    if (index >= 0) {
      this.state.completedShifts[index] = structuredClone(normalized);
    } else {
      this.state.completedShifts.push(structuredClone(normalized));
    }

    await this.appendEvent({
      occurredAt: new Date().toISOString(),
      entity: "completed_shift",
      entityKey: completedShiftKey(normalized),
      operation: "upsert",
      payloadJson: JSON.stringify(normalized)
    });
  }

  async deleteCompletedShifts(matcher: (record: CompletedShiftRecord) => boolean): Promise<void> {
    const removing = this.state.completedShifts.filter(matcher);
    this.state.completedShifts = this.state.completedShifts.filter((record) => !matcher(record));

    for (const record of removing) {
      await this.appendEvent({
        occurredAt: new Date().toISOString(),
        entity: "completed_shift",
        entityKey: completedShiftKey(record),
        operation: "delete",
        payloadJson: ""
      });
    }
  }

  getWeeklyReportMarker(chatId: number, weekKey: string): string | undefined {
    return this.state.weeklyReports[`${chatId}:${weekKey}`];
  }

  async markWeeklyReportSent(chatId: number, weekKey: string, sentAt: string): Promise<void> {
    const entityKey = `${chatId}:${weekKey}`;
    this.state.weeklyReports[entityKey] = sentAt;
    await this.appendEvent({
      occurredAt: new Date().toISOString(),
      entity: "weekly_report",
      entityKey,
      operation: "upsert",
      payloadJson: JSON.stringify({ sentAt })
    });
  }

  async upsertSession(key: string, session: UserSession): Promise<void> {
    const normalized = normalizeSession(session);
    this.state.sessions[key] = structuredClone(normalized);
    await this.appendEvent({
      occurredAt: new Date().toISOString(),
      entity: "session",
      entityKey: key,
      operation: "upsert",
      payloadJson: JSON.stringify(normalized)
    });
  }

  async deleteSession(key: string): Promise<void> {
    delete this.state.sessions[key];
    await this.appendEvent({
      occurredAt: new Date().toISOString(),
      entity: "session",
      entityKey: key,
      operation: "delete",
      payloadJson: ""
    });
  }

  private rebuildState(rawCsv: string): BotState {
    const nextState: BotState = { sessions: {}, completedShifts: [], weeklyReports: {} };
    const completedShiftMap = new Map<string, CompletedShiftRecord>();

    for (const line of rawCsv.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("occurred_at,")) {
        continue;
      }

      const row = lineToEventRow(line);
      if (!row) {
        continue;
      }

      if (row.entity === "session") {
        if (row.operation === "delete") {
          delete nextState.sessions[row.entityKey];
        } else {
          nextState.sessions[row.entityKey] = normalizeSession(JSON.parse(row.payloadJson) as UserSession);
        }
        continue;
      }

      if (row.entity === "completed_shift") {
        if (row.operation === "delete") {
          completedShiftMap.delete(row.entityKey);
        } else {
          completedShiftMap.set(row.entityKey, normalizeCompletedShift(JSON.parse(row.payloadJson) as CompletedShiftRecord));
        }
        continue;
      }

      if (row.entity === "weekly_report") {
        if (row.operation === "delete") {
          delete nextState.weeklyReports[row.entityKey];
        } else {
          const payload = JSON.parse(row.payloadJson) as { sentAt: string };
          nextState.weeklyReports[row.entityKey] = payload.sentAt;
        }
      }
    }

    nextState.completedShifts = [...completedShiftMap.values()];
    return nextState;
  }

  private async appendEvent(row: CsvEventRow): Promise<void> {
    let existing = "";
    try {
      existing = await readFile(this.filePath, "utf-8");
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
      existing = "occurred_at,entity,entity_key,operation,payload_json\n";
    }

    const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
    await writeFile(this.filePath, `${prefix}${eventRowToLine(row)}\n`, "utf-8");
  }

  private async flushAll(): Promise<void> {
    const rows: CsvEventRow[] = [];
    const nowIso = new Date().toISOString();

    for (const [key, session] of Object.entries(this.state.sessions)) {
      rows.push({
        occurredAt: nowIso,
        entity: "session",
        entityKey: key,
        operation: "upsert",
        payloadJson: JSON.stringify(normalizeSession(session))
      });
    }

    for (const record of this.state.completedShifts) {
      rows.push({
        occurredAt: nowIso,
        entity: "completed_shift",
        entityKey: completedShiftKey(record),
        operation: "upsert",
        payloadJson: JSON.stringify(normalizeCompletedShift(record))
      });
    }

    for (const [key, sentAt] of Object.entries(this.state.weeklyReports)) {
      rows.push({
        occurredAt: nowIso,
        entity: "weekly_report",
        entityKey: key,
        operation: "upsert",
        payloadJson: JSON.stringify({ sentAt })
      });
    }

    const contents = [
      "occurred_at,entity,entity_key,operation,payload_json",
      ...rows.map(eventRowToLine)
    ].join("\n");

    await writeFile(this.filePath, `${contents}\n`, "utf-8");
  }

  private async tryMigrateLegacyJson(): Promise<boolean> {
    try {
      const raw = await readFile(this.legacyJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as BotState;
      this.state = {
        sessions: Object.fromEntries(
          Object.entries(parsed.sessions ?? {}).map(([key, session]) => [key, normalizeSession(session as UserSession)])
        ),
        completedShifts: (parsed.completedShifts ?? []).map((record) => normalizeCompletedShift(record as CompletedShiftRecord)),
        weeklyReports: parsed.weeklyReports ?? {}
      };
      await this.flushAll();
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}
