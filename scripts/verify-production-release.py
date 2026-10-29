"""Read-only verification of public TLS, deployed build identity and routes.

No credentials, TLS bypass, customer endpoints or write operations. A successful
build/manifest merge is not considered a successful production release by itself.
"""
import argparse
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

BASE = 'https://swkoo.kr'
ROUTES = {'/': 200, '/deploy': 200, '/notices/2026-10-27-security-update': 200,
          '/api/deploy/current': 401, '/api/admin/deployment-recovery': 401}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read(path):
    request = urllib.request.Request(BASE + path, headers={'Cache-Control': 'no-cache', 'User-Agent': 'swkoo-release-verification/1'})
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=10) as response:
            return response.status, response.read(1024 * 1024 + 1), response.headers
    except urllib.error.HTTPError as error:
        return error.code, b'', error.headers


def verify(expected):
    checks = {}
    for service, path in [('backend', '/api/health'), ('frontend', '/version.json')]:
        status, body, headers = read(path)
        if status != 200 or len(body) > 1024 * 1024:
            raise RuntimeError(f'{service}: unexpected HTTP status or response size ({status})')
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise RuntimeError(f'{service}: invalid revision response')
        revision = payload.get('revision')
        if not isinstance(revision, str) or not re.fullmatch('[a-f0-9]{40}', revision):
            raise RuntimeError(f'{service}: missing deployed revision')
        if service == 'backend' and payload.get('status') != 'ok':
            raise RuntimeError('backend: unhealthy')
        if expected.get(service) and revision != expected[service]:
            raise RuntimeError(f'{service}: expected revision has not reached production')
        if 'no-store' not in headers.get('Cache-Control', ''):
            raise RuntimeError(f'{service}: revision response must not be cached')
        checks[service] = revision
    for path, expected_status in ROUTES.items():
        status, _, _ = read(path)
        if status != expected_status:
            raise RuntimeError(f'{path}: expected {expected_status}, got {status}')
    return {'ok': True, 'revisions': checks, 'routes': ROUTES, 'tlsVerification': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for service in ['backend', 'frontend']:
        parser.add_argument('--' + service, type=lambda value: value if re.fullmatch('[a-f0-9]{40}', value) else parser.error('Full lowercase commit SHA required'))
    parser.add_argument('--wait-seconds', type=int, default=0, choices=range(0, 901), metavar='0..900')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    deadline = time.monotonic() + args.wait_seconds
    while True:
        try:
            result = verify({'backend': args.backend, 'frontend': args.frontend})
            break
        except (RuntimeError, ValueError, OSError) as error:
            result = {'ok': False, 'error': str(error), 'tlsVerification': True}
            if time.monotonic() >= deadline:
                break
            print(json.dumps({'waiting': True, 'error': str(error)}), flush=True)
            time.sleep(10)
    result['checkedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
    if not result['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
