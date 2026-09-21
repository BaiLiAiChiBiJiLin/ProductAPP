import { useState } from 'react'
import { Image, Popover, Select } from 'antd'
import type { ProductOption, ProductOptionValue } from '../services/productConfigService'
import './product-options.css'

type Props = {
  option: ProductOption
  values: ProductOptionValue[]
  value?: string
  imageOverride?: string
  disabled: boolean
  onChange: (value: string, image?: string) => void
}

export default function ProductOptionField({ option, values, value, imageOverride, disabled, onChange }: Props) {
  const [failedImage, setFailedImage] = useState('')
  const selected = values.find(item => item.name === value)
  const image = imageOverride || selected?.image || option.image
  const description = `${option.label}：${selected?.label ?? option.label}`
  const accessoryColor = [option.name, option.label].some(name => /accessor(?:y|ies)\s*colou?r|配件颜色/i.test(name.replace(/[_-]/g, ' ')))
  return <div className="product-config-field" role="group" aria-label={option.label}>
    <span>{option.label}</span>
    <Select aria-label={option.label} disabled={disabled} allowClear placeholder={`请选择${option.label}`}
      value={selected?.name} options={values.map(item => ({ value: item.name, label: item.label }))}
      optionRender={entry => {
        const item = values.find(candidate => candidate.name === entry.value)
        const previewImage = item?.image || option.image
        const label = <div className="product-option-hover-target">{entry.label}</div>
        return accessoryColor && previewImage ? <Popover placement="left" trigger="hover" mouseEnterDelay={0.12}
          content={<div className="accessory-option-hover-preview"><Image src={previewImage} alt={item?.label || option.label} width={160} height={160} style={{ objectFit: 'contain' }} preview={false}/><span>{item?.label}</span></div>}>
          {label}
        </Popover> : label
      }}
      onChange={next => { const selectedValue = values.find(item => item.name === next); onChange(next ?? '', selectedValue?.image || option.image) }} />
    {image && <div className="product-option-preview">
      {failedImage === image ? <span className="product-option-image-error">图片暂时无法加载</span> :
        <Image key={image} src={image} alt={description} width={96} height={96} loading="lazy"
          style={{ objectFit: 'contain' }} preview={{ mask: '查看大图' }} onError={() => setFailedImage(image)} />}
    </div>}
  </div>
}
