import { useState } from 'react'
import { Button, Dropdown, Input } from 'antd'
import { ChevronDown } from 'lucide-react'

type Props<Value extends string | number> = {
  name: string
  selectionName: string
  text: string
  selected?: Value
  options: { value: Value; label: string }[]
  readOnly?: boolean
  disabled?: boolean
  placeholder?: string
  onTextChange: (text: string) => void
  onSelect: (value: Value) => void
}

/** Editing the name never opens the menu; the separate arrow selects a record. */
export default function EditableNameSelect<Value extends string | number>({ name, selectionName, text, selected, options, readOnly, disabled, placeholder, onTextChange, onSelect }: Props<Value>) {
  const [open, setOpen] = useState(false)
  return <div className="po-name-select">
    <Input aria-label={name} value={text} readOnly={readOnly} disabled={disabled} placeholder={placeholder} onFocus={() => setOpen(false)} onChange={event => onTextChange(event.target.value)}/>
    <Dropdown trigger={['click']} placement="bottomRight" destroyOnHidden overlayStyle={{ maxWidth: 'min(680px, calc(100vw - 48px))' }} open={open && !disabled} onOpenChange={setOpen} disabled={disabled || !options.length}
      menu={{ selectable: true, selectedKeys: selected === undefined ? [] : [String(selected)], style: { maxHeight: 320, overflowY: 'auto' }, items: options.map(option => ({ key: String(option.value), label: option.label })), onClick: ({ key }) => {
        const option = options.find(item => String(item.value) === key)
        setOpen(false)
        if (option) onSelect(option.value)
      } }}>
      <Button aria-label={selectionName} aria-haspopup="menu" aria-expanded={open && !disabled} disabled={disabled || !options.length} icon={<ChevronDown size={14}/>} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}/>
    </Dropdown>
  </div>
}
