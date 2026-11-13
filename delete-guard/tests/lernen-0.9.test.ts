import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { type Ctx, type Lang, lang, newOut, within } from '../hooks/common'
import '../hooks/bash'
import '../hooks/ps'

// Aus dem Lern- und Entscheidungsprotokoll (0.9.0): was sich aus dem Text
// bestimmen lässt, je mit einem Fall innerhalb, einem außerhalb und einem
// Ausweg durch die neue Stelle. Dazu `source`-Dateien, die mitgelesen werden,
// und die Antwort „Umschreiben lassen“.

const LINUX: Ctx = { root: '/home/u/proj', win: false, home: '/home/u', env: n => ({ TMPDIR: '/tmp' } as Record<string, string>)[n] }

function check(src: string, ctx: Ctx = LINUX, which: Lang = 'bash') {
  const out = newOut()
  lang[which](src, { cwd: ctx.root, vars: new Map(), stack: [] }, { ctx, out, depth: 0 })
  const outside = out.targets.filter(t => !within(t.path, ctx.root, ctx.win, t.mode === 'children')).map(t => t.path)
  return { outside, unknowns: out.unknowns, scripts: out.scripts }
}
const free = (src: string, ctx?: Ctx) => test(`frei: ${src}`, () => { const r = check(src, ctx); expect({ outside: r.outside, unknowns: r.unknowns }).toEqual({ outside: [], unknowns: [] }) })
const outside = (src: string, paths: string[], ctx?: Ctx) => test(`außerhalb: ${src}`, () => { const r = check(src, ctx); expect({ outside: r.outside, unknowns: r.unknowns }).toEqual({ outside: paths, unknowns: [] }) })
const asks = (src: string, ctx?: Ctx) => test(`fragt: ${src}`, () => { const r = check(src, ctx); expect(r.outside.length + r.unknowns.length).toBeGreaterThan(0) })

describe('Python-Code, der fremden Code nur als Text enthält', () => {
  free('python3 - <<\'EOF\'\nedit(g, """process.once("exit", () => rmSync(directory, { recursive: true }));""", """x = join(tmpdir(), P)""")\nEOF')
  free('python3 -c "open(\'a.ts\',\'w\').write(\'fs.rmSync(dir); Deno.remove(p)\')"')
  // Python-eigene Aufrufe zählen weiter, auch neben fremdem Text.
  outside('python3 -c "import shutil; shutil.rmtree(\'/etc/x\'); s=\'rmSync\'"', ['/etc/x'])
  // Startet der Code Programme, könnte der Text doch laufen: wie bisher.
  asks('python3 -c "import subprocess,tempfile; subprocess.run([\'node\',\'-e\',\'fs.rmSync(process.env.X)\'])"')
  // Für node bleibt rmSync ein Löschaufruf.
  outside('node -e "require(\'fs\').rmSync(\'/etc/x\')"', ['/etc/x'])
})

describe('dieselbe Variable mehrfach in einem Wort', () => {
  const eleven = '2026-10-20 2026-10-21 2026-10-23 2026-10-24 2026-10-25 2026-10-26 2026-10-27 2026-10-28 2026-10-29 2026-10-30 2026-11-01'
  free(`for d in ${eleven}; do python3 -c "import json;d=json.load(open('g3_$d.json'));print('$d',len(d))"; done`)
  free(`for d in ${eleven}; do rm "out/$d/$d.json"; done`)
  outside('for d in a b c; do rm "/etc/$d/$d.conf"; done', ['/etc/a/a.conf', '/etc/b/b.conf', '/etc/c/c.conf'])
  // Verschiedene Variablen bleiben unabhängig: alle Kombinationen zählen.
  outside('for a in x y; do for b in 1 2; do rm "/etc/$a$b"; done; done', ['/etc/x1', '/etc/x2', '/etc/y1', '/etc/y2'])
  // Mit Operator: Fassung i gehört weiter zu Fassung i.
  outside('for f in a.png b.png; do rm "/etc/$f" "/etc/${f%.png}-${f%.png}.jpg"; done', ['/etc/a.png', '/etc/b.png', '/etc/a-a.jpg', '/etc/b-b.jpg'])
})

describe('Leerzeichen in ${…}', () => {
  free('for v in "de 1280" "en 390"; do rm "probe-${v// /-}.json"; done')
  outside('for v in "de 1280" "en 390"; do rm "/etc/${v// /-}"; done', ['/etc/de-1280', '/etc/en-390'])
  outside('v="a b"; rm "/etc/${v/ b/ c}"', ['/etc/a c'])
  outside('v="a b c"; rm "/etc/${v% *}"', ['/etc/a b'])
})

describe('mehrere Skripte aus einer Schleife', () => {
  test('bash $S/$s.sh: beide werden nachgelesen', () => {
    const r = check('S=/tmp/sp; for s in density density2; do bash $S/$s.sh a b; done')
    expect(r.unknowns).toEqual([])
    expect(r.scripts.map(s => s.path)).toEqual(['/tmp/sp/density.sh', '/tmp/sp/density2.sh'])
  })
  asks('bash "$UNBEKANNT/x.sh"')
  asks('bash scripts/*.sh')
})

describe('Schutzlücken, beim Durchsehen gefunden', () => {
  // Die Vorgabe in ${X:-…} ist ein Wort, kein Text.
  outside('rm -rf "${X:-$HOME/y}"', ['/home/u/y'])
  free('rm -rf "${X:-build}/tmp"')
  asks('rm -rf "${X:-$UNBEKANNT/y}"')
  // Eine freie Variable zerfällt an Leerraum in mehrere Wörter.
  outside('F="a /etc/x"; rm $F', ['/etc/x'])
  free('F="a b"; rm $F')
  free('F="a b"; rm "$F"')
  outside('L="/etc/a /etc/b"; for f in $L; do rm "$f"; done', ['/etc/a', '/etc/b'])
  // shift und set -- ändern $1.
  asks("bash -c 'shift; rm \"$1\"' _ a /etc/x")
  outside("bash -c 'set -- /etc/x; rm \"$1\"' _ a", ['/etc/x'])
  free("bash -c 'set -- out; rm \"$1\"' _ /etc/x")
  free("bash -c 'set -e; rm \"$1\"' _ out")
  asks("bash -c 'set -- $(ls); rm \"$1\"' _ out")
  asks('for pt in "a /etc/x" "b /etc/y"; do set -- $pt; rm "$2"; done')
  // trap: der Befehl läuft später.
  outside("trap 'rm -rf /etc/x' EXIT", ['/etc/x'])
  free("trap 'rm -rf build' EXIT")
  free('trap - EXIT; trap "" INT')
  asks('trap "$UNBEKANNT" EXIT')
})

describe('source liest mit, wenn der Inhalt bekannt ist', () => {
  const files = new Map([
    ['/home/u/proj/scripts/aliases.sh', 'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\nFILES="-f $ROOT/a.yml"\nalias up="bash $ROOT/scripts/compose.sh"\n'],
    ['/home/u/proj/scripts/weg.sh', 'ZIEL=/etc/weg\n'],
    ['/home/u/proj/scripts/loescht.sh', 'rm -rf /etc/y\n'],
    ['/home/u/proj/scripts/kreis.sh', 'source /home/u/proj/scripts/kreis.sh\nX=1\n'],
  ])
  const C: Ctx = { ...LINUX, files }
  test('Variablen aus der Datei gelten danach: das gestartete Skript ist bestimmbar', () => {
    const r = check('source scripts/aliases.sh >/dev/null && bash $ROOT/scripts/compose.sh $FILES up -d', C)
    expect(r.unknowns).toEqual([])
    expect(r.scripts.map(s => `${s.path}${s.done ? ' (mitgelesen)' : ''}`)).toEqual(['/home/u/proj/scripts/aliases.sh (mitgelesen)', '/home/u/proj/scripts/compose.sh'])
  })
  free('. scripts/aliases.sh; rm -rf "$ROOT/build"', C)
  outside('source scripts/weg.sh; rm -rf "$ZIEL"', ['/etc/weg'], C)
  outside('source scripts/loescht.sh', ['/etc/y'], C)
  free('source scripts/kreis.sh; rm -rf build', C)
  // Ohne Inhalt bleibt es wie bisher: vormerken, Variable unbekannt.
  asks('source scripts/aliases.sh && bash $ROOT/scripts/compose.sh')
  // BASH_SOURCE gilt nur während des Mitlesens.
  asks('source scripts/weg.sh; rm -rf "$(dirname "${BASH_SOURCE[0]}")/x"', C)
})

// ---------------------------------------------------------------- über den Hook

type Setup = { files?: Record<string, string>; ai?: string; store?: Record<string, unknown> }

function engine(on: On, s: Setup = {}) {
  const seen = { reads: [] as string[], prompts: [] as string[] }
  on('session.root', () => ({ value: '/home/u/proj' }))
  on('session.cwd', () => ({ value: '/home/u/proj' }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.stat', (_$, e) => {
    const file = s.files?.[e.path]
    if (file === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: file.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const path = (e as { path: string }).path
    const file = s.files?.[path]
    if (file === undefined) throw new Error('ENOENT')
    seen.reads.push(path)
    return { value: file }
  })
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('model.complete', (_$, e) => {
    seen.prompts.push((e as { prompt: string }).prompt)
    return s.ai === undefined
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
      : { value: { isAnswered: true as const, text: s.ai, usage: USAGE } }
  })
  mock.store(on, s.store ?? {})
  mock.clock(on, { now: Date.UTC(2026, 10, 13) })
  return seen
}
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Checker = { tool: { check: (a: { tool: string; input: unknown; tool_use_id?: string }) => Promise<{ decision: string; reason?: string }> } }
const check$ = ($: unknown, command: string, id?: string) =>
  ($ as Checker).tool.check({ tool: 'Bash', input: { command }, ...(id ? { tool_use_id: id } : {}) })
const run = ($: unknown, command: string, args = '') =>
  ($ as { command: { run: (a: { command: string; args: string }) => Promise<{ text?: string }> } }).command.run({ command, args })

const ALIASES = 'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n'

test('Hook: source wird nachgelesen, das damit bestimmte Skript auch', async ($, on) => {
  const seen = engine(on, { files: { '/home/u/proj/scripts/aliases.sh': ALIASES, '/home/u/proj/scripts/compose.sh': 'docker compose "$@"\n' } })
  expect((await check$($, 'source scripts/aliases.sh >/dev/null && bash $ROOT/scripts/compose.sh up -d')).decision).toBe('allow')
  expect(seen.reads).toEqual(['/home/u/proj/scripts/aliases.sh', '/home/u/proj/scripts/compose.sh'])
})

test('Hook: was das so bestimmte Skript löscht, zählt', async ($, on) => {
  engine(on, { files: { '/home/u/proj/scripts/aliases.sh': ALIASES, '/home/u/proj/scripts/compose.sh': 'rm -rf /etc/x\n' } })
  const r = await check$($, 'source scripts/aliases.sh && bash $ROOT/scripts/compose.sh')
  expect(r.decision).toBe('ask')
  expect(r.reason).toContain('compose.sh: rm: /etc/x')
})

test('Hook: Löschen in der source-Datei selbst zählt einmal', async ($, on) => {
  engine(on, { files: { '/home/u/proj/lib.sh': 'weg() { rm -f "$3"; }\n' } })
  const r = await check$($, '. ./lib.sh; echo hi')
  expect(r.decision).toBe('ask')
  expect(r.reason?.match(/lib\.sh: rm/g)?.length).toBe(1)
})

const LIB = 'weg() { rm -f "$3"; }\n'
const LIB_CMD = '. ./lib.sh; weg a b owner.jar'
const solved = (ziele: string[]) => JSON.stringify({ luecken: [{ nr: 1, sicher: true, ziele, grund: 'Argument des Aufrufs' }], erklaerung: 'löscht owner.jar' })

test('KI-Prüfung bekommt die gelesenen Skripte zu sehen', async ($, on) => {
  const seen = engine(on, { files: { '/home/u/proj/lib.sh': LIB }, ai: solved(['/home/u/proj/owner.jar']) })
  const r = await check$($, LIB_CMD)
  expect(r.decision).toBe('allow')
  expect(r.reason).toContain('KI-geprüft')
  expect(seen.prompts[0]).toContain('<skript pfad="/home/u/proj/lib.sh">')
  expect(seen.prompts[0]).toContain('weg() { rm -f "$3"; }')
})

test('KI-Prüfung: ein zu langes Skript wird nicht halb gezeigt', async ($, on) => {
  const seen = engine(on, { files: { '/home/u/proj/lib.sh': `${LIB}${'# x\n'.repeat(4000)}` } })
  await check$($, LIB_CMD)
  expect(seen.prompts[0]).toContain('fehlt="zu lang')
  expect(seen.prompts[0]).not.toContain('weg() {')
})

// Der Dialog selbst (und damit die Wahl „Umschreiben lassen“) lässt sich hier
// nicht bedienen: geprüft wird der Modus, der dieselbe Antwort ohne Dialog gibt.

test('Modus umschreiben: ohne Dialog zurück an Claude mit Anleitung, protokolliert; beim dritten Mal der Dialog', { options: { unresolved: 'umschreiben' } }, async ($, on) => {
  const seen = engine(on)
  for (const n of ['a', 'b']) {
    const r = await check$($, `rm -rf "$(cat ${n})"`, `t${n}`)
    expect(r.decision).toBe('deny')
    expect(r.reason).toContain('so umschreiben')
    expect(r.reason).toContain(`$(cat ${n})`)
    expect(r.reason).toContain('erneut versuchen')
  }
  expect(seen.prompts.length).toBe(2)
  // Zwei Rückgaben kurz hintereinander: jetzt entscheidet der Nutzer (hier ist niemand da).
  const third = await check$($, 'rm -rf "$(cat c)"', 'tc')
  expect(third.decision).toBe('deny')
  expect(third.reason).not.toContain('so umschreiben')
  expect((await run($, 'delete-guard-protokoll')).text).toContain('auto: umschreiben')
  expect((await run($, 'delete-guard-lernen')).text).toContain('3 Entscheidungen')
})

test('Modus umschreiben: was die KI auflöst, läuft; bekannte Ziele außerhalb gehen an den Nutzer', { options: { unresolved: 'umschreiben', allowedFolders: '/tmp' } }, async ($, on) => {
  engine(on, { ai: JSON.stringify({ luecken: [{ nr: 1, sicher: true, ziele: ['/tmp/s/a'], grund: 'x' }], erklaerung: 'x' }) })
  expect((await check$($, 'R=x; rm -rf "/tmp/s/${!R}"', 't1')).decision).toBe('allow')
  const r = await check$($, 'rm -rf /etc/x "/tmp/s/${!R}"', 't2')
  expect(r.decision).toBe('deny')
  expect(r.reason).not.toContain('so umschreiben')
})

test('Modus umschreiben: ohne tool_use_id (reine Abfrage) bleibt es bei ask', { options: { unresolved: 'umschreiben' } }, async ($, on) => {
  engine(on)
  expect((await check$($, 'rm -rf "$(cat liste)"')).decision).toBe('ask')
})

// ---------------------------------------------------------------- 0.9.1

describe('$(mktemp): der Ordner steht fest, nur der Name nicht', () => {
  const TMP: Ctx = { ...LINUX, allowed: ['/tmp'] }
  const inTmp = (src: string, paths: string[], ctx: Ctx = TMP) => test(`mktemp: ${src}`, () => {
    const r = check(src, ctx)
    expect(r.unknowns).toEqual([])
    expect(r.outside).toEqual(paths)
  })
  inTmp('jar=$(mktemp); curl -c "$jar" x; rm -f "$jar"', ['/tmp/tmp.XXXXXXXXXX'])
  inTmp('d=$(mktemp -d) && rm -rf "$d/sub"', ['/tmp/tmp.XXXXXXXXXX/sub'])
  inTmp('f=$(mktemp /var/lib/app/fooXXXXXX); rm "$f"', ['/var/lib/app/fooXXXXXX'])
  inTmp('f=$(mktemp); rm "$f"', ['/var/run/t/tmp.XXXXXXXXXX'], { ...LINUX, env: n => (n === 'TMPDIR' ? '/var/run/t' : undefined) })
  free('f=$(mktemp outXXXXXX); rm "$f"')
  // Der Ausweg über den Ordner: -p, -t, --tmpdir und ein im Befehl gesetztes TMPDIR bleiben unbekannt.
  asks('f=$(mktemp -p /etc); rm "$f"')
  asks('f=$(mktemp -t x.XXXXXX); rm "$f"')
  asks('f=$(mktemp --tmpdir=/etc); rm "$f"')
  asks('TMPDIR=/etc; f=$(mktemp); rm "$f"')
  asks('f=$(mktemp "$UNBEKANNT/aXXXXXX"); rm "$f"')
  asks('f=$(mktemp | head -1); rm "$f"')
})

describe('Zuweisung vor dem Befehl mit unbekanntem Wert', () => {
  // Früher: „Befehl nicht auflösbar“, weil im Pfad zufällig „rm“ stand (the-rm-oschmiede).
  free('CHROME_PATH=$(node -e "console.log(require(\'/x/thermoschmiede/p.js\').path())") timeout 240 lighthouse https://x.y --quiet')
  outside('X=$(cat thermo) rm -rf /etc/x', ['/etc/x'])
  asks('X=$(cat thermo) rm -rf "$UNBEKANNT"')
  // Ein unbekannter Befehl, der nach Löschen aussieht, fragt weiter.
  asks('$(cat thermo) -rf /etc/x')
})

const SCRIPT = '/home/u/proj/s.sh'
const withScript = (text: string, extra: Record<string, string> = {}) => ({ files: { [SCRIPT]: text, ...extra } })

test('Skript-Argumente: $1 des Skripts ist das Argument des Aufrufs', async ($, on) => {
  engine(on, withScript('rm -rf "$1/cache"\n'))
  expect((await check$($, 'bash s.sh build')).decision).toBe('allow')
  const r = await check$($, 'bash s.sh /etc')
  expect(r.decision).toBe('ask')
  expect(r.reason).toContain('s.sh: rm: /etc/cache')
})

test('Skript-Argumente: jede Fassung aus einer Schleife, jeder Aufruf für sich', async ($, on) => {
  engine(on, withScript('rm -rf "$2"\n'))
  expect((await check$($, 'for d in a b; do bash s.sh x "$d"; done')).decision).toBe('allow')
  const r = await check$($, './s.sh x out; ./s.sh x /etc/y')
  expect(r.decision).toBe('ask')
  expect(r.reason).toContain('/etc/y')
})

test('Skript-Argumente: steht die Zählung nicht fest, bleibt $1 unbekannt', async ($, on) => {
  engine(on, withScript('rm -rf "$1"\n'))
  for (const c of ['F="a /etc/x"; bash s.sh $F', 'bash s.sh $(cat liste)', 'bash s.sh *.txt', 'bash s.sh "$UNBEKANNT"'])
    expect({ c, d: (await check$($, c)).decision }).toEqual({ c, d: 'ask' })
})

test('Skript-Argumente: Python-Code im Skript mit $1 ist vollständig', async ($, on) => {
  engine(on, withScript('python3 -c "print($1 + $2)"\n'))
  expect((await check$($, 'for d in 0.1 0.3; do bash s.sh 9.03 $d; done')).decision).toBe('allow')
})

test('Lernprotokoll: was über eine source-Datei jetzt auflösbar ist, wird beim Start gestrichen', async ($, on) => {
  const example = 'source scripts/aliases.sh >/dev/null && bash "$ROOT/scripts/compose.sh" up -d'
  const learn = { 'other|bash: Skript nicht auflösbar': { kind: 'other', construct: 'bash: Skript nicht auflösbar', lang: 'bash', cwd: '/home/u/proj', example, count: 7, first: 0, last: 0, ai: 'offen' } }
  engine(on, { files: { '/home/u/proj/scripts/aliases.sh': ALIASES, '/home/u/proj/scripts/compose.sh': 'docker compose "$@"\n' }, store: { learn } })
  expect((await check$($, example)).decision).toBe('allow')
})
