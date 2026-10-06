# Deploy QM with private app hostnames

`qm.example.com` is a placeholder hostname, not a QM default. Set your own portal hostname in `hosting.env`; published apps then use `https://<app>.apps.<portal-host>/`. QM core checks sign-in and app sharing grants before proxying each app. The `/d/<app>/` path viewer restricts JavaScript modules, so web apps need these separate hostnames.

## Portable Docker setup

This deployment needs a Docker host with a Unix Docker socket, Node.js 24, npm, Python 3, Git, and an HTTPS reverse proxy on the **same host**. Its application ports bind to loopback. Use your operating system's package manager and service manager for prerequisites; the standard QM startup script does not require Ubuntu or a particular username. The local Docker backend still needs validation on each new host. Keep the source fork and this deployment directory alongside each other, or set `QM_SOURCE_DIR` to the source checkout's path.

This template ships in the QM source fork. Copy it outside the source checkout so deployment config and source can be updated independently:

```bash
git clone --branch fix/local-docker-computer https://github.com/tiekkeat/qm.git qm
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

The included `scripts/install-root.sh` and `scripts/apply-hosting.sh` install Docker, Caddy, dnsmasq, and firewall rules using Ubuntu 24.04 packages and systemd. They are optional host adapters, not a requirement for deploying QM. Set `QM_LAN_IP`, `QM_LAN_INTERFACE`, and `QM_LAN_PREFIX` in `hosting.env` to the Ubuntu host's existing static address. Set `QM_DNS_SERVER` to `QM_LAN_IP` and `QM_CA_CERT=certificates/qm-lan-root.crt`. Then run:

```bash
bash scripts/configure-hosting.sh
sudo bash scripts/install-root.sh
bash scripts/start.sh
```

For an existing installation or later hostname/IP changes, edit `hosting.env`, run `bash scripts/configure-hosting.sh`, then `sudo bash scripts/apply-hosting.sh`, then `bash scripts/start.sh`. Point clients at the configured DNS server and trust `certificates/qm-lan-root.crt`. The old `https://<QM_LAN_IP>:8443` endpoint redirects to the new portal hostname.

To update the source fork, pull it into the path named by `QM_SOURCE_DIR`, then run `bash scripts/start.sh`; that script checks and plans the deployment before applying it. `python3 scripts/verify.py` can recheck containers, DNS, HTTPS, and anonymous access at any time.
