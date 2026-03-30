import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBot } from "./bot.js";
import { FileStateStore } from "./storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and fill it in.");
  }

  const dataFile = path.resolve(__dirname, "..", "data", "state.json");
  const store = new FileStateStore(dataFile);
  await store.load();

  const bot = createBot(token, store);

  await bot.telegram.setMyCommands([
    { command: "start", description: "근무 시작 또는 복귀" },
    { command: "stop", description: "잠깐 자리 비움" },
    { command: "lunch", description: "식사 중" },
    { command: "manual", description: "시간대를 입력해서 부재 안내" },
    { command: "status", description: "내 현재 근무 상태 보기" },
    { command: "team", description: "방 안 팀 상태 보기" },
    { command: "end", description: "오늘 근무 종료" },
    { command: "help", description: "도움말 보기" }
  ]);

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  await bot.launch({
    dropPendingUpdates: true
  });

  console.log(process.env.BOT_NAME ?? "Buykery 근태 텔레그램 봇", "is running");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
