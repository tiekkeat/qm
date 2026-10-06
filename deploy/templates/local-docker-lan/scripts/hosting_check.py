import os
import socket
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
hosting = dict(line.split('=', 1) for line in (root / 'hosting.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
host = hosting['QM_PORTAL_HOST']
ip = hosting.get('QM_LAN_IP', '')
dns_server = hosting.get('QM_DNS_SERVER', '')
apps_domain = f'apps.{host}'

def check_dns():
    for dns_host in [host, f'qm-probe.{apps_domain}']:
        if dns_server:
            answers = set(subprocess.check_output(['dig', '+short', '+tries=1', '+time=2', f'@{dns_server}', dns_host, 'A'], text=True).splitlines())
        else:
            answers = {item[4][0] for item in socket.getaddrinfo(dns_host, None, socket.AF_INET)}
        if not answers or (ip and ip not in answers):
            raise SystemExit(f'DNS did not resolve {dns_host} to the expected ingress address')

def curl_host_args(request_host):
    args = []
    ca_cert = hosting.get('QM_CA_CERT', '')
    if ca_cert:
        cert = Path(ca_cert)
        if not cert.is_absolute():
            cert = root / cert
        if not cert.is_file():
            raise SystemExit(f'CA certificate is missing: {cert}')
        args += ['--cacert', str(cert)]
    if ip:
        args += ['--resolve', f'{request_host}:443:{ip}']
    return args
