import Redis from "ioredis";
import nodemailer from "nodemailer";
import { renderEmailNotification } from "./notification-template.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redisChannel = process.env.REDIS_CHANNEL ?? "notifications:email";
const frontendUrl = (
  process.env.FRONTEND_URL ?? "http://localhost:5173"
).replace(/\/$/, "");
const mailFrom = process.env.MAIL_FROM ?? "git-web-review@localhost";
const dryRun = parseBoolean(process.env.EMAIL_DRY_RUN ?? "false");

const subscriber = new Redis(redisUrl);
const transporter = dryRun
  ? null
  : nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? "localhost",
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: parseBoolean(process.env.SMTP_SECURE ?? "false"),
      auth:
        process.env.SMTP_USER || process.env.SMTP_PASSWORD
          ? {
              user: process.env.SMTP_USER ?? "",
              pass: process.env.SMTP_PASSWORD ?? "",
            }
          : undefined,
    });

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value));
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseEvent(message) {
  try {
    const event = JSON.parse(message);
    if (!event || typeof event !== "object") {
      return null;
    }

    const user = event.user;
    if (!user || typeof user !== "object" || !asString(user.email)) {
      return null;
    }

    return event;
  } catch (error) {
    console.error("Invalid Redis notification event", error);
    return null;
  }
}

const footerLabels = {
  FR: {
    project: "Projet",
    branch: "Branche",
    commit: "Commit",
    openReview: "Ouvrir la review",
    openGitweb: "Ouvrir git-web",
  },
  EN: {
    project: "Project",
    branch: "Branch",
    commit: "Commit",
    openReview: "Open review",
    openGitweb: "Open git-web",
  },
};

async function formatEvent(event) {
  const { subject, heading, lines, view } = await renderEmailNotification(
    event,
    { frontendUrl },
  );
  const labels = footerLabels[view.locale] ?? footerLabels.FR;

  const allLines = [...lines];
  for (const [name, value] of [
    [labels.project, view.sourceProject],
    [labels.branch, view.sourceBranch],
    [labels.commit, view.sourceCommit],
  ]) {
    if (value) {
      allLines.push(`${name}: ${value}`);
    }
  }
  if (view.url) {
    allLines.push(`${labels.openReview}: ${view.url}`);
  }
  if (view.showGitwebUrl) {
    allLines.push(`${labels.openGitweb}: ${view.gitwebUrl}`);
  }

  return {
    subject,
    text: `${heading}\n\n${allLines.join("\n")}`,
    html: renderHtml(heading, allLines),
  };
}

function renderHtml(heading, lines) {
  const items = lines
    .map((line) => `<li>${linkifyHtml(escapeHtml(line))}</li>`)
    .join("");
  return `<!doctype html><html><body><h2>${escapeHtml(heading)}</h2><ul>${items}</ul></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function linkifyHtml(value) {
  return value.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>',
  );
}

async function sendEmail(event) {
  if (!event.user.mailNotificationsEnabled) {
    return;
  }

  const recipient = asString(event.user.email);
  if (!recipient) {
    return;
  }

  const formatted = await formatEvent(event);
  if (dryRun) {
    console.log(`[dry-run] email to ${recipient}: ${formatted.subject}`);
    return;
  }

  await transporter.sendMail({
    from: mailFrom,
    to: recipient,
    subject: formatted.subject,
    text: formatted.text,
    html: formatted.html,
  });
  console.log(`email sent to ${recipient}: ${formatted.subject}`);
}

subscriber.on("message", (_channel, message) => {
  const event = parseEvent(message);
  if (!event) {
    return;
  }

  void sendEmail(event).catch((error) => {
    console.error("Failed to send email notification", error);
  });
});

subscriber.on("error", (error) => {
  console.error("Redis subscriber error", error);
});

if (transporter) {
  void transporter.verify().catch((error) => {
    console.error("SMTP verification failed; relay will keep running", error);
  });
}

await subscriber.subscribe(redisChannel);
console.log(
  `email-relay listening on Redis channel ${redisChannel}${dryRun ? " in dry-run mode" : ""}`,
);

const shutdown = async () => {
  subscriber.disconnect();
  if (transporter) {
    transporter.close();
  }
};

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
