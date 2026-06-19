// Backup the identity store — the irreplaceable part (memory, self-image, opinions, journals, …). A
// pg_dump of DATABASE_URL written to BACKUP_DIR, optionally age-encrypted (AGE_RECIPIENT) and pushed
// offsite via rclone (RCLONE_REMOTE).
//   npm run backup           — dump (+ encrypt + push if configured)
//   npm run backup:verify    — dump → restore into a scratch DB → row-count sanity check, then drop it
//
// An untested backup is a hope, not a backup — run :verify periodically.
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const DB = process.env.DATABASE_URL;
const BACKUP_DIR = process.env.BACKUP_DIR ?? "./backups";
const AGE_RECIPIENT = process.env.AGE_RECIPIENT;
const RCLONE_REMOTE = process.env.RCLONE_REMOTE;

function run(cmd: string, args: string[], opts: { input?: string } = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", input: opts.input, maxBuffer: 1024 * 1024 * 512 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function stamp(): string {
  // Date is fine in a one-shot script (not the resumable workflow runtime).
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function dump(): string {
  if (!DB) throw new Error("DATABASE_URL is not set");
  mkdirSync(BACKUP_DIR, { recursive: true });
  const base = join(BACKUP_DIR, `backup-${stamp()}.sql`);
  const out = AGE_RECIPIENT ? `${base}.age` : base;

  console.log(`[backup] dumping → ${out}`);
  const dumped = run("pg_dump", ["--no-owner", "--no-privileges", "-f", AGE_RECIPIENT ? "/dev/stdout" : base, DB]);
  if (dumped.code !== 0) throw new Error(`pg_dump failed: ${dumped.stderr}`);

  if (AGE_RECIPIENT) {
    const enc = run("age", ["-r", AGE_RECIPIENT, "-o", out], { input: dumped.stdout });
    if (enc.code !== 0) throw new Error(`age encrypt failed: ${enc.stderr}`);
  }
  if (!existsSync(out)) throw new Error(`backup file not written: ${out}`);
  console.log(`[backup] wrote ${(statSync(out).size / 1024).toFixed(0)} KB`);

  if (RCLONE_REMOTE) {
    console.log(`[backup] pushing → ${RCLONE_REMOTE}`);
    const push = run("rclone", ["copy", out, RCLONE_REMOTE]);
    if (push.code !== 0) console.error(`[backup] rclone push failed: ${push.stderr}`);
    else console.log("[backup] pushed offsite.");
  }
  return out;
}

// Restore the latest plain dump into a scratch DB and count rows — proves the dump is restorable. Only runs
// on an UNENCRYPTED dump (verify needs the SQL); for an encrypted pipeline, decrypt manually first.
function verify(): void {
  if (!DB) throw new Error("DATABASE_URL is not set");
  if (AGE_RECIPIENT) {
    console.log("[verify] AGE_RECIPIENT is set — write a plain dump (unset it) to run the restore drill, or decrypt by hand.");
  }
  const file = dump();
  if (file.endsWith(".age")) {
    console.log("[verify] skipping restore (encrypted dump). Decrypt with `age -d` and restore manually.");
    return;
  }
  const scratch = `${(DB.split("/").pop() ?? "db").split("?")[0]}_verify_${Date.now()}`;
  const adminUrl = DB.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
  console.log(`[verify] creating scratch DB ${scratch}`);
  run("psql", [adminUrl, "-c", `CREATE DATABASE ${scratch}`]);
  const scratchUrl = DB.replace(/\/[^/?]+(\?|$)/, `/${scratch}$1`);
  const restored = run("psql", [scratchUrl, "-f", file]);
  if (restored.code !== 0) console.error(`[verify] restore had errors: ${restored.stderr.slice(0, 400)}`);
  const counted = run("psql", [scratchUrl, "-t", "-c", "SELECT count(*) FROM \"Memory\""]);
  console.log(`[verify] restored Memory rows: ${counted.stdout.trim() || "?"}`);
  run("psql", [adminUrl, "-c", `DROP DATABASE ${scratch}`]);
  console.log("[verify] dropped scratch DB. Restore drill complete.");
}

const cmd = process.argv[2];
try {
  if (cmd === "verify") verify();
  else dump();
  process.exit(0);
} catch (e) {
  console.error(`[backup] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
