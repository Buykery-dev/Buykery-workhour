import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregateWeeklyTotals,
  buildManualEditPayload,
  buildManualEditPayloadWithBreak,
  calculateWorkedMsInRange,
  createShift,
  endShift,
  getCurrentWeekContext,
  getWeeklyReportContext,
  parseBreakMinutesInput,
  parseClockTime,
  parseEditDateInput,
  parseManualInput,
  setPausedStatus,
  startOrResumeShift
} from "../src/domain.js";
import { createBot } from "../src/bot.js";
import { sendDeploymentNotice } from "../src/deployment.js";
import { FileStateStore } from "../src/storage.js";

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

test("weekly report context fires on Sunday 23:59 in Seoul", () => {
  const context = getWeeklyReportContext(new Date("2026-03-29T14:59:00Z"));
  assert.equal(context.shouldSend, true);
  assert.equal(context.weekKey, "2026-03-23");
  assert.equal(context.windowStart.toISOString(), "2026-03-22T15:00:00.000Z");
  assert.equal(context.windowEnd.toISOString(), "2026-03-29T14:59:59.999Z");
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
        pausedMs: 0,
        pauses: [],
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
        pausedMs: 0,
        pauses: [],
        awayWindows: []
      }
    ],
    [],
    new Date("2026-03-22T15:00:00.000Z"),
    new Date("2026-03-29T14:59:59.999Z")
  );

  assert.equal(totals[0]?.workedMs, 60 * 60 * 1000);
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

test("edit command preserves current shift state while opening pending edit flow", async () => {
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
        startedAt: "2026-04-02T13:00:00.000Z",
        currentStatus: "working",
        totalPausedMs: 0,
        pauses: [],
        awayWindows: []
      },
      updatedAt: "2026-04-02T13:00:00.000Z"
    });

    const bot = createBot("test-token", store);
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };
    bot.context.reply = async () => ({ message_id: 777 } as never);
    bot.context.answerCbQuery = async () => true as never;
    Object.defineProperty(bot.telegram, "callApi", {
      value: async (...args: unknown[]) => {
        if (args[0] === "sendMessage") {
          return { message_id: 777 };
        }
        return true;
      }
    });

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
