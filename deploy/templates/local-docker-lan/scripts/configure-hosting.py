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
rendered = json.dumps(config, indent=2) + '\n'
if config_path.read_text() != rendered:
    config_path.write_text(rendered)
print(f'QM portal: https://{host}; published apps: https://<app>.{apps_domain}/')
