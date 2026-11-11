import type { Register } from 'claude-code'
import { withFileLinks } from './links'

export const register: Register = on => {
  let distro: string | undefined

  on('session.start', async ($, e, next) => {
    // Outside WSL (native Linux, macOS, Windows) WSL_DISTRO_NAME is unset and nothing is rewritten.
    distro = (await $.env.get('WSL_DISTRO_NAME')) || undefined
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (distro === undefined) {
      return next(e)
    }
    const text = withFileLinks(e.props.text, distro)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })
}
