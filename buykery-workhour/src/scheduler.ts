import type { Telegraf } from "telegraf";
import { aggregateWeeklyTotals, getActiveAwayWindow, getWeeklyReportContext } from "./domain.js";
import { buildFocusPraiseMessage, buildWeeklySummaryMessage, createMention } from "./messages.js";
import { FileStateStore } from "./storage.js";
import type { UserSession } from "./types.js";

const FOCUS_PRAISE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_FOCUS_PRAISE_HOUR = 24;

type TelegramSender = Pick<Telegraf["telegram"], "deleteMessage" | "sendMessage">;

function formatWeekLabel(windowStart: Date, windowEnd: Date): string {
  const formatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric"
  });

  return `${formatter.format(windowStart)} ~ ${formatter.format(windowEnd)}`;
}

export function startWeeklySummaryScheduler(bot: Telegraf, store: FileStateStore): NodeJS.Timeout {
  const run = async (): Promise<number> => {
    const now = new Date();
    const context = getWeeklyReportContext(now);
    if (!context.shouldSend) {
      return 0;
    }

    let sentCount = 0;
    const chatIds = store.getKnownChatIds();
    for (const chatId of chatIds) {
      if (store.getWeeklyReportMarker(chatId, context.weekKey)) {
        continue;
      }

      const members = aggregateWeeklyTotals(
        store.getCompletedShiftsByChat(chatId),
        store.getSessionsByChat(chatId),
        context.windowStart,
        context.windowEnd
      );

      const message = buildWeeklySummaryMessage(formatWeekLabel(context.windowStart, context.windowEnd), members);
      await bot.telegram.sendMessage(chatId, message, {
        parse_mode: "HTML",
        link_preview_options: {
          is_disabled: true
        }
      });
      await store.markWeeklyReportSent(chatId, context.weekKey, now.toISOString());
      sentCount += 1;
    }

    return sentCount;
  };

  const runAndLog = async (): Promise<void> => {
    const sentCount = await run();
    if (sentCount > 0) {
      console.log("Sent weekly summary reports:", sentCount);
    }
  };

  void runAndLog().catch((error) => {
    console.error("Weekly summary scheduler failed:", error);
  });

  return setInterval(() => {
    void runAndLog().catch((error) => {
      console.error("Weekly summary scheduler failed:", error);
    });
  }, 30_000);
}

function getOpenFocusStartedAt(session: UserSession, now: Date): string | undefined {
  if (!session.shift || session.shift.currentStatus !== "focus" || getActiveAwayWindow(session.shift, now)) {
    return undefined;
  }

  return [...session.shift.focusWindows].reverse().find((window) => !window.endedAt)?.startedAt;
}

async function deleteFocusPraiseMessage(telegram: TelegramSender, session: UserSession): Promise<void> {
  if (!session.focusPraiseMessageId) {
    return;
  }

  try {
    await telegram.deleteMessage(session.chatId, session.focusPraiseMessageId);
  } catch {
    // Ignore missing or already-deleted praise messages.
  }
}

async function clearFocusPraiseState(
  telegram: TelegramSender,
  store: FileStateStore,
  key: string,
  session: UserSession
): Promise<void> {
  if (!session.focusPraiseMessageId && !session.focusPraiseLastHour) {
    return;
  }

  await deleteFocusPraiseMessage(telegram, session);
  delete session.focusPraiseMessageId;
  delete session.focusPraiseLastHour;
  session.updatedAt = new Date().toISOString();
  await store.upsertSession(key, session);
}

export async function runFocusPraiseSweep(telegram: TelegramSender, store: FileStateStore, now: Date = new Date()): Promise<number> {
  let sentCount = 0;

  for (const { key, session } of store.getSessionEntries()) {
    const focusStartedAt = getOpenFocusStartedAt(session, now);
    if (!focusStartedAt) {
      await clearFocusPraiseState(telegram, store, key, session);
      continue;
    }

    const elapsedHour = Math.floor((now.getTime() - new Date(focusStartedAt).getTime()) / FOCUS_PRAISE_INTERVAL_MS);
    if (elapsedHour < 1 || elapsedHour > MAX_FOCUS_PRAISE_HOUR || session.focusPraiseLastHour === elapsedHour) {
      continue;
    }

    const mention = createMention(session.userId, session.displayName);
    const message = await telegram.sendMessage(session.chatId, buildFocusPraiseMessage(mention, elapsedHour), {
      parse_mode: "HTML",
      link_preview_options: {
        is_disabled: true
      }
    });
    await deleteFocusPraiseMessage(telegram, session);

    session.focusPraiseMessageId = message.message_id;
    session.focusPraiseLastHour = elapsedHour;
    session.updatedAt = now.toISOString();
    await store.upsertSession(key, session);
    sentCount += 1;
  }

  return sentCount;
}

export function startFocusPraiseScheduler(bot: Telegraf, store: FileStateStore): NodeJS.Timeout {
  const runAndLog = async (): Promise<void> => {
    const sentCount = await runFocusPraiseSweep(bot.telegram, store);
    if (sentCount > 0) {
      console.log("Sent focus praise messages:", sentCount);
    }
  };

  void runAndLog().catch((error) => {
    console.error("Focus praise scheduler failed:", error);
  });

  return setInterval(() => {
    void runAndLog().catch((error) => {
      console.error("Focus praise scheduler failed:", error);
    });
  }, 30_000);
}
