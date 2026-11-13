import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / 'services/deploy/deploy-site.sh'
FAKE_SUDO = '''#!/bin/bash
echo "$*" >> "$SUDO_LOG"
[[ -z ${FAIL_INSTALL:-} ]] || exit 1
git rev-parse HEAD > "$GATEWAY_REV_FILE"
'''


class DeployHookTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.dir = Path(folder.name)
        self.git('init', '-q', '--bare', '-b', 'main', 'origin.git')
        self.git('clone', '-q', 'origin.git', 'work')
        self.commit({'services/vestaboard/server.py': 'v1'})
        self.git('clone', '-q', 'origin.git', 'checkout')
        bin_dir = self.dir / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'sudo').write_text(FAKE_SUDO)
        (bin_dir / 'sudo').chmod(0o755)
        self.env = dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}', DEPLOY_REPO=str(self.dir / 'checkout'),
                        GATEWAY_REV_FILE=str(self.dir / 'installed-rev'), SUDO_LOG=str(self.dir / 'sudo.log'))

    def git(self, *args, cwd=None):
        subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', *args],
                       cwd=cwd or self.dir, check=True, capture_output=True)

    def commit(self, files):
        work = self.dir / 'work'
        for name, text in files.items():
            (work / name).parent.mkdir(parents=True, exist_ok=True)
            (work / name).write_text(text)
        self.git('add', '-A', cwd=work)
        self.git('commit', '-q', '-m', 'change', cwd=work)
        self.git('push', '-q', 'origin', 'HEAD:main', cwd=work)

    def deploy(self, **env):
        return subprocess.run(['bash', str(DEPLOY)], env=dict(self.env, **env), capture_output=True, text=True)

    def installs(self):
        log = self.dir / 'sudo.log'
        return log.read_text().splitlines() if log.exists() else []

    def test_installs_gateway_only_when_its_code_changed_since_last_install(self):
        self.assertEqual(self.deploy().returncode, 0)
        self.assertEqual(self.installs(), ['-n /usr/local/sbin/install-vestaboard-gateway'])
        for files in ({'site/index.html': 'x'}, {'services/vestaboard/README.md': 'x'},
                      {'services/vestaboard/test_server.py': 'x'}):
            with self.subTest(files=files):
                self.commit(files)
                result = self.deploy()
                self.assertEqual(result.returncode, 0)
                self.assertIn('gateway unchanged', result.stdout)
                self.assertEqual(len(self.installs()), 1)
        self.commit({'services/vestaboard/server.py': 'v2'})
        self.assertEqual(self.deploy().returncode, 0)
        self.assertEqual(len(self.installs()), 2)

    def test_failed_or_unknown_installs_are_retried_on_the_next_deploy(self):
        self.assertNotEqual(self.deploy(FAIL_INSTALL='1').returncode, 0)
        self.commit({'site/index.html': 'x'})
        self.assertEqual(self.deploy().returncode, 0)
        self.assertEqual(len(self.installs()), 2)
        (self.dir / 'installed-rev').write_text('0' * 40 + '\n')
        self.assertEqual(self.deploy().returncode, 0)
        self.assertEqual(len(self.installs()), 3)


if __name__ == '__main__':
    unittest.main()
