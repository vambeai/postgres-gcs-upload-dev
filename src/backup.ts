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
      (file) => file.name.startsWith("backup-") && file.name.endsWith(".dump")
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

const testConnection = async () => {
  console.log("Testing connection to the database...");
  return new Promise((resolve, reject) => {
    const connectionString = env.BACKUP_DATABASE_URL;
    const command = `psql "${connectionString}" -c "SELECT 1;"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Connection test error:", stderr);
        reject({ error: JSON.stringify(error), stderr });
        return;
      }
      if (stderr) {
        console.warn("Connection test warning:", stderr);
      }
      resolve(stdout);
    });
  });
};

const restoreFromFile = async (filePath: string) => {
  console.log("Restoring DB from file...");
  return new Promise((resolve, reject) => {
    const restoreCommand = `pg_restore -h roundhouse.proxy.rlwy.net -p 43335 -U postgres -d railway -v --connect-timeout=3000 ${filePath}`;
    const childProcess = exec(
      restoreCommand,
      {
        env: { ...process.env, PGPASSWORD: env.DB_PASSWORD },
        maxBuffer: 1024 * 1024 * 500, // Increase buffer size
        timeout: 1200000, // Increase timeout to 20 minutes
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

const retryOperation = async (
  operation: Function,
  retries: number = 3,
  delay: number = 5000
) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === retries) throw error;
      console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
      await new Promise((res) => setTimeout(res, delay));
      delay *= 2; // Exponential backoff
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

    console.log("Testing connection to the database...");
    await retryOperation(testConnection);

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
