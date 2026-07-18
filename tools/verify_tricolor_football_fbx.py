from pathlib import Path
import sys

import bpy


ROOT = Path(__file__).resolve().parents[1]
LOW_POLY = "--lowpoly" in sys.argv
ASSET_NAME = "tricolor_football_lowpoly" if LOW_POLY else "tricolor_football"
FBX = ROOT / "artifacts" / ASSET_NAME / f"{ASSET_NAME}.fbx"

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.fbx(filepath=str(FBX), use_image_search=True)

meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
assert len(meshes) == 3, f"Expected ball and two valve meshes, got {len(meshes)}"

ball = bpy.data.objects.get("Tricolor_Football")
assert ball is not None, "Main ball mesh is missing"
if LOW_POLY:
    assert 1_500 < len(ball.data.vertices) < 5_000, "Unexpected low-poly vertex count"
else:
    assert len(ball.data.vertices) > 30_000, "The detailed seam geometry was not preserved"
assert len(ball.data.uv_layers) == 1, "Expected one UV map"
assert len(ball.data.materials) == 1, "Expected one ball material"

material = ball.data.materials[0]
image_nodes = [node for node in material.node_tree.nodes if node.type == "TEX_IMAGE"]
assert image_nodes, "No image texture was reconstructed from the FBX"
resolved_images = []
for node in image_nodes:
    image = node.image
    if image is not None:
        resolved_images.append((image.name, image.packed_file is not None, bpy.path.abspath(image.filepath)))

assert resolved_images, "FBX material has no usable image"
print(f"FBX verification passed: {len(meshes)} meshes")
print(f"Ball vertices={len(ball.data.vertices)}, polygons={len(ball.data.polygons)}, uv_layers={len(ball.data.uv_layers)}")
print(f"Material={material.name}, images={resolved_images}")
