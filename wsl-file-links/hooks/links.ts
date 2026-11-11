/** Absolute Linux paths as Claude writes them: a known top folder, then no blank, quote or bracket. */
const LINUX_PATH = /(?<![\w:/.\]])(\/(?:home|tmp|mnt|usr|etc|opt|var|srv|root)\/[^\s`'"()<>[\]]+)/g
/** UNC paths into WSL as Windows shows them: \\wsl.localhost\Distro\... or \\wsl$\Distro\... */
const UNC_PATH = /(\\\\wsl(?:\.localhost|\$)\\[^\s`'"()<>[\]]+)/g
/** An inline code span holding nothing but such a path loses its backticks, so the link can be drawn. */
const CODE_SPAN_WITH_PATH = /`((?:\/(?:home|tmp|mnt|usr|etc|opt|var|srv|root)\/|\\\\wsl(?:\.localhost|\$)\\)[^`\s]+)`/g
/** A Markdown link whose target is an absolute Linux path: the text stays, the target becomes file://. */
const LINK_TO_LINUX_PATH = /^\[([^\]]*)\]\((\/(?:home|tmp|mnt|usr|etc|opt|var|srv|root)\/[^)\s]+)\)$/
const TRAILING_PUNCTUATION = /[.,;:!?]+$/
const WINDOWS_DRIVE_MOUNT = /^\/mnt\/([a-z])(\/.*)?$/
const FENCE = /^\s*(```|~~~)/

function encodedPath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

/** The file:// address Windows opens for a Linux path of the given distribution. */
export function fileUrlOf(linuxPath: string, distro: string): string {
  const drive = WINDOWS_DRIVE_MOUNT.exec(linuxPath)
  if (drive) {
    return `file:///${drive[1].toUpperCase()}:${encodedPath(drive[2] ?? '/')}`
  }
  return `file://wsl.localhost/${encodeURIComponent(distro)}${encodedPath(linuxPath)}`
}

function uncToUrl(unc: string): string {
  return `file:${unc.replace(/\\/g, '/').replace(/^\/\//, '////').split('/').map((s, i) => (i < 4 ? s : encodeURIComponent(s))).join('/')}`
}

function splitTrailing(text: string): [string, string] {
  const trailing = TRAILING_PUNCTUATION.exec(text)?.[0] ?? ''
  return [text.slice(0, text.length - trailing.length), trailing]
}

function linkLine(line: string, distro: string): string {
  const withoutCode = line.replace(CODE_SPAN_WITH_PATH, '$1')
  const parts = withoutCode.split(/(\[[^\]]*\]\([^)]*\)|`[^`]*`)/)
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        return part.replace(LINK_TO_LINUX_PATH, (_, text, path) => `[${text}](${fileUrlOf(path, distro)})`)
      }
      return part
        .replace(LINUX_PATH, match => {
          const [path, trailing] = splitTrailing(match)
          return `[${path}](${fileUrlOf(path, distro)})${trailing}`
        })
        .replace(UNC_PATH, match => {
          const [path, trailing] = splitTrailing(match)
          return `[${path}](${uncToUrl(path)})${trailing}`
        })
    })
    .join('')
}

/** Every absolute path outside code blocks, code spans and existing links becomes a clickable file:// link. */
export function withFileLinks(markdown: string, distro: string): string {
  let insideFence = false
  return markdown
    .split('\n')
    .map(line => {
      if (FENCE.test(line)) {
        insideFence = !insideFence
        return line
      }
      return insideFence ? line : linkLine(line, distro)
    })
    .join('\n')
}
