// Gemeinsame Typen und Pfadlogik der Analyse. Alles hier ist rein (kein `$`):
// register.ts holt Projektordner, Arbeitsordner und Umgebung und reicht sie
// als Ctx herein; was echte Dateisystemauskunft braucht (Symlinks, Skripte),
// erledigt register.ts danach.

/** Was über die Umgebung der Sitzung bekannt ist. */
export type Ctx = {
  /** Projektordner, absolut und gefaltet: die Grenze. */
  root: string
  /** Läuft die Sitzung unter Windows (Projektordner `C:/…` oder `//server/…`)? */
  win: boolean
  /** Heimatordner, gefaltet, oder null. */
  home: string | null
  /** Umgebungsvariable lesen (unter Windows ohne Groß/Klein-Unterschied). */
  env: (name: string) => string | undefined
}

/**
 * Wie ein Ziel gelöscht wird:
 * - `exact`: der Pfad selbst; ein Symlink am Ende wird nicht verfolgt (rm link).
 * - `deep`: der Pfad selbst, voll aufgelöst (rm -r link/, rd, rmtree).
 * - `children`: der Inhalt des Ordners, nicht er selbst (rm *, find ., rsync --delete).
 */
export type Mode = 'exact' | 'deep' | 'children'

export type Target = { path: string; mode: Mode; via: string }

/** Ein Skript, das der Befehl ausführt und das register.ts nachliest. */
export type ScriptRef = { path: string; lang: Lang }

export type Lang = 'bash' | 'ps' | 'cmd'

export type Out = {
  targets: Target[]
  /** Löschungen, deren Ziel sich nicht bestimmen lässt. */
  unknowns: string[]
  scripts: ScriptRef[]
}

/** Laufzeitzustand eines Befehlsstrangs: Ordner, Variablen. */
export type State = {
  /** Aktueller Ordner, gefaltet; null, wenn er sich nicht bestimmen lässt (cd -, cd $X). */
  cwd: string | null
  /** Variablen des Befehls; null = Wert unbekannt. Mehrere Werte aus for-Schleifen. */
  vars: Map<string, Val[] | null>
  stack: (string | null)[]
  /** Was `$_` / Pipeline-Eingabe gerade bedeutet (PowerShell, xargs). undefined = nichts. */
  pipe?: Target[] | null
  /**
   * Weitere Ordner, in denen der Befehl gerade stehen könnte: nach einem `cd`,
   * auf das kein `&&` folgt, läuft der Rest auch dann, wenn der `cd` scheiterte.
   */
  alts?: string[]
}

/** Ein ausgewerteter Wortwert. `glob`: enthält unquotierte Platzhalter. */
export type Val = { s: string; glob: boolean }

export const newOut = (): Out => ({ targets: [], unknowns: [], scripts: [] })

export const fork = (st: State): State => ({
  cwd: st.cwd,
  vars: new Map(st.vars),
  stack: [...st.stack],
  pipe: st.pipe,
  alts: st.alts ? [...st.alts] : undefined,
})

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
 * Absolute, gefaltete Form von `p` relativ zu `base`.
 *
 * `winSyntax`: der Pfad stammt aus PowerShell/cmd (Rückstriche sind Trenner).
 * Windows-Schreibweisen werden auf die Plattform des Projektordners gebracht:
 * unter Windows `/c/x` (Git Bash) und `/mnt/c/x` (WSL) zu `C:/x`, unter
 * Linux/WSL `C:\x` zu `/mnt/c/x`. Andere Provider (HKLM:, Env:, Cert:) bleiben,
 * wie sie sind, und liegen damit immer außerhalb.
 */
export function absolute(p: string, base: string | null, ctx: Ctx, winSyntax: boolean): string | null {
  let s = winSyntax || ctx.win ? p.replace(/\\/g, '/') : p
  s = s.replace(/^(Microsoft\.PowerShell\.Core\/)?FileSystem::/i, '')

  const prov = PROVIDER.exec(s)
  if (prov && !DRIVE.test(s) && !/^[A-Za-z]:[^/]/.test(s)) return s // HKLM:/…, Env:/…

  // Laufwerksrelativ (`C:foo`) wie `C:/foo` behandeln: lieber zu streng.
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

export const normalizeRoot = (p: string, ctx: Pick<Ctx, 'win'>): string =>
  absolute(p, null, { root: '', home: null, env: () => undefined, ...ctx }, ctx.win) ?? p

const key = (p: string, win: boolean) => (win ? p.toLowerCase() : p)

/** Liegt `p` echt unterhalb von `root` (bzw. ist `root` selbst, wenn `orEqual`)? */
export function within(p: string, root: string, win: boolean, orEqual: boolean): boolean {
  const a = key(p, win)
  const r = key(root, win)
  if (a === r) return orEqual
  return a.startsWith(r.endsWith('/') ? r : `${r}/`)
}

export const parentOf = (p: string): string => {
  const i = p.lastIndexOf('/')
  if (i <= 0) return '/'
  const head = p.slice(0, i)
  return /^[A-Za-z]:$/.test(head) ? `${head}/` : head
}

export const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

const GLOB = /[*?[]/

/**
 * Einen Wortwert als Löschziel festhalten. Platzhalter: gelöscht wird, was im
 * Ordner vor dem ersten Platzhalter liegt (`../*.txt` → Inhalt von `..`).
 * `.*` kann bei manchen Shells `..` treffen; außer bei rm/rmdir, die `..`
 * verweigern, zählt dann auch der Elternordner.
 */
export function addTarget(
  out: Out,
  v: Val,
  st: State,
  ctx: Ctx,
  via: string,
  mode: Mode,
  winSyntax: boolean,
  dotdotSafe = false,
): void {
  if (v.s === '') return
  if (v.glob && GLOB.test(v.s)) {
    const s = winSyntax || ctx.win ? v.s.replace(/\\/g, '/') : v.s
    const g = s.search(/[*?[{]/)
    const cut = s.lastIndexOf('/', g)
    const drive = /^[A-Za-z]:/.exec(s)?.[0]
    const dir = cut < 0 ? (drive ? `${drive}/` : '.') : cut === 0 ? '/' : s.slice(0, cut)
    const seg = s.slice(cut + 1).split('/')[0] ?? ''
    for (const base of [st.cwd, ...(st.alts ?? [])]) {
      const abs = absolute(dir, base, ctx, winSyntax)
      if (abs === null) { out.unknowns.push(`${via}: ${v.s} (Ordner unbekannt)`); continue }
      out.targets.push({ path: abs, mode: 'children', via })
      if (!dotdotSafe && /^\.[*?[]/.test(seg)) out.targets.push({ path: parentOf(abs), mode: 'children', via })
    }
    return
  }
  const trailing = /[\\/]\.?$/.test(v.s)
  for (const base of [st.cwd, ...(st.alts ?? [])]) {
    const abs = absolute(v.s, base, ctx, winSyntax)
    if (abs === null) { out.unknowns.push(`${via}: ${v.s} (aktueller Ordner unbekannt)`); continue }
    out.targets.push({ path: abs, mode: trailing && mode === 'exact' ? 'deep' : mode, via })
  }
}

/** Bekannte Namen von Befehlen, die Dateien löschen (Unix-Seite). */
export const DELETE_CMDS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'srm', 'wipe', 'trash', 'trash-put', 'gtrash', 'rimraf', 'del-cli', 'trash-cli',
])

/**
 * Code, der einem Interpreter direkt übergeben wird (python -c, node -e, …):
 * enthält er Lösch-Aufrufe, zählen alle Zeichenketten darin und die übrigen
 * Argumente als mögliche Ziele. Ohne erkennbare Ziele: unbekannt.
 */
const DELETE_API =
  /rmtree|remove_tree|removedirs|\bos\.(remove|unlink|rmdir)\b|\.unlink\s*\(|\.rmdir\s*\(|\bunlink(Sync)?\b|\brmdir(Sync)?\b|\brmSync\b|\bfs(\.promises)?\.rm\b|\bpromises\.rm\b|\brm_r|FileUtils\.(rm|remove)|File\.delete|Dir\.delete|send2trash|Deno\.remove|::Delete\s*\(|\.Delete\s*\(/
const DYNAMIC_LOC =
  /expanduser|Path\.home|os\.environ|getenv|homedir|process\.env|\bENV\[|\$HOME|gettempdir|tmpdir|tempfile|os\.walk\(\s*['"]\//

export function inlineCode(code: string, args: Val[], st: State, ctx: Ctx, out: Out, via: string): void {
  if (!DELETE_API.test(code)) return
  if (DYNAMIC_LOC.test(code)) out.unknowns.push(`${via}: Löschcode mit berechneten Pfaden`)
  const lits: string[] = []
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
    const s = (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1')
    if (s && s.length < 400 && !/[\n{}%]/.test(s)) lits.push(s)
  }
  const cands = [...lits.map(s => ({ s, glob: GLOB.test(s) })), ...args]
  if (cands.length === 0) return void out.unknowns.push(`${via}: Löschcode ohne erkennbare Pfade`)
  for (const c of cands) {
    const s = c.s.startsWith('~') && ctx.home ? ctx.home + c.s.slice(1) : c.s
    addTarget(out, { s, glob: c.glob }, st, ctx, via, 'children', false)
  }
}

export type Run = { ctx: Ctx; out: Out; depth: number }

/** Einen `cd` vermerken: der alte Ordner bleibt möglich, wenn der `cd` scheitern kann. */
export function moveTo(st: State, to: string | null, mayFail: boolean): void {
  if (mayFail && st.cwd !== null && st.cwd !== to) st.alts = [...(st.alts ?? []), st.cwd]
  st.cwd = to
}
type Analyzer = (src: string, st: State, run: Run) => void

/**
 * Die Sprachen rufen einander auf (bash -c → pwsh -Command → cmd /c …); jede
 * trägt sich hier ein, damit die Module einander nicht importieren müssen.
 */
export const lang: {
  bash: Analyzer
  ps: Analyzer
  cmd: Analyzer
  nested: (name: string, vals: (string | null)[], st: State, run: Run) => void
} = { bash: () => {}, ps: () => {}, cmd: () => {}, nested: () => {} }

/** -EncodedCommand: Base64 über UTF-16LE. */
export function decodeEncoded(b64: string): string | null {
  try {
    const bin = atob(b64.trim())
    let s = ''
    for (let i = 0; i + 1 < bin.length; i += 2) s += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8))
    return s
  } catch {
    return null
  }
}

/** Ist Version `a` neuer als `b`? (`1.10.0` > `1.9.3`; Vorabversionen zählen als älter) */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre] = v.trim().replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre: pre !== undefined }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return !x.pre && y.pre
}

/**
 * Die Grenze aus der Option `boundary`: ein absoluter Pfad oder `~`, `~/…`.
 * Leer, relativ oder nicht auflösbar: der Startordner der Session.
 */
export function resolveBoundary(option: string, sessionRoot: string, ctx: Ctx): string {
  const o = option.trim().replace(/^["']|["']$/g, '')
  if (o === '') return sessionRoot
  const tilde = o === '~' || /^~[\\/]/.test(o)
  if (tilde && !ctx.home) return sessionRoot
  const expanded = tilde ? `${ctx.home}${o.slice(1)}` : o
  return absolute(expanded, null, ctx, ctx.win) ?? sessionRoot
}
