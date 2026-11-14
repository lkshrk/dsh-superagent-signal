import { expect, it } from 'vitest'
import { inject, name } from '../src/index.ts'

it('names the plugin and the service it needs', () => {
  expect(name).toBe('dsh-superagent-signal')
  expect(inject).toEqual(['orchestrator'])
})
