#!/usr/bin/env python3
import os
import re
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
path = root / '.env'
values = {}
for line in path.read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        name, value = line.split('=', 1)
        values[name] = value
if not os.isatty(0):
    raise SystemExit('Run this script in your own interactive terminal.')
default = values.get('ADMIN_GRANTS', '').removesuffix(':org_admin')
email = input(f'Administrator email [{default}]: ').strip().lower() or default
if not re.fullmatch(r'[^@\s,;<>\"]+@[^@\s,;<>\"]+\.[^@\s,;<>\"]+', email):
    raise SystemExit('Enter a valid administrator email.')
allowed = set(item.strip().lower() for item in values.get('AUTH_ALLOWED_EMAILS', '').split(',') if item.strip())
allowed.add(email)
values.update(ADMIN_GRANTS=f'{email}:org_admin', AUTH_ALLOWED_EMAILS=','.join(sorted(allowed)),
              PUBLIC_API_URL='http://qm-qm-local-core:8080')
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
print('Credentials saved privately. Next: bash scripts/start.sh')
