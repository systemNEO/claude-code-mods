import type { EngineInterface, HookFailure, Register } from 'claude-code'
import {
  type Ctx, type Finding, type Lang, type Rules,
  GLOB, absolute, baseName, computedCounts, globRe, parentOf, hasProtectedExtension, isAllowedFile, isFree, isWinPath, joinPath, lang, makeRules,
  normalizeRoot, splitList, untilde,
} from './common'
import './bash'
import './ps'

// Write auf eine bestehende Datei und Shell-Befehle, die eine bestehende
// Datei komplett ersetzen, werden abgelehnt: Wer eine ganze Datei neu
// schreibt, ändert nebenbei Logik, um die niemand gebeten hat. Edit zeigt den
// Diff und ändert nur die Stelle. Vorbild sind die Projekt-Hooks
// block-write-on-existing-file.sh und protect-full-overwrite.sh.
//
// Schlägt die Prüfung selbst fehl, wird durchgelassen und eine Zeile ins
// Protokoll geschrieben: Ein kaputter Schutz darf nie jeden Write und jeden
// Shell-Befehl sperren (siehe failOpen).

/** Fallback, falls die Engine die Vorgabe aus plugin.json nicht mitgibt. */
const DEFAULT_EXTENSIONS = 'md, ts, tsx, js, jsx, mjs, cjs, php, json, yaml, yml, sh, bash, html, css, scss, py, sql, env, conf, caddy, toml'
const DEFAULT_FREE_FOLDERS = '/tmp, ~/.claude/plans, scratchpad, node_modules, vendor'
const SHELL_TOOLS = /^(Bash|PowerShell|Monitor)$/
const HINT_LENGTH = 120

type Settings = { protectedExtensions: string[]; freeFolders: string[]; allowedFiles: string[] }

async function context($: EngineInterface): Promise<{ ctx: Ctx; cwd: string }> {
  const [rootRaw, cwdRaw, HOME, USERPROFILE, TMPDIR, TEMP, TMP] = await Promise.all([
    $.session.root(), $.session.cwd(),
    $.env.get('HOME'), $.env.get('USERPROFILE'), $.env.get('TMPDIR'), $.env.get('TEMP'), $.env.get('TMP'),
  ])
  const win = isWinPath(rootRaw)
  const table: Record<string, string | undefined> = { HOME: HOME ?? (win ? USERPROFILE : undefined), USERPROFILE, TMPDIR, TEMP, TMP }
  const homeRaw = HOME ?? USERPROFILE
  const root = normalizeRoot(rootRaw, win)
  const ctx: Ctx = { root, win, home: homeRaw ? normalizeRoot(homeRaw, win) : null, env: n => table[win ? n.toUpperCase() : n] }
  return { ctx, cwd: absolute(cwdRaw, null, ctx, win) ?? root }
}

async function isExistingFile($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.stat(path).then(s => s.kind === 'file', () => false)
}

/** Zählt eine Datei überhaupt (geschützte Endung, nicht frei, nicht erlaubt), und gibt es sie schon? */
async function guarded($: EngineInterface, path: string, rules: Rules, ctx: Ctx): Promise<boolean> {
  if (isFree(path, rules, ctx) || isAllowedFile(path, rules) || !hasProtectedExtension(path, rules)) return false
  return isExistingFile($, path)
}

const shorten = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/** Je Fund die Zeile für die Ablehnung, falls er eine bestehende Datei ersetzt. */
async function blockedBy($: EngineInterface, f: Finding, rules: Rules, ctx: Ctx): Promise<string[]> {
  if (f.kind === 'computed') return computedCounts(f.hint, rules, ctx) ? [`Pfad wird erst beim Ausführen bestimmt (${f.via}: ${shorten(f.hint, HINT_LENGTH)})`] : []
  if (f.kind === 'file') return (await guarded($, f.path, rules, ctx)) ? [`${f.path} (${f.via})`] : []
  const stat = await $.fs.stat(f.dest).catch(() => undefined)
  if (stat?.kind === 'file') return (await guarded($, f.dest, rules, ctx)) ? [`${f.dest} (${f.via})`] : []
  if (stat?.kind !== 'dir') return []
  const hits: string[] = []
  for (const source of f.sources) {
    for (const name of await sourceNames($, source, ctx)) {
      const path = joinPath(f.dest, name)
      if (await guarded($, path, rules, ctx)) hits.push(`${path} (${f.via})`)
    }
  }
  return hits
}

/** Die Dateinamen, die eine Quelle von cp/mv mitbringt; bei Platzhaltern aus ihrem Ordner gelesen. */
async function sourceNames($: EngineInterface, source: string, ctx: Ctx): Promise<string[]> {
  const name = baseName(source)
  if (!GLOB.test(name)) return [name]
  const folder = parentOf(source)
  if (GLOB.test(folder)) return []
  const pattern = globRe(name, ctx.win)
  return (await $.fs.list(folder).catch(() => [])).map(x => x.name).filter(n => pattern.test(n) && !n.startsWith('.'))
}

async function judgeShell($: EngineInterface, command: string, which: Lang, settings: Settings): Promise<string[]> {
  const { ctx, cwd } = await context($)
  const rules = makeRules(settings, ctx)
  const out: Finding[] = []
  lang[which](command, [cwd], { ctx, out, depth: 0 })
  const unique = [...new Map(out.map(f => [JSON.stringify(f), f])).values()]
  const lines = (await Promise.all(unique.map(f => blockedBy($, f, rules, ctx)))).flat()
  return [...new Set(lines)]
}

function writeRefusal(name: string, path: string): string {
  return [
    `${name}: BLOCKIERT: Write auf bestehende Datei ${path}!`,
    '   → Nutze Edit statt Write, um keine bestehende Logik zu verlieren.',
    '   → Write erstellt die Datei komplett neu – dabei ändern sich Flows und Abhängigkeiten subtil.',
    '   → Mehrere Stellen: mehrere Edits, NICHT ein Write.',
    '',
    'AUCH VERBOTEN: den Block durch Löschen und Neu-Erstellen umgehen (rm, dann Write).',
    '   → Muss wirklich die ganze Datei ersetzt werden: EIN großer Edit mit old_string = aktueller Inhalt.',
  ].join('\n')
}

function shellRefusal(name: string, lines: string[], settings: Settings): string {
  return [
    `${name}: BLOCKIERT: kompletter Inhaltstausch einer bestehenden Datei über die Shell!`,
    ...lines.map(l => `   • ${l}`),
    '',
    "   → Das ist dasselbe wie 'Write auf bestehende Datei' — nur am Schutz vorbei.",
    '   → Nutze Edit. Dann siehst DU den Diff und der Schutz greift.',
    '   → Muss wirklich die ganze Datei ersetzt werden: EIN großer Edit mit',
    '     old_string = aktueller Inhalt.',
    '',
    'AUCH VERBOTEN: den Block durch Löschen und Neu-Erstellen umgehen (rm, dann neu schreiben).',
    '',
    `   Erlaubt bleiben: Anhängen (>>), neue Dateien anlegen und die freien Ordner (${settings.freeFolders.join(', ')}).`,
  ].join('\n')
}

/**
 * Fehlerpolitik: durchlassen und protokollieren. Der Schutz ist ein Netz
 * gegen eine Angewohnheit, keine Sicherheitsgrenze; sperrte ein Fehler im
 * Parser jeden Write und jeden Shell-Befehl, wäre die Sitzung lahmgelegt.
 */
function logFailure($: EngineInterface, tool: string, next: { called: boolean; error: HookFailure }): void {
  if (!next.called) $.ui.log(`${$.plugin.name}: Prüfung fehlgeschlagen (${next.error.message ?? next.error.kind}); ${tool} durchgelassen.`)
}

export const register: Register = (on, options) => {
  const text = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback)
  const settings: Settings = {
    protectedExtensions: splitList(text(options.protectedExtensions, DEFAULT_EXTENSIONS)),
    freeFolders: splitList(text(options.freeFolders, DEFAULT_FREE_FOLDERS)),
    allowedFiles: splitList(text(options.allowedFiles, '')),
  }

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const { ctx, cwd } = await context($)
    const rules = makeRules(settings, ctx)
    const path = absolute(untilde(e.file_path, ctx), cwd, ctx, ctx.win)
    if (path === null || isFree(path, rules, ctx) || isAllowedFile(path, rules)) return next(e)
    return (await isExistingFile($, path)) ? { deny: writeRefusal($.plugin.name, path) } : next(e)
  }).catch(($, e, next) => { logFailure($, String(e.tool), next); return next(e) })

  on('tool.call', { tool: SHELL_TOOLS }, async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    if (typeof command !== 'string') return next(e)
    const lines = await judgeShell($, command, String(e.tool) === 'PowerShell' ? 'ps' : 'bash', settings)
    return lines.length ? { deny: shellRefusal($.plugin.name, lines, settings) } : next(e)
  }).catch(($, e, next) => { logFailure($, String(e.tool), next); return next(e) })
}
