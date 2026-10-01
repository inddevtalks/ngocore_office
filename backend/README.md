# Office Task Hub — Backend

## Run on Windows PowerShell

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
python app.py
```

Backend: http://localhost:5000

Seed demo data:
```powershell
Invoke-RestMethod -Method POST http://localhost:5000/api/seed
```

## Daily email

1. Fill SMTP values in `.env`.
2. Set `DAILY_EMAIL_TIME=09:00`.
3. Start the scheduler in another terminal:

```powershell
python scheduler.py
```

The email contains each member's open tasks and a link to the frontend.

For production, run the scheduler as a Windows Task Scheduler/service or use your hosting provider's scheduled-job facility.
