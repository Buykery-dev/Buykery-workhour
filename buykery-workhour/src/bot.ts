import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import {
  attachManualAwayNote,
  createSessionKey,
  endShift,
  isManualInputReply,
  parseManualInput,
  setPausedStatus,
  sortSessionsForTeamView,
  startOrResumeShift
} from "./domain.js";
import {
  buildEndMessage,
  buildHelpMessage,
  buildManualParseError,
  buildManualPrompt,
  buildManualSavedMessage,
  buildNoShiftMessage,
  buildPauseMessage,
  buildStartMessage,
  buildStatusMessage,
  buildTeamStatusMessage,
  createMention
} from "./messages.js";
import { FileStateStore } from "./storage.js";
import type { ManualAwayNote, UserSession, WorkStatus } from "./types.js";

function getDisplayName(ctx: Context): string {
  const firstName = ctx.from?.first_name ?? "팀원";
  const lastName = ctx.from?.last_name?.trim();
  return lastName ? `${firstName} ${lastName}` : firstName;
}

function getSessionFromContext(ctx: Context, store: FileStateStore): { key: string; session: UserSession; mention: string } | undefined {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  if (!chatId || !userId || !ctx.from) {
    return undefined;
  }

  const key = createSessionKey(chatId, userId);
  const existing = store.getSession(key);
  const displayName = getDisplayName(ctx);
  const mention = createMention(userId, displayName);

  return {
    key,
    mention,
    session: {
      chatId,
      userId,
      displayName,
      username: ctx.from.username,
      shift: existing?.shift,
      pendingManual: existing?.pendingManual,
      updatedAt: new Date().toISOString()
    }
  };
}

async function replyHtml(ctx: Context, html: string): Promise<void> {
  await ctx.reply(html, {
    parse_mode: "HTML",
    link_preview_options: {
      is_disabled: true
    }
  });
}

async function handlePause(
  ctx: Context,
  store: FileStateStore,
  status: Exclude<WorkStatus, "working">
): Promise<void> {
  const current = getSessionFromContext(ctx, store);
  if (!current) {
    return;
  }

  const now = new Date();
  const result = setPausedStatus(current.session.shift, status, now);
  if (result.mode === "missing" || !result.shift) {
    await replyHtml(ctx, buildNoShiftMessage(current.mention));
    return;
  }

  current.session.shift = result.shift;
  current.session.updatedAt = now.toISOString();
  await store.upsertSession(current.key, current.session);
  await replyHtml(ctx, buildPauseMessage(current.mention, status, result.mode));
}

export function createBot(token: string, store: FileStateStore): Telegraf {
  const bot = new Telegraf(token);

  bot.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  bot.command("help", async (ctx) => {
    await replyHtml(ctx, buildHelpMessage());
  });

  bot.hears(/^help$/i, async (ctx) => {
    await replyHtml(ctx, buildHelpMessage());
  });

  bot.command("start", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    const now = new Date();
    const result = startOrResumeShift(current.session.shift, now);
    current.session.shift = result.shift;
    delete current.session.pendingManual;
    current.session.updatedAt = now.toISOString();

    await store.upsertSession(current.key, current.session);
    await replyHtml(ctx, buildStartMessage(current.mention, now, result.mode));
  });

  bot.command("stop", async (ctx) => {
    await handlePause(ctx, store, "break");
  });

  bot.command("lunch", async (ctx) => {
    await handlePause(ctx, store, "lunch");
  });

  bot.command("manual", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    if (!current.session.shift) {
      await replyHtml(ctx, buildNoShiftMessage(current.mention));
      return;
    }

    const prompt = await ctx.reply(buildManualPrompt(current.mention), {
      parse_mode: "HTML",
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "예: 15:00-16:30 외근"
      }
    });

    current.session.pendingManual = {
      promptMessageId: prompt.message_id,
      createdAt: new Date().toISOString()
    };
    current.session.updatedAt = new Date().toISOString();

    await store.upsertSession(current.key, current.session);
  });

  bot.command("status", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    if (!current.session.shift) {
      await replyHtml(ctx, buildNoShiftMessage(current.mention));
      return;
    }

    await replyHtml(ctx, buildStatusMessage(current.mention, current.session.shift, new Date()));
  });

  bot.command("team", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const sessions = sortSessionsForTeamView(store.getSessionsByChat(chatId));
    await replyHtml(ctx, buildTeamStatusMessage(sessions, new Date()));
  });

  bot.command("end", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    const now = new Date();
    const result = endShift(current.session.shift, now);

    if (!result.summary) {
      await replyHtml(ctx, buildNoShiftMessage(current.mention));
      return;
    }

    delete current.session.shift;
    delete current.session.pendingManual;
    current.session.updatedAt = now.toISOString();

    await store.appendCompletedShift({
      chatId: current.session.chatId,
      userId: current.session.userId,
      displayName: current.session.displayName,
      username: current.session.username,
      startedAt: result.shift?.startedAt ?? now.toISOString(),
      endedAt: now.toISOString(),
      workedMs: result.summary.workedMs,
      pausedMs: result.summary.totalPausedMs,
      pauses: result.shift?.pauses ?? []
    });
    await store.upsertSession(current.key, current.session);
    await replyHtml(ctx, buildEndMessage(current.mention, result.summary));
  });

  bot.on("text", async (ctx, next) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return next();
    }

    const replyToMessageId = ctx.message.reply_to_message?.message_id;
    if (!isManualInputReply(current.session, replyToMessageId)) {
      return next();
    }

    const parsed = parseManualInput(ctx.message.text, new Date());
    if (!parsed) {
      await replyHtml(ctx, buildManualParseError(current.mention));
      return;
    }

    if (!current.session.shift) {
      await replyHtml(ctx, buildNoShiftMessage(current.mention));
      return;
    }

    const now = new Date();
    const pauseResult = setPausedStatus(current.session.shift, "manual", now, parsed.note);
    if (!pauseResult.shift) {
      await replyHtml(ctx, buildNoShiftMessage(current.mention));
      return;
    }

    const manualNote: ManualAwayNote = {
      from: parsed.from.toISOString(),
      to: parsed.to.toISOString(),
      note: parsed.note,
      createdAt: now.toISOString()
    };

    current.session.shift = attachManualAwayNote(pauseResult.shift, manualNote);
    delete current.session.pendingManual;
    current.session.updatedAt = now.toISOString();

    await store.upsertSession(current.key, current.session);
    await replyHtml(ctx, buildManualSavedMessage(current.mention, parsed));
  });

  return bot;
}
