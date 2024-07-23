import { Storage } from "@google-cloud/storage";
import { exec } from "child_process";
import { unlink, writeFile } from "fs/promises";
import path from "path";
import { env } from "./env";

const storage = new Storage({
  projectId: env.GOOGLE_PROJECT_ID,
  credentials: JSON.parse(env.SERVICE_ACCOUNT_JSON),
});

const getLatestBackupFile = async (): Promise<string> => {
  console.log("Getting latest backup file from GCS...");
  const bucketName = env.GCS_BUCKET;
  const [files] = await storage.bucket(bucketName).getFiles();

  if (files.length === 0) {
    throw new Error("No backup files found in the bucket");
  }

  const backupFiles = files
    .filter(
      (file) => file.name.startsWith("backup-") && file.name.endsWith(".sql.gz")
    )
    .sort((a, b) =>
      b.metadata.timeCreated!.localeCompare(a.metadata.timeCreated!)
    );

  if (backupFiles.length === 0) {
    throw new Error("No valid backup files found in the bucket");
  }

  return backupFiles[0].name;
};

const downloadFromGCS = async ({
  name,
  path,
}: {
  name: string;
  path: string;
}) => {
  console.log(`Downloading backup ${name} from GCS...`);
  const bucketName = env.GCS_BUCKET;

  await storage.bucket(bucketName).file(name).download({ destination: path });
  console.log("Backup downloaded from GCS...");
};

const clearDatabase = async () => {
  console.log("Clearing existing database...");
  return new Promise((resolve, reject) => {
    const command = `psql -h roundhouse.proxy.rlwy.net -p 43335 -U postgres -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`;
    exec(
      command,
      { env: { ...process.env, PGPASSWORD: env.DB_PASSWORD } },
      (error, stdout, stderr) => {
        if (error) {
          console.error("Database clear error:", stderr);
          reject({ error: JSON.stringify(error), stderr });
          return;
        }
        if (stderr) {
          console.warn("Database clear warning:", stderr);
        }
        resolve(stdout);
      }
    );
  });
};

const restoreFromFile = async (filePath: string) => {
  console.log("Restoring DB from file...");
  return new Promise((resolve, reject) => {
    // Add --no-owner and --no-acl flags to ignore role-related commands
    const command = `gunzip -c ${filePath} | psql -h roundhouse.proxy.rlwy.net -p 43335 -U postgres --no-owner --no-acl`;
    exec(
      command,
      { env: { ...process.env, PGPASSWORD: env.DB_PASSWORD } },
      (error, stdout, stderr) => {
        if (error) {
          console.error("Restore error:", stderr);
          reject({ error: JSON.stringify(error), stderr });
          return;
        }
        if (stderr) {
          console.warn("Restore warning:", stderr);
        }
        resolve(stdout);
      }
    );
  });
};

export const restore = async () => {
  try {
    console.log("Initiating DB restore...");

    const latestBackupFilename = await getLatestBackupFile();
    console.log(`Latest backup file: ${latestBackupFilename}`);

    const filepath = `${latestBackupFilename}`;

    console.log(`Downloading file: ${latestBackupFilename}`);
    await downloadFromGCS({ name: latestBackupFilename, path: filepath });

    console.log("Clearing existing database...");
    await clearDatabase();

    console.log(`Restoring from file: ${filepath}`);
    await restoreFromFile(filepath);

    console.log(`Deleting temporary file: ${filepath}`);
    await unlink(filepath);

    console.log("DB restore complete...");
  } catch (error) {
    console.error("Restore failed:", error);
  }
};
