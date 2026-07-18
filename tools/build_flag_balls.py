from __future__ import annotations

import math
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
FLAGS_DIR = ROOT / "flags"
OUTPUT_DIR = FLAGS_DIR / "fbx_balls"
RADIUS = 1.0
SEGMENTS = 128
RINGS = 64

FLAGS = (
    ("argentina", FLAGS_DIR / "argentina.jpg"),
    ("england", FLAGS_DIR / "england.webp"),
    ("france", FLAGS_DIR / "france.webp"),
    ("spain", FLAGS_DIR / "spain.jpg"),
)

# These source images are wider than they are tall, but the requested front
# projection is a circle. A centered square crop preserves round emblems and
# equal cross-arm thickness instead of squeezing the source horizontally.
SQUARE_FRONT_CROP = {"argentina", "england"}

# The front carries the emblem/cross. The back uses a narrow, detail-free strip
# from the same flag so a side view does not reveal a second compressed emblem.
FRONT_DETAIL_ONLY = {"argentina", "england"}


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def clear_scene(remove_orphans: bool = False) -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    if not remove_orphans:
        return

    datablock_groups = (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    )
    for datablocks in datablock_groups:
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)
    for image in list(bpy.data.images):
        if image.users == 0 and image.name not in {"Render Result", "Viewer Node"}:
            bpy.data.images.remove(image)


def convert_texture_to_png(slug: str, source_path: Path) -> bpy.types.Image:
    if not source_path.exists():
        raise FileNotFoundError(f"Missing flag image: {source_path}")

    output_path = OUTPUT_DIR / f"{slug}_basecolor.png"
    image = bpy.data.images.load(str(source_path), check_existing=False)
    image.name = f"{slug.title()}_Flag_BaseColor"
    image.colorspace_settings.name = "sRGB"
    # Blender lazily decodes file-backed images. Force that decode before
    # changing filepath_raw, otherwise Blender 5 can discard the source buffer.
    _ = image.pixels[0]

    if slug in SQUARE_FRONT_CROP:
        width, height = image.size
        crop_size = min(width, height)
        x_start = (width - crop_size) // 2
        y_start = (height - crop_size) // 2
        source_pixels = np.asarray(image.pixels[:], dtype=np.float32).reshape((height, width, 4))
        cropped_pixels = np.ascontiguousarray(
            source_pixels[y_start : y_start + crop_size, x_start : x_start + crop_size, :]
        )
        cropped = bpy.data.images.new(
            f"{slug.title()}_Flag_BaseColor_Square",
            width=crop_size,
            height=crop_size,
            alpha=True,
            float_buffer=False,
        )
        cropped.colorspace_settings.name = "sRGB"
        cropped.pixels.foreach_set(cropped_pixels.ravel())
        cropped.update()
        bpy.data.images.remove(image)
        image = cropped

    image.filepath_raw = str(output_path)
    image.file_format = "PNG"
    image.save()
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError(f"Texture conversion failed: {output_path}")
    return image


def create_material(slug: str, image: bpy.types.Image) -> bpy.types.Material:
    material = bpy.data.materials.new(f"{slug.title()}_Flag_Gloss")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (520, 0)

    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.location = (220, 0)
    principled.inputs["Metallic"].default_value = 0.0
    principled.inputs["Roughness"].default_value = 0.30
    principled.inputs["IOR"].default_value = 1.46
    if "Specular IOR Level" in principled.inputs:
        principled.inputs["Specular IOR Level"].default_value = 0.38
    if "Coat Weight" in principled.inputs:
        principled.inputs["Coat Weight"].default_value = 0.22
    if "Coat Roughness" in principled.inputs:
        principled.inputs["Coat Roughness"].default_value = 0.20

    texture = nodes.new("ShaderNodeTexImage")
    texture.name = "Flag_BaseColor_Texture"
    texture.label = "Embedded Flag Base Color"
    texture.location = (-260, 80)
    texture.image = image
    texture.interpolation = "Linear"
    texture.extension = "EXTEND"

    links.new(texture.outputs["Color"], principled.inputs["Base Color"])
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    return material


def assign_front_back_planar_uv(ball: bpy.types.Object, slug: str) -> None:
    """Map the entire flag to the front in orthographic view.

    Blender's stock sphere UV uses one flag across the full 360 degrees, which
    only exposes half of the flag from the front. This custom map duplicates the
    projection on the back by default. For front-detail-only flags, the back
    instead samples a clean edge strip. Straight flag bands remain straight in
    the requested head-on view without duplicating emblems at the rear.
    """
    mesh = ball.data
    uv_layer = mesh.uv_layers.active or mesh.uv_layers.new(name="Flag_UV")
    uv_layer.name = "Flag_UV"

    for polygon in mesh.polygons:
        center_y = sum(mesh.vertices[index].co.y for index in polygon.vertices) / len(polygon.vertices)
        is_front = center_y <= 0.0
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            u = 0.5 + (vertex.x / (2.0 * RADIUS))
            if not is_front:
                if slug in FRONT_DETAIL_ONLY:
                    # Sample only a slim detail-free vertical strip on the back.
                    # A small range avoids degenerate UV triangles while keeping
                    # Argentina's sun and England's vertical bar front-only.
                    u = 0.10 - (vertex.x / RADIUS) * 0.02
                else:
                    u = 1.0 - u
            v = 0.5 + (vertex.z / (2.0 * RADIUS))
            uv_layer.data[loop_index].uv = (max(0.0, min(1.0, u)), max(0.0, min(1.0, v)))


def create_ball(slug: str, image: bpy.types.Image) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=SEGMENTS,
        ring_count=RINGS,
        radius=RADIUS,
        location=(0.0, 0.0, 0.0),
        rotation=(0.0, 0.0, 0.0),
    )
    ball = bpy.context.active_object
    ball.name = f"{slug.title()}_Flag_Ball"
    ball.data.name = f"{slug.title()}_Flag_Ball_Mesh"
    ball["front_direction"] = "-Y"
    ball["uv_layout"] = "full flag on front; clean continuation on back where configured"

    for polygon in ball.data.polygons:
        polygon.use_smooth = True

    assign_front_back_planar_uv(ball, slug)
    ball.data.materials.append(create_material(slug, image))
    return ball


def export_fbx(ball: bpy.types.Object, output_path: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    ball.select_set(True)
    bpy.context.view_layer.objects.active = ball
    bpy.ops.export_scene.fbx(
        filepath=str(output_path),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_UNITS",
        axis_forward="-Z",
        axis_up="Y",
        mesh_smooth_type="FACE",
        use_mesh_modifiers=True,
        add_leaf_bones=False,
        path_mode="COPY",
        embed_textures=True,
        bake_anim=False,
    )
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError(f"FBX export failed: {output_path}")


def add_preview_studio() -> None:
    world = bpy.context.scene.world or bpy.data.worlds.new("Preview_World")
    bpy.context.scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.16, 0.17, 0.20, 1.0)
    background.inputs["Strength"].default_value = 0.30

    lights = (
        ((-3.2, -4.0, 4.2), 720.0, 3.0, (1.0, 0.95, 0.90)),
        ((3.5, -2.5, 1.2), 480.0, 3.2, (0.78, 0.88, 1.0)),
        ((0.4, 2.8, 3.7), 650.0, 2.4, (1.0, 1.0, 1.0)),
    )
    for index, (location, energy, size, color) in enumerate(lights, start=1):
        light_data = bpy.data.lights.new(f"Preview_Area_{index}", type="AREA")
        light_data.energy = energy
        light_data.shape = "DISK"
        light_data.size = size
        light_data.color = color
        light = bpy.data.objects.new(light_data.name, light_data)
        bpy.context.collection.objects.link(light)
        light.location = location
        look_at(light, Vector((0.0, 0.0, 0.0)))

    camera_data = bpy.data.cameras.new("Front_Preview_Camera")
    camera = bpy.data.objects.new("Front_Preview_Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (0.0, -4.5, 0.0)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 2.24
    look_at(camera, Vector((0.0, 0.0, 0.0)))
    bpy.context.scene.camera = camera


def verify_import_and_render(slug: str, fbx_path: Path, preview_path: Path) -> dict[str, object]:
    clear_scene(remove_orphans=True)
    bpy.ops.import_scene.fbx(filepath=str(fbx_path), use_image_search=True)

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if len(meshes) != 1:
        raise AssertionError(f"{slug}: expected one mesh, got {len(meshes)}")
    ball = meshes[0]
    if len(ball.data.vertices) < 7_000:
        raise AssertionError(f"{slug}: sphere resolution is unexpectedly low")
    if len(ball.data.uv_layers) != 1:
        raise AssertionError(f"{slug}: expected exactly one UV map")
    if len(ball.data.materials) != 1:
        raise AssertionError(f"{slug}: expected exactly one material")

    material = ball.data.materials[0]
    if material is None or not material.use_nodes:
        raise AssertionError(f"{slug}: FBX material did not survive import")
    image_nodes = [node for node in material.node_tree.nodes if node.type == "TEX_IMAGE" and node.image]
    if not image_nodes:
        raise AssertionError(f"{slug}: imported FBX has no image texture")

    uv_values = [loop.uv for loop in ball.data.uv_layers.active.data]
    min_u = min(value.x for value in uv_values)
    max_u = max(value.x for value in uv_values)
    min_v = min(value.y for value in uv_values)
    max_v = max(value.y for value in uv_values)
    if min_u > 0.01 or max_u < 0.99 or min_v > 0.01 or max_v < 0.99:
        raise AssertionError(f"{slug}: UV map does not cover the full texture")

    dimensions = tuple(round(value, 5) for value in ball.dimensions)
    if any(abs(value - 2.0) > 0.01 for value in dimensions):
        raise AssertionError(f"{slug}: unexpected imported dimensions {dimensions}")

    add_preview_studio()
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = str(preview_path)
    scene.view_settings.look = "AgX - Medium High Contrast"
    bpy.ops.render.render(write_still=True)

    if slug in SQUARE_FRONT_CROP:
        camera = bpy.data.objects["Front_Preview_Camera"]
        for side_name, location in (
            ("side_left", (-4.5, 0.0, 0.0)),
            ("side_right", (4.5, 0.0, 0.0)),
        ):
            camera.location = location
            look_at(camera, Vector((0.0, 0.0, 0.0)))
            scene.render.filepath = str(OUTPUT_DIR / f"{slug}_ball_{side_name}_preview.png")
            bpy.ops.render.render(write_still=True)

    return {
        "vertices": len(ball.data.vertices),
        "polygons": len(ball.data.polygons),
        "dimensions": dimensions,
        "uv_range": (round(min_u, 5), round(max_u, 5), round(min_v, 5), round(max_v, 5)),
        "texture": image_nodes[0].image.name,
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    results: dict[str, dict[str, object]] = {}

    for slug, source_path in FLAGS:
        clear_scene(remove_orphans=True)
        image = convert_texture_to_png(slug, source_path)
        ball = create_ball(slug, image)
        fbx_path = OUTPUT_DIR / f"{slug}_ball.fbx"
        preview_path = OUTPUT_DIR / f"{slug}_ball_preview.png"
        export_fbx(ball, fbx_path)
        results[slug] = verify_import_and_render(slug, fbx_path, preview_path)
        print(f"BUILT {slug}: {fbx_path}")

    print("ALL FLAG BALLS BUILT AND VERIFIED")
    for slug, result in results.items():
        print(f"{slug}: {result}")


if __name__ == "__main__":
    main()
