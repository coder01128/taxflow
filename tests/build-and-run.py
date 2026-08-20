#!/usr/bin/env python3
"""Rebuild both jsdom suites against the CURRENT protax-app2.html and run them.

Old test HTML goes stale the moment the app changes, so nothing is cached —
the harness is injected fresh every run.

    python3 tests/build-and-run.py            # both suites
    python3 tests/build-and-run.py buckets    # one suite

jsdom is installed into a cache OUTSIDE this folder (see CACHE below) and
found via NODE_PATH. Do not npm-install into tests/ — node_modules is tens of
thousands of tiny files and resolving it across a synced/mounted folder makes
every run take minutes instead of seconds.
"""
import json, os, subprocess, sys, tempfile

ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, 'tests')
APP   = os.path.join(ROOT, 'protax-app2.html')
CACHE = os.path.join(os.path.expanduser('~'), '.protax-test-deps')


def node_env():
    """Ensure jsdom exists in the out-of-tree cache and expose it via NODE_PATH."""
    mods = os.path.join(CACHE, 'node_modules')
    if not os.path.isdir(os.path.join(mods, 'jsdom')):
        os.makedirs(CACHE, exist_ok=True)
        print('Installing jsdom into ' + CACHE + ' (one-off, ~30s)…')
        r = subprocess.run(['npm', 'install', '--no-audit', '--no-fund', 'jsdom'],
                           cwd=CACHE, capture_output=True, text=True)
        if r.returncode:
            print(r.stdout[-1500:] + r.stderr[-1500:])
            sys.exit('jsdom install failed — install it manually in ' + CACHE)
    env = dict(os.environ)
    env['NODE_PATH'] = mods + os.pathsep + env.get('NODE_PATH', '')
    return env

def build(suite, tmpdir):
    app = open(APP, encoding='utf-8').read()
    harness = open(os.path.join(TESTS, f'harness-{suite}.html'), encoding='utf-8').read()
    inject = harness
    if suite == 'buckets':
        # buckets asserts against Brad's real committed figures
        session = os.path.join(ROOT, 'protax-session.json')
        data = json.load(open(session, encoding='utf-8'))
        fixture = ('<script type="application/json" id="__fixture">'
                   + json.dumps({'committedData': data['committedData']}) + '</script>')
        inject = fixture + harness
    out = os.path.join(tmpdir, f'protax-{suite}-test.html')
    open(out, 'w', encoding='utf-8').write(app.replace('</body>', inject + '</body>'))
    return out

def main():
    suites = sys.argv[1:] or ['buckets', 'regression']
    env = node_env()
    failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        for s in suites:
            print(f'\n===== {s} =====')
            path = build(s, tmp)
            runner = os.path.join(tmp, 'run-suite.js')
            open(runner, 'w', encoding='utf-8').write(
                open(os.path.join(TESTS, 'run-suite.js'), encoding='utf-8').read())
            r = subprocess.run(['node', runner, path],
                               capture_output=True, text=True, env=env, cwd=tmp)
            print('\n'.join(l for l in r.stdout.splitlines()
                            if 'Could not parse CSS' not in l))
            if r.returncode: failed += 1; print(r.stderr[-2000:])
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
