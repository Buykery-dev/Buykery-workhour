import "dotenv/config";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBot } from "./bot.js";
import { loadDeploymentNoticeConfig, sendDeploymentNotice } from "./deployment.js";
import { startWeeklySummaryScheduler } from "./scheduler.js";
import { FileStateStore } from "./storage.js";

process.env.TZ = process.env.TZ ?? "Asia/Seoul";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and fill it in.");
  }

  const appRootDir = path.resolve(__dirname, "..", "..");
  const fallbackDataDir = path.resolve(appRootDir, "data");
  let dataDir = process.env.DATA_DIR ?? "/data";
  try {
    await access(dataDir);
  } catch {
    dataDir = fallbackDataDir;
  }

  const store = new FileStateStore(path.resolve(dataDir, "events.csv"));
  await store.load();

  const bot = createBot(token, store);

  await bot.telegram.setMyCommands([
    { command: "start", description: "근무 시작 또는 복귀" },
    { command: "back", description: "업무로 복귀" },
    { command: "stop", description: "잠깐 자리 비움" },
    { command: "lunch", description: "식사 중 (/bab도 가능)" },
    { command: "bab", description: "식사 중" },
    { command: "meeting", description: "회의 중" },
    { command: "focus", description: "집중 작업 중" },
    { command: "outside", description: "외근 또는 이동 중" },
    { command: "manual", description: "시간대를 입력해서 부재 안내" },
    { command: "edit", description: "날짜별 근무 시간 수정" },
    { command: "status", description: "내 현재 근무 상태 보기" },
    { command: "team", description: "방 안 팀 상태 보기" },
    { command: "end", description: "현재 근무 종료" },
    { command: "help", description: "도움말 보기" }
  ]);

  const deploymentNoticeConfig = await loadDeploymentNoticeConfig(appRootDir);
  let weeklySummaryTimer: NodeJS.Timeout | undefined;
  let postLaunchStarted = false;

  const stop = (reason: "SIGINT" | "SIGTERM"): void => {
    if (weeklySummaryTimer) {
      clearInterval(weeklySummaryTimer);
    }
    bot.stop(reason);
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  await bot.launch(
    {
      dropPendingUpdates: true
    },
    () => {
      if (postLaunchStarted) {
        return;
      }

      postLaunchStarted = true;
      void (async () => {
        const sentDeploymentNotices = await sendDeploymentNotice(bot.telegram, store, deploymentNoticeConfig);
        if (sentDeploymentNotices > 0) {
          console.log("Sent deployment notices:", sentDeploymentNotices);
        }

        weeklySummaryTimer = startWeeklySummaryScheduler(bot, store);

        console.log(process.env.BOT_NAME ?? "Buykery 근태 텔레그램 봇", "is running");
      })().catch((error) => {
        console.error("Post-launch tasks failed:", error);
      });
    }
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
