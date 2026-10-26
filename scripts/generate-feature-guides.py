"""Build the four offline, silent feature-guide GIFs (Pillow only).

These are deliberately labelled operation illustrations, with no customer
artwork or business data. Run from any directory: python scripts/generate-feature-guides.py
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
# This generator belongs to this release; application version bumps must not
# redirect it into (or overwrite) another release's introduction.
OUT = ROOT / "src" / "modules" / "feature-tour" / "versions" / "0.1.32"
W, H, SS, FPS, SECONDS = 960, 540, 2, 10, 11
BG, INK, MUTED = "#f3f6fb", "#182333", "#66758a"
BLUE, RULER, GREEN = "#1677ff", "#2f6fa3", "#d4e9da"
PALETTE = ["#f9c958", "#a999ef", "#f399a8", "#6ecac3"]


@lru_cache(maxsize=80)
def font(size: int, bold: bool = False):
    return ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc", round(size * SS))


class Scene:
    def __init__(self):
        self.im = Image.new("RGB", (W * SS, H * SS), BG)
        self.d = ImageDraw.Draw(self.im)

    def box(self, box, fill, outline=None, width=1, radius=0):
        coords = tuple(round(v * SS) for v in box)
        if radius:
            self.d.rounded_rectangle(coords, round(radius * SS), fill, outline, round(width * SS))
        else:
            self.d.rectangle(coords, fill, outline, round(width * SS))

    def line(self, points, fill, width=1):
        self.d.line([(round(x * SS), round(y * SS)) for x, y in points], fill, round(width * SS), joint="curve")

    def circle(self, x, y, r, fill, outline=None, width=1):
        self.d.ellipse(((x-r)*SS, (y-r)*SS, (x+r)*SS, (y+r)*SS), fill, outline, round(width*SS))

    def poly(self, points, fill, outline=None, width=1):
        points = [(round(x*SS), round(y*SS)) for x, y in points]
        self.d.polygon(points, fill, outline, round(width*SS))

    def text(self, x, y, value, size=18, fill=INK, bold=False, anchor="la"):
        self.d.text((round(x*SS), round(y*SS)), value, font=font(size, bold), fill=fill, anchor=anchor)

    def vertical_text(self, x, y, value, size=14, fill=RULER):
        f = font(size)
        b = f.getbbox(value)
        layer = Image.new("RGBA", (b[2]-b[0]+8*SS, b[3]-b[1]+8*SS))
        ImageDraw.Draw(layer).text((4*SS-b[0], 4*SS-b[1]), value, font=f, fill=fill)
        layer = layer.rotate(90, expand=True)
        self.im.paste(layer, (round(x*SS-layer.width/2), round(y*SS-layer.height/2)), layer)

    def done(self):
        return self.im.resize((W, H), Image.Resampling.LANCZOS)


def ease(value):
    value = max(0, min(1, value))
    return value * value * (3 - 2 * value)


def mix(a, b, t):
    return a + (b-a)*ease(t)


def header(s, active="选择", selected=0, combine=False):
    s.box((0, 0, W, 59), "#ffffff")
    s.circle(31, 29, 10, BLUE)
    s.poly([(27, 24), (37, 29), (27, 34)], "#ffffff")
    s.text(52, 17, "示意图排列", 21, bold=True)
    s.text(931, 21, "操作示意", 14, MUTED, anchor="ra")
    s.line([(0, 59), (W, 59)], "#dfe6f0")
    for x, label in [(31, "选择"), (127, "文字"), (223, "标尺")]:
        selected_tool = label == active
        if selected_tool:
            s.box((x-8, 71, x+73, 106), "#e7f0ff", radius=7)
        s.text(x+10, 77, label, 17, BLUE if selected_tool else MUTED, selected_tool)
    s.line([(328, 77), (328, 102)], "#d6deea")
    if selected:
        s.text(350, 79, f"已选 {selected} 组", 16, MUTED)
    if combine:
        s.box((540, 72, 638, 108), BLUE if selected >= 2 else "#edf1f6", radius=7)
        s.text(589, 89, "组合", 17, "white" if selected >= 2 else "#9ba7b6", True, "mm")


def paper(s):
    s.box((38, 121, 924, 468), "#e1e7ef", radius=13)
    s.box((34, 117, 920, 464), "#ffffff", "#dbe3ee", radius=13)


def footer(s, main, hint=""):
    s.text(480, 476, main, 22, INK, True, "ma")
    if hint:
        s.text(480, 509, hint, 16, MUTED, anchor="ma")


def key(s, x, y, label):
    width = 56 if label == "Ctrl" else 48
    s.box((x, y, x+width, y+31), "white", "#b9c8dd", radius=6)
    s.text(x+width/2, y+15, label, 16, BLUE, True, "mm")


def cursor(s, x, y, click=0, drag=False):
    if click > 0:
        r = 9 + click * 13
        s.circle(x, y, r, None, "#80b5ff", 2)
        s.circle(x, y, 4, BLUE)
    s.poly([(x+2,y+3), (x+3,y+31), (x+10,y+24), (x+16,y+37), (x+22,y+34), (x+16,y+22), (x+26,y+21)], "#22344d", "white", 1.5)
    if drag:
        s.circle(x+2, y+3, 3.5, BLUE)


def pulse(t, at, span=.42):
    return max(0, 1 - abs(t-at)/(span/2))


def charm(s, cx, cy, width=92, color=PALETTE[0]):
    # Original sample artwork: a little cat-shaped acrylic charm.
    k = width/100
    def p(x, y): return cx+x*k, cy+y*k
    outline = "#435366"
    s.poly([p(-39,-27),p(-35,-60),p(-12,-43),p(12,-43),p(35,-60),p(39,-27),p(43,35),p(29,51),p(-29,51),p(-43,35)], "#ffffff", outline, 1.5)
    s.poly([p(-34,-26),p(-31,-50),p(-11,-36),p(11,-36),p(31,-50),p(34,-26),p(38,32),p(25,45),p(-25,45),p(-38,32)], color)
    s.circle(*p(0,-42), 5*k, "white", outline, 1)
    s.circle(*p(-16,-2), 4*k, outline)
    s.circle(*p(16,-2), 4*k, outline)
    s.circle(*p(-25,12), 6*k, "#f1a7a3")
    s.circle(*p(25,12), 6*k, "#f1a7a3")
    s.line([p(-10,14),p(-5,19),p(0,20),p(5,19),p(10,14)], outline, 2)


def ruler(s, x, y1, y2, end_x, label="50.8 mm", preview=False):
    s.line([(x,y1),(end_x,y1)], RULER, 1)
    s.line([(x,y2),(end_x,y2)], RULER, 1)
    mid=(y1+y2)/2
    gap=34
    s.line([(x,y1),(x,mid-gap)], RULER, 1)
    s.line([(x,mid+gap),(x,y2)], RULER, 1)
    s.poly([(x,y1),(x-4,y1+10),(x+4,y1+10)], RULER)
    s.poly([(x,y2),(x-4,y2-10),(x+4,y2-10)], RULER)
    s.vertical_text(x-3,mid,label,13)
    if preview:
        s.circle(x, y1, 3, BLUE)
        s.circle(x, y2, 3, BLUE)


def selection(s, box, handles=True):
    x1,y1,x2,y2=box
    s.box(box, None, BLUE, 2)
    if handles:
        for x,y in [(x1,y1),((x1+x2)/2,y1),(x2,y1),(x1,(y1+y2)/2),(x2,(y1+y2)/2),(x1,y2),((x1+x2)/2,y2),(x2,y2)]:
            s.box((x-4,y-4,x+4,y+4), "#ffffff", BLUE, 1)


def block(s,x,y,w,h,index=0,selected=False,scale=1):
    s.box((x,y,x+w,y+h),GREEN)
    size=min(92, h*.58)*scale
    cx,cy=x+w*.31,y+h*.53
    charm(s,cx,cy,size,PALETTE[index%4])
    s.text(x+w*.61,y+13,"Size: 50.8 mm",14)
    s.text(x+w*.61,y+38,"QT: 2",14)
    if selected: selection(s,(x,y,x+w,y+h))


def resize_scene(t):
    s=Scene(); header(s,selected=1); paper(s)
    x,y,col,gap=82,176,250,12
    height=176
    if t<2.5: columns=1
    elif t<3.8: columns=2
    elif t<7.7: columns=3
    else: columns=2
    if 4.6<t<6.4: height=mix(176,239,(t-4.6)/1.8)
    elif 6.4<=t<7.2: height=239
    elif 7.2<=t<9: height=mix(239,178,(t-7.2)/1.8)
    width=columns*col+(columns-1)*gap
    for i in range(3):
        s.text(x+i*(col+gap)+col/2,139,f"{i+1} 列",15,MUTED,anchor="ma")
        for yy in range(171,435,12): s.line([(x+(i+1)*col+i*gap,yy),(x+(i+1)*col+i*gap,yy+5)],"#d7dfeb")
    block(s,x,y,width,height,selected=True)
    if t<1.3:
        cursor(s,x+col*.75,y+height*.8,pulse(t,.7))
        main="先选中需要调整的块"
    elif t<4.6:
        px=mix(x+col,x+3*col+2*gap,(t-1.3)/3)
        cursor(s,px,y+height/2,drag=True)
        main="拖动左右边缘，宽度按整列调整"
    elif t<7.2:
        cursor(s,x+width/2,y+height,drag=True)
        main="拖动上下边缘，高度自由调整"
    elif t<9:
        px=mix(x+3*col+2*gap,x+2*col+gap,(t-7.2)/1.8)
        cursor(s,px,y+height,drag=True)
        main="拖动角点，同时调整宽度和高度"
    else:
        cursor(s,x+width+26,y+height+15)
        main="松开鼠标，完成调整"
    footer(s,main,"横向吸附 1 / 2 / 3 列  ·  纵向自由调整")
    return s.done()


def image_scale_scene(t):
    s=Scene(); header(s); paper(s)
    changes=[(0,100),(1.7,110),(2.35,120),(3,130),(3.65,140),(6.1,130),(6.75,120),(7.4,110),(8.05,100)]
    percent=next(value for start,value in reversed(changes) if t>=start)
    s.text(572,81,"图片显示",16,MUTED)
    s.box((665,71,797,107),"white","#bad0ee",radius=6)
    s.text(731,89,f"{percent}%",18,BLUE,True,"mm")
    x,y,w,h=115,143,730,297
    s.box((x,y,x+w,y+h),GREEN)
    cx,cy=370,295; size=124*percent/100
    charm(s,cx,cy,size)
    y1,y2=cy-size*.60,cy+size*.51
    ruler(s,cx-size*.61,y1,y2,cx-size*.3)
    selection(s,(cx-size*.44,cy-size*.61,cx+size*.44,cy+size*.53))
    s.text(631,183,"Size: 50.8 mm",20)
    s.text(631,218,"QT: 2",20)
    s.box((625,274,808,312),"#ffffff",radius=7)
    s.text(716,293,"真实尺寸保持不变",15,RULER,anchor="mm")
    key(s,461,358,"Alt")
    cursor(s,449,316, pulse(t,.6))
    s.box((520,354,547,397),"white","#8b9bb0",radius=12)
    s.line([(533,358),(533,373)],BLUE,3)
    active=1.4<t<4.3 or 5.9<t<8.7
    if active:
        offset=(t*30)%10
        if t<5:
            s.poly([(564,376-offset),(571,366-offset),(578,376-offset)],BLUE)
        else:
            s.poly([(564,366+offset),(571,376+offset),(578,366+offset)],BLUE)
    footer(s,"选中图片，按住 Alt 并滚动滚轮","每次调整 10%  ·  图片与标尺同步缩放")
    return s.done()


def manual_ruler_scene(t):
    s=Scene(); header(s,active="标尺" if t<8 else "选择"); paper(s)
    s.box((150,142,809,439),GREEN)
    charm(s,507,298,181,PALETTE[1])
    s.text(660,164,"Size: 50.8 mm",16)
    s.text(660,193,"QT: 2",16)
    y1,y2,x0=189,390,405
    if t<1.1:
        px=mix(260,x0,t/1.1); py=mix(88,y1,t/1.1)
        cursor(s,px,py,pulse(t,1))
        main="第 1 次点击：确定测量起点"
    elif t<3.4:
        py=mix(y1,y2,(t-1.1)/1.8)
        s.circle(x0,y1,5,BLUE)
        if py>y1+20: ruler(s,x0,y1,py,x0,label=f"{50.8*(py-y1)/(y2-y1):.1f} mm",preview=True)
        cursor(s,x0,py,pulse(t,3))
        main="第 2 次点击：确定测量终点"
    elif t<7.6:
        offset=mix(0,99,(t-3.4)/2.6)
        line_x=x0-offset
        ruler(s,line_x,y1,y2,x0,preview=True)
        s.circle(x0,y1,4,"white",BLUE,2);s.circle(x0,y2,4,"white",BLUE,2)
        px=mix(x0,line_x,(t-3.4)/1.7); py=mix(y2,293,(t-3.4)/1.7)
        cursor(s,px,py,pulse(t,7.3))
        main="移动鼠标，调整延伸方向与长度"
    else:
        ruler(s,x0-99,y1,y2,x0)
        cursor(s,342,322)
        main="第 3 次点击：完成标尺"
    if 1.1<=t<7.6:
        for n,yy in [(1,y1),(2,y2)]:
            if n==2 and t<3.2: continue
            s.circle(x0+22,yy,12,BLUE)
            s.text(x0+22,yy,str(n),14,"white",True,"mm")
    footer(s,main,"文字跟随标尺角度  ·  竖向标尺，文字也竖向显示")
    return s.done()


def combined_block(s, x,y,w,h, count, selected=False):
    s.box((x,y,x+w,y+h),GREEN)
    row=h/count
    for i in range(count):
        charm(s,x+w*.31,y+(i+.5)*row,min(70,row*.75),PALETTE[i])
        s.text(x+w*.61,y+i*row+14,"Size: 50.8 mm",14)
        s.text(x+w*.61,y+i*row+35,"QT: 2",14)
    if selected: selection(s,(x,y,x+w,y+h))
    s.box((x+10,y+8,x+99,y+34),"white",radius=5)
    s.text(x+54,y+21,f"{count} 张已组合",13,BLUE,True,"mm")


def combine_scene(t):
    s=Scene()
    initial=t<4.3
    if initial:
        selected=0 if t<.7 else 1 if t<1.6 else 2 if t<2.5 else 3
    elif t<6.4:selected=1
    elif t<8.2:selected=2
    else:selected=1
    header(s,selected=selected,combine=True);paper(s)
    if initial:
        for i in range(4):
            x=68+i*211
            # The small scale focuses on block selection; all four share one product.
            s.box((x,158,x+191,428),GREEN)
            charm(s,x+94,282,107,PALETTE[i])
            s.text(x+18,178,"Size: 50.8 mm",16)
            s.text(x+18,202,"QT: 2",16)
            if i<selected: selection(s,(x,158,x+191,428),False)
        target=0 if t<1.6 else 1 if t<2.5 else 2
        px=68+target*211+171;py=401
        if t>=3.35:
            px=mix(661,589,(t-3.35)/.5);py=mix(401,89,(t-3.35)/.5)
        cursor(s,px,py,max(pulse(t,.7),pulse(t,1.6),pulse(t,2.5),pulse(t,4)))
        if t<3.35:key(s,min(px+29,850),py-45,"Ctrl")
        main="按住 Ctrl，多选需要组合的块"
    elif t<8.2:
        combined_block(s,112,151,386,292,3,True)
        block(s,534,151,308,292,index=3,selected=selected==2)
        if t<5.5:
            cursor(s,589,108)
            main="点击组合，多张图片成为一个块"
        else:
            px,py=814,410
            if t>7.2:
                px=mix(814,589,(t-7.2)/.55);py=mix(410,89,(t-7.2)/.55)
            cursor(s,px,py,max(pulse(t,6.4),pulse(t,8)))
            if t<7.2:key(s,738,356,"Ctrl")
            main="保留已有组合，再按 Ctrl 加选其他块"
    else:
        combined_block(s,265,145,432,303,4,True)
        cursor(s,733,357)
        main="再次点击组合，继续加入更多图片"
    footer(s,main,"支持多个同产品块  ·  已组合的块也能继续组合")
    return s.done()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    scenes = [
        ("block-resize", resize_scene, 9.7),
        ("image-scale", image_scale_scene, 4.7),
        ("manual-ruler", manual_ruler_scene, 9),
        ("multi-combine", combine_scene, 9.6),
    ]
    for name, render, poster_time in scenes:
        poster = render(poster_time)
        poster.save(OUT / f"{name}.png", optimize=True)
        # A shared palette keeps text/selection lines stable between frames.
        sample=Image.new("RGB",(W,H*3))
        for i,t in enumerate([0,4.5,9.5]): sample.paste(render(t),(0,i*H))
        palette=sample.quantize(colors=128,method=Image.Quantize.MEDIANCUT)
        frames=[render(i/FPS).quantize(palette=palette,dither=Image.Dither.NONE) for i in range(FPS*SECONDS)]
        path=OUT/f"{name}.gif"
        frames[0].save(path,save_all=True,append_images=frames[1:],duration=1000//FPS,loop=0,optimize=True,disposal=1)
        with Image.open(path) as gif:
            duration=0
            for i in range(gif.n_frames):
                gif.seek(i);duration+=gif.info.get("duration",0)
            print(f"{name}: {gif.size}, {gif.n_frames} frames, {duration/1000:.1f}s, {path.stat().st_size/1024:.0f} KiB")


if __name__ == "__main__":
    main()
