import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PoolAssetCard from '../src/modules/schematic/components/PoolAssetCard'
import { POOL_DROP_EVENT } from '../src/modules/schematic/services/poolDragService'
vi.mock('../src/modules/schematic/components/LazySvgImage', () => ({ default: (props: { alt: string }) => <img alt={props.alt}/> }))
afterEach(cleanup)
const asset={id:'a',name:'test image',productId:'p',width:100,height:100,svg:'<svg/>',previewUrl:'',thumbnailUrl:''}
test('double click adds once without opening preview; preview button is independent', () => {
 const add=vi.fn(), preview=vi.fn()
 render(<PoolAssetCard asset={asset} used={false} onAdd={add} onPreview={preview}/>)
 const card=screen.getByRole('button',{name:'加入画布 test image'})
 fireEvent.click(card);fireEvent.click(card);fireEvent.doubleClick(card)
 expect(add).toHaveBeenCalledExactlyOnceWith('a');expect(preview).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'放大预览 test image'}))
 expect(preview).toHaveBeenCalledOnce();expect(add).toHaveBeenCalledTimes(1)
})
test('pointer drag emits drop once and cancellation does not add', () => {
 vi.stubGlobal('PointerEvent',MouseEvent)
 const add=vi.fn(), drop=vi.fn()
 window.addEventListener(POOL_DROP_EVENT,drop)
 render(<PoolAssetCard asset={asset} used={false} onAdd={add} onPreview={vi.fn()}/>)
 const card=screen.getByRole('button',{name:'加入画布 test image'})
 card.setPointerCapture=vi.fn();card.hasPointerCapture=()=>true;card.releasePointerCapture=vi.fn()
 fireEvent.pointerDown(card,{button:0,clientX:10,clientY:10})
 fireEvent.pointerMove(card,{clientX:100,clientY:100})
 fireEvent.pointerUp(card,{clientX:100,clientY:100})
 expect(drop).toHaveBeenCalledOnce()
 expect(drop.mock.calls[0][0].detail).toEqual({assetId:'a',clientX:100,clientY:100})
 expect(add).not.toHaveBeenCalled()
 fireEvent.pointerDown(card,{button:0,clientX:10,clientY:10})
 fireEvent.pointerMove(card,{clientX:100,clientY:100})
 fireEvent.pointerCancel(card);fireEvent.pointerUp(card,{clientX:100,clientY:100})
 expect(drop).toHaveBeenCalledTimes(1)
 window.removeEventListener(POOL_DROP_EVENT,drop);vi.unstubAllGlobals()
})
