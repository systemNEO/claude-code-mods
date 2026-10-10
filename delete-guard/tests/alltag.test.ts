import { expect, test } from 'claude-code/testing'
import { type Ctx, lang, newOut, within } from '../hooks/common'
import '../hooks/bash'
import '../hooks/ps'
const C: Ctx = { root: '/home/u/proj', win: false, home: '/home/u', env: n => ({ PATH: '/usr/bin', TMPDIR: '/tmp' } as Record<string,string>)[n] }
const cmds = [
  'npm install', 'git status && git diff --stat', 'ls -la /etc', 'cat /etc/hosts | grep local', 'mkdir -p /tmp/x', 'cp a.txt /tmp/b.txt',
  'python3 script.py --out /tmp/res', 'curl -s https://x.y/api | jq .', 'cd /tmp && ls', 'source ~/.bashrc', 'export PATH=$PATH:/opt/bin',
  'docker run --rm -v /data:/data img', 'git commit -m "rm -rf old stuff"', 'echo "delete me" > /tmp/note', 'find /etc -name "*.conf"',
  'grep -rn "Remove-Item" src/', 'sed -i "s/rm/del/" file.txt', 'npm run build -- --clean', 'git rm --cached secret.env', 'kubectl delete pod x',
  'gh pr view 12', 'tar -xzf a.tgz -C /tmp/out', 'pip uninstall -y foo', 'apt list --installed', 'node -e "console.log(require(\'fs\').readdirSync(\'/\'))"',
  'rm -rf node_modules && npm ci', 'for f in src/*.ts; do echo $f; done', 'while read l; do echo "$l"; done < list.txt', 'ps aux | grep node',
  'nvm use 20 && node -v', 'git worktree list', 'find . -type f -newer x | wc -l', 'xargs -n1 echo < list', 'ls | xargs -I{} echo {}',
  'docker rm -f container1', 'git branch -D feature', 'npm uninstall left-pad', 'dropdb mydb', 'redis-cli DEL key',
]
test('Fehlalarme im Alltag', () => {
  const hits: string[] = []
  for (const c of cmds) {
    const out = newOut()
    lang.bash(c, { cwd: C.root, vars: new Map(), stack: [] }, { ctx: C, out, depth: 0 })
    const o = out.targets.filter(t => !within(t.path, C.root, false, t.mode === 'children')).map(t => t.path)
    if (o.length || out.unknowns.length) hits.push(`${c} => ${JSON.stringify([...o, ...out.unknowns])}`)
  }
  expect(hits).toEqual([])
})
