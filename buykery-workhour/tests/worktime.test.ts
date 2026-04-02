import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateWeeklyTotals,
  buildManualEditPayload,
  calculateWorkedMsInRange,
  createShift,
  endShift,
  getWeeklyReportContext,
  parseClockTime,
  parseEditDateInput,
  parseManualInput,
  setPausedStatus,
  startOrResumeShift
} from "../src/domain.js";

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
  assert.equal(payload?.workedMs, 9.5 * 60 * 60 * 1000);
});
