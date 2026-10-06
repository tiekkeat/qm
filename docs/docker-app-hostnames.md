# Published app hostnames on Docker

Published web apps that load JavaScript modules need a dedicated hostname. The `/d/<app>/` viewer uses a restrictive browser sandbox, so a module-based app can appear blank there. With an apps domain configured, QM redirects browser visits from `/d/<app>/` to `https://<app>.<apps-domain>/`.

For a portal at `https://qm.example.com`, use an apps domain such as `apps.qm.example.com`. Configure `env.core.DEPLOY_APPS_DOMAIN` and `env.portal.PORTAL_APPS_DOMAIN` to the same bare domain. If the portal and apps domains are siblings, also set `env.portal.PORTAL_COOKIE_DOMAIN` to their common parent. Alias `secretEnv.core.DEPLOY_APPS_SESSION_SECRET` to the same secret source as the portal's `PORTAL_SESSION_SECRET`, and set `AWS_DEPLOY_GATE_SECRET` in `.env`. The portal URL must use HTTPS on port 443. `qm check` validates this wiring on Docker deployments.

Create DNS records for the portal name and the wildcard app names, and serve TLS for both. Route the portal hostname to the portal service and route `*.apps.qm.example.com` to **QM core**. Forward the original Host header and set `X-QM-App-Host: 1` on app-host requests. Never route the wildcard directly to app containers: core checks sign-in and app sharing grants before proxying an app.

For a private LAN with no public DNS, run a DNS server accessible to every client and issue locally trusted TLS certificates. Clients must use that DNS server and trust its root certificate. The host-specific Caddy and dnsmasq example lives in a separate deployment repository; cloning this QM source fork alone does not include that deployment. Its `README.md` explains the portable Docker setup and the optional Ubuntu host installer.
