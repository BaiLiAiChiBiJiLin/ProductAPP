import { beforeEach, expect, test } from 'vitest'
import { confirmCloudRegistration, needsCloudRegistration } from '../src/services/cloudRegistration'

const production = { shared: true, environment: 'production', configPath: 'production/config.toml' }
beforeEach(() => localStorage.clear())

test('legacy saved username requires explicit cloud confirmation once', () => {
  localStorage.setItem('printflow-account-name', 'Alice')
  expect(needsCloudRegistration(production, 'Alice')).toBe(true)
  confirmCloudRegistration(production, 'Alice')
  expect(needsCloudRegistration(production, 'Alice')).toBe(false)
  expect(needsCloudRegistration(production, 'Bob')).toBe(true)
})

test('development confirmation does not register production; local mode is unchanged', () => {
  confirmCloudRegistration({ ...production, environment: 'development' }, 'Alice')
  expect(needsCloudRegistration(production, 'Alice')).toBe(true)
  expect(needsCloudRegistration({ ...production, shared: false }, 'Alice')).toBe(false)
})
