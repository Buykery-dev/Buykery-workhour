import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregateWeeklyTotals,
  buildManualEditPayload,
  buildManualEditPayloadWithBreak,
  buildManualWorkedDurationPayload,
  calculateWorkedMsInRange,
  createShift,
  endShift,
  getCurrentWeekContext,
  getWeeklyReportContext,
  parseBreakMinutesInput,
  parseClockTime,
  parseEditDateInput,
  parseManualInput,
  parseWorkedDurationInput,
  setFocusStatus,
  setPausedStatus,
  startOrResumeShift
} from "../src/domain.js";
import { createBot } from "../src/bot.js";
import { sendDeploymentNotice } from "../src/deployment.js";
import { buildEndMessage, buildFocusPraiseMessage, buildPauseMessage, buildStartMessage, buildWeeklySummaryMessage } from "../src/messages.js";
import { runFocusPraiseSweep } from "../src/scheduler.js";
import { FileStateStore } from "../src/storage.js";

function mockBotTelegramCallApi(
  bot: ReturnType<typeof createBot>,
  handler: (...args: unknown[]) => Promise<unknown>
): () => void {
  const prototype = Object.getPrototypeOf(bot.telegram) as {
    callApi: (...args: unknown[]) => Promise<unknown>;
  };
  const original = prototype.callApi;
  prototype.callApi = async function (...args: unknown[]): Promise<unknown> {
    return handler(...args);
  };

  return () => {
    prototype.callApi = original;
  };
}

test("break time is excluded from worked duration", () => {
  const start = new Date("2026-03-30T09:00:00+09:00");
  const shift = createShift(start);

  const paused = setPausedStatus(shift, "break", new Date("2026-03-30T12:00:00+09:00"));
  assert.ok(paused.shift);

  const resumed = startOrResumeShift(paused.shift, new Date("2026-03-30T12:30:00+09:00"));
  const ended = endShift(resumed.shift, new Date("2026-03-30T18:00:00+09:00"));

  assert.ok(ended.summary);
  assert.equal(ended.summary?.workedMs, 8.5 * 60 * 60 * 1000);
});

test("focus time is included in worked duration and tracked separately", () => {
  const shift = createShift(new Date("2026-03-30T09:00:00+09:00"));

  const focused = setFocusStatus(shift, new Date("2026-03-30T10:00:00+09:00"));
  assert.equal(focused.mode, "focused");
  assert.ok(focused.shift);

  const resumed = startOrResumeShift(focused.shift, new Date("2026-03-30T12:00:00+09:00"));
  assert.equal(resumed.mode, "resumed");

  const ended = endShift(resumed.shift, new Date("2026-03-30T17:00:00+09:00"));
  assert.ok(ended.summary);
  assert.equal(ended.summary?.workedMs, 8 * 60 * 60 * 1000);
  assert.equal(ended.summary?.focusMs, 2 * 60 * 60 * 1000);
});

test("focus cannot start while lunching before returning with back", () => {
  const shift = createShift(new Date("2026-03-30T09:00:00+09:00"));
  const lunch = setPausedStatus(shift, "lunch", new Date("2026-03-30T12:00:00+09:00"));
  assert.ok(lunch.shift);

  const focused = setFocusStatus(lunch.shift, new Date("2026-03-30T12:10:00+09:00"));
  assert.equal(focused.mode, "blocked");
  assert.equal(focused.blockingStatus, "lunch");
  assert.equal(focused.shift?.currentStatus, "lunch");
});

test("focus time excludes overlapping manual away windows", () => {
  const shift = createShift(new Date("2026-03-30T09:00:00+09:00"));
  const focused = setFocusStatus(shift, new Date("2026-03-30T10:00:00+09:00"));
  assert.ok(focused.shift);

  focused.shift.awayWindows.push({
    from: "2026-03-30T02:00:00.000Z",
    to: "2026-03-30T03:00:00.000Z",
    createdAt: "2026-03-30T02:00:00.000Z"
  });

  const ended = endShift(focused.shift, new Date("2026-03-30T13:00:00+09:00"));
  assert.equal(ended.summary?.workedMs, 3 * 60 * 60 * 1000);
  assert.equal(ended.summary?.focusMs, 2 * 60 * 60 * 1000);
});

test("meeting and outside return with back and are excluded from worked duration", () => {
  for (const status of ["meeting", "outside"] as const) {
    const shift = createShift(new Date("2026-03-30T09:00:00+09:00"));
    const paused = setPausedStatus(shift, status, new Date("2026-03-30T10:00:00+09:00"));
    assert.ok(paused.shift);

    const resumed = startOrResumeShift(paused.shift, new Date("2026-03-30T11:00:00+09:00"));
    assert.equal(resumed.mode, "resumed");
    assert.equal(resumed.shift.currentStatus, "working");

    const ended = endShift(resumed.shift, new Date("2026-03-30T13:00:00+09:00"));
    assert.equal(ended.summary?.workedMs, 3 * 60 * 60 * 1000);
    assert.equal(ended.summary?.totalPausedMs, 60 * 60 * 1000);
  }
});

test("manual input parser accepts same-day ranges", () => {
  const parsed = parseManualInput("15:00-16:30 병원", new Date("2026-03-30T09:00:00+09:00"));
  assert.ok(parsed);
  assert.equal(parsed?.from.getHours(), 15);
  assert.equal(parsed?.to.getHours(), 16);
  assert.equal(parsed?.to.getMinutes(), 30);
  assert.equal(parsed?.note, "병원");
});

test("manual input parser accepts explicit dates", () => {
  const parsed = parseManualInput(
    "2026-03-30 15:00 - 2026-03-30 17:00 외근",
    new Date("2026-03-30T09:00:00+09:00")
  );

  assert.ok(parsed);
  assert.equal(parsed?.from.getDate(), 30);
  assert.equal(parsed?.from.getHours(), 15);
  assert.equal(parsed?.to.getHours(), 17);
  assert.equal(parsed?.note, "외근");
});

test("weekly report context fires on Monday after the Seoul week closes", () => {
  const context = getWeeklyReportContext(new Date("2026-03-29T15:00:00Z"));
  assert.equal(context.shouldSend, true);
  assert.equal(context.weekKey, "2026-03-23");
  assert.equal(context.windowStart.toISOString(), "2026-03-22T15:00:00.000Z");
  assert.equal(context.windowEnd.toISOString(), "2026-03-29T14:59:59.999Z");
});

test("weekly report context keeps retrying on Monday if not marked sent", () => {
  const context = getWeeklyReportContext(new Date("2026-03-30T05:30:00Z"));
  assert.equal(context.shouldSend, true);
  assert.equal(context.weekKey, "2026-03-23");
  assert.equal(context.windowStart.toISOString(), "2026-03-22T15:00:00.000Z");
  assert.equal(context.windowEnd.toISOString(), "2026-03-29T14:59:59.999Z");
});

test("weekly report context does not send before the Seoul week closes", () => {
  const context = getWeeklyReportContext(new Date("2026-03-29T14:59:00Z"));
  assert.equal(context.shouldSend, false);
  assert.equal(context.weekKey, "2026-03-16");
  assert.equal(context.windowStart.toISOString(), "2026-03-15T15:00:00.000Z");
  assert.equal(context.windowEnd.toISOString(), "2026-03-22T14:59:59.999Z");
});

test("current week context starts at Monday 00:00 in Seoul", () => {
  const context = getCurrentWeekContext(new Date("2026-03-25T03:00:00Z"));
  assert.equal(context.weekKey, "2026-03-23");
  assert.equal(context.windowStart.toISOString(), "2026-03-22T15:00:00.000Z");
  assert.equal(context.windowEnd.toISOString(), "2026-03-25T03:00:00.000Z");
});

test("weekly totals aggregate completed and active shifts", () => {
  const totals = aggregateWeeklyTotals(
    [
      {
        chatId: 1,
        userId: 10,
        displayName: "Han",
        startedAt: "2026-03-23T00:00:00.000Z",
        endedAt: "2026-03-25T09:00:00.000Z",
        workedMs: 3 * 60 * 60 * 1000,
        focusMs: 0,
        pausedMs: 0,
        pauses: [],
        focusWindows: [],
        awayWindows: []
      }
    ],
    [
      {
        chatId: 1,
        userId: 11,
        displayName: "Mina",
        updatedAt: "2026-03-29T08:00:00.000Z",
        shift: {
          startedAt: "2026-03-29T00:00:00.000Z",
          currentStatus: "working",
          totalPausedMs: 0,
          pauses: [],
          focusWindows: [],
          awayWindows: []
        }
      }
    ],
    new Date("2026-03-23T00:00:00.000Z"),
    new Date("2026-03-29T14:59:59.999Z")
  );

  assert.equal(totals.length, 2);
  assert.equal(totals[0]?.displayName, "Han");
  assert.ok((totals[0]?.workedMs ?? 0) > (totals[1]?.workedMs ?? 0));
  assert.equal(totals[1]?.displayName, "Mina");
});

test("weekly totals include early Monday hours in Seoul week", () => {
  const totals = aggregateWeeklyTotals(
    [
      {
        chatId: 1,
        userId: 10,
        displayName: "Han",
        startedAt: "2026-03-22T15:30:00.000Z",
        endedAt: "2026-03-22T16:30:00.000Z",
        workedMs: 60 * 60 * 1000,
        focusMs: 0,
        pausedMs: 0,
        pauses: [],
        focusWindows: [],
        awayWindows: []
      }
    ],
    [],
    new Date("2026-03-22T15:00:00.000Z"),
    new Date("2026-03-29T14:59:59.999Z")
  );

  assert.equal(totals[0]?.workedMs, 60 * 60 * 1000);
});

test("weekly totals and report message show focus time separately", () => {
  const totals = aggregateWeeklyTotals(
    [
      {
        chatId: 1,
        userId: 10,
        displayName: "Han",
        startedAt: "2026-03-23T00:00:00.000Z",
        endedAt: "2026-03-23T08:00:00.000Z",
        workedMs: 8 * 60 * 60 * 1000,
        focusMs: 2 * 60 * 60 * 1000,
        pausedMs: 0,
        pauses: [],
        focusWindows: [
          {
            startedAt: "2026-03-23T01:00:00.000Z",
            endedAt: "2026-03-23T03:00:00.000Z"
          }
        ],
        awayWindows: []
      }
    ],
    [],
    new Date("2026-03-23T00:00:00.000Z"),
    new Date("2026-03-29T14:59:59.999Z")
  );

  assert.equal(totals[0]?.workedMs, 8 * 60 * 60 * 1000);
  assert.equal(totals[0]?.focusMs, 2 * 60 * 60 * 1000);

  const message = buildWeeklySummaryMessage("3. 23. ~ 3. 29.", totals);
  assert.match(message, /근무 <b>8시간<\/b> \/ 집중 <b>2시간<\/b>/);
});

test("focus praise message changes tone for long focus sessions", () => {
  const early = buildFocusPraiseMessage("Han", 1, 0);
  const late = buildFocusPraiseMessage("Han", 24, 0);

  assert.match(early, /집중 근무 1시간/);
  assert.match(late, /건강이 먼저/);
});

test("worked time in range excludes pauses and clips by window", () => {
  const workedMs = calculateWorkedMsInRange(
    "2026-03-22T23:00:00.000Z",
    "2026-03-23T03:00:00.000Z",
    [
      {
        status: "break",
        startedAt: "2026-03-23T01:00:00.000Z",
        endedAt: "2026-03-23T01:30:00.000Z"
      }
    ],
    [],
    new Date("2026-03-23T00:00:00.000Z"),
    new Date("2026-03-23T02:00:00.000Z")
  );

  assert.equal(workedMs, 90 * 60 * 1000);
});

test("worked time in range excludes manual away windows", () => {
  const workedMs = calculateWorkedMsInRange(
    "2026-03-23T00:00:00.000Z",
    "2026-03-23T04:00:00.000Z",
    [],
    [
      {
        from: "2026-03-23T01:00:00.000Z",
        to: "2026-03-23T02:30:00.000Z",
        note: "병원",
        createdAt: "2026-03-23T00:30:00.000Z"
      }
    ],
    new Date("2026-03-23T00:00:00.000Z"),
    new Date("2026-03-23T04:00:00.000Z")
  );

  assert.equal(workedMs, 150 * 60 * 1000);
});

test("edit date parser accepts mm-dd shorthand in Seoul", () => {
  const parsed = parseEditDateInput("04-02", new Date("2026-04-02T03:00:00+09:00"));
  assert.equal(parsed, "2026-04-02");
});

test("manual edit payload builds work duration", () => {
  assert.equal(parseClockTime("9:05"), "09:05");
  const payload = buildManualEditPayload("2026-04-02", "09:00", "18:30");
  assert.ok(payload);
  assert.equal(payload?.endDateKey, "2026-04-02");
  assert.equal(payload?.workedMs, 9.5 * 60 * 60 * 1000);
});

test("manual edit payload supports overnight end times", () => {
  const payload = buildManualEditPayload("2026-04-02", "22:00", "08:30");
  assert.ok(payload);
  assert.equal(payload?.endDateKey, "2026-04-03");
  assert.equal(payload?.endedAt, "2026-04-03T08:30:00+09:00");
  assert.equal(payload?.workedMs, 10.5 * 60 * 60 * 1000);
});

test("manual edit payload rolls overnight end time into next month", () => {
  const payload = buildManualEditPayload("2026-04-30", "23:30", "01:00");
  assert.ok(payload);
  assert.equal(payload?.endDateKey, "2026-05-01");
  assert.equal(payload?.endedAt, "2026-05-01T01:00:00+09:00");
});

test("manual edit payload rolls overnight end time into next year", () => {
  const payload = buildManualEditPayload("2026-12-31", "23:30", "01:00");
  assert.ok(payload);
  assert.equal(payload?.endDateKey, "2027-01-01");
  assert.equal(payload?.endedAt, "2027-01-01T01:00:00+09:00");
});

test("manual edit payload applies break minutes", () => {
  assert.equal(parseBreakMinutesInput("1:30"), 90);
  const payload = buildManualEditPayloadWithBreak("2026-04-02", "09:00", "18:30", 90);
  assert.ok(payload);
  assert.equal(payload?.pausedMs, 90 * 60 * 1000);
  assert.equal(payload?.workedMs, 8 * 60 * 60 * 1000);
});

test("manual edit payload applies break minutes across midnight", () => {
  const payload = buildManualEditPayloadWithBreak("2026-04-02", "22:00", "08:30", 60);
  assert.ok(payload);
  assert.equal(payload?.pausedMs, 60 * 60 * 1000);
  assert.equal(payload?.workedMs, 9.5 * 60 * 60 * 1000);
});

test("manual edit payload rejects zero-length shifts", () => {
  const payload = buildManualEditPayload("2026-04-02", "09:00", "09:00");
  assert.equal(payload, undefined);
});

test("manual edit payload rejects breaks longer than overnight shift", () => {
  const payload = buildManualEditPayloadWithBreak("2026-04-02", "23:00", "00:30", 120);
  assert.equal(payload, undefined);
});

test("worked duration parser accepts hour and clock formats", () => {
  assert.equal(parseWorkedDurationInput("8"), 480);
  assert.equal(parseWorkedDurationInput("8.5"), 510);
  assert.equal(parseWorkedDurationInput("8:30"), 510);
});

test("manual worked duration payload stores total hours on selected date", () => {
  const payload = buildManualWorkedDurationPayload("2026-04-02", 510);
  assert.ok(payload);
  assert.equal(payload?.dateKey, "2026-04-02");
  assert.equal(payload?.workedMs, 8.5 * 60 * 60 * 1000);
});

test("manual worked duration payload rejects more than 24 hours", () => {
  assert.equal(buildManualWorkedDurationPayload("2026-04-02", 24 * 60 + 1), undefined);
});

test("weekend start message includes weekend notice in Seoul", () => {
  const message = buildStartMessage("<b>Han</b>", new Date("2026-04-04T01:00:00Z"), "started");
  assert.match(message, /주말에 출근이라니/);
});

test("weekend end message includes weekend closing note in Seoul", () => {
  const message = buildEndMessage(
    "<b>Han</b>",
    { totalElapsedMs: 2 * 60 * 60 * 1000, totalPausedMs: 0, workedMs: 2 * 60 * 60 * 1000, focusMs: 0 },
    new Date("2026-04-05T02:00:00Z")
  );
  assert.match(message, /남은 주말 알차게, 행복하게 보내세요/);
});

test("pause message uses natural lunch wording", () => {
  const message = buildPauseMessage("Hanvenue", "lunch", "paused");
  assert.match(message, /현재 상태는 <b>식사 중<\/b>이에요/);
  assert.doesNotMatch(message, /식사 중로/);
});

test("/밥 alias switches status to lunch", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "buykery-workhour-"));
  let restoreCallApi: (() => void) | undefined;

  try {
    const store = new FileStateStore(path.join(tempDir, "events.csv"));
    await store.load();

    await store.upsertSession("100:200", {
      chatId: 100,
      userId: 200,
      displayName: "Han",
      username: "han",
      shift: {
        startedAt: "2026-04-02T13:00:00.000Z",
        currentStatus: "working",
        totalPausedMs: 0,
        pauses: [],
        focusWindows: [],
        awayWindows: []
      },
      updatedAt: "2026-04-02T13:00:00.000Z"
    });

    const bot = createBot("test-token", store);
    restoreCallApi = mockBotTelegramCallApi(bot, async (...args: unknown[]) => {
      if (args[0] === "sendMessage") {
        return { message_id: 777 };
      }
      return true;
    });
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };
    Object.defineProperty(bot.context, "telegram", { value: bot.telegram });
    bot.context.reply = async () => ({ message_id: 777 } as never);
    bot.context.answerCbQuery = async () => true as never;

    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        date: Math.floor(new Date("2026-04-02T13:20:00+09:00").getTime() / 1000),
        text: "/밥",
        chat: {
          id: 100,
          type: "group",
          title: "QA"
        },
        from: {
          id: 200,
          is_bot: false,
          first_name: "Han",
          username: "han"
        }
      }
    });

    const session = store.getSession("100:200");
    assert.equal(session?.shift?.currentStatus, "lunch");
  } finally {
    restoreCallApi?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("/bab alias switches status to lunch", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "buykery-workhour-"));
  let restoreCallApi: (() => void) | undefined;

  try {
    const store = new FileStateStore(path.join(tempDir, "events.csv"));
    await store.load();

    await store.upsertSession("100:200", {
      chatId: 100,
      userId: 200,
      displayName: "Han",
      username: "han",
      shift: {
        startedAt: "2026-04-02T13:00:00.000Z",
        currentStatus: "working",
        totalPausedMs: 0,
        pauses: [],
        focusWindows: [],
        awayWindows: []
      },
      updatedAt: "2026-04-02T13:00:00.000Z"
    });

    const bot = createBot("test-token", store);
    restoreCallApi = mockBotTelegramCallApi(bot, async (...args: unknown[]) => {
      if (args[0] === "sendMessage") {
        return { message_id: 777 };
      }
      return true;
    });
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };
    Object.defineProperty(bot.context, "telegram", { value: bot.telegram });
    bot.context.reply = async () => ({ message_id: 777 } as never);
    bot.context.answerCbQuery = async () => true as never;

    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 12,
        date: Math.floor(new Date("2026-04-02T13:20:00+09:00").getTime() / 1000),
        text: "/bab",
        chat: {
          id: 100,
          type: "group",
          title: "QA"
        },
        from: {
          id: 200,
          is_bot: false,
          first_name: "Han",
          username: "han"
        },
        entities: [{ type: "bot_command", offset: 0, length: 4 }]
      }
    });

    const session = store.getSession("100:200");
    assert.equal(session?.shift?.currentStatus, "lunch");
  } finally {
    restoreCallApi?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("status card is re-sent on updates and cleared on /end", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "buykery-workhour-"));
  let restoreCallApi: (() => void) | undefined;

  try {
    const store = new FileStateStore(path.join(tempDir, "events.csv"));
    await store.load();

    const calls: string[] = [];
    let nextMessageId = 500;
    const bot = createBot("test-token", store);
    restoreCallApi = mockBotTelegramCallApi(bot, async (...args: unknown[]) => {
      const method = String(args[0]);
      calls.push(method);
      if (method === "sendMessage") {
        return { message_id: nextMessageId++ };
      }
      return true;
    });
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };
    Object.defineProperty(bot.context, "telegram", { value: bot.telegram });
    bot.context.reply = async () => {
      calls.push("reply");
      return { message_id: nextMessageId++ } as never;
    };
    bot.context.answerCbQuery = async () => true as never;

    await bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 21,
        date: Math.floor(new Date("2026-04-02T09:00:00+09:00").getTime() / 1000),
        text: "/start",
        chat: {
          id: 100,
          type: "group",
          title: "QA"
        },
        from: {
          id: 200,
          is_bot: false,
          first_name: "Han",
          username: "han"
        },
        entities: [{ type: "bot_command", offset: 0, length: 6 }]
      }
    });

    let session = store.getSession("100:200");
    assert.equal(session?.lastStatusMessageId, 500);

    await bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 22,
        date: Math.floor(new Date("2026-04-02T12:00:00+09:00").getTime() / 1000),
        text: "/stop",
        chat: {
          id: 100,
          type: "group",
          title: "QA"
        },
        from: {
          id: 200,
          is_bot: false,
          first_name: "Han",
          username: "han"
        },
        entities: [{ type: "bot_command", offset: 0, length: 5 }]
      }
    });

    session = store.getSession("100:200");
    assert.equal(session?.lastStatusMessageId, 501);
    assert.equal(session?.shift?.currentStatus, "break");
    assert.equal(calls.filter((method) => method === "reply").length, 2);
    assert.ok(calls.includes("deleteMessage"));

    await bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 23,
        date: Math.floor(new Date("2026-04-02T18:00:00+09:00").getTime() / 1000),
        text: "/end",
        chat: {
          id: 100,
          type: "group",
          title: "QA"
        },
        from: {
          id: 200,
          is_bot: false,
          first_name: "Han",
          username: "han"
        },
        entities: [{ type: "bot_command", offset: 0, length: 4 }]
      }
    });

    session = store.getSession("100:200");
    assert.equal(session?.lastStatusMessageId, undefined);
    assert.equal(session?.shift, undefined);
    assert.equal(calls.filter((method) => method === "deleteMessage").length, 2);
  } finally {
    restoreCallApi?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("focus praise sweep sends hourly praise and replaces previous message", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "buykery-workhour-"));

  try {
    const store = new FileStateStore(path.join(tempDir, "events.csv"));
    await store.load();

    await store.upsertSession("100:200", {
      chatId: 100,
      userId: 200,
      displayName: "Han",
      username: "han",
      shift: {
        startedAt: "2026-04-20T00:00:00.000Z",
        currentStatus: "focus",
        totalPausedMs: 0,
        pauses: [],
        focusWindows: [{ startedAt: "2026-04-20T01:00:00.000Z" }],
        awayWindows: []
      },
      updatedAt: "2026-04-20T01:00:00.000Z"
    });

    const sentMessages: Array<{ chatId: number; text: string }> = [];
    const deletedMessages: Array<{ chatId: number; messageId: number }> = [];
    let nextMessageId = 900;
    const telegram = {
      sendMessage: async (chatId: number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: nextMessageId++, text, date: 0, chat: { id: chatId, type: "group", title: "QA" } } as never;
      },
      deleteMessage: async (chatId: number, messageId: number) => {
        deletedMessages.push({ chatId, messageId });
        return true as const;
      }
    };

    const firstCount = await runFocusPraiseSweep(telegram, store, new Date("2026-04-20T02:00:00.000Z"));
    const duplicateCount = await runFocusPraiseSweep(telegram, store, new Date("2026-04-20T02:30:00.000Z"));
    const secondCount = await runFocusPraiseSweep(telegram, store, new Date("2026-04-20T03:05:00.000Z"));

    const session = store.getSession("100:200");
    assert.equal(firstCount, 1);
    assert.equal(duplicateCount, 0);
    assert.equal(secondCount, 1);
    assert.equal(sentMessages.length, 2);
    assert.match(sentMessages[0]?.text ?? "", /1시간/);
    assert.match(sentMessages[1]?.text ?? "", /2시간/);
    assert.deepEqual(deletedMessages, [{ chatId: 100, messageId: 900 }]);
    assert.equal(session?.focusPraiseMessageId, 901);
    assert.equal(session?.focusPraiseLastHour, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("back from focus clears praise message", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "buykery-workhour-"));
  let restoreCallApi: (() => void) | undefined;

  try {
    const store = new FileStateStore(path.join(tempDir, "events.csv"));
    await store.load();

    await store.upsertSession("100:200", {
      chatId: 100,
      userId: 200,
      displayName: "Han",
      username: "han",
      shift: {
        startedAt: "2026-04-20T00:00:00.000Z",
        currentStatus: "focus",
        totalPausedMs: 0,
        pauses: [],
        focusWindows: [{ startedAt: "2026-04-20T00:30:00.000Z" }],
        awayWindows: []
      },
      focusPraiseMessageId: 777,
      focusPraiseLastHour: 1,
      updatedAt: "2026-04-20T00:30:00.000Z"
    });

    const deletedMessageIds: number[] = [];
    let nextMessageId = 800;
    const bot = createBot("test-token", store);
    restoreCallApi = mockBotTelegramCallApi(bot, async (...args: unknown[]) => {
      const method = String(args[0]);
      const payload = args[1] as { message_id?: number };
      if (method === "deleteMessage" && payload.message_id) {
        deletedMessageIds.push(payload.message_id);
      }
      if (method === "sendMessage") {
        return { message_id: nextMessageId++ };
      }
      return true;
    });
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };
    Object.defineProperty(bot.context, "telegram", { value: bot.telegram });
    bot.context.reply = async () => ({ message_id: nextMessageId++ } as never);

    await bot.handleUpdate({
      update_id: 40,
      message: {
        message_id: 41,
        date: Math.floor(new Date("2026-04-20T10:00:00+09:00").getTime() / 1000),
        text: "/back",
        chat: {
          id: 100,
          type: "group",
          title: "QA"
        },
        from: {
          id: 200,
          is_bot: false,
          first_name: "Han",
          username: "han"
        },
        entities: [{ type: "bot_command", offset: 0, length: 5 }]
      }
    });

    const session = store.getSession("100:200");
    assert.equal(session?.shift?.currentStatus, "working");
    assert.equal(session?.focusPraiseMessageId, undefined);
    assert.equal(session?.focusPraiseLastHour, undefined);
    assert.ok(deletedMessageIds.includes(777));
  } finally {
    restoreCallApi?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("edit command preserves current shift state while opening pending edit flow", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "buykery-workhour-"));
  let restoreCallApi: (() => void) | undefined;

  try {
    const store = new FileStateStore(path.join(tempDir, "events.csv"));
    await store.load();

    await store.upsertSession("100:200", {
      chatId: 100,
      userId: 200,
      displayName: "Han",
      username: "han",
      shift: {
        startedAt: "2026-04-02T13:00:00.000Z",
        currentStatus: "working",
        totalPausedMs: 0,
        pauses: [],
        focusWindows: [],
        awayWindows: []
      },
      updatedAt: "2026-04-02T13:00:00.000Z"
    });

    const bot = createBot("test-token", store);
    restoreCallApi = mockBotTelegramCallApi(bot, async (...args: unknown[]) => {
      if (args[0] === "sendMessage") {
        return { message_id: 777 };
      }
      return true;
    });
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };
    Object.defineProperty(bot.context, "telegram", { value: bot.telegram });
    bot.context.reply = async () => ({ message_id: 777 } as never);
    bot.context.answerCbQuery = async () => true as never;

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: Math.floor(new Date("2026-04-02T13:10:00+09:00").getTime() / 1000),
        text: "/edit",
        chat: {
          id: 100,
          type: "group",
          title: "QA"
        },
        from: {
          id: 200,
          is_bot: false,
          first_name: "Han",
          username: "han"
        },
        entities: [
          {
            type: "bot_command",
            offset: 0,
            length: 5
          }
        ]
      }
    });

    const session = store.getSession("100:200");
    assert.equal(session?.shift?.startedAt, "2026-04-02T13:00:00.000Z");
    assert.equal(session?.shift?.currentStatus, "working");
    assert.equal(session?.pendingEdit?.step, "date");
  } finally {
    restoreCallApi?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("past-date edit switches to worked-duration flow", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "buykery-workhour-"));
  let restoreCallApi: (() => void) | undefined;

  try {
    const store = new FileStateStore(path.join(tempDir, "events.csv"));
    await store.load();

    await store.upsertSession("100:200", {
      chatId: 100,
      userId: 200,
      displayName: "Han",
      username: "han",
      updatedAt: "2026-04-02T13:00:00.000Z"
    });

    const bot = createBot("test-token", store);
    restoreCallApi = mockBotTelegramCallApi(bot, async (...args: unknown[]) => {
      if (args[0] === "sendMessage") {
        return { message_id: 777 };
      }
      return true;
    });
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };
    Object.defineProperty(bot.context, "telegram", { value: bot.telegram });
    bot.context.reply = async () => ({ message_id: 777 } as never);
    bot.context.answerCbQuery = async () => true as never;

    await store.upsertSession("100:200", {
      ...(store.getSession("100:200") as NonNullable<ReturnType<FileStateStore["getSession"]>>),
      pendingEdit: {
        step: "date",
        promptMessageId: 700,
        createdAt: "2026-04-08T00:00:00.000Z"
      },
      updatedAt: "2026-04-08T00:00:00.000Z"
    });

    await bot.handleUpdate({
      update_id: 30,
      message: {
        message_id: 31,
        date: Math.floor(new Date("2026-04-08T10:00:00+09:00").getTime() / 1000),
        text: "2026-04-01",
        chat: {
          id: 100,
          type: "group",
          title: "QA"
        },
        from: {
          id: 200,
          is_bot: false,
          first_name: "Han",
          username: "han"
        },
        reply_to_message: {
          message_id: 700,
          date: Math.floor(new Date("2026-04-08T09:59:00+09:00").getTime() / 1000),
          chat: {
            id: 100,
            type: "group",
            title: "QA"
          }
        } as never
      }
    });

    const session = store.getSession("100:200");
    assert.equal(session?.pendingEdit?.step, "worked");
    assert.equal(session?.pendingEdit?.selectedDate, "2026-04-01");
  } finally {
    restoreCallApi?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("deployment notice sends once per version and stores marker", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "buykery-workhour-"));

  try {
    const store = new FileStateStore(path.join(tempDir, "events.csv"));
    await store.load();

    await store.upsertSession("100:200", {
      chatId: 100,
      userId: 200,
      displayName: "Han",
      username: "han",
      updatedAt: "2026-04-06T00:00:00.000Z"
    });

    const sentMessages: Array<{ chatId: number; text: string }> = [];
    const telegram = {
      sendMessage: async (chatId: number, text: string) => {
        sentMessages.push({ chatId, text });
        return true as never;
      }
    };

    const config = {
      enabled: true,
      version: "abcdef1234567890",
      summaryLines: ["야간 /edit 수정 지원", "/status 주간 시간 표시"]
    };

    const firstCount = await sendDeploymentNotice(telegram, store, config, new Date("2026-04-06T00:00:00.000Z"));
    const secondCount = await sendDeploymentNotice(telegram, store, config, new Date("2026-04-06T00:05:00.000Z"));

    assert.equal(firstCount, 1);
    assert.equal(secondCount, 0);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.chatId, 100);
    assert.match(sentMessages[0]?.text ?? "", /업데이트됐어요/);
    assert.match(sentMessages[0]?.text ?? "", /야간 \/edit 수정 지원/);
    assert.equal(store.getDeploymentNoticeMarker(100), "abcdef1234567890");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
