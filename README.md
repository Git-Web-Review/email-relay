# email-relay

Email notification relay that consumes redis events to send notifications to users

## Configuration

The relay subscribes to `notifications:email` by default and sends one email per Redis notification event when `user.mailNotificationsEnabled` is true.

Useful environment variables:

- `REDIS_URL`, default `redis://localhost:6379`
- `REDIS_CHANNEL`, default `notifications:email`
- `FRONTEND_URL`, used to build review links
- `EMAIL_DRY_RUN`, log emails instead of sending them
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`
- `MAIL_FROM`

## User formats

When the event carries `user.mailFormat` (a printf-style format the user set in the
frontend settings for this notification type), it replaces the template. The
specifiers are listed in [`src/printf-format.js`](src/printf-format.js); a
missing value prints nothing and `%%` is a literal `%`.
