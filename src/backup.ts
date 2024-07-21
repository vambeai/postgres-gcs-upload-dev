import { Storage, UploadOptions } from "@google-cloud/storage";
import { exec } from "child_process";
import { mkdir, stat, unlink } from "fs/promises";
import path from "path";

import { env } from "./env";

const uploadToGCS = async ({ name, path }: { name: string; path: string }) => {
  console.log("Uploading backup to GCS...");

  const bucketName = env.GCS_BUCKET;

  const uploadOptions: UploadOptions = {
    destination: name,
  };

  const storage = new Storage({
    projectId: env.GOOGLE_PROJECT_ID,
    credentials: JSON.parse(env.SERVICE_ACCOUNT_JSON),
  });

  await storage.bucket(bucketName).upload(path, uploadOptions);

  console.log("Backup uploaded to GCS...");
};

const ensureDirectoryExists = async (filePath: string) => {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
};

const dumpToFile = async (filePath: string) => {
  console.log("Dumping DB to file...");
  await ensureDirectoryExists(filePath);
  return new Promise((resolve, reject) => {
    const command = `pg_dumpall -h viaduct.proxy.rlwy.net -p 57886 -U postgres | gzip > ${filePath}`;
    exec(
      command,
      { env: { ...process.env, PGPASSWORD: env.DB_PASSWORD } },
      (error, stdout, stderr) => {
        if (error) {
          console.error("pg_dumpall error:", stderr);
          reject({ error: JSON.stringify(error), stderr });
          return;
        }
        if (stderr) {
          console.warn("pg_dumpall warning:", stderr);
        }
        resolve(stdout);
      }
    );
  });
};

const deleteFile = async (path: string) => {
  console.log("Deleting file...");
  try {
    await unlink(path);
    console.log("File deleted successfully");
  } catch (error) {
    console.error("Error deleting file:", error);
    throw error; // Re-throw the error if you want to handle it in the calling function
  }
};

export const backup = async () => {
  try {
    console.log("Initiating DB backup...");

    let date = new Date().toISOString();
    const timestamp = date.replace(/[:.]+/g, "-");
    const filename = `backup-${timestamp}.sql.gz`;
    const filepath = `/tmp/bucket-ai/${filename}`;

    console.log(`Dumping to file: ${filepath}`);
    await dumpToFile(filepath);

    const stats = await stat(filepath);
    console.log(`File size after dump: ${stats.size} bytes`);

    console.log(`Uploading file: ${filename}`);
    await uploadToGCS({ name: filename, path: filepath });

    console.log(`Deleting file: ${filepath}`);
    await deleteFile(filepath);

    console.log("DB backup complete...");
  } catch (error) {
    console.error("Backup failed:", error);
  }
};
