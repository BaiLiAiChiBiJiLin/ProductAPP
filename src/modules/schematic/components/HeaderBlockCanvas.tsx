import { Group, Rect, Text } from 'react-konva'
import { HEADER_BACKGROUND, headerCellLines, headerCells, HEADER_BLOCK_HEIGHT, type HeaderBlock, type LayoutBounds } from '../../../model'
import { HEADER_TEXT_FONT_SIZE, headerTextLayout } from '../services/headerTextLayoutService'

type Props = { block: HeaderBlock; bounds: LayoutBounds; selected: boolean; interactive: boolean; onSelect: (id: string) => void; onChange: (block: HeaderBlock) => void }

export default function HeaderBlockCanvas({ block, interactive, onSelect }: Props) {
  return <Group name="table-header-block" id={block.id} x={block.x} y={block.y} draggable={false} listening={interactive} onClick={() => onSelect(block.id)} onTap={() => onSelect(block.id)}>
    <Rect width={block.width} height={HEADER_BLOCK_HEIGHT} fill={HEADER_BACKGROUND} cornerRadius={[4, 4, 0, 0]} />
    {headerCells(block).map(cell => <Group key={cell.id} x={cell.x} listening={false}>
      {headerTextLayout(headerCellLines(cell), HEADER_BLOCK_HEIGHT).map((line, index, lines) => <Text key={index} x={2} y={line.y} width={Math.max(1, cell.width - 4)} height={line.height} text={line.text} align="center" verticalAlign="middle" fontSize={HEADER_TEXT_FONT_SIZE} fill="#000" wrap="none" ellipsis={lines.length === 1}/>)}
    </Group>)}
  </Group>
}

