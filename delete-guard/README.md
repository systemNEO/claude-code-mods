# delete-guard

Claude-Code-Mod: **Löschen außerhalb des Projektordners nur mit deiner Zustimmung.**

- Innerhalb des Ordners, in dem die Sitzung gestartet wurde, entscheidet Claude
  wie gewohnt (Regeln und Modi bleiben unverändert, der Wächter mischt sich nicht ein).
- Außerhalb, oder wo sich das Ziel nicht sicher bestimmen lässt, öffnet der
  Wächter einen eigenen Dialog *Erlauben / Ablehnen*, und zwar **in jedem Modus**
  (auch `auto`, `acceptEdits`, `bypassPermissions`), auch wenn eine Allow-Regel
  wie `Bash(rm:*)` greift, und auch für Subagenten.
- Wo niemand gefragt werden kann (`claude -p`, SDK), wird abgelehnt.
- Freitext im Dialog („Andere“) gilt als Ablehnung und wird Claude als Begründung weitergereicht.

## Was erkannt wird

| Umgebung | Befehle |
| --- | --- |
| Bash (Linux, WSL, Git Bash) | `rm`, `rmdir`, `unlink`, `shred`, `trash`/`trash-put`, `gio trash`, `rimraf`, `find -delete` / `-exec rm`, `fd -x rm`, `xargs rm` (samt Quelle der Pipeline), `rsync --delete` / `--remove-source-files`, `git clean`, `git rm`, `git worktree remove`, `dd of=`, `mkfs`, `wipefs` |
| PowerShell | `Remove-Item` und Aliase (`rm`, `ri`, `del`, `erase`, `rd`, `rmdir`), `-Path`/`-LiteralPath`/Arrays, Pipelines (`gci … \| Remove-Item`, `% { Remove-Item $_ }`), `.Delete()`, `[IO.File]::Delete`, `Remove-ItemProperty` (Registry), `Clear-RecycleBin`, `Invoke-Expression` |
| cmd.exe | `del`, `erase`, `rd`, `rmdir`, auch hinter `if exist …` / `for … do` |
| Verschachtelt | `sudo`, `env`, `timeout`, `nice`, `npx` …, `bash -c`, `sh -c '…' _ arg`, `eval`, Heredocs, `echo … \| bash`, `$(…)`, `powershell -Command` / `-EncodedCommand`, `cmd /c`, `wsl …` |
| Inline-Code | `python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `deno eval` mit Lösch-Aufrufen |
| Skripte | `bash x.sh`, `./x.sh`, `source x.sh`, `.\x.ps1`, `x.cmd`: eine Ebene tief, wenn sie im Projekt oder in einem Temp-Ordner liegen |
| MCP | Werkzeuge mit `delete`/`remove`/`unlink`/`rmdir`/`trash` im Namen und Pfad-Argumenten |

Pfade werden aufgelöst: `~`, `$HOME`, `$env:TEMP`, `%APPDATA%`, `cd` im Befehl,
Variablen-Zuweisungen, `for`-Schleifen, Platzhalter (`../*` = Inhalt von `..`),
`{a,b}`, `$(pwd)`, `$(dirname "$0")`, `Join-Path`. Symlinks werden dort aufgelöst,
wo das Löschen ihnen folgt (`rm -rf link/` ja, `rm link` nein). Windows-Pfade
werden ohne Groß/Klein-Unterschied verglichen; `C:\x`, `/c/x` (Git Bash) und
`/mnt/c/x` (WSL) gelten als derselbe Ort. Den Projektordner selbst zu löschen
gilt als „außerhalb“.

Unter Windows zeigt ein `\` oder `\*` am Pfadanfang auf die Wurzel des
aktuellen Laufwerks (`Remove-Item \* -Recurse`, `rd /s /q \`, auch versehentlich
als `Remove-Item build \*` oder `del /q build \*`). Das wird als `C:\` erkannt,
ebenso `C:`, `C:*`, `$env:SystemDrive\*`, `%SystemDrive%\*`, `\\?\C:\`,
`..\..\..\*` über die Wurzel hinaus und `rm -rf /*` in Git Bash. Ein Pfad gilt
als außerhalb, sobald er wörtlich *oder* nach Auflösung von Symlinks außerhalb
liegt; die Auflösung macht nie etwas zu „innerhalb“.

Unbekanntes (eine Variable ohne Wert, `$(cat liste)`, `cat liste | xargs rm`,
`Invoke-Expression $x`) zählt als „außerhalb“: lieber einmal zu viel gefragt.

## Grenzen

Statische Analyse: Programme, die selbst löschen (ein Python-Skript als Datei,
`make clean`, `npm run clean`), sieht der Wächter nicht; ebenso wenig Skripte
außerhalb von Projekt und Temp-Ordnern. Verschieben (`mv`) gilt nicht als Löschen.

## Installation

Auf jedem Rechner (Linux, macOS, Windows) im Terminal:

```bash
claude plugin marketplace add systemNEO/claude-code-mods
claude plugin install delete-guard@claude-code-mods
```

Die erste Zeile fügt dieses Repository als Marketplace hinzu, die zweite
installiert die Mod für deinen Benutzer, also für alle Projekte und Sessions
auf diesem Rechner. Unter Windows geht das genauso in PowerShell, cmd oder Git
Bash; die Mod läuft in Claude Code selbst und braucht weder Node noch Python.

Alternativ in einer laufenden Claude-Code-Session:

```
/plugin install delete-guard --marketplace systemNEO/claude-code-mods
```

Bereits laufende Sessions übernehmen die Mod mit `/reload-plugins`.

Aktualisieren, deaktivieren, entfernen:

```bash
claude plugin marketplace update claude-code-mods
claude plugin update delete-guard@claude-code-mods
claude plugin disable delete-guard@claude-code-mods
claude plugin uninstall delete-guard@claude-code-mods
```

## Entwickeln

```bash
claude plugin validate .
claude plugin test .
```
