import { Group, Rect, Text } from 'react-konva'
import { HEADER_BACKGROUND, headerCellLines, headerCells, HEADER_BLOCK_HEIGHT, type HeaderBlock, type LayoutBounds } from '../../../model'

type Props = { block: HeaderBlock; bounds: LayoutBounds; selected: boolean; interactive: boolean; onSelect: (id: string) => void; onChange: (block: HeaderBlock) => void }

export default function HeaderBlockCanvas({ block, interactive, onSelect }: Props) {
  return <Group name="table-header-block" id={block.id} x={block.x} y={block.y} draggable={false} listening={interactive} onClick={() => onSelect(block.id)} onTap={() => onSelect(block.id)}>
    <Rect width={block.width} height={HEADER_BLOCK_HEIGHT} fill={HEADER_BACKGROUND} cornerRadius={[4, 4, 0, 0]} />
    {headerCells(block).map(cell => <Group key={cell.id} x={cell.x} listening={false}>
      {headerCellLines(cell).map((line, index, lines) => <Text key={index} x={2} y={index * HEADER_BLOCK_HEIGHT / lines.length} width={Math.max(1, cell.width - 4)} height={HEADER_BLOCK_HEIGHT / lines.length} text={line} align="center" verticalAlign="middle" fontSize={8.5} fill="#475569" wrap="none" ellipsis={lines.length === 1}/>)}
    </Group>)}
  </Group>
}

