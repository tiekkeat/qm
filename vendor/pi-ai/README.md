# Pi 1.0.4 integration

QM pins the stock npm releases of `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` to 1.0.4. The root lockfile and dependency
overrides retain the required MCP and transitive dependency security fixes.
The coding agent no longer requires a separately hosted, shrinkwrapped tarball.

`provider-error.patch` adds structured HTTP failures to Pi AI messages so QM can
distinguish budget limits, authentication failures and transient provider errors
without parsing display text. Pi 1.0.4 already preserves native stop reasons.
The patch also preserves AbortError as an aborted result when lazy request setup
is cancelled, rather than reporting cancellation as a provider failure.

The source-controlled installer applies the patch after npm installation:

```sh
node scripts/patch-pi-ai.mjs
```

The root `postinstall` runs this automatically. Installs using `--ignore-scripts`
must run it explicitly. The core Docker dependency installer does so before
building the image. Application is idempotent and fails if the installed version
or patch context is incompatible.

For a future Pi upgrade, pin matching AI and coding-agent versions, port any
remaining patch behavior, update the installer version check, and rerun the
provider-error, cancellation, dependency-security and harness tests. Refresh the
lockfile with `--min-release-age=0` only when intentionally choosing a newly
published stable release; the repository's normal seven-day policy is unchanged.

The web UI uses Pi AI and Agent Core 1.0.4. Its legacy Pi UI attachment library
retains its own compatible Pi AI dependency rather than being overridden to the
new major version.
