#!/usr/bin/env python3
import json
import subprocess
from hosting_check import apps_domain, check_dns, curl_host_args, host, root

expected = ['qm-qm-local-pg', 'qm-qm-local-core', 'qm-qm-local-web-ui', 'qm-qm-local-portal']
items = json.loads(subprocess.check_output(['docker', 'inspect', *expected], text=True))
for item in items:
    name = item['Name'].lstrip('/')
    if not item['State']['Running']:
        raise SystemExit(f'{name} is not running')
    if item['HostConfig']['RestartPolicy']['Name'] != 'unless-stopped':
        raise SystemExit(f'{name} has an unexpected restart policy')
    for bindings in item['NetworkSettings']['Ports'].values():
        for binding in bindings or []:
            if name.endswith('-pg') or binding['HostIp'] != '127.0.0.1':
                raise SystemExit(f'{name} publishes an unexpected host port')
print('Containers, loopback port bindings, and restart policies: passed')
bindings = json.loads(subprocess.check_output(['docker', 'network', 'inspect', 'qm-qm-local'], text=True))[0]['Options']
if bindings.get('com.docker.network.bridge.host_binding_ipv4') != '127.0.0.1':
    raise SystemExit('QM network must bind published ports to loopback')
check_dns()

def get(request_host, path, accept):
    output = subprocess.check_output([
        'curl', '--noproxy', '*', '--silent', '--show-error', '--max-time', '20',
        *curl_host_args(request_host),
        '--header', f'Accept: {accept}', '--write-out', '\n%{http_code}\n%{redirect_url}',
        f'https://{request_host}{path}',
    ], text=True)
    body, status, redirect = output.rsplit('\n', 2)
    return int(status), redirect, body

status, _, body = get(host, '/healthz', 'application/json')
if status != 200 or json.loads(body).get('ok') is not True:
    raise SystemExit('Portal health check failed')
print('LAN HTTPS portal and certificate validation: passed')
status, _, body = get(host, '/', 'application/json')
if status != 401 or json.loads(body).get('error') != 'sign in':
    raise SystemExit(f'Unexpected portal authentication response: HTTP {status}')
print('Unauthenticated portal access requires sign-in: passed')
status, redirect, _ = get(f'qm-probe.{apps_domain}', '/', 'text/html')
if status != 302 or not redirect.startswith(f'https://{host}/auth/login?'):
    raise SystemExit(f'App host did not require portal sign-in: HTTP {status}')
print('Unknown app host requires sign-in before access: passed')
print('Still required: sign-in, real model turn/title, sandbox proof, restart persistence, and another LAN client')
