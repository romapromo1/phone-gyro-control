from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "tricolor_football"
W, H = 4096, 2048


def normalize(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def hash_noise(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    n = np.sin(x * 127.1 + y * 311.7) * 43758.5453123
    return n - np.floor(n)


def tangent_frames(centers: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    up = np.array([0.0, 0.0, 1.0], dtype=np.float32)
    alt = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    us, vs = [], []
    for c in centers:
        ref = alt if abs(float(np.dot(c, up))) > 0.86 else up
        u = np.cross(ref, c)
        u /= np.linalg.norm(u)
        v = np.cross(c, u)
        v /= np.linalg.norm(v)
        us.append(u)
        vs.append(v)
    return np.asarray(us, np.float32), np.asarray(vs, np.float32)


def make_swirl_centers() -> np.ndarray:
    # Four tetrahedral directions create four broad vortex fields around the
    # ball. Each field will contain a red, green and blue spiral lobe, so the
    # visible construction reads as a four-panel pinwheel instead of a football
    # made from pentagons and hexagons.
    centers = np.asarray(
        [(1.0, 1.0, 1.0), (1.0, -1.0, -1.0), (-1.0, 1.0, -1.0), (-1.0, -1.0, 1.0)],
        dtype=np.float32,
    )
    centers = normalize(centers)

    # Rotate the panel arrangement so a red, green and blue group is visible
    # together in the default three-quarter product view.
    ax, ay, az = np.radians([18.0, -11.0, 23.0])
    rx = np.array([[1, 0, 0], [0, np.cos(ax), -np.sin(ax)], [0, np.sin(ax), np.cos(ax)]])
    ry = np.array([[np.cos(ay), 0, np.sin(ay)], [0, 1, 0], [-np.sin(ay), 0, np.cos(ay)]])
    rz = np.array([[np.cos(az), -np.sin(az), 0], [np.sin(az), np.cos(az), 0], [0, 0, 1]])
    return (centers @ (rz @ ry @ rx).T).astype(np.float32)


def star_mask(x: np.ndarray, y: np.ndarray, radius: float = 0.16) -> np.ndarray:
    angle = np.arctan2(y, x)
    r = np.sqrt(x * x + y * y)
    sector_width = math.pi / 5.0
    a = np.mod(angle + math.pi / 2.0, 2.0 * math.pi)
    sector = np.floor(a / sector_width).astype(np.int32)
    t = np.mod(a, sector_width) / sector_width
    r1 = np.where(sector % 2 == 0, radius, radius * 0.43)
    r2 = np.where(sector % 2 == 0, radius * 0.43, radius)
    boundary = r1 * (1.0 - t) + r2 * t
    return r < boundary


def build() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    lon = np.linspace(-math.pi, math.pi, W, endpoint=False, dtype=np.float32)
    lat = np.linspace(math.pi / 2, -math.pi / 2, H, dtype=np.float32)
    lon_grid, lat_grid = np.meshgrid(lon, lat)
    cos_lat = np.cos(lat_grid)
    points = np.stack(
        [cos_lat * np.cos(lon_grid), cos_lat * np.sin(lon_grid), np.sin(lat_grid)], axis=-1
    ).astype(np.float32)

    centers = make_swirl_centers()
    tangent_u, tangent_v = tangent_frames(centers)

    dots = points.reshape(-1, 3) @ centers.T
    nearest = np.argmax(dots, axis=1)
    best = dots[np.arange(dots.shape[0]), nearest]
    dots[np.arange(dots.shape[0]), nearest] = -10.0
    second = np.max(dots, axis=1)
    gap = (best - second).reshape(H, W)
    nearest = nearest.reshape(H, W)
    best = best.reshape(H, W)

    chosen_u = tangent_u[nearest]
    chosen_v = tangent_v[nearest]
    tx = np.sum(points * chosen_u, axis=-1)
    ty = np.sum(points * chosen_v, axis=-1)
    theta = np.arctan2(ty, tx)
    radial = np.arccos(np.clip(best, -1.0, 1.0))

    phase_per_panel = np.array([0.18, 1.34, 2.72, 4.22], np.float32)
    phase = phase_per_panel[nearest]

    # Three sectors rotate continuously with radius. Their boundaries therefore
    # become long spiral ribbons meeting at the vortex centre.
    sector_width = 2.0 * math.pi / 3.0
    spiral_angle = np.mod(theta + 2.55 * radial + phase + 0.16 * np.sin(3.0 * theta), 2.0 * math.pi)
    sector = np.floor(spiral_angle / sector_width).astype(np.int32)
    within_sector = np.mod(spiral_angle, sector_width)
    distance_to_ribbon = np.minimum(within_sector, sector_width - within_sector)

    outer_inset = smoothstep(0.070, 0.165, gap)
    ribbon_half_width = 0.175 + 0.055 * np.sin(3.0 * theta - 1.8 * radial + phase)
    away_from_ribbon = smoothstep(ribbon_half_width, ribbon_half_width + 0.125, distance_to_ribbon)
    centre_opening = smoothstep(0.030, 0.115, radial)
    core = outer_inset * away_from_ribbon * centre_opening

    # A narrow colour pinstripe sits just outside each broad white spiral.
    accent = (
        smoothstep(ribbon_half_width - 0.050, ribbon_half_width - 0.025, distance_to_ribbon)
        * (1.0 - smoothstep(ribbon_half_width + 0.025, ribbon_half_width + 0.060, distance_to_ribbon))
        * outer_inset
    )
    outer_seam = 1.0 - smoothstep(0.012, 0.034, gap)
    inner_seam = (1.0 - smoothstep(0.018, 0.052, distance_to_ribbon)) * outer_inset
    seam = np.maximum(outer_seam, inner_seam)

    white = np.array([0.925, 0.935, 0.925], dtype=np.float32)
    red = np.array([0.82, 0.027, 0.035], dtype=np.float32)
    green = np.array([0.01, 0.38, 0.18], dtype=np.float32)
    blue = np.array([0.015, 0.31, 0.72], dtype=np.float32)
    palette = np.stack([red, green, blue], axis=0)
    # Each vortex always carries all three colours. Adjacent vortex fields rotate
    # the order so matching colours do not form a regular tiled grid.
    colour_offsets = np.array([0, 2, 1, 0], dtype=np.int32)
    colour_index = np.mod(sector + colour_offsets[nearest], 3)
    base_colour = palette[colour_index]

    # Panel gradients, dark outer edges, and subtle printed wear.
    center_light = np.clip(1.14 - 0.62 * radial, 0.58, 1.12)
    noise = hash_noise(lon_grid * 49.0, lat_grid * 53.0)
    fine_noise = hash_noise(lon_grid * 401.0, lat_grid * 397.0)
    coloured = base_colour * center_light[..., None]
    coloured *= (0.94 + 0.07 * noise[..., None])
    speckle = (fine_noise > 0.965) & (core > 0.7)
    coloured[speckle] = coloured[speckle] * 0.62 + white * 0.18

    image = np.broadcast_to(white, (H, W, 3)).copy()
    image *= (0.985 + 0.018 * noise[..., None])
    image = image * (1.0 - core[..., None]) + coloured * core[..., None]

    accent_colour = np.clip(base_colour * 0.86 + 0.07, 0.0, 1.0)
    image = image * (1.0 - accent[..., None]) + accent_colour * accent[..., None]

    # Layered circuit/chevron linework follows the panel-local polar field.
    contour_field = radial * 22.0 + 0.62 * np.sin(3.0 * spiral_angle) + 0.18 * np.sin(6.0 * theta - phase)
    contour = np.abs((contour_field - np.floor(contour_field)) - 0.5) < 0.047
    contour &= core > 0.70
    contour_colour = np.clip(coloured * 0.45 + 0.20, 0.0, 1.0)
    image[contour] = contour_colour[contour]

    # Fine directional hatching gives the printed panels the technical texture
    # seen in the supplied photographs.
    hatch_field = tx * 90.0 + ty * 28.0 + 2.0 * np.sin(theta * 2.0)
    hatch = np.abs((hatch_field - np.floor(hatch_field)) - 0.5) < 0.030
    hatch &= core > 0.78
    image[hatch] = np.clip(image[hatch] * 1.28 + 0.05, 0.0, 1.0)

    # Thin white sweep inside each coloured area.
    sweep = np.abs(distance_to_ribbon - (0.55 + 0.045 * np.sin(5.0 * radial - phase))) < 0.010
    sweep &= core > 0.78
    image[sweep] = np.array([0.89, 0.93, 0.94], np.float32)

    # Small star clusters echo the blue reference fields. There are deliberately
    # no three-stripe marks or other brand logos.
    local_scale = 2.25
    mx = tx * local_scale
    my = ty * local_scale
    ca, sa = np.cos(phase), np.sin(phase)
    rxp = mx * ca - my * sa
    ryp = mx * sa + my * ca
    blue_panels = colour_index == 2
    stars = (
        star_mask(rxp + 0.17, ryp - 0.01, radius=0.080)
        | star_mask(rxp - 0.12, ryp + 0.14, radius=0.060)
        | star_mask(rxp - 0.17, ryp - 0.15, radius=0.050)
    )
    stars &= blue_panels & (core > 0.90)
    image[stars] = np.array([0.49, 0.83, 0.96], np.float32)

    # Dark, shallow actual seam line; the broad surrounding field stays white.
    seam_colour = np.array([0.56, 0.59, 0.57], np.float32)
    image = image * (1.0 - 0.42 * seam[..., None]) + seam_colour * (0.42 * seam[..., None])

    # Height is neutral on the shell, slightly proud on panels, and recessed at seams.
    height = 0.50 + 0.12 * core - 0.38 * seam
    height += 0.012 * np.sin(contour_field * 2.0 * math.pi) * core
    height = np.clip(height, 0.04, 0.68)

    # Tangent-space normal map derived from the wrap-safe height field.
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    dy = np.empty_like(height)
    dy[1:-1] = (height[2:] - height[:-2]) * 0.5
    dy[0] = height[1] - height[0]
    dy[-1] = height[-1] - height[-2]
    normal_strength = 18.0
    nx = -dx * normal_strength
    ny = dy * normal_strength
    nz = np.ones_like(height)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([nx * inv_len, ny * inv_len, nz * inv_len], axis=-1)
    normal = normal * 0.5 + 0.5

    roughness = 0.48 + 0.16 * (1.0 - core) + 0.12 * seam
    roughness -= 0.08 * speckle.astype(np.float32)
    roughness = np.clip(roughness, 0.30, 0.82)

    base_image = Image.fromarray(np.uint8(np.clip(image, 0, 1) * 255), "RGB")
    height_image = Image.fromarray(np.uint8(height * 255), "L")
    normal_image = Image.fromarray(np.uint8(np.clip(normal, 0, 1) * 255), "RGB")
    roughness_image = Image.fromarray(np.uint8(roughness * 255), "L")
    generated = {
        "tricolor_ball_basecolor.png": base_image,
        "tricolor_ball_height.png": height_image,
        "tricolor_ball_normal.png": normal_image,
        "tricolor_ball_roughness.png": roughness_image,
    }
    for filename, generated_image in generated.items():
        generated_image.save(OUT / filename, compress_level=5)

    # Web build: enough resolution for an on-screen ball while keeping the GLB
    # compact and cheap to upload to the GPU.
    web_out = ROOT / "artifacts" / "tricolor_football_lowpoly"
    web_out.mkdir(parents=True, exist_ok=True)
    for filename, generated_image in generated.items():
        generated_image.resize((1024, 512), Image.Resampling.LANCZOS).save(
            web_out / filename, compress_level=8, optimize=True
        )

    print(f"Textures written to {OUT}")
    print(f"Web textures written to {web_out}")


if __name__ == "__main__":
    build()
