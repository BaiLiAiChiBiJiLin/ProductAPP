import type { HeaderBlock, LayoutBounds } from '../../../model'
type Props = { pageId: number; blocks: HeaderBlock[]; bounds: LayoutBounds; selected: string | null; onSelect: (id: string) => void; onAdd: () => void; onChange: (block: HeaderBlock) => void; onRemove: (id: string) => void }
export default function HeaderBlocksEditor({ pageId, blocks, onChange }: Props) {
 return <div className="header-blocks-editor"><p className="page-config-help">第 {pageId} 页表头由排列自动生成，位置和列数固定。</p>{blocks.map((block,index)=><div key={block.id} className="header-block-editor"><strong>表头 {index+1}</strong>{block.columns.map((column,i)=><label key={column.id}><span>第 {i+1} 列属性标题</span><input value={column.detailLabel} onChange={event=>onChange({...block,columns:block.columns.map(c=>c.id===column.id?{...c,detailLabel:event.target.value}:c)})}/></label>)}</div>)}</div>
}
