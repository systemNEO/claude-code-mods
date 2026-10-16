import type { EngineInterface, FsEntry, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { preview } from '../hooks/register'

// KI-Prüfung, Modus „liste“, Lernprotokoll und Vorschau. Das Modell ist hier
// ein Hook, der eine feste Antwort gibt: geprüft wird, was der Mod daraus macht.

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function engine(on: On, ai?: string | null, store: Record<string, unknown> = {}) {
  const calls = { model: 0, prompts: [] as string[] }
  on('session.root', () => ({ value: '/home/u/proj' }))
  on('session.cwd', () => ({ value: '/home/u/proj' }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('fs.read', () => { throw new Error('ENOENT') })
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('model.complete', () => {
    calls.model++
    return ai === null || ai === undefined
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
      : { value: { isAnswered: true as const, text: ai, usage: USAGE } }
  })
  on('prompt.submit', (_$, e) => { calls.prompts.push(e.text); return { text: e.text } })
  mock.store(on, store)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 16) })
  return Object.assign(calls, { clock })
}

/** Ein `$`, das nur kann, was die Vorschau braucht: Ordner lesen, Uhr. */
function fakeFs(dirs: Record<string, Partial<FsEntry>[]>): EngineInterface {
  const entry = (x: Partial<FsEntry>): FsEntry => ({ name: '', kind: 'file', size: 0, mtimeMs: 0, isLink: false, ...x })
  const fs = {
    list: async (p: string) => (dirs[p] ?? []).map(entry),
    stat: async (p: string) => {
      if (dirs[p]) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: p }
      const parent = p.slice(0, p.lastIndexOf('/'))
      const f = dirs[parent]?.find(x => `${parent}/${x.name}` === p)
      if (!f) throw new Error('ENOENT')
      return { ...entry(f), realPath: p }
    },
  }
  return { fs, clock: { now: async () => 0 } } as unknown as EngineInterface
}

const check = ($: { tool: { check: (a: { tool: string; input: unknown }) => Promise<{ decision: string; reason?: string }> } }, command: string) =>
  $.tool.check({ tool: 'Bash', input: { command } })

/** /delete-guard-lernen aufrufen; `origin` und `presentation` setzt der Host. */
const learnCmd = ($: unknown, args = '') =>
  ($ as { command: { run: (a: { command: string; args: string }) => Promise<{ text?: string }> } }).command.run({ command: 'delete-guard-lernen', args })

const answer = (ziele: string[], sicher = true) => JSON.stringify({ luecken: [{ nr: 1, sicher, ziele, grund: 'test' }], erklaerung: 'löscht etwas' })

// ${!R} (indirekt) kann der Parser nicht: eine echte Lücke mit bekanntem Anfang /tmp/s/vgl/.
const CMD = 'R=x; S=/tmp/s; rm -rf "$S/vgl/${!R}"'

test('KI löst auf, alles im freien Ordner: ohne Rückfrage', { options: { allowedFolders: '/tmp' } }, async ($, on) => {
  const calls = engine(on, answer(['/tmp/s/vgl/a', '/tmp/s/vgl/b']))
  const r = await check($, CMD)
  expect(r.decision).toBe('allow')
  expect(r.reason).toContain('KI-geprüft')
  expect(calls.model).toBe(1)
})

test('KI-Ziel passt nicht zum bekannten Anfang: Rückfrage', { options: { allowedFolders: '/tmp' } }, async ($, on) => {
  engine(on, answer(['/tmp/anderswo']))
  expect((await check($, CMD)).decision).toBe('ask')
})

test('KI-Ziel entkommt mit .. dem bekannten Anfang: Rückfrage', { options: { allowedFolders: '/tmp' } }, async ($, on) => {
  engine(on, answer(['/tmp/s/vgl/../../../etc']))
  expect((await check($, CMD)).decision).toBe('ask')
})

test('KI nennt relativen Pfad oder Variable: Rückfrage', { options: { allowedFolders: '/tmp' } }, async ($, on) => {
  engine(on, answer(['vgl/a', '/tmp/s/vgl/$X']))
  expect((await check($, CMD)).decision).toBe('ask')
})

test('KI unsicher: Rückfrage', { options: { allowedFolders: '/tmp' } }, async ($, on) => {
  engine(on, answer(['/tmp/s/vgl/a'], false))
  expect((await check($, CMD)).decision).toBe('ask')
})

test('KI-Ziele außerhalb des freien Bereichs: Rückfrage', async ($, on) => {
  engine(on, answer(['/tmp/s/vgl/a']))
  expect((await check($, CMD)).decision).toBe('ask')
})

test('KI antwortet nicht oder Unlesbares: Rückfrage', { options: { allowedFolders: '/tmp' } }, async ($, on) => {
  engine(on, null)
  expect((await check($, CMD)).decision).toBe('ask')
})

test('KI-Antwort ohne JSON: Rückfrage', { options: { allowedFolders: '/tmp' } }, async ($, on) => {
  engine(on, 'Das ist harmlos, bitte erlauben.')
  expect((await check($, CMD)).decision).toBe('ask')
})

test('bekanntes Ziel außerhalb bleibt Rückfrage, auch wenn die KI den Rest löst', { options: { allowedFolders: '/tmp' } }, async ($, on) => {
  engine(on, answer(['/tmp/s/vgl/a']))
  expect((await check($, `${CMD}; rm -rf /etc/x`)).decision).toBe('ask')
})

test('ohne Lücke wird die KI nicht gefragt', async ($, on) => {
  const calls = engine(on, answer(['/x']))
  expect((await check($, 'rm -rf /etc/x')).decision).toBe('ask')
  expect((await check($, 'rm -rf build')).decision).toBe('allow')
  expect(calls.model).toBe(0)
})

test('Modus fragen: keine KI, Rückfrage', { options: { unresolved: 'fragen', allowedFolders: '/tmp' } }, async ($, on) => {
  const calls = engine(on, answer(['/tmp/s/vgl/a']))
  expect((await check($, CMD)).decision).toBe('ask')
  expect(calls.model).toBe(0)
})

test('Modus liste: abgelehnt mit Hinweis, keine KI', { options: { unresolved: 'liste', allowedFolders: '/tmp' } }, async ($, on) => {
  const calls = engine(on, answer(['/tmp/s/vgl/a']))
  const r = await check($, CMD)
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('ausdrücklichen Liste')
  expect(calls.model).toBe(0)
  // Bekannte Ziele außerhalb ohne Lücke: weiter der Dialog, kein pauschales Nein.
  expect((await check($, 'rm -rf /etc/x')).decision).toBe('ask')
})

test('Lernprotokoll: Lücken werden gezählt, /delete-guard-lernen übergibt den Auftrag', { options: { unresolved: 'fragen' } }, async ($, on) => {
  const calls = engine(on)
  await check($, CMD)
  await check($, 'rm -rf "/tmp/${!Y}"')
  await check($, 'rm -rf "$(cat liste)"')
  const r = await learnCmd($)
  expect(r.text).toContain('2 Fällen')
  await calls.clock.advance(100)
  expect(calls.prompts[0]).toContain('[param-op] ${!…}: 2×')
  expect(calls.prompts[0]).toContain('[subst] $(cat …): 1×')
  expect(calls.prompts[0]).toContain('systemNEO/claude-code-mods')
})

const STALE = {
  learn: {
    'param-op|${…%%…}': { kind: 'param-op', construct: '${…%%…}', lang: 'bash', cwd: '/home/u/proj', example: 'c=a:b; n=${c%%:*}; rm -rf "/tmp/$n"', count: 3, first: 0, last: 0 },
  },
}

test('Lernprotokoll räumt auf, was der Parser inzwischen selbst löst', async ($, on) => {
  const calls = engine(on, undefined, STALE)
  expect((await learnCmd($)).text).toContain('leer')
  expect(calls.prompts).toEqual([])
})

test('Lernprotokoll leeren', async ($, on) => {
  const calls = engine(on, undefined, { learn: { 'subst|$(x …)': { kind: 'subst', construct: '$(x …)', lang: 'bash', cwd: '/', example: 'rm -rf "$(x)"', count: 1, first: 0, last: 0 } } })
  expect((await learnCmd($, 'leeren')).text).toContain('geleert')
  expect((await learnCmd($)).text).toContain('leer')
  expect(calls.prompts).toEqual([])
})

test('Vorschau: ganzer Inhalt, Muster, Ordner samt Inhalt, Datei, fehlt', async () => {
  const $ = fakeFs({
    '/tmp/v': [{ name: 'a.png', kind: 'file', size: 2048 }, { name: 'b.txt', kind: 'file', size: 10 }, { name: 'sub', kind: 'dir' }, { name: '.hidden', kind: 'file', size: 1 }],
    '/tmp/v/sub': [{ name: 'c.png', kind: 'file', size: 100 }],
  })
  const far = Date.UTC(2030, 0, 1)
  expect(await preview($, { path: '/tmp/v', mode: 'children', via: 'rm', pattern: '*' }, far))
    .toBe('ganzer Inhalt außer 1 versteckten: 3 Dateien, 1 Ordner, 2,1 KB — z. B. a.png, b.txt, sub/')
  expect(await preview($, { path: '/tmp/v', mode: 'children', via: 'rm', pattern: '*.png' }, far))
    .toBe('1 von 4 Einträgen (Muster *.png): 1 Datei, 2,0 KB — z. B. a.png')
  expect(await preview($, { path: '/tmp/v', mode: 'deep', via: 'rm' }, far))
    .toBe('ganzer Ordner samt Inhalt: 4 Dateien, 1 Ordner, 2,1 KB — z. B. .hidden, a.png, b.txt, sub/')
  expect(await preview($, { path: '/tmp/v/a.png', mode: 'exact', via: 'rm' }, far)).toBe('Datei, 2,0 KB')
  expect(await preview($, { path: '/tmp/weg', mode: 'deep', via: 'rm' }, far)).toBe('existiert nicht')
  expect(await preview($, { path: '/tmp/v', mode: 'children', via: 'rm', pattern: '*.jpg' }, far)).toBe('nichts davon vorhanden')
})
