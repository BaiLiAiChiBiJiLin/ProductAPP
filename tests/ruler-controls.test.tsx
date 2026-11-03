import React, { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { defaultLayoutBounds, type Item } from '../src/model'
import { paginateAssets } from '../src/modules/schematic/services/paginationService'
vi.mock('../src/modules/schematic/ArtworkCanvas',()=>({default:(props: { onEditAnnotation?: (annotation: unknown) => void })=> <><button aria-label="编辑自定义标尺" onClick={() => props.onEditAnnotation?.({ id: 'manual-ruler', kind: 'ruler', x: 10, y: 20, x2: 100, y2: 20, color: '#2f6fa3', measuredMm: 40 })}>编辑自定义标尺</button><div>Canvas</div></>}))
vi.mock('../src/modules/schematic/components/ProductAttributesPanel',()=>({default:()=>null}))
vi.mock('../src/modules/schematic/components/AssetPool',()=>({default:()=>null}))
vi.mock('../src/modules/schematic/components/PageThumbnail',()=>({default:()=>null}))
import ArrangePage from '../src/modules/schematic/ArrangePage'
import CanvasTools from '../src/modules/schematic/components/CanvasTools'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
afterEach(cleanup)
const asset={id:'a',name:'a',productId:'a',width:100,height:200,svg:'<svg/>',previewUrl:'',thumbnailUrl:''}
const noop=()=>{}
function Harness({ onExport = noop }: { onExport?: React.ComponentProps<typeof ArrangePage>['onExport'] }){
 const [displayState,setDisplayState]=useState(emptyArrangementDisplayState)
 const [pages,setPages]=useState(()=>{ const [page] = paginateAssets([asset]); page.annotations = [{ id: 'manual-ruler', kind: 'ruler', x: 10, y: 20, x2: 100, y2: 20, color: '#2f6fa3', measuredMm: 40 }]; return [page] }); const [selected,setSelected]=useState<string|null>(pages[0].items[0].id)
 const update=(next:Item)=>setPages([{...pages[0],items:[next]}])
 return <><button onClick={()=>setSelected(null)}>取消图片选择</button><output>{JSON.stringify(pages[0].items[0])}</output><pre aria-label="页面状态">{JSON.stringify(pages[0])}</pre><ArrangePage displayState={displayState} onDisplayStateChange={setDisplayState} context={null} assets={[asset]} pages={pages} activePage={1} selectedItem={selected} selectedGroupIds={[]} onChangePage={next => setPages(current => current.map(page => page.id === next.id ? next : page))} onSelectPage={noop} onSelectItem={setSelected} onChangeItem={update} onDropAsset={noop} onDeleteGroups={noop} onConfirmAssetAttributes={async()=>{}} onAddPage={noop} onRefresh={noop} onCombine={noop} onSelectGroup={noop} onBack={noop} onBackToHistory={noop} onExport={onExport} onMetadataChange={noop} layoutBounds={defaultLayoutBounds} onBoundsChange={noop} onAddHeaderBlock={noop} onChangeHeaderBlock={noop} onRemoveHeaderBlock={noop}/></>
}
it('selected image unit and independent dimension controls update the item; deselection disables editing',()=>{
 render(<Harness/>);
 const width=screen.getByRole('checkbox',{name:'宽标尺'}) as HTMLInputElement
 const height=screen.getByRole('checkbox',{name:'高标尺'}) as HTMLInputElement
 expect(width.checked).toBe(false);expect(height.checked).toBe(true)
 fireEvent.change(screen.getByLabelText('标尺单位'),{target:{value:'in'}})
 expect(screen.getByRole('status').textContent).toContain('"rulerUnit":"in"')
 fireEvent.click(width);expect(width.checked).toBe(true);expect(height.checked).toBe(true)
 const sizeAxis=screen.getByLabelText('Size使用方向') as HTMLSelectElement
 expect(sizeAxis.value).toBe('height')
 fireEvent.change(sizeAxis,{target:{value:'width'}})
 expect(screen.getByRole('status').textContent).toContain('"sizeAxis":"width"')
 fireEvent.click(height);expect(height.checked).toBe(false)
 fireEvent.click(screen.getByText('取消图片选择'))
 expect((screen.getByLabelText('标尺单位') as HTMLSelectElement).disabled).toBe(true)
})

it('shows the three ruler directions only after activating the ruler tool', () => {
 function RulerToolHarness() {
  const [mode, setMode] = useState<'free' | 'vertical' | 'horizontal'>('free')
  return <CanvasTools tool="ruler" rulerMode={mode} onRulerMode={setMode} background="#d4e9da" onBackground={() => {}} hasGroup disabled={false}/>
 }
 render(<RulerToolHarness />)
 expect(screen.getByRole('group', { name: '标尺方向' })).toBeTruthy()
 expect(screen.getByRole('button', { name: '自由标尺' }).getAttribute('aria-pressed')).toBe('true')
 fireEvent.click(screen.getByRole('button', { name: '垂直标尺' }))
 expect(screen.getByRole('button', { name: '垂直标尺' }).getAttribute('aria-pressed')).toBe('true')
 fireEvent.click(screen.getByRole('button', { name: '水平标尺' }))
 expect(screen.getByRole('button', { name: '水平标尺' }).getAttribute('aria-pressed')).toBe('true')
})
it('exports saved zero-decimal settings even after the image is deselected', () => {
 const onExport = vi.fn()
 render(<Harness onExport={onExport}/> )
 const original = screen.getByRole('status').textContent!
 const itemId = JSON.parse(original).id
 fireEvent.change(screen.getByLabelText('小数位数'), { target: { value: '0' } })
 fireEvent.blur(screen.getByLabelText('小数位数'))
 fireEvent.click(screen.getByText('取消图片选择'))
 fireEvent.click(screen.getByRole('button', { name: '导出' }))
 expect(onExport).toHaveBeenCalledWith('pdf', new Map([[itemId, { decimalPlaces: 0, precision: 'default' }]]))
 expect(screen.getByRole('status').textContent).toBe(original)
})

it('preserves decimal text while editing a custom ruler label', () => {
 render(<Harness />)
 fireEvent.click(screen.getByRole('button', { name: '编辑自定义标尺' }))
 const input = screen.getByLabelText('标尺数值') as HTMLInputElement
 fireEvent.change(input, { target: { value: '12.30' } })
 expect(input.value).toBe('12.30')
 fireEvent.click(screen.getByRole('button', { name: /确\s*认/ }))
 const state = JSON.parse(screen.getByLabelText('页面状态').textContent!)
 expect(state.annotations).toEqual([expect.objectContaining({ id: 'manual-ruler', measuredMm: 12.3, label: '12.30' })])
})
