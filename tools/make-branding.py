#!/usr/bin/env python3
"""
make-branding.py
===============================================================================
'은월(Eunwol)' 런처의 브랜드 이미지를 생성합니다.

    python tools/make-branding.py            아이콘 + 로딩 씰 + 배경 전부 생성
    python tools/make-branding.py --seal     씰/아이콘만 다시 생성
    python tools/make-branding.py --bg       배경만 다시 생성

생성 파일:
    app/assets/images/SealCircle.png     창/작업표시줄 아이콘 (512x512)
    app/assets/images/SealCircle.ico     Windows 아이콘 (다중 크기)
    app/assets/images/LoadingSeal.png    로딩 화면 씰 (512x512, 투명)
    app/assets/images/backgrounds/0.jpg  런처 배경 (1920x1080)
    build/icon.png                       설치 파일/바탕화면 아이콘 (512x512)

색: 은백색(#eceffc) · 청회색(#8fa8c4) · 심해색(#070b14 / #16233a)
===============================================================================
"""

import argparse
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES_DIR = os.path.join(ROOT, 'app', 'assets', 'images')
BACKGROUNDS_DIR = os.path.join(IMAGES_DIR, 'backgrounds')
BUILD_DIR = os.path.join(ROOT, 'build')

SS = 4  # 슈퍼샘플 배율


# -----------------------------------------------------------------------------
# 공통 유틸
# -----------------------------------------------------------------------------

def radial_layer(size, center, radius, stops, supersample=SS):
    """원형 방사형 그라데이션을 ARGB 이미지로 만든다.

    stops: [(offset 0..1, (r,g,b,a)), ...] 오프셋 오름차순.
    """
    s = size * supersample
    yy, xx = np.mgrid[0:s, 0:s].astype(np.float32)
    cx, cy = center[0] * supersample, center[1] * supersample
    rr = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / (radius * supersample)
    rr = np.clip(rr, 0.0, 1.0)

    out = np.zeros((s, s, 4), dtype=np.float32)
    for i in range(len(stops) - 1):
        o0, c0 = stops[i]
        o1, c1 = stops[i + 1]
        mask = (rr >= o0) & (rr <= o1)
        if not np.any(mask):
            continue
        t = np.zeros_like(rr)
        t[mask] = (rr[mask] - o0) / max(o1 - o0, 1e-6)
        for ch in range(4):
            out[..., ch][mask] = c0[ch] + (c1[ch] - c0[ch]) * t[mask]

    out[..., 3] *= (rr < 1.0)
    img = Image.fromarray(out.clip(0, 255).astype(np.uint8), 'RGBA')
    if supersample != 1:
        img = img.resize((size, size), Image.LANCZOS)
    return img


def add_glow(base, mask_img, color, radius, strength=1.0):
    """mask_img(알파)를 color로 물들여 블러시킨 뒤 base 위에 더한다."""
    glow = Image.new('RGBA', base.size, (0, 0, 0, 0))
    glow.paste(color + (255,), (0, 0), mask_img)
    glow = glow.filter(ImageFilter.GaussianBlur(radius))
    if strength != 1.0:
        alpha = glow.getchannel('A').point(lambda v: int(v * strength))
        glow.putalpha(alpha)
    return Image.alpha_composite(base, glow)


# -----------------------------------------------------------------------------
# 씰 (아이콘)
# -----------------------------------------------------------------------------

def build_seal(size=512, glow=True):
    """은월 씰: 심해 원반 + 은색 이중 링 + 초승달 + 별."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    c = size / 2.0

    # 바깥 은은한 후광
    if glow:
        halo = radial_layer(size, (c, c), c, [
            (0.00, (176, 202, 236, 70)),
            (0.72, (120, 152, 200, 34)),
            (1.00, (0, 0, 0, 0)),
        ])
        img = Image.alpha_composite(img, halo)

    # 원반 (원형 마스크로 잘라 가장자리가 잘리지 않게 한다)
    disc_r = c * 0.945
    disc_mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(disc_mask).ellipse(
        [c - disc_r, c - disc_r, c + disc_r, c + disc_r], fill=255)
    disc_grad = radial_layer(size, (c - size * 0.10, c - size * 0.12), c * 1.35, [
        (0.00, (52, 76, 116, 255)),
        (0.35, (28, 44, 71, 255)),
        (0.72, (14, 21, 35, 255)),
        (1.00, (5, 8, 14, 255)),
    ])
    disc = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    disc.paste(disc_grad, (0, 0), disc_mask)
    img = Image.alpha_composite(img, disc)

    draw = ImageDraw.Draw(img)

    # 이중 링
    ring_r = c * 0.895
    draw.ellipse([c - ring_r, c - ring_r, c + ring_r, c + ring_r],
                 outline=(226, 238, 250, 205), width=max(2, size // 190))
    inner_r = c * 0.845
    draw.ellipse([c - inner_r, c - inner_r, c + inner_r, c + inner_r],
                 outline=(150, 175, 205, 110), width=max(1, size // 420))

    # 별 (링 안쪽, 달 주변)
    rng = random.Random(1207)
    for _ in range(46):
        ang = rng.uniform(0, math.tau)
        rad = rng.uniform(0.32, 0.80) * size * 0.5
        x = c + math.cos(ang) * rad
        y = c + math.sin(ang) * rad
        r = rng.uniform(0.6, 1.9) * (size / 512.0)
        a = rng.randint(70, 210)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(226, 238, 252, a))

    # 초승달: 큰 원 - 살짝 비껴간 원
    moon_r = size * 0.235
    mx, my = c - size * 0.035, c - size * 0.02
    mask = Image.new('L', (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([mx - moon_r, my - moon_r, mx + moon_r, my + moon_r], fill=255)
    off = size * 0.075
    cut_r = moon_r * 0.965
    md.ellipse([mx + off - cut_r, my - off * 0.72 - cut_r,
                mx + off + cut_r, my - off * 0.72 + cut_r], fill=0)

    # 달 본체 (은백색 그라데이션을 마스크로 잘라냄)
    moon_grad = radial_layer(size, (mx - moon_r * 0.35, my - moon_r * 0.35), moon_r * 1.6, [
        (0.00, (255, 255, 255, 255)),
        (0.45, (232, 241, 252, 255)),
        (0.80, (186, 205, 230, 255)),
        (1.00, (150, 174, 205, 255)),
    ])
    moon_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    moon_layer.paste(moon_grad, (0, 0), mask)
    img = Image.alpha_composite(img, moon_layer)

    # 달 후광
    if glow:
        glow_mask = Image.new('L', (size, size), 0)
        glow_mask.paste(mask, (0, 0))
        glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(size * 0.045))
        halo2 = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        halo2.paste((210, 228, 250, 255), (0, 0), glow_mask)
        alpha = halo2.getchannel('A').point(lambda v: int(v * 0.5))
        halo2.putalpha(alpha)
        img = Image.alpha_composite(img, halo2)

    return img


def save_ico(img, path, sizes=(16, 24, 32, 48, 64, 128, 256)):
    base = img.resize((256, 256), Image.LANCZOS)
    base.save(path, format='ICO', sizes=[(s, s) for s in sizes])


# -----------------------------------------------------------------------------
# 배경
# -----------------------------------------------------------------------------

def build_background(w=1920, h=1080):
    # 밤하늘 그라데이션 (위는 거의 검정, 지평선 근처는 푸른 밤)
    grad = np.zeros((h, w, 3), dtype=np.float32)
    stops = [
        (0.00, (4, 6, 13)),
        (0.42, (10, 16, 30)),
        (0.68, (23, 36, 58)),
        (1.00, (33, 48, 72)),
    ]
    y = np.linspace(0, 1, h, dtype=np.float32)
    for ch in range(3):
        col = np.zeros(h, dtype=np.float32)
        for i in range(len(stops) - 1):
            o0, c0 = stops[i]
            o1, c1 = stops[i + 1]
            m = (y >= o0) & (y <= o1)
            t = np.zeros_like(y)
            t[m] = (y[m] - o0) / (o1 - o0)
            col[m] = c0[ch] + (c1[ch] - c0[ch]) * t[m]
        grad[..., ch] = col[:, None]
    bg = Image.fromarray(grad.clip(0, 255).astype(np.uint8), 'RGB').convert('RGBA')

    rng = np.random.default_rng(20261106)

    # 별
    stars = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stars)
    n = 900
    xs = rng.uniform(0, w, n)
    ys = rng.uniform(0, h * 0.86, n)
    sizes = rng.choice([0.7, 0.9, 1.1, 1.4, 1.8, 2.2], n, p=[0.30, 0.26, 0.18, 0.13, 0.08, 0.05])
    alphas = rng.integers(45, 235, n)
    for x, y2, s, a in zip(xs, ys, sizes, alphas):
        sd.ellipse([x - s, y2 - s, x + s, y2 + s], fill=(226, 238, 252, int(a)))

    # 밝은 별 몇 개는 십자 광선
    for _ in range(14):
        x, y2 = rng.uniform(120, w - 120), rng.uniform(60, h * 0.62)
        a = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(a)
        d.line([x - 16, y2, x + 16, y2], fill=(226, 238, 252, 55), width=1)
        d.line([x, y2 - 16, x, y2 + 16], fill=(226, 238, 252, 55), width=1)
        a = a.filter(ImageFilter.GaussianBlur(0.8))
        stars = Image.alpha_composite(stars, a)

    stars = stars.filter(ImageFilter.GaussianBlur(0.4))
    bg = Image.alpha_composite(bg, stars)

    # 달 (오른쪽 위)
    mx, my, mr = w * 0.635, h * 0.285, h * 0.122

    glow = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for radius, alpha in ((mr * 3.6, 22), (mr * 2.4, 36), (mr * 1.6, 60), (mr * 1.12, 92)):
        gd.ellipse([mx - radius, my - radius, mx + radius, my + radius],
                   fill=(186, 208, 238, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(h * 0.035))
    bg = Image.alpha_composite(bg, glow)

    moon_size = int(mr * 2.4)
    moon = radial_layer(moon_size, (moon_size / 2 - 6, moon_size / 2 - 6), mr * 1.08, [
        (0.00, (251, 253, 255, 255)),
        (0.50, (242, 247, 254, 255)),
        (0.78, (216, 229, 247, 255)),
        (0.92, (188, 206, 232, 255)),
        (1.00, (156, 178, 213, 255)),
    ])
    bg.paste(moon, (int(mx - moon_size / 2), int(my - moon_size / 2)), moon)

    # 달 표면 결 (아주 옅게)
    craters = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(craters)
    for _ in range(26):
        ang = rng.uniform(0, math.tau)
        rad = rng.uniform(0, mr * 0.82)
        cx, cy = mx + math.cos(ang) * rad, my + math.sin(ang) * rad
        rr = rng.uniform(mr * 0.03, mr * 0.11)
        cd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(150, 172, 202, int(rng.integers(8, 20))))
    craters = craters.filter(ImageFilter.GaussianBlur(6))
    bg = Image.alpha_composite(bg, craters)

    # 구름 띠
    clouds = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    cld = ImageDraw.Draw(clouds)
    for _ in range(26):
        cw = rng.uniform(w * 0.18, w * 0.55)
        chh = rng.uniform(h * 0.012, h * 0.045)
        cx = rng.uniform(-w * 0.1, w)
        cy = rng.uniform(h * 0.18, h * 0.72)
        cld.ellipse([cx, cy, cx + cw, cy + chh],
                    fill=(176, 198, 228, int(rng.integers(6, 20))))
    clouds = clouds.filter(ImageFilter.GaussianBlur(22))
    bg = Image.alpha_composite(bg, clouds)

    # 언덕 실루엣 (아래)
    hills = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hills)
    xs = np.arange(w)
    base = h * 0.815
    wave = (np.sin(xs / w * 7.2 + 0.6) * 0.022
            + np.sin(xs / w * 3.1 + 2.2) * 0.030
            + np.sin(xs / w * 13.0 + 1.1) * 0.008)
    ys = base + wave * h
    hd.polygon([(0, h)] + list(zip(xs.tolist(), ys.tolist())) + [(w, h)], fill=(6, 10, 18, 255))

    # 능선 하이라이트
    for i in range(w - 1):
        a = int(26 + 16 * math.sin(i / w * 9.0))
        hd.line([(i, float(ys[i])), (i + 1, float(ys[i + 1]))], fill=(120, 150, 190, a), width=2)
    hills = hills.filter(ImageFilter.GaussianBlur(0.6))
    bg = Image.alpha_composite(bg, hills)

    # 두 번째 능선 (조금 더 앞, 어둡게)
    hills2 = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    hd2 = ImageDraw.Draw(hills2)
    base2 = h * 0.885
    wave2 = (np.sin(xs / w * 4.6 + 3.4) * 0.020
             + np.sin(xs / w * 9.3 + 0.2) * 0.010)
    ys2 = base2 + wave2 * h
    hd2.polygon([(0, h)] + list(zip(xs.tolist(), ys2.tolist())) + [(w, h)], fill=(3, 6, 11, 255))
    bg = Image.alpha_composite(bg, hills2)

    # 비네트
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx = (xx - w / 2) / (w / 2)
    ny = (yy - h / 2) / (h / 2)
    r = np.sqrt(nx ** 2 * 0.62 + ny ** 2)
    vig = np.clip((r - 0.55) / 0.85, 0, 1) ** 1.6
    arr = np.asarray(bg.convert('RGB')).astype(np.float32)
    arr *= (1.0 - vig[..., None] * 0.55)
    bg = Image.fromarray(arr.clip(0, 255).astype(np.uint8), 'RGB')

    # 미세한 그레인
    noise = rng.normal(0, 2.1, (h, w, 3))
    arr = np.asarray(bg).astype(np.float32) + noise
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8), 'RGB')


# -----------------------------------------------------------------------------
# 메인
# -----------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seal', action='store_true', help='씰/아이콘만 생성')
    ap.add_argument('--bg', action='store_true', help='배경만 생성')
    args = ap.parse_args()
    everything = not (args.seal or args.bg)

    os.makedirs(IMAGES_DIR, exist_ok=True)
    os.makedirs(BACKGROUNDS_DIR, exist_ok=True)
    os.makedirs(BUILD_DIR, exist_ok=True)

    if everything or args.seal:
        print('씰 생성 중..')
        seal = build_seal(512)
        seal.save(os.path.join(IMAGES_DIR, 'SealCircle.png'))
        seal.save(os.path.join(IMAGES_DIR, 'LoadingSeal.png'))
        seal.save(os.path.join(BUILD_DIR, 'icon.png'))
        seal.save(os.path.join(IMAGES_DIR, 'SealCircle.ico'), format='ICO',
                  sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
        print('  SealCircle.png / LoadingSeal.png / SealCircle.ico / build/icon.png')

    if everything or args.bg:
        print('배경 생성 중..')
        bg = build_background(1920, 1080)
        bg.save(os.path.join(BACKGROUNDS_DIR, '0.jpg'), quality=92, optimize=True)
        print('  backgrounds/0.jpg')

    print('완료.')


if __name__ == '__main__':
    main()
