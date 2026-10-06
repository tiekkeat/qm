#!/usr/bin/env python3
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
package = root / 'node_modules/@yc-software/qm'
version = json.loads((package / 'package.json').read_text())['version']
if version != '0.1.14':
    raise SystemExit(f'QM CLI version {version} needs a reviewed loopback binding patch')
source = package / 'dist/src/backends/docker.js'
content = source.read_text()
original = 'args.push("-p", `${baseHostPort(ctx) + def.docker.hostPortOffset}:${def.docker.internalPort}`);'
patched = 'args.push("-p", `127.0.0.1:${baseHostPort(ctx) + def.docker.hostPortOffset}:${def.docker.internalPort}`);'
if original in content:
    source.write_text(content.replace(original, patched, 1))
elif patched not in content:
    raise SystemExit('QM CLI Docker port binding changed; review before startup')
