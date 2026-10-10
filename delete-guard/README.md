# delete-guard

A Claude Code mod: **deleting anything outside the project folder requires your approval.**

- Inside the folder the session was started in, Claude decides as usual (rules
  and permission modes are unchanged; the guard stays out of the way).
- Outside of it, or wherever the target cannot be determined reliably, the
  guard opens its own *Allow / Deny* dialog, **in every permission mode**
  (including `auto`, `acceptEdits` and `bypassPermissions`), even when an allow
  rule such as `Bash(rm:*)` matches, and for subagents too.
- Where nobody can be asked (`claude -p`, the SDK), the call is denied.
- Free text typed into the dialog ("Other") counts as a denial and is passed on
  to Claude as the reason.

The dialog text is currently in German ("Erlauben" = allow, "Ablehnen" = deny).

## What is detected

| Environment | Commands |
| --- | --- |
| Bash (Linux, WSL, Git Bash) | `rm`, `rmdir`, `unlink`, `shred`, `trash`/`trash-put`, `gio trash`, `rimraf`, `find -delete` / `-exec rm`, `fd -x rm`, `xargs rm` (including the pipeline's source), `rsync --delete` / `--remove-source-files`, `git clean`, `git rm`, `git worktree remove`, `dd of=`, `mkfs`, `wipefs` |
| PowerShell | `Remove-Item` and its aliases (`rm`, `ri`, `del`, `erase`, `rd`, `rmdir`), `-Path`/`-LiteralPath`/arrays, pipelines (`gci … \| Remove-Item`, `% { Remove-Item $_ }`), `.Delete()`, `[IO.File]::Delete`, `Remove-ItemProperty` (registry), `Clear-RecycleBin`, `Invoke-Expression` |
| cmd.exe | `del`, `erase`, `rd`, `rmdir`, also behind `if exist …` / `for … do` |
| Nested | `sudo`, `env`, `timeout`, `nice`, `npx` …, `bash -c`, `sh -c '…' _ arg`, `eval`, heredocs, `echo … \| bash`, `$(…)`, `powershell -Command` / `-EncodedCommand`, `cmd /c`, `wsl …` |
| Inline code | `python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `deno eval` containing delete calls |
| Scripts | `bash x.sh`, `./x.sh`, `source x.sh`, `.\x.ps1`, `x.cmd`: one level deep, if they live in the project or in a temp folder |
| MCP | tools with `delete`/`remove`/`unlink`/`rmdir`/`trash` in their name and path arguments |

Paths are resolved: `~`, `$HOME`, `$env:TEMP`, `%APPDATA%`, `cd` within the
command, variable assignments, `for` loops, wildcards (`../*` = the contents of
`..`), `{a,b}`, `$(pwd)`, `$(dirname "$0")`, `Join-Path`. Symlinks are resolved
where the deletion follows them (`rm -rf link/` yes, `rm link` no). Windows
paths are compared case-insensitively; `C:\x`, `/c/x` (Git Bash) and
`/mnt/c/x` (WSL) count as the same location. Deleting the project folder
itself counts as "outside".

On Windows, a leading `\` or `\*` points to the root of the current drive
(`Remove-Item \* -Recurse`, `rd /s /q \`, or by accident as
`Remove-Item build \*` or `del /q build \*`). This is recognized as `C:\`, as
are `C:`, `C:*`, `$env:SystemDrive\*`, `%SystemDrive%\*`, `\\?\C:\`,
`..\..\..\*` past the root, and `rm -rf /*` in Git Bash. A path counts as
outside as soon as it lies outside either literally *or* after resolving
symlinks; resolution never turns anything into "inside".

Anything unknown (a variable without a value, `$(cat list)`,
`cat list | xargs rm`, `Invoke-Expression $x`) counts as outside: better to ask
once too often.

## Limitations

This is static analysis: programs that delete on their own (a Python script
file, `make clean`, `npm run clean`) are not seen, nor are scripts outside the
project and temp folders. Moving (`mv`) does not count as deleting.

## Installation

On any machine (Linux, macOS, Windows), in a terminal:

```bash
claude plugin marketplace add systemNEO/claude-code-mods
claude plugin install delete-guard@claude-code-mods
```

The first line adds this repository as a marketplace, the second installs the
mod for your user, i.e. for all projects and sessions on that machine. On
Windows this works the same in PowerShell, cmd or Git Bash; the mod runs inside
Claude Code itself and needs neither Node nor Python.

Alternatively, inside a running Claude Code session:

```
/plugin install delete-guard --marketplace systemNEO/claude-code-mods
```

Sessions that are already running pick up the mod with `/reload-plugins`.

Update, disable, remove:

```bash
claude plugin marketplace update claude-code-mods
claude plugin update delete-guard@claude-code-mods
claude plugin disable delete-guard@claude-code-mods
claude plugin uninstall delete-guard@claude-code-mods
```

## Where it applies

Once installed, the mod applies to every Claude Code session on that machine,
in every project and folder (it is installed with the `user` scope).

- **New sessions** load it automatically.
- **Sessions that are already running** need `/reload-plugins` once.
- **Subagents** are covered within every session.
- **`claude -p` (scripts, automation):** the mod is active, but nobody can be
  asked there, so deleting outside the start folder is denied.
- **Desktop app:** local Code sessions of the desktop app load plugins
  installed for the user as well.

One exception: each environment with its own Claude Code configuration
(`~/.claude`) needs its own installation. On a Windows PC that runs Claude Code
both inside WSL and natively on Windows (PowerShell or cmd), these are two
separate installations; run the two install commands once in each of them.
Cloud sessions on claude.ai do not run on your machine and are not covered.

## Development

```bash
claude plugin validate .
claude plugin test .
```
