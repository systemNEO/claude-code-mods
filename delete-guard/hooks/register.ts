import type { EngineInterface, Register } from 'claude-code'
import {
  type Ctx, type Lang, type Out, type State, type Target,
  absolute, asSetting, baseName, canRemember, collapse, folderFor, isFree, isNewer, isWinPath, lang, newOut,
  ancestors, normalizeRoot, parentOf, resolveBoundary, resolveFolder, resolveFolders, splitFolders, within,
} from './common'
import './bash'
import './ps'

// Löschen innerhalb des Projektordners entscheidet Claude selbst (die üblichen
// Regeln und Modi gelten weiter). Löschen außerhalb, oder wo sich das Ziel nicht
// bestimmen lässt, geht nur mit der Zustimmung des Nutzers: im eigenen Dialog,
// unabhängig vom Modus (auch auto, acceptEdits, bypassPermissions) und auch für
// Subagenten. Wo niemand gefragt werden kann (claude -p), wird abgelehnt.

const SHELL_TOOLS = /^(Bash|PowerShell|Monitor)$/
const MCP_DELETE = /^mcp__.*(delete|remove|unlink|rmdir|trash|erase)/i
const MAX_SCRIPT = 256 * 1024

/** Die Option `boundary` (leer: Startordner der Session); gesetzt bei jedem Laden. */
let boundaryOption = ''
/** Die Option `allowedFolders`: weitere freie Ordner, wie in den Einstellungen geschrieben. */
let allowedOption: readonly string[] = []

async function context($: EngineInterface): Promise<{ ctx: Ctx; cwd: string }> {
  const [rootRaw, cwdRaw] = await Promise.all([$.session.root(), $.session.cwd()])
  const win = isWinPath(rootRaw)
  // Jeder Name ein Literal: so verlangt es $.env.get.
  const [HOME, USERPROFILE, TMPDIR, TEMP, TMP, APPDATA, LOCALAPPDATA, PROGRAMDATA, PROGRAMFILES, PROGRAMFILES86,
    SYSTEMROOT, WINDIR, SYSTEMDRIVE, PUBLIC, ALLUSERSPROFILE, ONEDRIVE, HOMEDRIVE, HOMEPATH, USER, USERNAME,
    XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME, XDG_RUNTIME_DIR] = await Promise.all([
    $.env.get('HOME'), $.env.get('USERPROFILE'), $.env.get('TMPDIR'), $.env.get('TEMP'), $.env.get('TMP'),
    $.env.get('APPDATA'), $.env.get('LOCALAPPDATA'), $.env.get('PROGRAMDATA'), $.env.get('ProgramFiles'),
    $.env.get('ProgramFiles(x86)'), $.env.get('SystemRoot'), $.env.get('windir'), $.env.get('SystemDrive'),
    $.env.get('PUBLIC'), $.env.get('ALLUSERSPROFILE'), $.env.get('OneDrive'), $.env.get('HOMEDRIVE'),
    $.env.get('HOMEPATH'), $.env.get('USER'), $.env.get('USERNAME'), $.env.get('XDG_CONFIG_HOME'),
    $.env.get('XDG_DATA_HOME'), $.env.get('XDG_CACHE_HOME'), $.env.get('XDG_STATE_HOME'), $.env.get('XDG_RUNTIME_DIR'),
  ])
  const table: Record<string, string | undefined> = {
    HOME: HOME ?? (win ? USERPROFILE : undefined), USERPROFILE, TMPDIR, TEMP, TMP, APPDATA, LOCALAPPDATA,
    PROGRAMDATA, PROGRAMFILES, 'PROGRAMFILES(X86)': PROGRAMFILES86, SYSTEMROOT, WINDIR, SYSTEMDRIVE, PUBLIC,
    ALLUSERSPROFILE, ONEDRIVE, HOMEDRIVE, HOMEPATH, USER, USERNAME, XDG_CONFIG_HOME, XDG_DATA_HOME,
    XDG_CACHE_HOME, XDG_STATE_HOME, XDG_RUNTIME_DIR,
  }
  const root = normalizeRoot(rootRaw, { win })
  const base: Ctx = { root, win, home: null, env: n => table[win ? n.toUpperCase() : n] }
  const homeRaw = HOME ?? USERPROFILE
  const withHome: Ctx = { ...base, home: homeRaw ? absolute(homeRaw, null, base, win) : null }
  const ctx: Ctx = {
    ...withHome,
    root: resolveBoundary(boundaryOption, root, withHome),
    allowed: resolveFolders(allowedOption, withHome),
  }
  return { ctx, cwd: absolute(cwdRaw, null, ctx, win) ?? root }
}

function analyze(src: string, which: Lang, cwd: string, ctx: Ctx, script?: string): Out {
  const out = newOut()
  const st: State = { cwd, vars: new Map(), stack: [] }
  if (script) for (const n of ['0', 'BASH_SOURCE', 'ps:pscommandpath']) st.vars.set(n, [{ s: script, glob: false }])
  if (script) st.vars.set('ps:psscriptroot', [{ s: parentOf(script), glob: false }])
  lang[which](src, st, { ctx, out, depth: 0 })
  return out
}

/**
 * Skripte, die der Befehl startet, eine Ebene tief mitlesen: solche im
 * Projekt und in Temp-Ordnern (wo ein Agent sich eins ablegen würde), nicht
 * aber installierte Werkzeuge wie ~/.nvm/nvm.sh, deren Funktionen voller
 * `rm "$var"` stecken, ohne dass ein `source` sie ausführt.
 */
async function followScripts($: EngineInterface, out: Out, cwd: string, ctx: Ctx): Promise<void> {
  const seen = new Set<string>()
  const temp = ['/tmp', '/var/tmp', ctx.env('TMPDIR'), ctx.env('TEMP'), ctx.env('TMP')]
    .flatMap(t => (t ? [absolute(t, null, ctx, ctx.win)] : []))
    .filter((t): t is string => t !== null)
  for (const s of out.scripts.splice(0)) {
    if (seen.has(s.path)) continue
    seen.add(s.path)
    if (!within(s.path, ctx.root, ctx.win, false) && !temp.some(t => within(s.path, t, ctx.win, false))) continue
    try {
      const stat = await $.fs.stat(s.path)
      if (stat.kind !== 'file' || stat.size > MAX_SCRIPT) {
        if (stat.kind === 'file') out.unknowns.push(`Skript zu groß zum Prüfen: ${s.path}`)
        continue
      }
      const text = await $.fs.read(s.path)
      const sub = analyze(typeof text === 'string' ? text : '', s.lang, cwd, ctx, s.path)
      out.targets.push(...sub.targets.map(t => ({ ...t, via: `${baseName(s.path)}: ${t.via}` })))
      out.unknowns.push(...sub.unknowns.map(u => `${baseName(s.path)}: ${u}`))
    } catch {
      // Gibt es nicht oder ist nicht lesbar: dann führt der Befehl es auch nicht aus.
    }
  }
}

async function realPath($: EngineInterface, p: string, win: boolean): Promise<string | undefined> {
  try {
    const r = (await $.fs.stat(p, { resolve: true })).realPath
    return r ? normalizeRoot(r, { win }) : undefined
  } catch {
    return undefined
  }
}

/** Liegt das Ziel außerhalb? Symlinks werden aufgelöst, wo das Löschen ihnen folgt. */
/** Grenze und freigegebene Ordner, nach Auflösung der Symlinks. */
async function realFree($: EngineInterface, ctx: Ctx): Promise<string[]> {
  const all = [ctx.root, ...(ctx.allowed ?? [])]
  return (await Promise.all(all.map(f => realPath($, f, ctx.win)))).map((r, i) => r ?? all[i] ?? '')
}

async function outside($: EngineInterface, t: Target, ctx: Ctx, realRoots: readonly string[]): Promise<boolean> {
  const orEqual = t.mode === 'children'
  let real: string | undefined
  if (t.mode === 'exact' && !ctx.win) {
    const dir = await realPath($, parentOf(t.path), ctx.win)
    real = dir ? `${dir.replace(/\/$/, '')}/${baseName(t.path)}` : undefined
  } else {
    real = await realPath($, t.path, ctx.win)
  }
  // Außerhalb, sobald eine Sicht außerhalb liegt: der Pfad, wie er geschrieben
  // steht, oder wohin er aufgelöst führt. Die Auflösung macht nie etwas zu
  // „innerhalb“, was wörtlich außerhalb liegt.
  if (!isFree(t.path, orEqual, ctx)) return true
  return real !== undefined && !isFree(real, orEqual, ctx, realRoots)
}

/** Alle Befunde zu einem Befehl: Ziele außerhalb und nicht bestimmbare. */
type Findings = {
  problems: string[]
  ctx: Ctx
  /** Ordner, die „Immer erlauben“ freigäbe; null, wo das nicht geht (Unbekanntes, Wurzeln). */
  remember: string[] | null
}

/** Ordner für „Immer erlauben“ aus den Zielen außerhalb. */
function rememberFor(outsideTargets: readonly Target[], unknowns: number, ctx: Ctx): string[] | null {
  if (unknowns > 0 || outsideTargets.length === 0) return null
  const folders = collapse(outsideTargets.map(folderFor), ctx.win)
  return folders.every(canRemember) ? folders : null
}

async function findings($: EngineInterface, src: string, which: Lang): Promise<Findings> {
  const { ctx, cwd } = await context($)
  const out = analyze(src, which, cwd, ctx)
  await followScripts($, out, cwd, ctx)
  const realRoots = await realFree($, ctx)
  const problems: string[] = []
  const outsideTargets: Target[] = []
  const seen = new Set<string>()
  for (const t of out.targets) {
    const k = `${t.mode} ${t.path}`
    if (seen.has(k)) continue
    seen.add(k)
    if (await outside($, t, ctx, realRoots)) {
      outsideTargets.push(t)
      problems.push(`${t.via}: ${t.path}${t.mode === 'children' ? ' (Inhalt)' : ''}${t.path === ctx.root ? ' — der Projektordner selbst' : ''}`)
    }
  }
  const unknowns = [...new Set(out.unknowns)]
  problems.push(...unknowns)
  return { problems, ctx, remember: rememberFor(outsideTargets, unknowns.length, ctx) }
}

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Den Nutzer fragen; true nur bei ausdrücklicher Zustimmung. */
const ALLOW = 'Erlauben'
const ALWAYS = 'Immer erlauben'
const DENY = 'Ablehnen'

async function consent($: EngineInterface, what: string, f: Findings, agentId?: string): Promise<true | 'always' | string> {
  const { problems, ctx, remember } = f
  const list = problems.slice(0, 8).map(p => `• ${shorten(p, 160)}`).join('\n')
  const more = problems.length > 8 ? `\n• … und ${problems.length - 8} weitere` : ''
  const who = agentId ? 'Ein Subagent will' : 'Claude will'
  const always = remember
    ? `\n\n„${ALWAYS}“ erlaubt es jetzt und lässt dich danach wählen, welcher Ordner dauerhaft frei wird (ab ${remember.map(r => asSetting(r, ctx)).join(', ')} aufwärts).`
    : ''
  const question = `${who} außerhalb von ${ctx.root} löschen (oder das Ziel ist nicht eindeutig):\n${list}${more}\n\n${shorten(what, 400)}${always}\n\nErlauben?`
  try {
    const answer = await $.ui.ask(question, { options: remember ? [ALLOW, ALWAYS, DENY] : [ALLOW, DENY], header: 'Löschen' })
    if (answer === ALLOW) return true
    if (answer === ALWAYS && remember) return 'always'
    return answer === DENY ? 'Der Nutzer hat das Löschen außerhalb des Projektordners abgelehnt.' : `Der Nutzer hat nicht zugestimmt und schreibt: ${answer}`
  } catch {
    return 'Löschen außerhalb des Projektordners braucht die Zustimmung des Nutzers, und es konnte niemand gefragt werden.'
  }
}

type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string }
type Call = { tool: string; input: unknown; tool_use_id?: string; agentId?: string }

const HIGHER = 'Höher …'
const ONCE = 'Nur dieses Mal'

/**
 * „Immer erlauben“, zweiter Schritt: welcher Ordner frei werden soll. Zur Wahl
 * stehen je zwei Stufen (der Ordner, sein Elternordner), „Höher …“ wandert
 * weiter hinauf, „Nur dieses Mal“ merkt nichts. Unter „Other“ lässt sich ein
 * eigener Pfad eintippen. Wurzeln werden nie angeboten.
 */
async function chooseFolder($: EngineInterface, start: string, ctx: Ctx): Promise<string | null> {
  const chain = ancestors(start)
  for (let i = 0; i < chain.length; i += 2) {
    const page = chain.slice(i, i + 2)
    const labels = page.map(f => asSetting(f, ctx))
    const more = i + 2 < chain.length
    const question = `Welchen Ordner dauerhaft freigeben? Gelöscht wird in ${asSetting(start, ctx)}.\n` +
      'Je weiter oben, desto mehr ist künftig ohne Rückfrage löschbar. Unter „Other“ geht auch ein eigener Pfad.'
    let answer: string
    try {
      answer = await $.ui.ask(question, { options: [...labels, ...(more ? [HIGHER] : []), ONCE], header: 'Freigeben' })
    } catch {
      return null
    }
    if (answer === HIGHER) continue
    if (answer === ONCE) return null
    const picked = page[labels.indexOf(answer)]
    if (picked !== undefined) return picked
    const typed = resolveFolder(answer, ctx)
    if (typed !== null && canRemember(typed)) return typed
    $.ui.log(`${$.plugin.name}: „${answer}“ ist kein freigebbarer Ordner (absolut oder ~/…, keine Wurzel); nichts gespeichert.`)
    return null
  }
  return null
}

/** „Immer erlauben“: die Ordner an die Option `allowedFolders` anhängen. */
async function remember($: EngineInterface, folders: readonly string[], ctx: Ctx): Promise<void> {
  const value = [...new Set([...allowedOption, ...folders.map(f => asSetting(f, ctx))])]
  try {
    // Den Schlüssel nicht raten: die /config-Zeile dieser Mod für allowedFolders suchen.
    const mine = (await $.config.list()).filter(r => r.provider.plugin === $.plugin.name)
    const row = mine.find(r => /(^|[.:])allowedFolders$/.test(r.key))
    if (!row) throw new Error(`keine /config-Zeile für allowedFolders (vorhanden: ${mine.map(r => r.key).join(', ') || 'keine'})`)
    const r = await $.config.set({ key: row.key, value: value.join(', ') })
    if (r.deny !== undefined) throw new Error(r.deny)
    allowedOption = value
    $.ui.toast(`${$.plugin.name}: dauerhaft frei: ${folders.map(f => asSetting(f, ctx)).join(', ')}`)
  } catch (err) {
    $.ui.log(`${$.plugin.name}: Ordner konnte nicht gespeichert werden (${String(err)}); dieses Mal erlaubt.`)
  }
}

const verdictOf = async ($: EngineInterface, e: Call, f: Findings, what: string): Promise<Verdict> => {
  if (e.tool_use_id === undefined) return { decision: 'ask', reason: `${$.plugin.name}: Löschen außerhalb von ${f.ctx.root}: ${f.problems.join('; ')}` }
  const ok = await consent($, what, f, e.agentId)
  if (ok === 'always' && f.remember) {
    const chosen: string[] = []
    for (const start of f.remember) {
      const c = await chooseFolder($, start, f.ctx)
      if (c !== null) chosen.push(c)
    }
    if (chosen.length) await remember($, collapse(chosen, f.ctx.win), f.ctx)
  }
  return ok === true || ok === 'always'
    ? { decision: 'allow', reason: `${$.plugin.name}: vom Nutzer genehmigt` }
    : { decision: 'deny', reason: `${$.plugin.name}: ${ok}` }
}

/** Shell-Werkzeuge (Bash, PowerShell, Monitor): den Befehl analysieren. */
async function judgeShell($: EngineInterface, e: Call, verdict: Verdict): Promise<Verdict> {
  const command = (e.input as { command?: unknown } | null)?.command
  if (typeof command !== 'string' || verdict.decision === 'deny') return verdict
  const f = await findings($, command, e.tool === 'PowerShell' ? 'ps' : 'bash')
  return f.problems.length ? verdictOf($, e, f, `Befehl: ${command}`) : verdict
}

/**
 * MCP-Werkzeuge, die laut Namen löschen (z. B. ein Dateisystem-Server): ihre
 * Pfad-Argumente gelten wie bei `rm -r`.
 */
async function judgeMcp($: EngineInterface, e: Call, verdict: Verdict): Promise<Verdict> {
  if (verdict.decision === 'deny') return verdict
  const paths: string[] = []
  const collect = (v: unknown, k: string) => {
    if (typeof v === 'string' && /path|file|dir|target|source|src|dest/i.test(k) && /[\\/]|^[.~]/.test(v)) paths.push(v)
    else if (Array.isArray(v)) v.forEach(x => collect(x, k))
    else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) collect(vv, kk)
  }
  collect(e.input, '')
  if (!paths.length) return verdict
  const { ctx, cwd } = await context($)
  const realRoots = await realFree($, ctx)
  const problems: string[] = []
  const outsideTargets: Target[] = []
  let unknowns = 0
  for (const p of paths) {
    const abs = absolute(p.startsWith('~') && ctx.home ? ctx.home + p.slice(1) : p, cwd, ctx, ctx.win)
    const t: Target | null = abs === null ? null : { path: abs, mode: 'deep', via: e.tool }
    if (t === null) { unknowns++; problems.push(`${e.tool}: ${p}`) }
    else if (await outside($, t, ctx, realRoots)) { outsideTargets.push(t); problems.push(`${e.tool}: ${t.path}`) }
  }
  const f: Findings = { problems, ctx, remember: rememberFor(outsideTargets, unknowns, ctx) }
  return problems.length ? verdictOf($, e, f, `Werkzeug: ${e.tool}`) : verdict
}

// ---------------------------------------------------------------- Update-Hinweis

// Einmal am Tag beim Start einer Session die Version auf GitHub lesen und, wenn
// sie neuer ist, einen Hinweis mit den Update-Befehlen zeigen. Installiert wird
// nie von selbst: ein Löschschutz, der ungefragt Code nachlädt, wäre selbst ein
// Risiko. Abschalten: DELETE_GUARD_NO_UPDATE_CHECK=1 (oder
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1).

const REMOTE_MANIFEST = 'https://raw.githubusercontent.com/systemNEO/claude-code-mods/main/delete-guard/.claude-plugin/plugin.json'
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
const UPDATE_HINT = 'claude plugin marketplace update claude-code-mods && claude plugin update delete-guard@claude-code-mods'

const versionOf = (text: unknown): string | undefined => {
  try {
    const v = (JSON.parse(String(text)) as { version?: unknown }).version
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

async function checkForUpdate($: EngineInterface): Promise<void> {
  const [optOut, quiet] = await Promise.all([
    $.env.get('DELETE_GUARD_NO_UPDATE_CHECK'),
    $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
  ])
  if (optOut || quiet) return
  const installed = versionOf(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
  if (!installed) return

  const now = await $.clock.now()
  const seen = (await $.store.get('update')) as { checkedAt?: number; latest?: string } | undefined
  let latest = seen?.latest
  if (!seen?.checkedAt || now - seen.checkedAt > CHECK_EVERY_MS) {
    const res = await $.http.fetch(REMOTE_MANIFEST)
    if (res.ok) latest = versionOf(res.text) ?? latest
    await $.store.set('update', { checkedAt: now, latest })
  }
  if (latest && isNewer(latest, installed)) {
    const text = `delete-guard ${latest} ist verfügbar (installiert: ${installed}). Aktualisieren mit: ${UPDATE_HINT}`
    $.ui.toast(text, { timeoutMs: 15000 })
    $.ui.log(text)
  }
}

// tool.check ist die Rechteprüfung: sie läuft für jeden Aufruf, auch in
// Subagenten, und ihr Urteil gilt unabhängig vom Modus. Schlägt die Prüfung
// selbst fehl, wird abgelehnt statt durchgelassen.
export const register: Register = (on, options) => {
  boundaryOption = typeof options.boundary === 'string' ? options.boundary : ''
  allowedOption = splitFolders(options.allowedFolders)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Nicht den Start aufhalten: die Prüfung läuft kurz danach, Fehler bleiben still.
    if (e.isInteractive) $.clock.after(3000, () => { checkForUpdate($).catch(() => {}) })
    return started
  })

  on('tool.check', { tool: /^(Bash|PowerShell|Monitor)$/ }, async ($, e, next) => judgeShell($, e, await next(e)))
    .catch(() => ({ decision: 'deny', reason: 'delete-guard: Prüfung fehlgeschlagen, Befehl vorsichtshalber abgelehnt.' }))

  on('tool.check', { tool: /^mcp__.*(delete|remove|unlink|rmdir|trash|erase)/i }, async ($, e, next) => judgeMcp($, e, await next(e)))
    .catch(() => ({ decision: 'deny', reason: 'delete-guard: Prüfung fehlgeschlagen, Aufruf vorsichtshalber abgelehnt.' }))
}
