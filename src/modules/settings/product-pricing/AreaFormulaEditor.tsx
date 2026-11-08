import { useRef } from 'react'
import { Button, Input, type InputRef } from 'antd'
import { validateAreaFormula } from './areaPricing'
import { displayPricingMessage, displayPricingFormula, storePricingFormula } from './formulaDisplay'

type Props = {
  label: string
  value: string
  variables: readonly string[]
  validationVariables?: readonly string[]
  defaultFormula: string
  disabled?: boolean
  onChange: (value: string) => void
}

export default function AreaFormulaEditor({ label, value: storedValue, variables, validationVariables = variables, defaultFormula, disabled, onChange }: Props) {
  // Keep the persisted formula variable compatible while using the current UI name.
  const value = displayPricingFormula(storedValue)
  const changeFormula = (formula: string) => onChange(storePricingFormula(formula))
  const input = useRef<InputRef>(null)
  const cursor = useRef({ start: value.length, end: value.length })
  let error = ''
  try { validateAreaFormula(storedValue, validationVariables) } catch (failure) { error = displayPricingMessage(String(failure).replace(/^Error: /, '')) }
  const insert = (token: string) => {
    const { start, end } = cursor.current
    changeFormula(value.slice(0, start) + token + value.slice(end))
    const position = start + token.length
    cursor.current = { start: position, end: position }
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.input?.setSelectionRange(position, position)
    })
  }
  return <div className="area-formula-editor">
    <label>{label}
      <Input ref={input} aria-label={label} value={value} disabled={disabled} status={error ? 'error' : undefined}
        onSelect={event => { const field = event.currentTarget; cursor.current = { start: field.selectionStart ?? value.length, end: field.selectionEnd ?? value.length } }}
        onChange={event => changeFormula(event.target.value)}/>
    </label>
    <div className="area-formula-keys" aria-label={`${label}计算器`}>
      <div className="area-formula-key-row">
        {variables.map(variable => <Button size="small" disabled={disabled} key={variable} onClick={() => insert(displayPricingFormula(variable))}>{displayPricingFormula(variable)}</Button>)}
      </div>
      <div className="area-formula-key-row">
        {['+', '−', '×', '÷', '(', ')'].map(symbol => <Button size="small" disabled={disabled} key={symbol} onClick={() => insert(symbol === '−' ? '-' : symbol)}>{symbol}</Button>)}
        <Button size="small" disabled={disabled} onClick={() => onChange(defaultFormula)}>恢复默认公式</Button>
      </div>
    </div>
    <small className={error ? 'area-error' : 'pp-muted'}>{error || '可直接输入数字、变量、加减乘除和括号，也可点击上方按钮插入。'}</small>
  </div>
}
