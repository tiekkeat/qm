import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("LAN configuration forwards configured SMTP credentials to core without copying secret values", () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-email-config-"));
  try {
    mkdirSync(join(directory, "scripts"));
    const script = join(directory, "scripts/configure-hosting.py");
    copyFileSync(new URL("../deploy/templates/local-docker-lan/scripts/configure-hosting.py", import.meta.url), script);
    const configPath = join(directory, "qm.config.jsonc");
    const envPath = join(directory, ".env");
    const config = JSON.parse(
      readFileSync(new URL("../deploy/templates/local-docker-lan/qm.config.jsonc", import.meta.url), "utf8"),
    );
    config.env.auth.SMTP_PORT = "465";
    config.env.auth.SMTP_TLS = "implicit";
    writeFileSync(configPath, JSON.stringify(config));
    const run = () => {
      const result = spawnSync("python3", [script], {
        encoding: "utf8",
        env: { ...process.env, QM_PORTAL_HOST: "install.example.test", QM_APPS_DOMAIN: "apps.install.example.test" },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(readFileSync(configPath, "utf8"));
    };
    const empty = run();
    assert.equal(empty.secretEnv.core.SMTP_PASSWORD, undefined);
    const values =
      "SMTP_HOST=mail.example.test\nSMTP_USERNAME=mailer\nSMTP_PASSWORD=synthetic-secret\nAUTH_EMAIL_FROM=mailer@example.test\n";
    writeFileSync(envPath, values);
    const configured = run();
    assert.equal(configured.env.core.AUTH_EMAIL_TRANSPORT, "smtp");
    assert.equal(configured.env.core.SMTP_PORT, "465");
    assert.equal(configured.env.core.SMTP_TLS, "implicit");
    for (const name of ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"]) {
      assert.equal(configured.secretEnv.core[name], name);
    }
    assert.ok(!readFileSync(configPath, "utf8").includes("synthetic-secret"));
    assert.equal(readFileSync(envPath, "utf8"), values);
    assert.deepEqual(run(), configured);
    writeFileSync(envPath, values.replace("SMTP_PASSWORD=synthetic-secret", 'SMTP_PASSWORD=""'));
    const disabled = run();
    assert.equal(disabled.secretEnv.core.SMTP_PASSWORD, undefined);
    assert.equal(disabled.secretEnv.core.SMTP_HOST, undefined);
    assert.equal(disabled.secretEnv.core.ADMIN_GRANTS, "ADMIN_GRANTS");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
