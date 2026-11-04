import { useState } from 'react'
import { Alert, Button, Input, Modal, Select } from 'antd'
import { validateDocument, type DimensionPanel, type DimensionPrice, type PriceRange } from './model'
import PriceInput from './PriceInput'

type Props = {
  recipe: DimensionPrice
  onApply: (recipe: DimensionPrice) => void
  onCancel: () => void
}

type RangeEditorProps = {
  ranges: PriceRange[]
  label: string
  kindLabel: string
  change: (update: (ranges: PriceRange[]) => void) => void
}

export default function DimensionPriceDialog({ recipe, onApply, onCancel }: Props) {
  const [draft, setDraft] = useState(() => structuredClone(recipe))
  const [error, setError] = useState<string | null>(null)

  const edit = (update: (recipe: DimensionPrice) => void) => {
    setDraft(current => {
      const next = structuredClone(current)
      update(next)
      return next
    })
    setError(null)
  }

  const editPanel = (panelId: string, update: (panel: DimensionPanel) => void) => {
    edit(next => {
      const panel = next.panels.find(item => item.panelId === panelId)
      if (panel) update(panel)
    })
  }

  const apply = () => {
    try {
      validateDocument({
        schemaVersion: 4,
        currency: 'USD',
        accessoryPricing: 'style',
        accessoryPrices: [],
        products: [{
          productId: 'dimension-dialog',
          printPricing: 'included',
          pricingMode: 'standee',
          fixedUnitPrice: null,
          basePrices: [], attributePrices: [], legacyBodyPrices: [],
          dimensionPrices: [draft],
        }],
      })
      onApply(structuredClone(draft))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const addPanel = () => edit(next => {
    next.panels.push({
      panelId: `panel-${crypto.randomUUID()}`,
      label: '新面板',
      baseAdjustment: '0',
      pieceBands: [],
      baseBands: [],
    })
  })

  return (
    <Modal
      open
      title="尺寸计价"
      className="pp-dimension-dialog"
      width={1100}
      okText="应用"
      cancelText="取消"
      maskClosable={false}
      onOk={apply}
      onCancel={onCancel}
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 } }}
    >
      <p className="pp-help">一套价格 = 主体固定金额 + 各片材 + 各底座及调整。</p>
      <p className="pp-help">
        金额单位为 USD，尺寸单位为毫米（mm）。每片片材分别计价，每个面板加一次底座及调整。
        区间按最长边匹配，包含两端；未覆盖的尺寸不能试算。
      </p>
      {error && <Alert type="error" showIcon message={error} role="alert" />}

      <div className="pp-fixed-price">
        <label>
          主体固定金额
          <PriceInput
            label="主体固定金额"
            value={draft.baseUnitPrice}
            onChange={value => edit(next => { next.baseUnitPrice = value })}
          />
        </label>
      </div>

      <div className="pp-dimension-dialog-panels">
        {draft.panels.map((panel, panelIndex) => {
          const panelLabel = `面板${panelIndex + 1}`
          return (
            <section className="pp-panel-editor" aria-label={panelLabel} key={panel.panelId}>
              <h4>{panelLabel}</h4>
              <div className="pp-panel-toolbar">
                <label>
                  名称
                  <Input
                    aria-label={`${panelLabel}名称`}
                    value={panel.label}
                    onChange={event => editPanel(panel.panelId, next => {
                      next.label = event.target.value
                    })}
                  />
                </label>
                <label>
                  底座调整
                  <PriceInput
                    label={`${panelLabel}底座调整`}
                    value={panel.baseAdjustment}
                    signed
                    onChange={value => editPanel(panel.panelId, next => {
                      next.baseAdjustment = value
                    })}
                  />
                </label>
                <Button
                  danger
                  aria-label={`删除${panelLabel}`}
                  onClick={() => edit(next => {
                    next.panels = next.panels.filter(item => item.panelId !== panel.panelId)
                  })}
                >
                  删除面板
                </Button>
              </div>

              {(['pieceBands', 'baseBands'] as const).map(key => {
                const kindLabel = key === 'pieceBands' ? '片材' : '底座'
                return (
                  <div key={key}>
                    <h5>{kindLabel}价格区间</h5>
                    <RangeEditor
                      ranges={panel[key]}
                      label={`${panelLabel}${kindLabel}`}
                      kindLabel={kindLabel}
                      change={update => editPanel(panel.panelId, next => update(next[key]))}
                    />
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
      {!draft.panels.length && <p className="pp-empty">请新增面板，填写片材和底座的价格区间。</p>}
      <Button onClick={addPanel}>新增面板</Button>
    </Modal>
  )
}

function RangeEditor({ ranges, label, kindLabel, change }: RangeEditorProps) {
  const addRange = () => change(next => {
    next.push({
      rangeId: `range-${crypto.randomUUID()}`,
      minMm: '',
      maxMm: '',
      kind: 'fixed',
      amount: '',
      coefficient: '0',
    })
  })

  return (
    <>
      <div className="pp-table-wrap" role="region" aria-label={`${label}区间表`} tabIndex={0}>
        <table className="pp-range-table">
          <thead>
            <tr>
              <th scope="col">最长边起点（mm）</th>
              <th scope="col">最长边终点（mm）</th>
              <th scope="col">计价方式</th>
              <th scope="col">固定金额</th>
              <th scope="col">面积系数</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {ranges.map((range, index) => {
              const rowLabel = `${label}第${index + 1}段`
              return (
                <tr key={range.rangeId}>
                  <td>
                    <Input
                      aria-label={`${rowLabel}起点`}
                      inputMode="decimal"
                      value={range.minMm}
                      onChange={event => change(next => { next[index].minMm = event.target.value })}
                    />
                  </td>
                  <td>
                    <Input
                      aria-label={`${rowLabel}终点`}
                      inputMode="decimal"
                      value={range.maxMm}
                      onChange={event => change(next => { next[index].maxMm = event.target.value })}
                    />
                  </td>
                  <td>
                    <Select
                      aria-label={`${rowLabel}方式`}
                      value={range.kind}
                      options={[
                        { value: 'fixed', label: '固定金额' },
                        { value: 'area', label: '宽 × 高 × 系数 + 固定金额' },
                      ]}
                      onChange={(kind: PriceRange['kind']) => change(next => {
                        next[index].kind = kind
                        if (kind === 'fixed') next[index].coefficient = '0'
                      })}
                    />
                  </td>
                  <td>
                    <PriceInput
                      label={`${rowLabel}金额`}
                      value={range.amount}
                      onChange={value => change(next => { next[index].amount = value })}
                    />
                  </td>
                  <td>
                    <Input
                      aria-label={`${rowLabel}面积系数`}
                      inputMode="decimal"
                      value={range.coefficient}
                      disabled={range.kind === 'fixed'}
                      onChange={event => change(next => { next[index].coefficient = event.target.value })}
                    />
                  </td>
                  <td>
                    <Button
                      type="text"
                      danger
                      aria-label={`删除${rowLabel}`}
                      onClick={() => change(next => { next.splice(index, 1) })}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <Button aria-label={`新增${label}区间`} onClick={addRange}>新增{kindLabel}区间</Button>
    </>
  )
}
