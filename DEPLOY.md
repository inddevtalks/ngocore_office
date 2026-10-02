# Deploying NGOCORE OFFICE to Vercel

Vercel runs each request in a short-lived function with a read-only, ephemeral
filesystem. Two parts of this app were built on the assumption of a normal disk
and had to change before it could run there:

| Local assumption | What happens on Vercel | Fix applied |
| --- | --- | --- |
| `instance/office_tasks.db` holds the data | File is wiped on every deploy; the app starts empty | `DATABASE_URL` now accepts Postgres, so data lives in Neon |
| `instance/outbox.json` holds the email log | File is wiped; Email Center is always empty | New `email_log` table; the JSON file is now a local-only mirror |
| APScheduler sends the daily digest | No background threads exist in serverless | `/api/cron/daily-emails` endpoint driven by Vercel Cron |
| Email Center writes credentials to `.env` | Read-only, so saving appeared to work but was lost on the next cold start | Returns a message telling you to set Vercel env vars |

## 1. Create the Neon database

1. Sign up at [neon.tech](https://neon.tech) and create a project named
   `ngocore-office`.
2. Neon gives you a default Postgres database. Copy its **connection string**.
   It looks like this:
   ```
   postgresql://USER:PASSWORD@ep-xxx.aws.neon.tech/neondb?sslmode=require
   ```
3. Leave the branch as-is. Leave pooling off to start; the free tier is enough.

You do not need to create any tables. The app runs `db.create_all()` on startup,
so it builds its own schema.

## 2. Move your existing data across (optional but recommended)

Your current members and tasks live in `backend/instance/office_tasks.db`.
To bring them over rather than starting empty, use the migration script:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
$env:DATABASE_URL = "postgresql://USER:PASSWORD@ep-xxx.aws.neon.tech/neondb?sslmode=require"
python -m migrate_to_postgres
```

It copies members, tasks, and the email log, then prints row counts so you can
confirm. See `backend/migrate_to_postgres.py`.

## 3. Set the environment variables

In the Vercel project under **Settings > Environment Variables**, add:

| Variable | Value | Required |
| --- | --- | --- |
| `DATABASE_URL` | Your Neon connection string | Yes |
| `SECRET_KEY` | Any long random string, e.g. `python -c "import secrets; print(secrets.token_hex(32))"` | Yes |
| `ADMIN_PASSWORD` | Password for the manager dashboard. Same command. Without it the dashboard is open to anyone. | Strongly recommended |
| `CRON_SECRET` | Another random string, same command | Yes |
| `FRONTEND_URL` | Your Vercel domain, e.g. `https://ngocore-office.vercel.app` | Yes |
| `QA_SITE_URL` | The site the QA bot audits. Defaults to `https://ngocore.in`. | No |
| `SMTP_HOST` | `smtp.gmail.com` | For live email |
| `SMTP_PORT` | `587` | For live email |
| `SMTP_USERNAME` | Your Gmail address | For live email |
| `SMTP_PASSWORD` | Your 16-character Google App Password | For live email |
| `SMTP_FROM` | Your Gmail address | For live email |

Set them for **Production**. Preview deployments get them too if you want to
test against the same database, but note that both write to the same tables.

`FRONTEND_URL` matters: it is what turns into the `?portal=<id>` links inside
task-assignment emails. If it is wrong, employees get links pointing at
localhost.

Generate the two secrets:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

## 4. Deploy

From the project root, not from `backend/` or `frontend/`:

```powershell
npx vercel login
npx vercel
npx vercel --prod
```

`vercel.json` handles the rest: it builds the React frontend as static output,
routes `/api/*` to the Flask function, and registers the daily cron.

If the CLI asks about a framework preset, choose **Other**. Vercel's Flask
preset expects the app at the repo root; yours lives in `backend/`, and
`vercel.json` already points at it.

## 5. Check it worked

```powershell
# Should print ok: True
curl.exe https://YOUR-DOMAIN.vercel.app/api/health
```

Then open the domain, add a team member, assign a task, and confirm the person
card appears. Try a redeploy afterwards and confirm the data is still there,
which is the real test that the database is wired up.

To trigger the daily digest manually for a test:

```powershell
curl.exe -H "Authorization: Bearer YOUR_CRON_SECRET" https://YOUR-DOMAIN.vercel.app/api/cron/daily-emails
```

## Things to know

**The daily digest runs at 09:00 UTC**, set in `vercel.json`. That is not your
local timezone. Edit the `schedule` field to match; Vercel Cron only allows
one schedule per path, and the free tier allows daily-or-more-frequent jobs,
so once a day is the finest granularity for a specific time.

**The QA bot checks `https://ngocore.in` at 06:30 UTC** by the same mechanism.
Because the free tier allows only one scheduled invocation per day per project,
this is why the dashboard also has a **Run Check Now** button. Change the target
site with the `QA_SITE_URL` environment variable.

**Deleting a member deletes their tasks.** That was already true locally, via
the SQLAlchemy cascade. The UI now warns you with the task count before you
confirm.

**Manager access needs a password.** Set `ADMIN_PASSWORD` as a Vercel
environment variable, otherwise anyone with the URL can read your whole team
and task list. Employees do not need it; they open their own portal link.

**Employee portal links are guessable.** A portal is just `?portal=<id>`, so
one member can open another's by changing the number. The API blocks them from
editing anyone else's task, but they can still read it. If that matters, the
fix is a unique random token per member rather than a sequential id.

**SQLite still works locally.** Leave `DATABASE_URL=sqlite:///office_tasks.db`
in `backend/.env` and nothing about your local workflow changes.

**APScheduler is now unused on Vercel** but `backend/scheduler.py` still works
for local use. Keep it if you want a local daily digest during development.