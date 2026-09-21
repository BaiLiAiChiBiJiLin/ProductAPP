from pathlib import Path
import re
p=Path('src/App.tsx');s=p.read_text(encoding='utf-8');s=re.sub(r'<Progress percent=\{68\}.*?/>','<Progress percent={splitProgress??0} size="small" strokeColor="#2563eb" status={splitProgress===null?"normal":splitProgress===100?"success":"active"} format={()=>splitProgress===null?"等待上传 SVG":splitProgress===100?"拆分完成":"正在拆分 SVG…"}/>',s);p.write_text(s,encoding='utf-8')
