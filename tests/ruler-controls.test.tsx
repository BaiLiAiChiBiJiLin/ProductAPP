import React, { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { defaultLayoutBounds, type Item } from '../src/model'
import { paginateAssets } from '../src/modules/schematic/services/paginationService'
vi.mock('../src/modules/schematic/ArtworkCanvas',()=>({default:()=> <div>Canvas</div>}))
vi.mock('../src/modules/schematic/components/ProductAttributesPanel',()=>({default:()=>null}))
vi.mock('../src/modules/schematic/components/AssetPool',()=>({default:()=>null}))
vi.mock('../src/modules/schematic/components/PageThumbnail',()=>({default:()=>null}))
import ArrangePage from '../src/modules/schematic/ArrangePage'
afterEach(cleanup)
const asset={id:'a',name:'a',productId:'a',width:100,height:200,svg:'<svg/>',previewUrl:'',thumbnailUrl:''}
const noop=()=>{}
function Harness({ onExport = noop }: { onExport?: React.ComponentProps<typeof ArrangePage>['onExport'] }){
 const [pages,setPages]=useState(()=>paginateAssets([asset])); const [selected,setSelected]=useState<string|null>(pages[0].items[0].id)
 const update=(next:Item)=>setPages([{...pages[0],items:[next]}])
 return <><button onClick={()=>setSelected(null)}>取消图片选择</button><output>{JSON.stringify(pages[0].items[0])}</output><ArrangePage context={null} assets={[asset]} pages={pages} activePage={1} selectedItem={selected} selectedGroupIds={[]} sortMode="default" onSelectPage={noop} onSelectItem={setSelected} onChangeItem={update} onDropAsset={noop} onDeleteGroups={noop} onConfirmAssetAttributes={async()=>{}} onAddPage={noop} onAutoArrange={noop} onCombine={noop} onSelectGroup={noop} onBack={noop} onExport={onExport} onMetadataChange={noop} layoutBounds={defaultLayoutBounds} onBoundsChange={noop} onAddHeaderBlock={noop} onChangeHeaderBlock={noop} onRemoveHeaderBlock={noop}/></>
}
it('selected image unit and independent dimension controls update the item; deselection disables editing',()=>{
 render(<Harness/>);
 const width=screen.getByRole('checkbox',{name:'宽标尺'}) as HTMLInputElement
 const height=screen.getByRole('checkbox',{name:'高标尺'}) as HTMLInputElement
 expect(width.checked).toBe(false);expect(height.checked).toBe(true)
 fireEvent.change(screen.getByLabelText('标尺单位'),{target:{value:'in'}})
 expect(screen.getByRole('status').textContent).toContain('"rulerUnit":"in"')
 fireEvent.click(width);expect(width.checked).toBe(true);expect(height.checked).toBe(true)
 fireEvent.click(height);expect(height.checked).toBe(false)
 fireEvent.click(screen.getByText('取消图片选择'))
 expect((screen.getByLabelText('标尺单位') as HTMLSelectElement).disabled).toBe(true)
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
