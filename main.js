// --- START OF FILE backup.js ---

import fs from 'fs';
import { exec } from 'child_process';
import archiver from 'archiver';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import inquirer from 'inquirer'; // Untuk menu interaktif
import unzipper from 'unzipper'; // Untuk ekstrak file zip

// Load environment variables
dotenv.config();

// --- Validasi Environment Variable ---
const requiredEnvVars = [
  'DB_HOST', 'DB_USER', 'DB_NAME',
  'GDRIVE_CLIENT_EMAIL', 'GDRIVE_PRIVATE_KEY', 'GDRIVE_FOLDER_ID'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}
if (process.env.DB_PASSWORD === undefined) {
    throw new Error(`Missing required environment variable: DB_PASSWORD. If you have no password, set it to DB_PASSWORD= in your .env file.`);
}

// --- Konfigurasi ---
const {
  DB_HOST, DB_USER, DB_PASSWORD, DB_NAME,
  GDRIVE_CLIENT_EMAIL, GDRIVE_PRIVATE_KEY, GDRIVE_FOLDER_ID
} = process.env;

// Inisialisasi Google Drive
const auth = new google.auth.JWT({
  email: GDRIVE_CLIENT_EMAIL,
  key: GDRIVE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/drive.file']
});
const drive = google.drive({ version: 'v3', auth });
const passwordArg = DB_PASSWORD ? `-p${DB_PASSWORD}` : '';

// =================================================================
// ||                      FUNGSI-FUNGSI BACKUP                     ||
// =================================================================

const dumpDatabase = (dumpFile) => {
  return new Promise((resolve, reject) => {
    console.log(`📦 Creating database dump for ${DB_NAME}...`);
    const cmd = `mysqldump -h ${DB_HOST} -u ${DB_USER} ${passwordArg} ${DB_NAME} > ${dumpFile}`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('❌ Database dump failed:', stderr);
        return reject(new Error(`Database dump failed: ${error.message}`));
      }
      console.log('✅ Database dump created successfully.');
      resolve();
    });
  });
};

const zipFileFunc = (dumpFile, zipFile) => {
  return new Promise((resolve, reject) => {
    console.log(`🗜 Compressing ${dumpFile}...`);
    const output = fs.createWriteStream(zipFile);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`✅ File compressed: ${zipFile} (${archive.pointer()} bytes)`);
      resolve();
    });
    archive.on('error', (err) => {
      console.error('❌ Compression failed:', err);
      reject(new Error(`Compression failed: ${err.message}`));
    });

    archive.pipe(output);
    archive.file(dumpFile, { name: dumpFile });
    archive.finalize();
  });
};

const uploadToGoogleDrive = async (zipFile) => {
  console.log(`☁️ Uploading ${zipFile} to Google Drive...`);
  const fileMetadata = { name: zipFile, parents: [GDRIVE_FOLDER_ID] };
  const media = { mimeType: 'application/zip', body: fs.createReadStream(zipFile) };

  const response = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id,name,webViewLink'
  });

  console.log('✅ Upload successful:', {
    fileId: response.data.id,
    name: response.data.name,
    link: response.data.webViewLink
  });
};

// =================================================================
// ||                     FUNGSI-FUNGSI RESTORE                     ||
// =================================================================

const listBackupsFromDrive = async () => {
    console.log('🔍 Listing backups from Google Drive...');
    const res = await drive.files.list({
        q: `'${GDRIVE_FOLDER_ID}' in parents and name contains 'backup-' and mimeType='application/zip' and trashed = false`,
        fields: 'files(id, name, createdTime)',
        orderBy: 'createdTime desc',
        pageSize: 20,
    });
    return res.data.files;
};

const downloadFileFromDrive = (fileId, fileName) => {
    return new Promise(async (resolve, reject) => {
        console.log(`🔽 Downloading ${fileName}...`);
        const dest = fs.createWriteStream(fileName);
        try {
            const res = await drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream' }
            );
            res.data
                .on('end', () => {
                    console.log('✅ Download complete.');
                    resolve();
                })
                .on('error', err => {
                    console.error('❌ Error during download.', err);
                    reject(err);
                })
                .pipe(dest);
        } catch (error) {
            reject(error);
        }
    });
};

const unzipRestoreFile = (zipFile) => {
    return new Promise((resolve, reject) => {
        const sqlFile = zipFile.replace('.zip', '');
        console.log(`🗜 Unzipping ${zipFile}...`);
        fs.createReadStream(zipFile)
            .pipe(unzipper.Extract({ path: '.' }))
            .on('close', () => {
                console.log(`✅ Unzipped to ${sqlFile}.`);
                resolve(sqlFile);
            })
            .on('error', (err) => {
                console.error('❌ Unzip failed.', err);
                reject(err);
            });
    });
};

const importDatabase = (sqlFile) => {
    return new Promise((resolve, reject) => {
        console.log(`🔧 Restoring database from ${sqlFile}...`);
        const cmd = `mysql -h ${DB_HOST} -u ${DB_USER} ${passwordArg} ${DB_NAME} < ${sqlFile}`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Database restore failed:', stderr);
                return reject(new Error(`Database restore failed: ${error.message}`));
            }
            console.log('✅ Database restored successfully.');
            resolve();
        });
    });
};


// =================================================================
// ||                    PROSES UTAMA & CLEANUP                   ||
// =================================================================

const cleanup = (files) => {
  console.log('🧹 Cleaning up temporary files...');
  files.forEach(file => {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`   - Deleted: ${file}`);
      }
    } catch (err) {
      console.error(`   - Failed to delete ${file}:`, err.message);
    }
  });
};

const runBackupProcess = async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpFile = `backup-${DB_NAME}-${timestamp}.sql`;
    const zipFile = `${dumpFile}.zip`;
    
    try {
        await dumpDatabase(dumpFile);
        await zipFileFunc(dumpFile, zipFile);
        await uploadToGoogleDrive(zipFile);
        console.log('\n🎉 Backup completed successfully!');
    } catch (error) {
        console.error('\n🔥 Backup failed:', error.message);
        process.exitCode = 1;
    } finally {
        cleanup([dumpFile, zipFile]);
    }
};

const runRestoreProcess = async () => {
    let downloadedZipFile = '';
    let extractedSqlFile = '';

    try {
        const files = await listBackupsFromDrive();
        if (files.length === 0) {
            console.log('🤷 No backup files found in the specified Google Drive folder.');
            return;
        }

        const { fileToRestore } = await inquirer.prompt([
            {
                type: 'list',
                name: 'fileToRestore',
                message: 'Select a backup to restore:',
                choices: files.map(f => ({
                    name: `${f.name} (Created: ${new Date(f.createdTime).toLocaleString()})`,
                    value: f,
                })),
            },
        ]);

        const { confirm } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirm',
                message: `ARE YOU SURE you want to restore from "${fileToRestore.name}"?\n  This will OVERWRITE the current "${DB_NAME}" database.`,
                default: false,
            }
        ]);

        if (!confirm) {
            console.log('🛑 Restore cancelled.');
            return;
        }

        downloadedZipFile = fileToRestore.name;
        await downloadFileFromDrive(fileToRestore.id, downloadedZipFile);
        extractedSqlFile = await unzipRestoreFile(downloadedZipFile);
        await importDatabase(extractedSqlFile);

        console.log('\n🎉 Restore completed successfully!');

    } catch (error) {
        console.error('\n🔥 Restore failed:', error.message);
        process.exitCode = 1;
    } finally {
        cleanup([downloadedZipFile, extractedSqlFile].filter(Boolean)); // Hanya cleanup file yang ada
    }
};


// =================================================================
// ||                         MENU UTAMA                          ||
// =================================================================

const showMainMenu = async () => {
    console.clear();
    console.log('====================================');
    console.log('   Database Backup & Restore Tool   ');
    console.log('====================================');
    
    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'What do you want to do?',
            choices: [
                { name: '1. Backup Database to Google Drive', value: 'backup' },
                { name: '2. Restore Database from Google Drive', value: 'restore' },
                new inquirer.Separator(),
                { name: 'Exit', value: 'exit' },
            ],
        },
    ]);

    switch (action) {
        case 'backup':
            await runBackupProcess();
            break;
        case 'restore':
            await runRestoreProcess();
            break;
        case 'exit':
            console.log('👋 Goodbye!');
            process.exit(0);
    }
};

// Jalankan aplikasi
showMainMenu().catch(err => {
    console.error("An unexpected error occurred:", err);
    process.exit(1);
});