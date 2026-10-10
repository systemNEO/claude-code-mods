import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// Der Hook im geladenen Plugin, über $.tool.check (eine Abfrage ohne
// tool_use_id: dort antwortet er mit `ask` statt einen Dialog zu öffnen).
// Den Dialog selbst zeigt eine echte Sitzung.

type Setup = { verdict?: 'allow' | 'ask' | 'deny'; links?: Record<string, string>; files?: Record<string, string> }

function engine(on: On, s: Setup = {}) {
  on('session.root', () => ({ value: '/home/u/proj' }))
  on('session.cwd', () => ({ value: '/home/u/proj' }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.stat', (_$, e) => {
    const file = s.files?.[e.path]
    if (file !== undefined) return { value: { kind: 'file' as const, size: file.length, mtimeMs: 0, isLink: false } }
    const real = s.links?.[e.path]
    if (real === undefined) throw new Error('ENOENT')
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: real !== e.path, realPath: real } }
  })
  on('fs.read', (_$, e) => {
    const file = s.files?.[(e as { path: string }).path]
    if (file === undefined) throw new Error('ENOENT')
    return { value: file }
  })
  on('tool.check', () => ({ decision: s.verdict ?? 'allow' }))
}

const check = ($: { tool: { check: (a: { tool: string; input: unknown }) => Promise<{ decision: string; reason?: string }> } }, command: string, tool = 'Bash') =>
  $.tool.check({ tool, input: { command } })

test('innerhalb: Urteil der Engine bleibt', async ($, on) => {
  engine(on)
  expect((await check($, 'rm -rf build && rm *.log')).decision).toBe('allow')
})

test('außerhalb: ask, auch wenn die Engine erlaubt', async ($, on) => {
  engine(on)
  const r = await check($, 'rm -rf /tmp/x')
  expect(r.decision).toBe('ask')
  expect(r.reason).toContain('/tmp/x')
})

test('nicht bestimmbar: ask', async ($, on) => {
  engine(on)
  expect((await check($, 'rm -rf "$SOMEWHERE"')).decision).toBe('ask')
})

test('deny der Engine bleibt deny', async ($, on) => {
  engine(on, { verdict: 'deny' })
  expect((await check($, 'rm -rf /x')).decision).toBe('deny')
})

test('Symlink im Projekt nach außen: rm -rf link/ fragt, rm link nicht', async ($, on) => {
  engine(on, { links: { '/home/u/proj': '/home/u/proj', '/home/u/proj/link': '/srv/data' } })
  expect((await check($, 'rm -rf link/')).decision).toBe('ask')
  expect((await check($, 'rm link')).decision).toBe('allow')
})

test('Pfad außerhalb, der per Symlink im Projekt landet: fragt trotzdem (wörtlich außerhalb)', async ($, on) => {
  engine(on, { links: { '/home/u/proj': '/home/u/proj', '/home/u/shortcut/x': '/home/u/proj/sub/x' } })
  expect((await check($, 'rm -rf /home/u/shortcut/x/')).decision).toBe('ask')
})

test('Windows: Laufwerkswurzel wird nie über die Auflösung zu „innerhalb“', async ($, on) => {
  on('session.root', () => ({ value: 'C:\\Users\\u\\proj' }))
  on('session.cwd', () => ({ value: 'C:\\Users\\u\\proj' }))
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\u' : e.name === 'SystemDrive' ? 'C:' : undefined }))
  // So würde Windows `C:` (ohne Schrägstrich) auflösen: in den aktuellen Ordner.
  on('fs.stat', (_$, e) => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: /^C:\\?$/i.test(e.path) ? 'C:\\Users\\u\\proj' : e.path } }))
  on('fs.read', () => { throw new Error('ENOENT') })
  on('tool.check', () => ({ decision: 'allow' }))
  for (const c of ['Remove-Item \\* -Recurse -Force', 'rd /s /q \\', 'Remove-Item C: -Recurse', 'Remove-Item C:* -Recurse', 'cmd /c "del /s /q \\*"', 'Remove-Item $env:SystemDrive\\* -Recurse'])
    expect({ c, d: (await check($, c, 'PowerShell')).decision }).toEqual({ c, d: 'ask' })
})

test('PowerShell und Monitor', async ($, on) => {
  engine(on)
  expect((await check($, 'Remove-Item /etc/x -Recurse', 'PowerShell')).decision).toBe('ask')
  expect((await check($, 'Remove-Item ./x -Recurse', 'PowerShell')).decision).toBe('allow')
  expect((await check($, 'rm -rf /var/tmp/x', 'Monitor')).decision).toBe('ask')
})

test('MCP-Löschwerkzeuge', async ($, on) => {
  engine(on)
  expect((await $.tool.check({ tool: 'mcp__fs__delete_file', input: { path: '/etc/hosts' } })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'mcp__fs__delete_file', input: { path: './a.txt' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'mcp__docs__delete', input: { id: 'abc' } })).decision).toBe('allow')
})

test('andere Werkzeuge unberührt', async ($, on) => {
  engine(on)
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '/etc/passwd' } })).decision).toBe('allow')
})

test('Skripte im Projekt und in /tmp werden mitgelesen, installierte Werkzeuge nicht', async ($, on) => {
  engine(on, { files: {
    '/home/u/proj/clean.sh': 'cd "$(dirname "$0")"\nrm -rf out\nrm -rf ~/.cache/x\n',
    '/home/u/proj/ok.sh': 'OUT=build\nrm -rf "$OUT"\n',
    '/tmp/t.sh': 'rm -rf /srv/x',
    '/home/u/.nvm/nvm.sh': 'nvm_x() { rm -rf "$1"; }',
  } })
  const r = await check($, 'bash clean.sh')
  expect(r.decision).toBe('ask')
  expect(r.reason).toContain('/home/u/.cache/x')
  expect((await check($, './ok.sh')).decision).toBe('allow')
  expect((await check($, 'sh /tmp/t.sh')).decision).toBe('ask')
  expect((await check($, 'source ~/.nvm/nvm.sh && nvm use 20')).decision).toBe('allow')
})

test('Option boundary = ~: der ganze Heimatordner ist frei', { options: { boundary: '~' } }, async ($, on) => {
  engine(on)
  expect((await check($, 'rm -rf /home/u/other/x')).decision).toBe('allow')
  expect((await check($, 'rm -rf ../sibling')).decision).toBe('allow')
  expect((await check($, 'rm -rf /etc/x')).decision).toBe('ask')
  expect((await check($, 'rm -rf ~')).decision).toBe('ask')
})

test('Option boundary = ~/projects: auch der Startordner zählt nur, wenn er darin liegt', { options: { boundary: '~/projects' } }, async ($, on) => {
  engine(on)
  expect((await check($, 'rm -rf /home/u/projects/a/build')).decision).toBe('allow')
  expect((await check($, 'rm -rf build')).decision).toBe('ask')
})

test('Option allowedFolders: dort frei, sonst weiter gefragt', { options: { allowedFolders: ['/tmp', '~/Downloads'] } }, async ($, on) => {
  engine(on)
  expect((await check($, 'rm -rf /tmp/build')).decision).toBe('allow')
  expect((await check($, 'rm -rf /tmp/*')).decision).toBe('allow')
  expect((await check($, 'rm ~/Downloads/a.zip')).decision).toBe('allow')
  expect((await check($, 'rm -rf build')).decision).toBe('allow')
  expect((await check($, 'rm -rf /tmp')).decision).toBe('ask')
  expect((await check($, 'rm -rf /etc/x')).decision).toBe('ask')
  expect((await check($, 'rm -rf /tmp/x /etc/y')).decision).toBe('ask')
})

test('Option allowedFolders: Symlink aus dem freien Ordner nach außen fragt', { options: { allowedFolders: ['/tmp'] } }, async ($, on) => {
  engine(on, { links: { '/tmp': '/tmp', '/tmp/link': '/srv/data' } })
  expect((await check($, 'rm -rf /tmp/link/')).decision).toBe('ask')
  expect((await check($, 'rm /tmp/link')).decision).toBe('allow')
})
