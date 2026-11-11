import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

// Die Hooks im geladenen Plugin, über $.tool.call. Unter dem Plugin steht ein
// kleines Dateisystem: `files` gibt es, ihre Ordner auch; alles andere fehlt.
// Der Hook des Tests darunter steht für das Werkzeug selbst: er antwortet `ran`.

const ROOT = '/home/u/proj'
const FILES = [
  `${ROOT}/README.md`, `${ROOT}/src/app.ts`, `${ROOT}/src/util.ts`, `${ROOT}/config.json`, `${ROOT}/notes.txt`,
  `${ROOT}/build.log`, `${ROOT}/package-lock.json`, `${ROOT}/gen/api.ts`, `${ROOT}/node_modules/x/index.js`,
  `${ROOT}/sub/inner.md`, `${ROOT}/incoming/app.ts`, `${ROOT}/incoming/fresh.ts`, '/tmp/x.json', '/home/u/.claude/plans/plan.md', '/tmp/claude-1000/p/scratchpad/s.md',
]

function engine(on: On, cwd = ROOT) {
  const dirs = new Set(FILES.flatMap(f => f.split('/').slice(1, -1).map((_, i, a) => `/${a.slice(0, i + 1).join('/')}`)))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.stat', (_$, e) => {
    const path = (e as { path: string }).path
    if (FILES.includes(path)) return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
    if (dirs.has(path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('fs.list', (_$, e) => {
    const dir = (e as { path?: string }).path ?? cwd
    const names = FILES.filter(f => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/')).map(f => f.slice(dir.length + 1))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('tool.call', () => ({ result: 'ran' }))
}

/** Der Werkzeugaufruf mit einem Werkzeugnamen als Variable (PowerShell kennt dieser Build nicht). */
type LooseCall = (input: Record<string, unknown>) => Promise<{ deny?: string }>
type Dollar = { tool: { call: unknown } }

const call = async ($: Dollar, input: Record<string, unknown>) => {
  const r = await ($.tool.call as LooseCall)(input)
  return r.deny === undefined ? 'ran' : r.deny
}
const bash = ($: Dollar, command: string, tool = 'Bash') => call($, { tool, command })
const write = ($: Dollar, file_path: string) => call($, { tool: 'Write', file_path, content: 'x' })

describe('Write', () => {
  test('bestehende Datei: abgelehnt, mit Begründung', async ($, on) => {
    engine(on)
    const r = await write($, `${ROOT}/src/app.ts`)
    expect(r).toContain('BLOCKIERT: Write auf bestehende Datei /home/u/proj/src/app.ts')
    expect(r).toContain('old_string = aktueller Inhalt')
    expect(r).toContain('Löschen und Neu-Erstellen')
  })
  test('jede Endung zählt, auch ungeschützte', async ($, on) => {
    engine(on)
    expect(await write($, `${ROOT}/notes.txt`)).toContain('BLOCKIERT')
  })
  test('neue Datei: läuft', async ($, on) => {
    engine(on)
    expect(await write($, `${ROOT}/src/new.ts`)).toBe('ran')
  })
  test('freie Ordner: /tmp, Pläne, Scratchpad, node_modules', async ($, on) => {
    engine(on)
    for (const p of ['/tmp/x.json', '/home/u/.claude/plans/plan.md', '/tmp/claude-1000/p/scratchpad/s.md', `${ROOT}/node_modules/x/index.js`])
      expect({ p, r: await write($, p) }).toEqual({ p, r: 'ran' })
  })
  test('relativer Pfad am Arbeitsordner', async ($, on) => {
    engine(on, `${ROOT}/src`)
    expect(await write($, 'app.ts')).toContain('BLOCKIERT')
    expect(await write($, 'other.ts')).toBe('ran')
  })
  test('allowedFiles: Muster dürfen neu geschrieben werden', { options: { allowedFiles: 'package-lock.json, gen/**' } }, async ($, on) => {
    engine(on)
    expect(await write($, `${ROOT}/package-lock.json`)).toBe('ran')
    expect(await write($, `${ROOT}/gen/api.ts`)).toBe('ran')
    expect(await write($, `${ROOT}/config.json`)).toContain('BLOCKIERT')
  })
  test('freeFolders ersetzt die Vorgabe', { options: { freeFolders: 'sub' } }, async ($, on) => {
    engine(on)
    expect(await write($, `${ROOT}/sub/inner.md`)).toBe('ran')
    expect(await write($, '/tmp/x.json')).toContain('BLOCKIERT')
  })
})

describe('Bash', () => {
  const blocked = (command: string, cwd?: string) =>
    test(`blockiert: ${command}`, async ($, on) => {
      engine(on, cwd)
      const r = await bash($, command)
      expect({ command, blocked: r.includes('BLOCKIERT: kompletter Inhaltstausch') }).toEqual({ command, blocked: true })
    })
  const runs = (command: string, cwd?: string) =>
    test(`läuft: ${command}`, async ($, on) => {
      engine(on, cwd)
      expect({ command, r: await bash($, command) }).toEqual({ command, r: 'ran' })
    })

  blocked('cat > README.md <<EOF\nneu\nEOF')
  blocked('echo x > config.json')
  blocked('echo x >| config.json')
  blocked('printf "a" &> src/app.ts')
  blocked('echo x 1> src/app.ts')
  blocked('> config.json')
  blocked('echo x | tee src/app.ts')
  blocked('echo x | tee -i out.txt config.json')
  blocked('cp /tmp/x.json config.json')
  blocked('mv new.ts src/app.ts')
  blocked('cp -f other/app.ts src/')
  blocked('cp -t src other/util.ts')
  blocked('cp incoming/*.ts src/')
  blocked('mv incoming/a*.ts src')
  blocked("python3 -c \"from pathlib import Path; Path('config.json').write_text('{}')\"")
  blocked("python3 -c \"open('README.md', 'w').write('x')\"")
  blocked("node -e \"require('fs').writeFileSync('src/app.ts', '')\"")
  blocked("python3 <<'PY'\nwith open('config.json', 'w') as f:\n    f.write('{}')\nPY")
  blocked("python3 - <<'PY'\nimport pathlib\nfor p in pathlib.Path('src').glob('*.ts'):\n    p.write_text('x')\nPY")
  blocked('bash -c "echo x > config.json"')
  blocked('sudo tee /home/u/proj/config.json < /tmp/x.json')
  blocked('cd src && echo x > app.ts')
  blocked('cd src; echo x > app.ts')
  blocked('echo x > ~/proj/README.md')
  blocked('echo x > "$CLAUDE_PROJECT_DIR/README.md"')
  blocked('D=src; echo x > "$D/app.ts"')
  blocked('for f in src/*.ts; do echo x > "$f"; done')
  blocked('echo x > app.ts', `${ROOT}/src`)
  blocked("cat <<'EOF' > config.json\n{}\nEOF")
  blocked('make 2>&1 > config.json')
  blocked('echo x > "$OUT.json" # OUT unbekannt')

  runs('echo x >> config.json')
  runs('cat a b >> README.md')
  runs('echo x | tee -a config.json')
  runs('echo x | tee --append src/app.ts')
  runs('echo x > src/new.ts')
  runs('cp /tmp/x.json brand-new.json')
  runs('cp -n /tmp/x.json config.json')
  runs('cp other/fresh.ts src/')
  runs('cp incoming/f*.ts src/')
  runs('cp missing/*.ts src/')
  runs('echo x > notes.txt')
  runs('echo x > build.log')
  runs('npm test 2> build.log')
  runs('echo x > /tmp/x.json')
  runs('echo x > /dev/null 2>&1')
  runs('ls >&2')
  runs('echo x > node_modules/x/index.js')
  runs('echo x > /tmp/claude-1000/p/scratchpad/s.md')
  runs('echo "use > to redirect into config.json"')
  runs("grep 'a > config.json' README.md")
  runs('git commit -m "cat > README.md and tee config.json"')
  runs("git commit -F - <<'MSG'\necho x > config.json\nMSG")
  runs("cat <<'EOF'\npython3 -c \"open('config.json','w')\"\nEOF")
  runs('python3 -c "print(open(\'config.json\').read())"')
  runs("python3 -c \"open('/tmp/claude-1000/p/scratchpad/out.json', 'w').write('x')\"")
  runs("python3 - <<'PY'\nimport pathlib\npathlib.Path('/tmp/claude-1000/p/scratchpad/' + name + '.json').write_text('x')\nPY")
  runs('python3 gen.py > /tmp/out.json')
  runs('(cd src && ls) && echo x > app.ts')
  runs('echo x > app.ts', `${ROOT}/sub`)
  runs('mkdir -p x && cat src/app.ts | head')
})

describe('Optionen', () => {
  test('protectedExtensions: nur die genannten Endungen', { options: { protectedExtensions: 'ts' } }, async ($, on) => {
    engine(on)
    expect(await bash($, 'echo x > config.json')).toBe('ran')
    expect(await bash($, 'echo x > src/app.ts')).toContain('BLOCKIERT')
  })
  test('protectedExtensions = *: jede bestehende Datei', { options: { protectedExtensions: '*' } }, async ($, on) => {
    engine(on)
    expect(await bash($, 'echo x > notes.txt')).toContain('BLOCKIERT')
    expect(await bash($, 'echo x > build.log')).toBe('ran')
  })
  test('allowedFiles gilt auch für die Shell', { options: { allowedFiles: '*.json' } }, async ($, on) => {
    engine(on)
    expect(await bash($, 'echo x > config.json')).toBe('ran')
    expect(await bash($, 'echo x > src/app.ts')).toContain('BLOCKIERT')
  })
  test('freeFolders mit ~ und relativem Ordner', { options: { freeFolders: '~/proj/gen, sub' } }, async ($, on) => {
    engine(on)
    expect(await bash($, 'echo x > gen/api.ts')).toBe('ran')
    expect(await bash($, 'echo x > sub/inner.md')).toBe('ran')
    expect(await bash($, 'echo x > /tmp/x.json')).toContain('BLOCKIERT')
  })
})

describe('PowerShell und Monitor', () => {
  const ps = (command: string, expected: 'blockiert' | 'läuft') =>
    test(`${expected}: ${command}`, async ($, on) => {
      engine(on)
      const r = await bash($, command, 'PowerShell')
      expect({ command, r: r === 'ran' ? 'läuft' : r.includes('BLOCKIERT') ? 'blockiert' : r }).toEqual({ command, r: expected })
    })
  ps("Set-Content -Path config.json -Value '{}'", 'blockiert')
  ps("'x' | Out-File README.md", 'blockiert')
  ps("'x' | Out-File README.md -Append", 'läuft')
  ps("Add-Content config.json 'x'", 'läuft')
  ps("'x' > src/app.ts", 'blockiert')
  ps("'x' >> src/app.ts", 'läuft')
  ps('Copy-Item /tmp/x.json -Destination config.json', 'blockiert')
  ps('Copy-Item /tmp/x.json new.json', 'läuft')
  ps('New-Item -ItemType File config.json -Force', 'blockiert')
  ps('New-Item -ItemType File config.json', 'läuft')
  ps("[IO.File]::WriteAllText('config.json', 'x')", 'blockiert')
  ps("Write-Host 'Set-Content config.json'", 'läuft')
  ps("cmd /c \"echo x > config.json\"", 'blockiert')
  ps('cmd /c "copy /y a.json config.json"', 'blockiert')
  ps("Set-Location src; 'x' > app.ts", 'blockiert')

  test('Monitor wie Bash', async ($, on) => {
    engine(on)
    expect(await bash($, 'echo x > config.json', 'Monitor')).toContain('BLOCKIERT')
  })
})

describe('Alltag: keine Fehlalarme', () => {
  const everyday = [
    'npm install', 'git status && git diff --stat', 'ls -la > /dev/null', 'cat README.md | grep x', 'docker build -t x .',
    'curl -s https://x.y | jq .', 'find . -name "*.ts" | xargs grep foo', 'git log --oneline | head -5', 'npx tsc --noEmit 2>&1 | tail',
    'echo $((3 > 1))', 'node -e "console.log(require(\'./config.json\').name)"', 'python3 -c "import json; print(json.load(open(\'config.json\')))"',
    'git diff > /tmp/changes.patch', 'jq . config.json > /tmp/pretty.json', 'echo x > fresh.md && cat fresh.md', 'sed -n 1,5p src/app.ts',
  ]
  test('gewöhnliche Befehle laufen', async ($, on) => {
    engine(on)
    const hits: string[] = []
    for (const c of everyday) if ((await bash($, c)) !== 'ran') hits.push(c)
    expect(hits).toEqual([])
  })
})

test('Prüfung schlägt fehl: durchgelassen, mit Zeile im Protokoll', async ($, on) => {
  const logs: string[] = []
  on('session.root', () => { throw new Error('kaputt') })
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', () => ({ value: undefined }))
  on('ui.log', (_$, e) => { logs.push(e.text); return { value: undefined } })
  on('tool.call', () => ({ result: 'ran' }))
  expect(await bash($, 'echo x > config.json')).toBe('ran')
  expect(await write($, `${ROOT}/README.md`)).toBe('ran')
  expect(logs.length).toBe(2)
  expect(logs[0]).toContain('overwrite-guard: Prüfung fehlgeschlagen')
  expect(logs[0]).toContain('Bash durchgelassen')
})

test('Ablehnung nennt jede betroffene Datei und die freien Ordner', async ($, on) => {
  engine(on)
  const r = await bash($, 'echo a > README.md; echo b > config.json; echo c > new.ts')
  expect(r).toContain('/home/u/proj/README.md (>)')
  expect(r).toContain('/home/u/proj/config.json (>)')
  expect(r).not.toContain('new.ts')
  expect(r).toContain('Anhängen (>>)')
  expect(r).toContain('/tmp, ~/.claude/plans, scratchpad, node_modules, vendor')
})

test('Windows: Laufwerkspfade und Rückstriche', async ($, on) => {
  const existing = 'C:/Users/u/proj/config.json'
  on('session.root', () => ({ value: 'C:\\Users\\u\\proj' }))
  on('session.cwd', () => ({ value: 'C:\\Users\\u\\proj' }))
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\u' : undefined }))
  // Unter Linux legt die Testumgebung `C:/…` an ihren eigenen Ordner an: das Ende zählt.
  on('fs.stat', (_$, e) => {
    if ((e as { path: string }).path.toLowerCase().endsWith(existing.toLowerCase())) return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('tool.call', () => ({ result: 'ran' }))
  expect(await write($, 'C:\\Users\\u\\proj\\config.json')).toContain('BLOCKIERT')
  expect(await bash($, "Set-Content C:\\Users\\u\\proj\\Config.json 'x'", 'PowerShell')).toContain('BLOCKIERT')
  expect(await bash($, "Set-Content .\\config.json 'x'", 'PowerShell')).toContain('BLOCKIERT')
  expect(await bash($, "Set-Content .\\other.json 'x'", 'PowerShell')).toBe('ran')
  expect(await write($, 'C:\\Users\\u\\proj\\node_modules\\config.json')).toBe('ran')
})

test('andere Werkzeuge unberührt', async ($, on) => {
  engine(on)
  const r = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/app.ts`, old_string: 'a', new_string: 'b' })
  expect(r.deny).toBeUndefined()
})
