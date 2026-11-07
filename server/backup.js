import { backup } from 'node:sqlite';
import { mkdirSync, cpSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dataDir=resolve(process.env.DATA_DIR||join(root,'data'));
const backupRoot=resolve(process.env.BACKUP_DIR||join(dataDir,'backups'));
const stamp=new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
const destination=join(backupRoot,stamp);
mkdirSync(destination,{recursive:true,mode:0o700});
const db=openDatabase(join(dataDir,'slipbloom.sqlite'));
try {
  await backup(db,join(destination,'slipbloom.sqlite'));
  chmodSync(join(destination,'slipbloom.sqlite'),0o600);
  if(existsSync(join(dataDir,'uploads')))cpSync(join(dataDir,'uploads'),join(destination,'uploads'),{recursive:true});
  console.log(destination);
} finally {db.close();}
