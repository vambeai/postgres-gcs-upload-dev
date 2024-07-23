import { Storage } from "@google-cloud/storage";
import { exec } from "child_process";
import { unlink } from "fs/promises";
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
    const connectionString = env.BACKUP_DATABASE_URL;
    const command = `psql "${connectionString}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`;
    exec(command, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
      if (error) {
        console.error("Database clear error:", stderr);
        reject({ error: JSON.stringify(error), stderr });
        return;
      }
      if (stderr) {
        console.warn("Database clear warning:", stderr);
      }
      resolve(stdout);
    });
  });
};

const restoreFromFile = async (filePath: string) => {
  console.log("Restoring DB from file...");
  return new Promise((resolve, reject) => {
    const restoreCommand = `gunzip -c ${filePath} | psql -h roundhouse.proxy.rlwy.net -p 43335 -U postgres -d railway -v ON_ERROR_STOP=1`;
    const childProcess = exec(
      restoreCommand,
      {
        env: { ...process.env, PGPASSWORD: env.DB_PASSWORD },
        maxBuffer: 1024 * 1024 * 500, // Increase buffer size
        timeout: 300000, // Increase timeout to 5 minutes
      },
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

    childProcess.stdout!.on("data", (data) => {
      console.log(`stdout: ${data}`);
    });

    childProcess.stderr!.on("data", (data) => {
      console.error(`stderr: ${data}`);
    });
  });
};

const retryOperation = async (operation: Function, retries: number = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === retries) throw error;
      console.warn(`Attempt ${attempt} failed. Retrying...`);
    }
  }
};

export const restore = async () => {
  try {
    console.log("Initiating DB restore...");

    const latestBackupFilename = await getLatestBackupFile();
    console.log(`Latest backup file: ${latestBackupFilename}`);

    const filepath = `${latestBackupFilename}`;

    console.log(`Downloading file: ${latestBackupFilename}`);
    await retryOperation(() =>
      downloadFromGCS({ name: latestBackupFilename, path: filepath })
    );

    console.log("Clearing existing database...");
    await retryOperation(clearDatabase);

    console.log(`Restoring from file: ${filepath}`);
    await retryOperation(() => restoreFromFile(filepath));

    console.log(`Deleting temporary file: ${filepath}`);
    await unlink(filepath);

    console.log("DB restore complete...");
  } catch (error) {
    console.error("Restore failed:", error);
  }
};
