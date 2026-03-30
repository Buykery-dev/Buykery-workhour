import test from "node:test";
import assert from "node:assert/strict";
import { createShift, endShift, parseManualInput, setPausedStatus, startOrResumeShift } from "../src/domain.js";

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
