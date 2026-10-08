#!/usr/bin/env python3
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parent.parent
config_path = root / 'qm.config.jsonc'
config = json.loads(config_path.read_text())
host = os.environ['QM_PORTAL_HOST']
apps_domain = os.environ['QM_APPS_DOMAIN']
config['publicUrl'] = f'https://{host}'
config['env']['core']['DEPLOY_APPS_DOMAIN'] = apps_domain
config['env']['portal']['PORTAL_APPS_DOMAIN'] = apps_domain
values = {}
env_path = root / '.env'
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            name, value = line.split('=', 1)
            values[name] = value.strip().strip('\"\'')
auth = config['env'].get('auth', {})
core = config['env']['core']
if auth.get('AUTH_EMAIL_TRANSPORT') == 'smtp':
    core['AUTH_EMAIL_TRANSPORT'] = 'smtp'
    for name in ['SMTP_PORT', 'SMTP_TLS']:
        if name in auth:
            core[name] = auth[name]
    core_secrets = config.setdefault('secretEnv', {}).setdefault('core', {})
    configured = all(values.get(name) for name in ['SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'AUTH_EMAIL_FROM'])
    for name in ['SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD']:
        if configured:
            core_secrets.setdefault(name, name)
        elif core_secrets.get(name) == name:
            del core_secrets[name]
rendered = json.dumps(config, indent=2) + '\n'
if config_path.read_text() != rendered:
    config_path.write_text(rendered)
print(f'QM portal: https://{host}; published apps: https://<app>.{apps_domain}/')
