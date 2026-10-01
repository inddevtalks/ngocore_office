import os
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger
from dotenv import load_dotenv
from emailer import send_daily_emails

load_dotenv()

hhmm = os.getenv("DAILY_EMAIL_TIME", "09:00")
hour, minute = [int(x) for x in hhmm.split(":")]

scheduler = BlockingScheduler()
scheduler.add_job(
    send_daily_emails,
    CronTrigger(hour=hour, minute=minute),
    id="daily-task-email",
    replace_existing=True,
)

print(f"Daily task email scheduler running at {hhmm}.")
scheduler.start()
