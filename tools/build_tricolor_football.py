from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
LOW_POLY = "--lowpoly" in sys.argv
OUT = ROOT / "artifacts" / ("tricolor_football_lowpoly" if LOW_POLY else "tricolor_football")
BASE = OUT / "tricolor_ball_basecolor.png"
HEIGHT = OUT / "tricolor_ball_height.png"
NORMAL = OUT / "tricolor_ball_normal.png"
ROUGHNESS = OUT / "tricolor_ball_roughness.png"
ASSET_NAME = "tricolor_football_lowpoly" if LOW_POLY else "tricolor_football"
FBX = OUT / f"{ASSET_NAME}.fbx"
GLB = OUT / f"{ASSET_NAME}.glb"
BLEND = OUT / f"{ASSET_NAME}_source.blend"
PREVIEW = OUT / f"{ASSET_NAME}_preview.png"
RADIUS = 0.11


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def load_image(path: Path, non_color: bool = False) -> bpy.types.Image:
    image = bpy.data.images.load(str(path), check_existing=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    return image


def create_material() -> bpy.types.Material:
    mat = bpy.data.materials.new("Tricolor_Football_Material")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (700, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (410, 0)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.56
    bsdf.inputs["IOR"].default_value = 1.46
    bsdf.inputs["Coat Weight"].default_value = 0.18
    bsdf.inputs["Coat Roughness"].default_value = 0.24
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    tex_base = nodes.new("ShaderNodeTexImage")
    tex_base.name = "BaseColor_Texture"
    tex_base.label = "Embedded Base Color"
    tex_base.location = (-430, 170)
    tex_base.image = load_image(BASE)
    tex_base.interpolation = "Linear"
    links.new(tex_base.outputs["Color"], bsdf.inputs["Base Color"])

    tex_rough = nodes.new("ShaderNodeTexImage")
    tex_rough.name = "Roughness_Texture"
    tex_rough.label = "Embedded Roughness"
    tex_rough.location = (-430, -40)
    tex_rough.image = load_image(ROUGHNESS, non_color=True)
    tex_rough.interpolation = "Linear"
    links.new(tex_rough.outputs["Color"], bsdf.inputs["Roughness"])

    tex_normal = nodes.new("ShaderNodeTexImage")
    tex_normal.name = "Normal_Texture"
    tex_normal.label = "Embedded Normal"
    tex_normal.location = (-430, -250)
    tex_normal.image = load_image(NORMAL, non_color=True)
    tex_normal.interpolation = "Linear"
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (80, -230)
    normal_map.inputs["Strength"].default_value = 0.65
    links.new(tex_normal.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def create_ball() -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=64 if LOW_POLY else 256,
        ring_count=32 if LOW_POLY else 128,
        radius=RADIUS,
        location=(0.0, 0.0, 0.0),
    )
    ball = bpy.context.active_object
    ball.name = "Tricolor_Football"
    ball.data.name = "Tricolor_Football_Mesh"
    for polygon in ball.data.polygons:
        polygon.use_smooth = True

    ball.data.materials.append(create_material())

    height_image = load_image(HEIGHT, non_color=True)
    displacement_texture = bpy.data.textures.new("Panel_Seam_Height", type="IMAGE")
    displacement_texture.image = height_image
    displacement = ball.modifiers.new("Embossed_Panels_And_Seams", "DISPLACE")
    displacement.texture = displacement_texture
    displacement.texture_coords = "UV"
    displacement.direction = "NORMAL"
    displacement.mid_level = 0.50
    displacement.strength = 0.0028 if LOW_POLY else 0.0034
    bpy.context.view_layer.objects.active = ball
    bpy.ops.object.modifier_apply(modifier=displacement.name)

    # Small, separate valve detail on a green/white transition area.
    valve_direction = Vector((0.67, -0.72, 0.18)).normalized()
    valve_position = valve_direction * (RADIUS + 0.0010)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=16 if LOW_POLY else 48,
        radius=0.0030,
        depth=0.00115,
        location=valve_position,
    )
    valve = bpy.context.active_object
    valve.name = "Valve_Ring"
    valve.rotation_euler = valve_direction.to_track_quat("Z", "Y").to_euler()
    valve_mat = bpy.data.materials.new("Valve_Red_Rubber")
    valve_mat.diffuse_color = (0.54, 0.012, 0.016, 1.0)
    valve_mat.use_nodes = True
    valve_bsdf = valve_mat.node_tree.nodes.get("Principled BSDF")
    valve_bsdf.inputs["Base Color"].default_value = (0.54, 0.012, 0.016, 1.0)
    valve_bsdf.inputs["Roughness"].default_value = 0.36
    valve.data.materials.append(valve_mat)

    hole_position = valve_direction * (RADIUS + 0.00165)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=12 if LOW_POLY else 32,
        radius=0.00115,
        depth=0.00125,
        location=hole_position,
    )
    hole = bpy.context.active_object
    hole.name = "Valve_Hole"
    hole.rotation_euler = valve.rotation_euler
    hole_mat = bpy.data.materials.new("Valve_Hole_Dark")
    hole_mat.diffuse_color = (0.008, 0.006, 0.006, 1.0)
    hole.data.materials.append(hole_mat)

    bpy.context.view_layer.objects.active = ball
    ball.select_set(True)
    return ball


def add_studio() -> None:
    bpy.ops.mesh.primitive_plane_add(size=2.0, location=(0.0, 0.0, -RADIUS - 0.005))
    ground = bpy.context.active_object
    ground.name = "Preview_Ground"
    mat = bpy.data.materials.new("Preview_Ground_Material")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.115, 0.125, 0.145, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.72
    ground.data.materials.append(mat)

    world = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.025, 0.030, 0.044, 1.0)
    bg.inputs["Strength"].default_value = 0.18

    lights = [
        ((-0.38, -0.42, 0.48), 28.0, 0.34, (1.0, 0.91, 0.82)),
        ((0.44, -0.12, 0.27), 20.0, 0.28, (0.62, 0.78, 1.0)),
        ((0.08, 0.35, 0.40), 35.0, 0.25, (1.0, 0.35, 0.28)),
    ]
    for i, (location, power, size, colour) in enumerate(lights):
        data = bpy.data.lights.new(f"Studio_Light_{i + 1}", type="AREA")
        data.energy = power
        data.shape = "DISK"
        data.size = size
        data.color = colour
        obj = bpy.data.objects.new(data.name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = location
        look_at(obj, Vector((0.0, 0.0, 0.0)))

    camera_data = bpy.data.cameras.new("Preview_Camera")
    camera = bpy.data.objects.new("Preview_Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    # Face the lower-front tetrahedral vortex so the three interlocking curved
    # lobes are immediately visible in the product preview.
    camera.location = (-0.16, -0.485, 0.175)
    camera_data.lens = 57
    look_at(camera, Vector((0.0, 0.0, 0.005)))
    bpy.context.scene.camera = camera


def export_and_render() -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(PREVIEW)
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.look = "AgX - Medium High Contrast"

    # Keep studio-only objects out of the deliverable FBX.
    export_names = {"Tricolor_Football", "Valve_Ring", "Valve_Hole"}
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.context.scene.objects:
        if obj.name in export_names:
            obj.select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects["Tricolor_Football"]
    bpy.ops.export_scene.fbx(
        filepath=str(FBX),
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

    if LOW_POLY:
        bpy.ops.export_scene.gltf(
            filepath=str(GLB),
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_texcoords=True,
            export_normals=True,
            export_materials="EXPORT",
            export_image_format="AUTO",
            export_yup=True,
            export_animations=False,
        )

    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    bpy.ops.render.render(write_still=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for required in (BASE, HEIGHT, NORMAL, ROUGHNESS):
        if not required.exists():
            raise FileNotFoundError(f"Missing texture: {required}")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)
    create_ball()
    add_studio()
    export_and_render()
    print(f"FBX: {FBX}")
    if LOW_POLY:
        print(f"GLB: {GLB}")
    print(f"BLEND: {BLEND}")
    print(f"PREVIEW: {PREVIEW}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"BUILD FAILED: {exc}", file=sys.stderr)
        raise
