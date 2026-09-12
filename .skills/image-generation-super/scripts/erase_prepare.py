#!/usr/bin/env python3
"""
Step 1 of the erase workflow (LOCAL ONLY, no network calls).

Preprocess the original image with its erase mask so that the image-edit model
sees exactly which area to repaint: the mask's WHITE region is painted over with
a flat sentinel color on a copy of the original, so the object/person/text to
erase is physically gone before the model ever sees the image.

Outputs the prepared image plus the exact English prompt and size to pass to
generate_image.py, whose output is the final deliverable. The prepared image is
an intermediate artifact only — by default it is written to a system temp
directory so it never shows up in the user's working directory.

Usage:
    python3 erase_prepare.py --image photo.png --mask photo_mask.png
    python3 erase_prepare.py --image photo.png --mask photo_mask.png \
        --extra-prompt "the red trash bin on the left" --grow 6

Exit codes:
    0 - success, prints one JSON line
    1 - file or argument error
"""

import os
import sys
import json
import tempfile
import argparse

try:
    from PIL import Image, ImageFilter
except ImportError:
    print("Pillow is required. Install it with: pip install Pillow", file=sys.stderr)
    sys.exit(1)


# 哨兵填充色：品红在自然照片中几乎不出现，模型能明确识别"这块是待填补区域"
SENTINEL_FILL = (255, 0, 255)

SUPPORTED_SIZES = ("1024x1024", "1536x1024", "1024x1536", "2848x1152")

PROMPT_TEMPLATE = (
    "This is an inpainting task. The input image contains one solid magenta (RGB 255,0,255) patch. "
    "Return the same image with only that magenta patch replaced. "
    "Fill the patch by continuing the surface it sits on: match that surface's color, texture, "
    "lighting, shadow direction, grain and perspective, and extend only the lines, edges or patterns "
    "that already pass through the patch, so the patch disappears and nothing new takes its "
    "place.{extra} "
    "Everything outside the patch is a strict copy task: reproduce it as-is. "
    "Keep every other text block, number, table, list, logo, icon, label, illustration and graphic "
    "exactly where it is, at the same size, wording and color. Do not delete, move, resize, "
    "re-typeset, re-align or redraw any of them, even if they look decorative, repetitive or "
    "unimportant, and even if removing them would look cleaner. "
    "Do not add any new object, person, animal, text, logo, watermark or decorative pattern. "
    "Do not restyle, re-render, re-light, crop, zoom, mirror, or add a border. "
    "No magenta may remain in the output. "
    "high quality, detailed, photorealistic"
)


def parse_args():
    """解析命令行参数。"""
    p = argparse.ArgumentParser(description="Preprocess an image + erase mask before calling generate_image.py.")
    p.add_argument("--image", required=True, help="原图路径")
    p.add_argument("--mask", required=True, help="擦除区域 mask 路径：白色=擦除，黑色=保留")
    p.add_argument("--workdir", default="",
                   help="中间产物输出目录；默认落在系统临时目录，避免中间图出现在用户工作目录")
    p.add_argument("--extra-prompt", default="", help="可选：英文描述白区里是什么物体，提高擦除准确度")
    p.add_argument("--grow", type=int, default=2,
                   help="白区向外扩张的像素数，覆盖物体边缘残留（默认 2，0 表示不扩张）")
    p.add_argument("--threshold", type=int, default=128,
                   help="mask 二值化阈值，灰度 > 阈值视为白色擦除区（默认 128）")
    p.add_argument("--size", default="",
                   help="上游输出尺寸；默认按原图宽高自动选择最接近的受支持尺寸")
    return p.parse_args()


def fail(message):
    """打印错误信息并以非零状态退出。"""
    print(message, file=sys.stderr)
    sys.exit(1)


def load_mask(mask_path, size, threshold, grow):
    """读取 mask 并归一化为与原图同尺寸的二值 L 通道图（255=擦除区）。"""
    mask = Image.open(mask_path)
    mask.load()
    # 带透明通道的 mask：透明部分视为黑色（保留区），避免 alpha 被丢弃后整图变白
    if mask.mode in ("RGBA", "LA"):
        background = Image.new("RGBA", mask.size, (0, 0, 0, 255))
        mask = Image.alpha_composite(background, mask.convert("RGBA"))
    mask = mask.convert("L")

    if mask.size != size:
        mask = mask.resize(size, Image.NEAREST)

    mask = mask.point(lambda v: 255 if v > threshold else 0, mode="L")

    if grow > 0:
        # MaxFilter 的 kernel size 必须是奇数，grow 像素对应 2*grow+1
        mask = mask.filter(ImageFilter.MaxFilter(2 * grow + 1))

    return mask


def pick_size(width, height, explicit):
    """选择上游输出尺寸：显式指定优先，否则按宽高比选最接近的受支持尺寸。"""
    if explicit:
        return explicit
    ratio = width / height if height else 1.0
    return min(
        SUPPORTED_SIZES,
        key=lambda s: abs((int(s.split("x")[0]) / int(s.split("x")[1])) - ratio),
    )


def main():
    """入口：生成待擦除图 + 擦除 prompt，供 generate_image.py 直接使用。"""
    args = parse_args()

    if not os.path.isfile(args.image):
        fail(f"Image not found: {args.image}")
    if not os.path.isfile(args.mask):
        fail(f"Mask not found: {args.mask}")

    original = Image.open(args.image)
    original.load()
    if original.mode not in ("RGB", "RGBA"):
        original = original.convert("RGB")

    mask = load_mask(args.mask, original.size, args.threshold, args.grow)
    white_pixels = sum(mask.histogram()[1:])
    if white_pixels == 0:
        fail("Mask has no white region — nothing to erase. Check the mask polarity "
             "(white = erase, black = keep).")
    if white_pixels == original.width * original.height:
        fail("Mask is fully white — the whole image would be erased. Check the mask polarity "
             "(white = erase, black = keep).")

    # 中间产物默认写到系统临时目录：prepared 图只是给模型看的输入，不应出现在用户工作目录
    if args.workdir:
        workdir = args.workdir
        os.makedirs(workdir, exist_ok=True)
    else:
        workdir = tempfile.mkdtemp(prefix="erase_")
    stem = os.path.splitext(os.path.basename(args.image))[0]

    # 待擦除图：白区physically填成哨兵色，模型只需填补这块
    prepared = original.copy()
    fill = Image.new(original.mode, original.size,
                     SENTINEL_FILL + ((255,) if original.mode == "RGBA" else ()))
    prepared.paste(fill, (0, 0), mask)
    prepared_path = os.path.join(workdir, f"{stem}_prepared.png")
    prepared.save(prepared_path)

    extra = f" The content removed from that area was: {args.extra_prompt}." if args.extra_prompt else ""
    prompt = PROMPT_TEMPLATE.format(extra=extra)

    print(json.dumps({
        "prepared_image": prepared_path,
        "prompt": prompt,
        "size": pick_size(original.width, original.height, args.size),
        "erase_pixels": white_pixels,
        "original_size": f"{original.width}x{original.height}",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
