# claude-code-mods

Mods für [Claude Code](https://claude.com/claude-code) von systemNEO.

| Mod | Was sie tut |
| --- | --- |
| [delete-guard](delete-guard/) | Löschen außerhalb des Projektordners nur mit deiner Zustimmung, in jedem Modus, auch für Subagenten; Bash, PowerShell, cmd, Git Bash, WSL, MCP |

## Installation

Marketplace hinzufügen und eine Mod installieren (Linux, macOS, Windows):

```bash
claude plugin marketplace add systemNEO/claude-code-mods
claude plugin install delete-guard@claude-code-mods
```

Installiert wird für deinen Benutzer, also für alle Projekte und Sessions auf
dem Rechner. Laufende Sessions übernehmen die Mod mit `/reload-plugins`.

In einer laufenden Claude-Code-Session geht auch:

```
/plugin install delete-guard --marketplace systemNEO/claude-code-mods
```

## Lizenz

MIT
