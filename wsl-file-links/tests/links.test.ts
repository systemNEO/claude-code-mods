import { expect, test } from 'claude-code/testing'
import { fileUrlOf, withFileLinks } from '../hooks/links'

test('a path in the scratchpad becomes a link into WSL', () => {
  expect(withFileLinks('Bild: /tmp/a/b c.png', 'Ubuntu')).toBe('Bild: [/tmp/a/b](file://wsl.localhost/Ubuntu/tmp/a/b) c.png')
  expect(withFileLinks('siehe /home/u/x.png.', 'Ubuntu')).toBe('siehe [/home/u/x.png](file://wsl.localhost/Ubuntu/home/u/x.png).')
})

test('a code span holding only a path loses its backticks, code blocks stay', () => {
  expect(withFileLinks('`/tmp/x.png`', 'Ubuntu')).toBe('[/tmp/x.png](file://wsl.localhost/Ubuntu/tmp/x.png)')
  expect(withFileLinks('```\n/tmp/x.png\n```', 'Ubuntu')).toBe('```\n/tmp/x.png\n```')
  expect(withFileLinks('`ls /tmp/x`', 'Ubuntu')).toBe('`ls /tmp/x`')
})

test('existing links and relative paths stay untouched', () => {
  const linked = '[x](file://wsl.localhost/Ubuntu/tmp/x.png)'
  expect(withFileLinks(linked, 'Ubuntu')).toBe(linked)
  expect(withFileLinks('client/src/main.ts', 'Ubuntu')).toBe('client/src/main.ts')
})

test('Windows drives and UNC paths', () => {
  expect(fileUrlOf('/mnt/c/Users/you/Videos', 'Ubuntu')).toBe('file:///C:/Users/you/Videos')
  expect(withFileLinks('\\\\wsl.localhost\\Ubuntu\\tmp\\x.png', 'Ubuntu')).toBe(
    '[\\\\wsl.localhost\\Ubuntu\\tmp\\x.png](file:////wsl.localhost/Ubuntu/tmp/x.png)',
  )
})
