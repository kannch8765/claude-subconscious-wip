import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { getDurableStateDir } from './conversation_utils.js';
import type { LiveWorkerPayload } from './send_worker_native.js';
import type { TranscriptMessage } from './transcript_utils.js';

export interface MaintenanceQueueJob {
  schema_version: 1;
  job_id: string;
  session_id: string;
  start_index: number;
  through_index: number;
  created_at: string;
  payload: LiveWorkerPayload;
  transcript_messages: TranscriptMessage[];
}

export interface MaintenanceDrainLock {
  lock_path: string;
  owner_path: string;
  token: string;
}

type DrainOwner = { pid: number; token: string; created_at: string };

const STALE_UNPUBLISHED_LOCK_MS = 30_000;

function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
}

export function maintenanceQueueSessionDir(cwd: string, sessionId: string): string {
  return path.join(getDurableStateDir(cwd), 'maintenance-queue', sessionKey(sessionId));
}

export function maintenanceQueueJobsDir(cwd: string, sessionId: string): string {
  return path.join(maintenanceQueueSessionDir(cwd, sessionId), 'jobs');
}

function jobFile(cwd: string, sessionId: string, jobId: string): string {
  return path.join(maintenanceQueueJobsDir(cwd, sessionId), `${encodeURIComponent(jobId)}.json`);
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function sameJob(a: MaintenanceQueueJob, b: MaintenanceQueueJob): boolean {
  return a.job_id === b.job_id
    && a.session_id === b.session_id
    && a.start_index === b.start_index
    && a.through_index === b.through_index
    && JSON.stringify(a.payload) === JSON.stringify(b.payload)
    && JSON.stringify(a.transcript_messages) === JSON.stringify(b.transcript_messages);
}

export function publishMaintenanceQueueJob(cwd: string, job: MaintenanceQueueJob): MaintenanceQueueJob {
  if (job.schema_version !== 1) throw new Error('unsupported maintenance queue job schema');
  if (!job.job_id || !job.session_id) throw new Error('maintenance queue job requires job_id and session_id');
  if (!Number.isInteger(job.start_index) || !Number.isInteger(job.through_index) || job.through_index <= job.start_index) {
    throw new Error('maintenance queue job requires a non-empty integer transcript range');
  }
  const file = jobFile(cwd, job.session_id, job.job_id);
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as MaintenanceQueueJob;
    if (!sameJob(existing, job)) throw new Error(`maintenance queue job collision for ${job.job_id}`);
    return existing;
  }
  atomicWriteJson(file, job);
  return job;
}

function parseJob(file: string): MaintenanceQueueJob {
  const job = JSON.parse(fs.readFileSync(file, 'utf8')) as MaintenanceQueueJob;
  if (
    job?.schema_version !== 1
    || typeof job.job_id !== 'string'
    || typeof job.session_id !== 'string'
    || !Number.isInteger(job.start_index)
    || !Number.isInteger(job.through_index)
    || job.through_index <= job.start_index
    || !job.payload
    || !Array.isArray(job.transcript_messages)
  ) throw new Error(`invalid maintenance queue job ${file}`);
  return job;
}

export function listMaintenanceQueueJobs(cwd: string, sessionId: string): MaintenanceQueueJob[] {
  const dir = maintenanceQueueJobsDir(cwd, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => parseJob(path.join(dir, name)))
    .filter((job) => job.session_id === sessionId)
    .sort((a, b) => a.start_index - b.start_index || a.through_index - b.through_index || a.job_id.localeCompare(b.job_id));
}

export function removeMaintenanceQueueJob(cwd: string, sessionId: string, jobId: string): void {
  try { fs.unlinkSync(jobFile(cwd, sessionId, jobId)); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === 'EPERM'; }
}

function readOwner(file: string): DrainOwner | null {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as DrainOwner;
    return Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner?.token === 'string' && owner.token
      ? owner
      : null;
  } catch { return null; }
}

export function acquireMaintenanceDrainLock(cwd: string, sessionId: string): MaintenanceDrainLock | null {
  const dir = maintenanceQueueSessionDir(cwd, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, 'drain.lock');
  const ownerPath = path.join(lockPath, 'owner.json');

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        try { fs.rmdirSync(lockPath); } catch {}
        throw error;
      }
      return { lock_path: lockPath, owner_path: ownerPath, token };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = readOwner(ownerPath);
      if (owner && processIsAlive(owner.pid)) return null;
      if (!owner) {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs < STALE_UNPUBLISHED_LOCK_MS) return null;
      }
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
    }
  }
  return null;
}

export function releaseMaintenanceDrainLock(lock: MaintenanceDrainLock): void {
  const owner = readOwner(lock.owner_path);
  if (!owner || owner.token !== lock.token) return;
  try { fs.unlinkSync(lock.owner_path); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  try { fs.rmdirSync(lock.lock_path); } catch (error: any) { if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error; }
}
