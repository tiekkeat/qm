#!/usr/bin/env python3
import os
import secrets
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
path = root / '.env'
template = root / '.env.example'
values = {}
for source in [template, path]:
    if not source.exists():
        continue
    for line in source.read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            name, value = line.split('=', 1)
            values[name] = value
for name in [
    'AUTH_CLIENT_SECRET', 'AUTH_TOKEN_SECRET', 'AWS_DEPLOY_GATE_SECRET',
    'CAPABILITY_SECRET', 'CONNECTOR_SECRET_KEY', 'CORE_SIGNING_SECRET',
    'PORTAL_IDENTITY_SECRET', 'PORTAL_SESSION_SECRET', 'SKILL_SIGNING_SECRET',
]:
    if not values.get(name):
        values[name] = secrets.token_hex(32)
if not values.get('AUTH_SIGNING_JWK'):
    values['AUTH_SIGNING_JWK'] = subprocess.check_output([
        'node', '-e',
        "const {generateKeyPairSync}=require('node:crypto');process.stdout.write(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))",
    ], text=True)
fd, temporary = tempfile.mkstemp(dir=root, prefix='.env-')
try:
    with os.fdopen(fd, 'w') as output:
        for name, value in values.items():
            output.write(f'{name}={value}\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('Required local signing secrets are ready in the private .env file.')
