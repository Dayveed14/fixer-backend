# Operating Fixer

Backups, restores, rollbacks and alerts. Commands run from the backend folder
with the `DB_*` variables of the database you mean (`.env` is read automatically).

## Monitoring and alerts

What raises an alert (`services/monitor.js`):

| Alert | When |
| --- | --- |
| Payment amount/currency mismatch | Paystack reports a different amount than the server priced |
| Paid but couldn't be applied | Customer paid, but creating the booking/approval failed (e.g. the quote changed) |
| Paid payments not yet used | Checked every 10 min: paid more than 15 min ago, nothing created |
| Failed payments spike | 5+ failed/mismatched payments in an hour (`ALERT_PAYMENT_FAILURE_THRESHOLD`) |
| Server errors | 10+ 5xx responses within 5 minutes (`ALERT_5XX_THRESHOLD`) |
| Unhandled error | A promise rejection nothing caught |

Where alerts go:
- **Logs, always** — one JSON line with `"event":"fixer_alert"`. In Render → Logs, search `fixer_alert`.
- **Email** to `ADMIN_EMAIL` for critical alerts.
- **Chat** if `ALERT_WEBHOOK_URL` is set (Slack incoming webhook, or Discord webhook URL + `/slack`).
- The same alert repeats at most every 30 minutes (`ALERT_COOLDOWN_MINUTES`).

Admins see the live picture at **Admin → Payments** (or `GET /api/health/metrics`):
paid-but-unused payments, failures in the last hour, recent server errors and alerts.

**Following up a "paid but not used" payment:** Admin → Payments → *Paid, not used*
→ open the payment to see its history. Contact the customer: either create what
they paid for, or refund in the Paystack dashboard.

Uptime: point an external monitor (UptimeRobot, Better Stack) at
`https://<render-host>/api/health/ready` — it returns 503 when the database is down.

## Backups

```bash
npm run db:backup                 # → backups/<db>-<UTC time>.sql.gz + .sha256
```

- Consistent snapshot without locking the site (`--single-transaction`).
- Fails if the dump is incomplete.
- `.github/workflows/backup.yml` runs nightly once these repository secrets are
  set: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`. Each backup is
  kept 14 days as a private workflow artifact. Also keep a weekly copy somewhere
  else (Google Drive, S3): backups contain customer data, so store them privately.
- Before every migration: take a manual backup.

## Restoring

```bash
# 1. Restore into a NEW database next to the live one (default: <DB_NAME>_restore)
bash scripts/restore-db.sh backups/fixer-20261023T011700Z.sql.gz

# 2. Check it (row counts, recent payments), then either point the app at it
#    (change DB_NAME on Render and redeploy) or restore over the live database:
RESTORE_INTO_LIVE=yes bash scripts/restore-db.sh backups/<file>.sql.gz <live_db_name>
```

The script checks the `.sha256` first and refuses to overwrite the live
database unless you name it and set `RESTORE_INTO_LIVE=yes`.

**Prove it works (monthly):** `npm run db:verify-restore` takes a fresh backup,
restores it into a scratch database and compares every table's row count and
checksum with the source, then drops the scratch copy. CI does the same on every push.

## Deploying and rolling back

Order for a release with a migration:
1. Backup (`npm run db:backup`).
2. Apply the new file(s) in `migrations/` (in name order).
3. Deploy the backend (Render), then the frontend (Vercel).

### Roll back the code

- **Backend (Render):** Service → Events → choose the last good deploy → *Rollback*
  (or *Manual Deploy → Deploy a specific commit*). Render waits for `/api/health`
  before switching traffic; the app finishes in-flight requests on shutdown.
- **Frontend (Vercel):** Deployments → last good deployment → *Promote to Production*.
- Roll back both if the release changed the API between them.

Code is safe to roll back without touching the database as long as the
migration only **added** things (all current ones do: the older code ignores
new columns/tables).

### Roll back a migration (rarely needed)

Each `migrations/<name>.sql` has `migrations/rollback/<name>.down.sql`, tested in
CI (apply → roll back → re-apply must restore the exact schema).

1. Roll the code back first.
2. Backup.
3. Run the down files newest first, e.g.
   `mysql … < migrations/rollback/2026-10-23d_sessions_passwords.down.sql`

Notes:
- `2026-10-23d` (sessions): safe; logins keep working.
- `2026-10-18c` (technician jobs, meeting links): drops that data.
- `2026-10-18b` (repair quotes, pricing): refuses to run while repair/return
  payments exist — that's real money; restore from a backup instead.
- `2026-10-18` (payments): drops the payment ledger. Never on a database that has
  taken real payments; restore from a backup instead.

If data is wrong rather than the schema, don't roll back migrations: restore the
last good backup into a new database, compare, and copy back what's needed.
