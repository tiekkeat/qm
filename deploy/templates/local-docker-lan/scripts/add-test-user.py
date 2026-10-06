#!/usr/bin/env python3
import getpass
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
path = root / '.env'
if not os.isatty(0):
    raise SystemExit('Run this script in your own interactive terminal.')
email = (sys.argv[1] if len(sys.argv) == 2 else input('User email: ')).strip().lower()
if not re.fullmatch(r'[^@\s,;<>\"]+@[^@\s,;<>\"]+\.[^@\s,;<>\"]+', email) or ':' in email:
    raise SystemExit('Enter a valid user email.')
password = getpass.getpass('Test-user password (at least 12 characters): ')
again = getpass.getpass('Repeat password: ')
if password != again:
    raise SystemExit('Passwords did not match; no changes made.')
if len(password) < 12 or len(password.encode()) > 1024 or '\n' in password or '\r' in password:
    raise SystemExit('Use a password of at least 12 characters, at most 1024 bytes, without line breaks.')
result = subprocess.run(['docker', 'exec', '-i', 'qm-qm-local-portal', 'node',
                         '/auth/src/hash-password.ts', email],
                        input=password + '\n', text=True, capture_output=True)
if result.returncode != 0:
    raise SystemExit('Password hashing failed. Confirm Docker access and that the portal container is running.')
entry = result.stdout.strip()
if not entry.startswith(email + ':scrypt$') or '\n' in entry:
    raise SystemExit('Password helper returned an unexpected format; no changes made.')
values = {}
for line in path.read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        name, value = line.split('=', 1)
        values[name] = value
users = dict(item.split(':', 1) for item in values.get('AUTH_PASSWORD_USERS', '').split(',') if ':' in item)
users[email] = entry.split(':', 1)[1]
allowed = set(item.strip().lower() for item in values.get('AUTH_ALLOWED_EMAILS', '').split(',') if item.strip())
allowed.add(email)
values['AUTH_PASSWORD_USERS'] = ','.join(f'{name}:{hashed}' for name, hashed in sorted(users.items()))
values['AUTH_ALLOWED_EMAILS'] = ','.join(sorted(allowed))
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
print(f'Password sign-in configured for {email}; administrator grants unchanged.')
print('Apply the change with: bash scripts/start.sh')
