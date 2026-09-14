import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";

const templateEnv = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
});

const defaultTemplatesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);
const templateCache = new Map();

const statusLabels = {
  FR: {
    PENDING: "En attente",
    IN_REVIEW: "En review",
    REVIEWED: "Reviewee",
    ACKED: "Ackee",
    CLOSED: "Done",
  },
  EN: {
    PENDING: "Pending",
    IN_REVIEW: "In review",
    REVIEWED: "Reviewed",
    ACKED: "Acked",
    CLOSED: "Done",
  },
};

function normalizeLocale(locale) {
  return String(locale ?? "FR").toUpperCase() === "EN" ? "EN" : "FR";
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function reviewTitle(payload) {
  return (
    asString(payload.title) ??
    asString(payload.gitwebTitle) ??
    asString(payload.reviewId) ??
    "Review"
  );
}

function reviewUrl(payload, frontendUrl) {
  const reviewId = asString(payload.reviewId);
  if (reviewId) {
    return `${frontendUrl}/review/${encodeURIComponent(reviewId)}`;
  }

  return asString(payload.gitwebUrl);
}

function statusLabel(locale, status) {
  const key = asString(status);
  return key ? (statusLabels[locale][key] ?? key) : null;
}

function versionCounts(payload, locale) {
  const names =
    locale === "EN"
      ? {
          new: "new",
          modified: "modified",
          rebased: "rebased",
          dropped: "dropped",
        }
      : {
          new: "nouveaux",
          modified: "modifies",
          rebased: "rebases",
          dropped: "retires",
        };
  return [
    [names.new, payload.newCount],
    [names.modified, payload.modifiedCount],
    [names.rebased, payload.rebasedCount],
    [names.dropped, payload.droppedCount],
  ]
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");
}

function eventView(event, options) {
  const locale = normalizeLocale(event.user?.locale);
  const payload =
    event.payload && typeof event.payload === "object" ? event.payload : {};
  const frontendUrl = options.frontendUrl.replace(/\/$/, "");
  const url = reviewUrl(payload, frontendUrl);
  const gitwebUrl = asString(payload.gitwebUrl);

  return {
    app: "git-web-review",
    locale,
    type: event.type,
    notificationId: event.notificationId,
    createdAt: event.createdAt,
    user: event.user,
    payload,
    title: reviewTitle(payload),
    url,
    gitwebUrl,
    hasUrl: !!url,
    hasGitwebUrl: !!gitwebUrl,
    showGitwebUrl: !!gitwebUrl && gitwebUrl !== url,
    actor: asString(payload.actorNickname) ?? asString(payload.actorEmail),
    ownerEmail: asString(payload.ownerEmail),
    message: asString(payload.message),
    commentExcerpt:
      asString(payload.commentExcerpt) ?? asString(payload.message),
    filePath: asString(payload.filePath),
    lineNumber: payload.lineNumber ?? null,
    previousStatus: asString(payload.previousStatus),
    nextStatus: asString(payload.nextStatus),
    previousStatusLabel: statusLabel(locale, payload.previousStatus),
    nextStatusLabel: statusLabel(locale, payload.nextStatus),
    sourceProject: asString(payload.sourceProject),
    sourceBranch: asString(payload.sourceBranch),
    sourceCommit: asString(payload.sourceCommit),
    versionCounts: versionCounts(payload, locale),
    rawPayload: JSON.stringify(payload),
  };
}

/**
 * The type and locale come from the Redis event and are used to build a file
 * path, which is then rendered as a template. The backend only ever puts values
 * from its own enum there, but the relay must not depend on another service's
 * discipline to avoid reading an arbitrary file.
 */
const KNOWN_TEMPLATE_TYPES = new Set([
  "TEXT",
  "REVIEW_PENDING",
  "REVIEW_STATUS_CHANGED",
  "COMMENT_RECEIVED",
  "COMMIT_REVIEWED",
  "REVIEW_NEW_VERSION",
  "DEFAULT",
]);

const KNOWN_LOCALES = new Set(["FR", "EN"]);

async function readTemplate(templatesDir, locale, type) {
  if (!KNOWN_LOCALES.has(locale) || !KNOWN_TEMPLATE_TYPES.has(type)) {
    const error = new Error(`Unknown notification template ${locale}/${type}`);
    error.code = "ENOENT";
    throw error;
  }

  const filePath = path.join(templatesDir, locale, `${type}.njk`);
  const cacheKey = filePath;
  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey);
  }

  const template = await fs.readFile(filePath, "utf8");
  templateCache.set(cacheKey, template);
  return template;
}

async function loadTemplate(event, templatesDir) {
  const locale = normalizeLocale(event.user?.locale);
  const type = asString(event.type) ?? "DEFAULT";
  const candidates = [
    [locale, type],
    ["FR", type],
    [locale, "DEFAULT"],
    ["FR", "DEFAULT"],
  ];

  for (const [candidateLocale, candidateType] of candidates) {
    try {
      return await readTemplate(templatesDir, candidateLocale, candidateType);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(`No notification template found for ${locale}/${type}`);
}

/**
 * Renders a notification email from a nunjucks template.
 *
 * Template convention: the first non-empty rendered line is the subject
 * (usually prefixed with [app]); the remaining non-empty lines form the
 * body. Returns {subject, heading, lines, view}.
 */
export async function renderEmailNotification(event, options) {
  const templatesDir = options.templatesDir ?? defaultTemplatesDir;
  const template = await loadTemplate(event, templatesDir);
  const view = eventView(event, options);
  const rendered = templateEnv.renderString(template, view);
  const lines = rendered
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const subject = lines[0] ?? `[${view.app}] Notification`;
  const heading = subject.replace(/^\[[^\]]*\]\s*/, "");

  return { subject, heading, lines: lines.slice(1), view };
}
