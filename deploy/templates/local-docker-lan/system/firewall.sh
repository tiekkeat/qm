#!/usr/bin/env bash
set -euo pipefail
source /etc/qm-lan/hosting.env
iptables -w -N QM-LAN 2>/dev/null || iptables -w -S QM-LAN >/dev/null
iptables -w -F QM-LAN
iptables -w -A QM-LAN -d "$QM_LAN_IP" -j ACCEPT
iptables -w -A QM-LAN -p tcp -j REJECT --reject-with tcp-reset
for spec in tcp:443 tcp:8443 tcp:53 udp:53; do
    protocol="${spec%%:*}"
    port="${spec#*:}"
    iptables -w -C INPUT -p "$protocol" --dport "$port" -j QM-LAN 2>/dev/null || iptables -w -I INPUT 1 -p "$protocol" --dport "$port" -j QM-LAN
done
