import { createHash, randomBytes } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { LoginPolicy, PasswordTicket } from "../../plugins/chassis/src/accounts.ts";

export interface PasswordAccount {
  email: string;
  passwordHash: string;
  mustChangePassword: boolean;
  version: number;
}
export interface AccountStore {
  policy(): Promise<LoginPolicy>;
  setPolicy(policy: LoginPolicy): Promise<void>;
  get(email: string): Promise<PasswordAccount | null>;
  list(): Promise<PasswordAccount[]>;
  create(email: string, hash: string, temporary: boolean, version?: number): Promise<boolean>;
  replace(email: string, hash: string, temporary: boolean): Promise<PasswordAccount | null>;
  removeIfVersion(email: string, version: number): Promise<void>;
  issue(ticket: PasswordTicket): Promise<string>;
  ticket(token: string): Promise<PasswordTicket | null>;
  complete(token: string, hash: string | null): Promise<PasswordAccount | null>;
}
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS auth_accounts (org TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL, must_change_password BOOLEAN NOT NULL DEFAULT false, version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (org, email))`,
  `CREATE TABLE IF NOT EXISTS auth_login_policy (org TEXT PRIMARY KEY, method TEXT NOT NULL CHECK (method IN ('both','password','email')))`,
  `CREATE TABLE IF NOT EXISTS auth_password_tickets (org TEXT NOT NULL, token_hash TEXT NOT NULL, email TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, invite_id TEXT, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (org,token_hash))`,
  `CREATE INDEX IF NOT EXISTS auth_password_tickets_expiry ON auth_password_tickets(expires_at)`,
];
const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const account = (row: Record<string, unknown>): PasswordAccount => ({
  email: String(row.email),
  passwordHash: String(row.password_hash),
  mustChangePassword: Boolean(row.must_change_password),
  version: Number(row.version),
});
const ticket = (row: Record<string, unknown>): PasswordTicket => ({
  email: String(row.email),
  kind: row.kind as PasswordTicket["kind"],
  version: Number(row.version),
  ...(row.invite_id ? { inviteId: String(row.invite_id) } : {}),
});
export function createPostgresAccounts(connectionString: string, org: string): AccountStore {
  const pg = createPgPool(connectionString, "auth/accounts/0001", SCHEMA);
  return {
    async policy() {
      return (
        ((await pg.query("SELECT method FROM auth_login_policy WHERE org=$1", [org])).rows[0]?.method as LoginPolicy) ??
        "both"
      );
    },
    async setPolicy(policy) {
      await pg.query(
        "INSERT INTO auth_login_policy(org,method) VALUES($1,$2) ON CONFLICT(org) DO UPDATE SET method=EXCLUDED.method",
        [org, policy],
      );
    },
    async get(email) {
      const rows = (await pg.query("SELECT * FROM auth_accounts WHERE org=$1 AND email=$2", [org, email])).rows;
      return rows[0] ? account(rows[0]) : null;
    },
    async list() {
      return (await pg.query("SELECT * FROM auth_accounts WHERE org=$1", [org])).rows.map(account);
    },
    async create(email, hash, temporary, version = 1) {
      return (
        (
          await pg.query(
            "INSERT INTO auth_accounts(org,email,password_hash,must_change_password,version) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [org, email, hash, temporary, version],
          )
        ).rowCount === 1
      );
    },
    async removeIfVersion(email, version) {
      await pg.query("DELETE FROM auth_accounts WHERE org=$1 AND email=$2 AND version=$3", [org, email, version]);
    },
    async replace(email, hash, temporary) {
      const rows = (
        await pg.query(
          "UPDATE auth_accounts SET password_hash=$3, must_change_password=$4, version=version+1, updated_at=now() WHERE org=$1 AND email=$2 RETURNING *",
          [org, email, hash, temporary],
        )
      ).rows;
      return rows[0] ? account(rows[0]) : null;
    },
    async issue(value) {
      const token = randomBytes(32).toString("base64url");
      await pg.query("DELETE FROM auth_password_tickets WHERE expires_at<=now()");
      await pg.query(
        "INSERT INTO auth_password_tickets(org,token_hash,email,kind,version,invite_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '15 minutes')",
        [org, tokenHash(token), value.email, value.kind, value.version, value.inviteId ?? null],
      );
      return token;
    },
    async ticket(token) {
      const rows = (
        await pg.query("SELECT * FROM auth_password_tickets WHERE org=$1 AND token_hash=$2 AND expires_at>now()", [
          org,
          tokenHash(token),
        ])
      ).rows;
      return rows[0] ? ticket(rows[0]) : null;
    },
    async complete(token, hash) {
      const client = await (await pg.pool()).connect();
      try {
        await client.query("BEGIN");
        const rows = (
          await client.query(
            "SELECT * FROM auth_password_tickets WHERE org=$1 AND token_hash=$2 AND expires_at>now() FOR UPDATE",
            [org, tokenHash(token)],
          )
        ).rows;
        if (!rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        const value = ticket(rows[0]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`auth-account:${org}:${value.email}`]);
        const current = (
          await client.query("SELECT * FROM auth_accounts WHERE org=$1 AND email=$2 FOR UPDATE", [org, value.email])
        ).rows[0];
        if ((current ? Number(current.version) : 0) !== value.version || (hash === null && value.kind !== "setup")) {
          await client.query("ROLLBACK");
          return null;
        }
        let result = current
          ? account(current)
          : { email: value.email, passwordHash: "", mustChangePassword: false, version: 0 };
        if (hash !== null) {
          const saved = current
            ? await client.query(
                "UPDATE auth_accounts SET password_hash=$3,must_change_password=false,version=version+1,updated_at=now() WHERE org=$1 AND email=$2 RETURNING *",
                [org, value.email, hash],
              )
            : await client.query(
                "INSERT INTO auth_accounts(org,email,password_hash,must_change_password,version) VALUES($1,$2,$3,false,1) ON CONFLICT DO NOTHING RETURNING *",
                [org, value.email, hash],
              );
          if (!saved.rows[0]) {
            await client.query("ROLLBACK");
            return null;
          }
          result = account(saved.rows[0]);
        }
        await client.query("DELETE FROM auth_password_tickets WHERE org=$1 AND token_hash=$2", [org, tokenHash(token)]);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
