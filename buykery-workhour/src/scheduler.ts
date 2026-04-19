import type { Telegraf } from "telegraf";
import { aggregateWeeklyTotals, getWeeklyReportContext } from "./domain.js";
import { buildWeeklySummaryMessage } from "./messages.js";
import { FileStateStore } from "./storage.js";

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
