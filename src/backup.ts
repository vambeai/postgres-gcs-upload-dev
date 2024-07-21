import { Storage, UploadOptions } from "@google-cloud/storage";
import { exec } from "child_process";
import { unlink } from "fs";

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

const dumpToFile = async (path: string) => {
  console.log("Dumping DB to file...");

  await new Promise((resolve, reject) => {
    const command = `pg_dump ${env.BACKUP_DATABASE_URL} | gzip > ${path}`;
    exec(command, (error, _, stderr) => {
      if (error) {
        reject({ error: JSON.stringify(error), stderr });
        return;
      }
      resolve(undefined);
    });
  });

  console.log("DB dumped to file...");
};

const deleteFile = async (path: string) => {
  console.log("Deleting file...");
  await new Promise((resolve, reject) => {
    unlink(path, (err) => {
      if (err) {
        reject({ error: JSON.stringify(err) });
        return;
      }
      resolve(undefined);
    });
  });
};

export const backup = async () => {
  try {
    console.log("Initiating DB backup...");

    let date = new Date().toISOString();
    const timestamp = date.replace(/[:.]+/g, "-");
    const filename = `${env.BACKUP_PREFIX}backup-${timestamp}.sql.gz`;
    const filepath = `/tmp/${filename}`;

    console.log(`Dumping to file: ${filepath}`);
    await dumpToFile(filepath);

    console.log(`Uploading file: ${filename}`);
    await uploadToGCS({ name: filename, path: filepath });

    console.log(`Deleting file: ${filepath}`);
    await deleteFile(filepath);

    console.log("DB backup complete...");
  } catch (error) {
    console.error("Backup failed:", error);
  }
};
