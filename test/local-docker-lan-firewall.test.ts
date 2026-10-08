import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const firewall = readFileSync(
  new URL("../deploy/templates/local-docker-lan/system/firewall.sh", import.meta.url),
  "utf8",
);

for (const mode of ["external", "local"] as const) {
  test(`LAN firewall preserves HTTPS access with ${mode} DNS`, () => {
    const directory = mkdtempSync(join(tmpdir(), "qm-firewall-"));
    try {
      const config = join(directory, "hosting.env");
      const log = join(directory, "iptables.log");
      const executable = join(directory, "iptables");
      writeFileSync(config, `QM_LAN_IP=192.0.2.10\n${mode === "external" ? "QM_MANAGE_HOST_DNS=0\n" : ""}`);
      writeFileSync(
        executable,
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$QM_FIREWALL_TEST_LOG"\nif [[ "$2" == -C ]]; then exit 1; fi\n',
      );
      chmodSync(executable, 0o755);
      const result = spawnSync(
        "bash",
        ["-c", firewall.replace("source /etc/qm-lan/hosting.env", 'source "$QM_FIREWALL_TEST_CONFIG"')],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            QM_FIREWALL_TEST_CONFIG: config,
            QM_FIREWALL_TEST_LOG: log,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const commands = readFileSync(log, "utf8").trim().split("\n");
      assert.ok(commands.includes("-w -A QM-LAN -d 192.0.2.10 -j ACCEPT"));
      assert.ok(commands.every((command) => !command.includes(" -s ")));
      const ingress = commands.filter((command) => command.includes("-I INPUT"));
      assert.ok(ingress.some((command) => command.includes("-p tcp --dport 443 ")));
      assert.ok(ingress.some((command) => command.includes("-p tcp --dport 8443 ")));
      assert.equal(
        ingress.some((command) => command.includes("--dport 53 ")),
        mode === "local",
      );
      if (mode === "local") {
        assert.ok(ingress.some((command) => command.includes("-p udp --dport 53 ")));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
