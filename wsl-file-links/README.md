# wsl-file-links

A Claude Code mod for **Claude Code running in WSL**, shown in Windows Terminal:
**absolute paths in Claude's replies become clickable links** that Windows
opens, files and folders alike.

## What this does

Claude often names files it made: screenshots, logs, reports. Under WSL such a
path (`/tmp/…/screenshot.png`) is not clickable in Windows Terminal, so you
open Explorer and walk there by hand. wsl-file-links rewrites how each reply is
drawn: every absolute path becomes a markdown link to the matching `file://`
address, which Windows Terminal opens with Ctrl+click in the program Windows
uses for it (an image viewer, an editor, Explorer for a folder).

| Claude writes | The link opens |
| --- | --- |
| `/tmp/…/shot.png`, `/home/you/report.md` | `file://wsl.localhost/<distro>/tmp/…/shot.png` |
| a folder, `/home/you/project/` | the folder in Explorer |
| `/mnt/c/Users/you/Videos/` | `file:///C:/Users/you/Videos/` |
| `\\wsl.localhost\<distro>\…` (a UNC path) | `file:////wsl.localhost/<distro>/…` |
| a link to a path, `[Screenshot](/tmp/…/shot.png)` | the same `file://` address; the text `Screenshot` stays |

The text you see stays the same; only the path becomes a link. Left alone are:

- code blocks (fenced with ``` or ~~~) and inline code with more than a path in it,
- links Claude already wrote to anything other than an absolute path (`https://…`, `file://…`),
- relative paths such as `src/main.ts`.

A path in backticks on its own (`` `/tmp/x.png` ``) loses the backticks, so it
can be drawn as a link.

Only the drawing changes: the stored reply, what Claude sees and what you copy
with ctrl+o stay as written. The mod reads the distribution's name from
`WSL_DISTRO_NAME` when a session starts. Outside WSL (native Linux, macOS,
Windows) that variable is unset and the mod does nothing.

## Installation

In the WSL terminal where you run Claude Code:

```bash
claude plugin marketplace add systemNEO/claude-code-mods
claude plugin install wsl-file-links@claude-code-mods
```

The first line adds this repository as a marketplace (skip it if you already
use another mod from here), the second installs the mod for your user, i.e. for
all projects and sessions in that WSL distribution.

Alternatively, inside a running Claude Code session:

```
/plugin install wsl-file-links --marketplace systemNEO/claude-code-mods
```

Sessions that are already running pick up the mod with `/reload-plugins`.

## Requirements

- Claude Code inside WSL 2.
- A terminal that opens `file://` links, such as Windows Terminal
  (Ctrl+click). Tested with Windows Terminal and Ubuntu on WSL 2.

## Updates

```bash
claude plugin marketplace update claude-code-mods
claude plugin update wsl-file-links@claude-code-mods
```

## Tests

```bash
claude plugin test wsl-file-links
```

## License

MIT
