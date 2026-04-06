import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Telegram } from "telegraf";
import { buildDeploymentNoticeMessage } from "./messages.js";
import { FileStateStore } from "./storage.js";

export interface DeploymentNoticeConfig {
  enabled: boolean;
  summaryLines: string[];
  version?: string;
}

function parseSummaryLines(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(/\r?\n|\|/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readSummaryFile(baseDir: string): Promise<string | undefined> {
  const fileName = process.env.BOT_UPDATE_SUMMARY_FILE?.trim() || "update-summary.txt";
  const filePath = path.resolve(baseDir, fileName);

  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function resolveDeploymentVersion(): string | undefined {
  const version =
    process.env.BOT_RELEASE_VERSION ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.SOURCE_VERSION ??
    process.env.npm_package_version;

  return version?.trim() || undefined;
}

export function formatDeploymentVersionLabel(version: string | undefined): string | undefined {
  if (!version) {
    return undefined;
  }

  if (/^[0-9a-f]{12,}$/i.test(version)) {
    return version.slice(0, 7);
  }

  return version.length > 24 ? version.slice(0, 24) : version;
}

export async function loadDeploymentNoticeConfig(baseDir: string): Promise<DeploymentNoticeConfig> {
  const enabled = process.env.BOT_UPDATE_NOTIFICATIONS_ENABLED === "true";
  const summaryFromEnv = parseSummaryLines(process.env.BOT_UPDATE_SUMMARY);
  const summaryFromFile = parseSummaryLines(await readSummaryFile(baseDir));

  return {
    enabled,
    summaryLines: summaryFromEnv.length > 0 ? summaryFromEnv : summaryFromFile,
    version: resolveDeploymentVersion()
  };
}

export async function sendDeploymentNotice(
  telegram: Pick<Telegram, "sendMessage">,
  store: FileStateStore,
  config: DeploymentNoticeConfig,
  now: Date = new Date()
): Promise<number> {
  if (!config.enabled || !config.version) {
    return 0;
  }

  const versionLabel = formatDeploymentVersionLabel(config.version);
  const message = buildDeploymentNoticeMessage(versionLabel, config.summaryLines);
  let sentCount = 0;

  for (const chatId of store.getKnownChatIds()) {
    if (store.getDeploymentNoticeMarker(chatId) === config.version) {
      continue;
    }

    await telegram.sendMessage(chatId, message, {
      parse_mode: "HTML",
      link_preview_options: {
        is_disabled: true
      }
    });
    await store.markDeploymentNoticeSent(chatId, config.version, now.toISOString());
    sentCount += 1;
  }

  return sentCount;
}
