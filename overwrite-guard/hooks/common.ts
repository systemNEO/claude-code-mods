// Gemeinsame Typen, Pfadlogik und Regeln. Alles hier ist rein (kein `$`):
// register.ts holt Projektordner, Arbeitsordner und Umgebung und reicht sie
// als Ctx herein; ob eine Datei schon da ist, klärt register.ts danach.
// Die Pfadlogik stammt aus delete-guard (hooks/common.ts).

/** Was über die Umgebung der Sitzung bekannt ist. */
export type Ctx = {
  /** Projektordner, absolut und gefaltet. */
  root: string
  /** Läuft die Sitzung unter Windows (Projektordner `C:/…` oder `//server/…`)? */
  win: boolean
  /** Heimatordner, gefaltet, oder null. */
  home: string | null
  /** Umgebungsvariable lesen (unter Windows ohne Groß/Klein-Unterschied). */
  env: (name: string) => string | undefined
}

/**
 * Was ein Befehl womöglich komplett ersetzt:
 * - `file`: genau diese Datei (`> f`, `tee f`, `open('f','w')`).
 * - `into`: Ziel von cp/mv: ist `dest` ein Ordner, die gleichnamigen Dateien
 *   der Quellen darin (Quellen dürfen Platzhalter im Namen haben), sonst
 *   `dest` selbst.
 * - `computed`: der Pfad steht erst zur Laufzeit fest; `hint` ist der Text,
 *   an dem sich Endung und freie Ordner noch erkennen lassen.
 */
export type Finding =
  | { kind: 'file'; path: string; via: string }
  | { kind: 'into'; dest: string; sources: string[]; via: string }
  | { kind: 'computed'; hint: string; via: string }

export type Lang = 'bash' | 'ps' | 'cmd'

/** Arbeitsordner eines Befehlsstrangs: alle möglichen (nach einem `cd`, das scheitern kann); null = unbekannt. */
export type Cwds = string[] | null

export type Run = { ctx: Ctx; out: Finding[]; depth: number }

export const MAX_DEPTH = 6

type Analyzer = (src: string, cwds: Cwds, run: Run) => void

/** Die Sprachen rufen einander auf (bash -c → pwsh -Command → cmd /c …), ohne einander zu importieren. */
export const lang: Record<Lang, Analyzer> = { bash: () => {}, ps: () => {}, cmd: () => {} }

const DRIVE = /^([A-Za-z]):(?:\/|$)/
const PROVIDER = /^([A-Za-z][A-Za-z0-9.]+):/

export const isWinPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p)

/** `.` und `..` falten; `prefix` (`/`, `C:/`, `//srv/share/`) bleibt stehen. */
function fold(prefix: string, rest: string): string {
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  const joined = prefix + out.join('/')
  if (joined.length > prefix.length || prefix === '') return joined
  return /^[A-Za-z]:\/$/.test(prefix) ? prefix : prefix.replace(/\/$/, '') || '/'
}

/**
 * Absolute, gefaltete Form von `p` relativ zu `base`; null, wenn `p` relativ
 * und `base` unbekannt ist. `winSyntax`: Rückstriche sind Trenner
 * (PowerShell, cmd). Windows-Schreibweisen werden auf die Plattform des
 * Projektordners gebracht (`C:\x` unter WSL zu `/mnt/c/x`).
 */
export function absolute(p: string, base: string | null, ctx: Ctx, winSyntax: boolean): string | null {
  let s = winSyntax || ctx.win ? p.replace(/\\/g, '/') : p
  s = s.replace(/^(Microsoft\.PowerShell\.Core\/)?FileSystem::/i, '')
  const prov = PROVIDER.exec(s)
  if (prov && !DRIVE.test(s) && !/^[A-Za-z]:[^/]/.test(s)) return s
  const drive = /^([A-Za-z]):\/?(.*)$/.exec(s)
  if (drive) {
    const [, d = 'C', rest = ''] = drive
    return ctx.win ? fold(`${d.toUpperCase()}:/`, rest) : fold('/', `mnt/${d.toLowerCase()}/${rest}`)
  }
  if (s.startsWith('//')) {
    const m = /^\/\/([^/]+)\/?([^/]*)\/?(.*)$/.exec(s)
    if (m) return fold(`//${m[1]}/${m[2] ? `${m[2]}/` : ''}`, m[3] ?? '')
  }
  if (s.startsWith('/')) {
    if (!ctx.win) return fold('/', s)
    const mnt = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(s) ?? /^\/([A-Za-z])(?:\/(.*))?$/.exec(s)
    if (mnt) return fold(`${(mnt[1] ?? 'C').toUpperCase()}:/`, mnt[2] ?? '')
    const d = base && DRIVE.exec(base)?.[1]
    return fold(`${(d || 'C').toUpperCase()}:/`, s)
  }
  if (base === null) return null
  return absolute(`${base}/${s}`, null, ctx, winSyntax)
}

export const normalizeRoot = (p: string, win: boolean): string =>
  absolute(p, null, { root: '', home: null, env: () => undefined, win }, win) ?? p

const key = (p: string, win: boolean) => (win ? p.toLowerCase() : p)

/** Liegt `p` unterhalb von `root`? */
export function within(p: string, root: string, win: boolean): boolean {
  const r = key(root, win)
  return key(p, win).startsWith(r.endsWith('/') ? r : `${r}/`)
}

export const parentOf = (p: string): string => {
  const i = p.lastIndexOf('/')
  if (i <= 0) return '/'
  const head = p.slice(0, i)
  return /^[A-Za-z]:$/.test(head) ? `${head}/` : head
}

export const baseName = (p: string): string => p.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '')

export const joinPath = (dir: string, name: string) => `${dir.replace(/\/$/, '')}/${name}`

export const GLOB = /[*?[]/

/** `~` und `~/…` auflösen; sonst unverändert. */
export const untilde = (p: string, ctx: Ctx): string =>
  ctx.home && (p === '~' || /^~[\\/]/.test(p)) ? `${ctx.home}${p.slice(1)}` : p

/**
 * Ein geschriebenes Ziel festhalten, je möglichem Arbeitsordner einmal. Ist
 * der Ordner unbekannt, bleibt nur der Text als Hinweis.
 */
export function addFile(out: Finding[], s: string, cwds: Cwds, ctx: Ctx, via: string, winSyntax: boolean): void {
  if (s === '') return
  const p = untilde(s, ctx)
  if (GLOB.test(p)) return void out.push({ kind: 'computed', hint: s, via })
  for (const base of cwds ?? [null]) {
    const abs = absolute(p, base, ctx, winSyntax)
    if (abs === null) out.push({ kind: 'computed', hint: s, via })
    else out.push({ kind: 'file', path: abs, via })
  }
}

/** Einen Pfad an jedem möglichen Arbeitsordner auflösen (für `cd`); null, wenn einer unbekannt ist. */
export function resolveAll(p: string, cwds: Cwds, ctx: Ctx, winSyntax: boolean): Cwds {
  const out: string[] = []
  for (const base of cwds ?? [null]) {
    const abs = absolute(untilde(p, ctx), base, ctx, winSyntax)
    if (abs === null) return null
    out.push(abs)
  }
  return out
}

/** Ziel von cp/mv festhalten: `dest` und die Namen der Quellen. */
export function addInto(out: Finding[], dest: string, sources: string[], cwds: Cwds, ctx: Ctx, via: string, winSyntax: boolean): void {
  const p = untilde(dest, ctx)
  if (GLOB.test(p)) return void out.push({ kind: 'computed', hint: dest, via })
  for (const base of cwds ?? [null]) {
    const abs = absolute(p, base, ctx, winSyntax)
    const from = sources.map(s => absolute(untilde(s, ctx), base, ctx, winSyntax) ?? s)
    if (abs === null) out.push({ kind: 'computed', hint: dest, via })
    else out.push({ kind: 'into', dest: abs, sources: from, via })
  }
}

// ---------------------------------------------------------------- Code für Interpreter

/**
 * Schreibaufrufe in Code, der einem Interpreter übergeben wird (python -c,
 * node -e, Heredoc an python3 …). Mit festem Pfad wird er geprüft; mit einem
 * berechneten Pfad zählt der Code selbst als Hinweis.
 */
const STR = String.raw`(['"\x60])((?:(?!\1)[^\\\n]|\\.)*)\1`
const LITERAL_WRITES: RegExp[] = [
  new RegExp(String.raw`\bopen\(\s*${STR}\s*,\s*(?:mode\s*=\s*)?['"]w`, 'g'),
  new RegExp(String.raw`\bPath\(\s*${STR}\s*\)\s*\.write_(?:text|bytes)\(`, 'g'),
  new RegExp(String.raw`\b(?:writeFileSync|writeFile|writeTextFile|writeTextFileSync|Bun\.write)\(\s*${STR}`, 'g'),
  new RegExp(String.raw`\bFile\.write\(\s*${STR}`, 'g'),
  new RegExp(String.raw`\bfile_put_contents\(\s*${STR}(?![^)]*FILE_APPEND)`, 'g'),
  new RegExp(String.raw`\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]>['"]\s*,\s*${STR}`, 'g'),
  new RegExp(String.raw`\[(?:System\.)?IO\.File\]::WriteAll(?:Text|Lines|Bytes)\(\s*${STR}`, 'gi'),
]
const ANY_WRITE =
  /\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"]w|\.write_(?:text|bytes)\(|\b(?:writeFileSync|writeFile|writeTextFile|writeTextFileSync|Bun\.write|File\.write|file_put_contents)\(|\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]>['"]|::WriteAll(?:Text|Lines|Bytes)\(/i

export function inlineCode(code: string, cwds: Cwds, ctx: Ctx, out: Finding[], via: string): void {
  let rest = code
  for (const re of LITERAL_WRITES) {
    rest = rest.replace(re, (whole: string, quote: string, path: string) => {
      if (quote === '`' && path.includes('${')) return whole
      addFile(out, path.replace(/\\(.)/g, '$1'), cwds, ctx, via, false)
      return ' '
    })
  }
  if (ANY_WRITE.test(rest)) out.push({ kind: 'computed', hint: code, via })
}

export const INTERPRETERS: Record<string, string[]> = {
  python: ['-c'], py: ['-c'], pypy: ['-c'],
  node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval'], bun: ['-e', '--eval'],
  perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'],
}

/** `python3.12` → `python`; null, wenn kein bekannter Interpreter. */
export function interpreterFlags(name: string): string[] | null {
  return INTERPRETERS[name] ?? INTERPRETERS[name.replace(/[\d.]+$/, '')] ?? null
}

// ---------------------------------------------------------------- Regeln aus den Optionen

/** Eine Liste aus den Optionen: Text mit `,` `;` oder Zeilen. */
export function splitList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]/) : []
  return list.filter((x): x is string => typeof x === 'string').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

export type Rules = {
  /** Endungen ohne Punkt, klein; `*` schützt alles. */
  extensions: string[]
  /** Freie Ordner, absolut und gefaltet. */
  freeRoots: string[]
  /** Freie Ordnernamen (überall im Pfad). */
  freeNames: string[]
  /** Erlaubte Dateien als RegExp über den absoluten Pfad. */
  allowed: RegExp[]
}

/** Ordner, in denen nie eine Projektdatei liegt. */
const DEVICE_ROOTS = ['/dev', '/proc', '/sys']

export function makeRules(options: { protectedExtensions: string[]; freeFolders: string[]; allowedFiles: string[] }, ctx: Ctx): Rules {
  const freeRoots = [...DEVICE_ROOTS]
  const freeNames: string[] = []
  for (const f of options.freeFolders) {
    const p = untilde(f, ctx)
    if (!/[\\/]/.test(p) && !p.startsWith('~')) { freeNames.push(ctx.win ? p.toLowerCase() : p); continue }
    const abs = absolute(p, ctx.root, ctx, ctx.win)
    if (abs !== null && !p.startsWith('~')) freeRoots.push(abs)
  }
  return {
    extensions: options.protectedExtensions.map(x => x.replace(/^\*?\./, '').toLowerCase()),
    freeRoots,
    freeNames,
    allowed: options.allowedFiles.flatMap(p => {
      const re = patternRe(p, ctx)
      return re ? [re] : []
    }),
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Ein Dateimuster (`*`, `**`, `?`) als RegExp über den absoluten Pfad. */
export function patternRe(pattern: string, ctx: Ctx): RegExp | null {
  const p = untilde(pattern.replace(/\\/g, '/'), ctx)
  if (p.startsWith('~')) return null
  const anchored = p.includes('/') ? absolute(p.replace(/\/$/, '/**'), ctx.root, ctx, ctx.win) : `**/${p}`
  if (anchored === null) return null
  let re = ''
  for (let i = 0; i < anchored.length; i++) {
    const c = anchored[i] ?? ''
    if (c === '*' && anchored[i + 1] === '*') {
      i++
      if (anchored[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += esc(c)
  }
  return new RegExp(`^${re}$`, ctx.win ? 'i' : '')
}

/** Ein Name mit Platzhaltern (`*.ts`, `a?.json`) als RegExp über einen Dateinamen. */
export function globRe(name: string, win: boolean): RegExp {
  let re = ''
  for (const c of name) re += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : esc(c)
  return new RegExp(`^${re}$`, win ? 'i' : '')
}

/** Liegt der Pfad in einem freien Ordner? */
export function isFree(path: string, rules: Rules, ctx: Ctx): boolean {
  if (rules.freeRoots.some(r => within(path, r, ctx.win))) return true
  const folders = path.split('/').slice(0, -1).map(s => (ctx.win ? s.toLowerCase() : s))
  return folders.some(s => rules.freeNames.includes(s))
}

export const isAllowedFile = (path: string, rules: Rules): boolean => rules.allowed.some(re => re.test(path))

/** Zählt die Endung zu den geschützten? `.log` nie. */
export function hasProtectedExtension(path: string, rules: Rules): boolean {
  const name = baseName(path).toLowerCase()
  if (name.endsWith('.log')) return false
  return rules.extensions.some(x => x === '*' || name.endsWith(`.${x}`))
}

/**
 * Ein berechneter Pfad zählt nur, wenn der Text eine geschützte Endung nennt
 * und keinen freien Ordner: sonst gäbe es zu viele Fehlalarme (so hält es
 * auch der Projekt-Hook protect-full-overwrite.sh).
 */
export function computedCounts(hint: string, rules: Rules, ctx: Ctx): boolean {
  const text = ctx.win ? hint.toLowerCase().replace(/\\/g, '/') : hint
  const exts = rules.extensions.filter(x => x !== 'log')
  const namesExt = exts.includes('*') || exts.some(x => new RegExp(`\\.${esc(x)}\\b`, 'i').test(text))
  if (!namesExt) return false
  const mentionsFree = rules.freeRoots.some(r => r !== '/' && text.includes(`${key(r, ctx.win)}/`)) ||
    rules.freeNames.some(n => text.includes(`/${n}/`)) ||
    (ctx.home !== null && rules.freeRoots.some(r => within(r, ctx.home ?? '', ctx.win) && text.includes(`~${r.slice((ctx.home ?? '').length)}/`)))
  return !mentionsFree
}
