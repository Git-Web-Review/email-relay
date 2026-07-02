import Redis from "ioredis";
import nodemailer from "nodemailer";

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

const translations = {
  FR: {
    app: "git-web-review",
    notification: "Notification",
    textNotification: "Notification",
    reviewPending: "Review a faire",
    reviewStatusChanged: "Statut de review modifie",
    commentReceived: "Commentaire recu",
    commitReviewed: "Commit reviewe",
    openedBy: "Ouverte par",
    updatedBy: "Modifiee par",
    reviewedBy: "Reviewe par",
    commentBy: "Par",
    project: "Projet",
    branch: "Branche",
    commit: "Commit",
    openReview: "Ouvrir la review",
    openGitweb: "Ouvrir git-web",
    message: "Message",
    statuses: {
      PENDING: "En attente",
      IN_REVIEW: "En review",
      REVIEWED: "Reviewee",
      ACKED: "Ackee",
      CLOSED: "Done",
    },
  },
  EN: {
    app: "git-web-review",
    notification: "Notification",
    textNotification: "Notification",
    reviewPending: "Review requested",
    reviewStatusChanged: "Review status changed",
    commentReceived: "Comment received",
    commitReviewed: "Commit reviewed",
    openedBy: "Opened by",
    updatedBy: "Updated by",
    reviewedBy: "Reviewed by",
    commentBy: "By",
    project: "Project",
    branch: "Branch",
    commit: "Commit",
    openReview: "Open review",
    openGitweb: "Open git-web",
    message: "Message",
    statuses: {
      PENDING: "Pending",
      IN_REVIEW: "In review",
      REVIEWED: "Reviewed",
      ACKED: "Acked",
      CLOSED: "Done",
    },
  },
};

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value));
}

function normalizeLocale(locale) {
  return String(locale ?? "FR").toUpperCase() === "EN" ? "EN" : "FR";
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

function reviewTitle(payload) {
  return (
    asString(payload.title) ??
    asString(payload.gitwebTitle) ??
    asString(payload.reviewId) ??
    "Review"
  );
}

function reviewUrl(payload) {
  const reviewId = asString(payload.reviewId);
  if (reviewId) {
    return `${frontendUrl}/review/${encodeURIComponent(reviewId)}`;
  }

  return asString(payload.gitwebUrl);
}

function statusLabel(labels, status) {
  const key = asString(status);
  return key ? (labels.statuses[key] ?? key) : null;
}

function compactMetadata(labels, payload) {
  return [
    [labels.project, asString(payload.sourceProject)],
    [labels.branch, asString(payload.sourceBranch)],
    [labels.commit, asString(payload.sourceCommit)],
  ].filter(([, value]) => !!value);
}

function formatEvent(event) {
  const payload =
    event.payload && typeof event.payload === "object" ? event.payload : {};
  const labels = translations[normalizeLocale(event.user.locale)];
  const title = reviewTitle(payload);
  const url = reviewUrl(payload);
  const gitwebUrl = asString(payload.gitwebUrl);
  const lines = [];
  let subject;
  let heading;

  switch (event.type) {
    case "REVIEW_PENDING": {
      heading = `${labels.reviewPending}: ${title}`;
      subject = `[${labels.app}] ${heading}`;
      const ownerEmail = asString(payload.ownerEmail);
      if (ownerEmail) {
        lines.push(`${labels.openedBy}: ${ownerEmail}`);
      }
      break;
    }
    case "REVIEW_STATUS_CHANGED": {
      const previousStatus = statusLabel(labels, payload.previousStatus) ?? "-";
      const nextStatus = statusLabel(labels, payload.nextStatus) ?? "-";
      heading = `${labels.reviewStatusChanged}: ${title}`;
      subject = `[${labels.app}] ${heading}`;
      lines.push(`${previousStatus} -> ${nextStatus}`);
      const actor =
        asString(payload.actorNickname) ?? asString(payload.actorEmail);
      if (actor) {
        lines.push(`${labels.updatedBy}: ${actor}`);
      }
      break;
    }
    case "TEXT": {
      heading = asString(payload.title) ?? labels.textNotification;
      subject = `[${labels.app}] ${heading}`;
      const message = asString(payload.message);
      if (message) {
        lines.push(message);
      }
      break;
    }
    case "COMMENT_RECEIVED": {
      heading = `${labels.commentReceived}: ${title}`;
      subject = `[${labels.app}] ${heading}`;
      const filePath = asString(payload.filePath);
      if (filePath) {
        lines.push(
          payload.lineNumber ? `${filePath}:${payload.lineNumber}` : filePath,
        );
      }
      const message =
        asString(payload.commentExcerpt) ?? asString(payload.message);
      if (message) {
        lines.push(message);
      }
      const actor =
        asString(payload.actorNickname) ?? asString(payload.actorEmail);
      if (actor) {
        lines.push(`${labels.commentBy}: ${actor}`);
      }
      break;
    }
    case "COMMIT_REVIEWED": {
      heading = `${labels.commitReviewed}: ${title}`;
      subject = `[${labels.app}] ${heading}`;
      const commitTitles = asString(payload.commitTitles);
      if (commitTitles) {
        lines.push(...commitTitles.split("\n"));
      }
      const actor =
        asString(payload.actorNickname) ?? asString(payload.actorEmail);
      if (actor) {
        lines.push(`${labels.reviewedBy}: ${actor}`);
      }
      break;
    }
    default: {
      heading = labels.notification;
      subject = `[${labels.app}] ${heading}`;
      lines.push(JSON.stringify(payload));
    }
  }

  for (const [name, value] of compactMetadata(labels, payload)) {
    lines.push(`${name}: ${value}`);
  }

  if (url) {
    lines.push(`${labels.openReview}: ${url}`);
  }
  if (gitwebUrl && gitwebUrl !== url) {
    lines.push(`${labels.openGitweb}: ${gitwebUrl}`);
  }

  return {
    subject,
    text: `${heading}\n\n${lines.join("\n")}`,
    html: renderHtml(heading, lines),
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

  const formatted = formatEvent(event);
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
