# Deploy QM with private app hostnames

`qm.example.com` is a placeholder hostname, not a QM default. Set your own portal hostname in `hosting.env`; published apps then use `https://<app>.apps.<portal-host>/`. QM core checks sign-in and app sharing grants before proxying each app. The `/d/<app>/` path viewer restricts JavaScript modules, so web apps need these separate hostnames.

## Guided Ubuntu installation

Use Ubuntu 24.04 x86_64 with Internet access, a permanent IPv4 address, and a normal user who can run sudo. Install Git first if it is missing. Keep the source checkout and deployment directory alongside each other:

```bash
git clone --branch feat/app-github-lifecycle https://github.com/tiekkeat/qm.git qm
cp -a qm/deploy/templates/local-docker-lan qm-deployment
cd qm-deployment
bash scripts/install.sh
```

No coding assistant or model API key is required to install and administer the stack. The installer prompts for the portal hostname, source directory, network interface, permanent IPv4 address, subnet prefix, firewall DNS server, and administrator email. Existing hosting settings and credentials are reused. Edit `orgName` in `qm.config.jsonc` to change the organization display name; this template keeps the internal resource ID `qm-local` and supports one stack per host.

Before the DNS verification stage, configure your firewall or existing DNS server:

| Record                 | Value                                    |
| ---------------------- | ---------------------------------------- |
| `<portal-host>`        | The Docker host's permanent IPv4 address |
| `*.apps.<portal-host>` | The same IPv4 address                    |

QM chooses the app from its hostname and enforces sharing grants. No individual app DNS records are needed. The installer queries the supplied DNS server for verification; it does not change host or Docker DNS, gateways, or firewall DNS records. If the host's default resolver cannot see the private zone, core may log a DNS warning even when the explicit firewall checks pass.

The installer checks or installs basic tools, installs checksum-verified Node 24.21.0 when an adequate Node/npm is absent, runs `npm ci` with the pinned CLI 0.1.14, generates missing signing/encryption secrets, and sets administrator access. It installs Docker/Buildx and Caddy through `sudo bash scripts/install-host.sh`, builds the selected source checkout, verifies loopback bindings, HTTPS and anonymous access gates, checks live deployment conformance, then verifies a backup and restores it into a temporary database. Fresh Docker group membership is handled with `sg`, without requiring a new login during installation. A sudo password prompt is normal.

The external-DNS host adapter preserves HTTPS access from any client address and installs no DNS server on this machine. Caddy routes the portal to `127.0.0.1:8081` and wildcard apps to core at `127.0.0.1:8080` with `X-QM-App-Host: 1`. Application and database containers stay private.

The generated `.env` has permissions `0600`. Signing and encryption secrets contain real generated values; the fields below start empty unless previously configured:

```dotenv
SMTP_HOST=
SMTP_USERNAME=
SMTP_PASSWORD=
AUTH_EMAIL_FROM=
```

Email delivery and AI responses remain unconfigured until you supply those credentials. For SMTP, port 587 and STARTTLS are defaults; set `SMTP_PORT` and `SMTP_TLS` in `env.auth` in `qm.config.jsonc` when different. Configure the model provider and base model in Admin. Rerun deployment after editing `.env`; editing the file alone does not update running containers.

After installation, trust `certificates/qm-lan-root.crt` on every client device, then generate a private one-time administrator link:

```bash
bash scripts/qm.sh admin-login
```

Open it within five minutes. Generate this link separately so it is not written to the installer log. With no AI provider configured, browser sign-in directs an administrator to onboarding. Public URLs are `https://<portal-host>`, `/admin/`, `/admin/onboarding`, `/admin/connectors`, and `/keychain`.

### Installer modes and troubleshooting

```bash
bash scripts/install.sh --prepare-only
bash scripts/install.sh --deploy-only
bash scripts/diagnose.sh
```

`--prepare-only` configures local deployment files, installs user-local Node/CLI dependencies, and runs static checks without changing host services or containers. `--deploy-only` runs source deployment and live verification on a host with Docker/Caddy already configured, without apt installation or the root backup test. Reruns preserve secrets, database state and volumes; services may be briefly replaced during deployment.

Installer logs are stored in ignored `validation/install-*.log` with permissions `0600`. Failures identify the stage, command, line and exit code. The first source build can take several minutes, especially while Docker compresses and unpacks large image layers; later builds reuse cache. Do not infer a deployment failure from the last displayed `RUN npm ci` line.

`diagnose.sh` checks core health, container state, firewall DNS, HTTPS access gates and live conformance. An absent `/etc/docker/daemon.json` is normal. A failed `sudo -n true` means sudo needs a password prompt, not that core deployment failed. Shell commands report the final command's exit code, so an absent optional file can make a combined inspection look unsuccessful even when earlier checks passed.

### Address meanings

| Setting                                       | Purpose                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `publicUrl` in `qm.config.jsonc`              | Browser-facing HTTPS portal origin                                                                |
| `DEPLOY_APPS_DOMAIN` / `PORTAL_APPS_DOMAIN`   | Wildcard app hostname suffix                                                                      |
| `PUBLIC_API_URL=http://qm-qm-local-core:8080` | Private core API reachable by Docker agent containers for files, credentials and other operations |

Docker resolves the core container name internally. `PUBLIC_API_URL` need not be Internet-facing and is not a replacement for the portal URL.

### Backups and another-machine installation

Full installation runs the backup/recovery test. On an existing host, run it separately:

```bash
sudo bash scripts/finalize-host.sh
sudo systemctl status qm-lan-backup.timer
```

Daily backups around 03:00 retain seven days under root-only `/var/backups/qm-lan`. They contain the database, deployment secrets, Caddy state and persistent volumes. Copy verified backups off the host for machine-loss recovery. The restore test uses a disposable database and preserves live data.

For a fresh installation elsewhere, clone this source and copy the template as shown above. Alternatively export a portable kit from a configured deployment:

```bash
bash scripts/export-installer.sh "$HOME/qm-reinstall-kit.tar.gz"
```

Copy the kit and its `.sha256` file to the new machine and verify the digest against the local filename:

```bash
kit_digest=$(awk '{print $1}' qm-reinstall-kit.tar.gz.sha256)
printf '%s  qm-reinstall-kit.tar.gz\n' "$kit_digest" | sha256sum -c -
git clone --branch feat/app-github-lifecycle https://github.com/tiekkeat/qm.git qm
tar -xzf qm-reinstall-kit.tar.gz
git -C qm checkout "$(cat qm-deployment/SOURCE_REVISION)"
cd qm-deployment
bash scripts/install.sh
```

The kit excludes `.env`, `hosting.env`, certificates, private keys, node_modules, logs and runtime data. It records the selected source revision and keeps the CLI lockfile; OS packages still follow their repositories. The exporter refuses to overwrite an existing kit; choose a new filename for subsequent exports. A fresh machine gets new secrets and a new CA, requiring client trust again. Migrating existing data requires its matching secrets, database, volumes and Caddy state from backups.

## Portable Docker setup

This deployment needs a Docker host with a Unix Docker socket, Node.js 24, npm, Python 3, Git, and an HTTPS reverse proxy on the **same host**. Its application ports bind to loopback. Use your operating system's package manager and service manager for prerequisites; the standard QM startup script does not require Ubuntu or a particular username. The local Docker backend still needs validation on each new host. Keep the source fork and this deployment directory alongside each other, or set `QM_SOURCE_DIR` to the source checkout's path.

This template ships in the QM source fork. Copy it outside the source checkout so deployment config and source can be updated independently:

```bash
git clone --branch feat/app-github-lifecycle https://github.com/tiekkeat/qm.git qm
cp -a qm/deploy/templates/local-docker-lan qm-deployment
cd qm-deployment
```

Never put `.env`, backups, or certificate private keys in Git. The copied directory is your deployment repository; initialize a private Git remote if you want to preserve machine-specific settings.

```bash
cp hosting.env.example hosting.env
${EDITOR:-nano} hosting.env
bash scripts/configure-hosting.sh
npm ci
python3 scripts/bootstrap-secrets.py
python3 scripts/credentials.py
```

Set `QM_PORTAL_HOST` to the DNS name clients will use. `QM_SOURCE_DIR` defaults to the sibling `../qm` checkout. `QM_LAN_IP` is optional and, when set, makes verification require DNS to resolve to that ingress IP. `QM_DNS_SERVER` optionally queries a specific DNS server; leave it empty to use the host resolver. `QM_CA_CERT` optionally names a trusted CA certificate for a private HTTPS issuer. `QM_LAN_INTERFACE` and `QM_LAN_PREFIX` are needed only by the Ubuntu helper below. `hosting.env` is ignored by Git. `configure-hosting.sh` synchronizes the portal URL and app domain in `qm.config.jsonc`.

Create DNS records for the portal hostname and `*.apps.<portal-host>` that point to the HTTPS ingress. The same-host proxy must route the portal hostname to `127.0.0.1:8081` and wildcard app hostnames to **QM core** at `127.0.0.1:8080`, preserving Host and sending `X-QM-App-Host: 1` on app requests. For example, with Caddy:

```caddyfile
https://qm.example.com {
    reverse_proxy 127.0.0.1:8081
}
https://*.apps.qm.example.com {
    reverse_proxy 127.0.0.1:8080 {
        header_up X-QM-App-Host 1
    }
}
```

Replace the example names with your `QM_PORTAL_HOST`. Serve valid HTTPS on port 443 for both names. If you use a private CA, set `QM_CA_CERT` for host verification and trust that CA on each client. Do not route wildcard hostnames directly to app containers, or publish the app container ports.

After DNS and the reverse proxy are configured, run `bash scripts/start.sh`. It checks DNS, config, Docker port bindings, and the deployed sign-in gate. Open `https://<portal-host>` and a real app at `https://<app>.apps.<portal-host>/`. Test a private app as its owner and as an ungranted user; the latter must be forbidden. QM's existing owner and organization settings govern explicitly public apps.

## Optional Ubuntu 24.04 amd64 host setup

If you want this machine to host DNS instead of using a firewall DNS server, the included `scripts/install-root.sh` and `scripts/apply-hosting.sh` install Docker, Caddy, dnsmasq, and firewall rules using Ubuntu 24.04 packages and systemd. They are optional host adapters, not a requirement for deploying QM. Set `QM_LAN_IP`, `QM_LAN_INTERFACE`, and `QM_LAN_PREFIX` in `hosting.env` to the Ubuntu host's existing static address. Set `QM_DNS_SERVER` to `QM_LAN_IP` and `QM_CA_CERT=certificates/qm-lan-root.crt`. Then run:

```bash
bash scripts/configure-hosting.sh
sudo bash scripts/install-root.sh
bash scripts/start.sh
```

For an existing installation or later hostname/IP changes, edit `hosting.env`, run `bash scripts/configure-hosting.sh`, then `sudo bash scripts/apply-hosting.sh`, then `bash scripts/start.sh`. Point clients at the configured DNS server and trust `certificates/qm-lan-root.crt`. The old `https://<QM_LAN_IP>:8443` endpoint redirects to the new portal hostname.

To update the source fork, pull it into the path named by `QM_SOURCE_DIR`, then run `bash scripts/start.sh`; that script checks and plans the deployment before applying it. `python3 scripts/verify.py` can recheck containers, DNS, HTTPS, and anonymous access at any time.
