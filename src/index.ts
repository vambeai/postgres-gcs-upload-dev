import { CronJob } from "cron";

import { restore } from "./backup";
import { env } from "./env";

const tryBackup = async () => {
  try {
    await restore();
  } catch (error) {
    console.error("Error while running backup: ", error);
  }
};

const job = new CronJob(env.BACKUP_CRON_SCHEDULE, async () => {
  await tryBackup();
});

if (env.RUN_ON_STARTUP) {
  tryBackup();
}
job.start();

console.log("Backup cron scheduled...");

