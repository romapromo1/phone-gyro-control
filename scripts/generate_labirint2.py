import bpy
import math
import os
import random

# === CONFIGURATION ===
GRID_SIZE = 10
MAZE_TOTAL_SIZE = 35.6
CELL_SIZE = MAZE_TOTAL_SIZE / GRID_SIZE
FLOOR_THICKNESS = 0.37
FILLET_RADIUS = 1.17
OUTER_WALL_THICKNESS = 0.45
LINK_LENGTH = 0.3

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "public", "source")
FORMA_FBX = os.path.join(OUTPUT_DIR, "forma.fbx")
FLOOR_FBX = os.path.join(OUTPUT_DIR, "floor.fbx")
REFERENCE_MATERIAL_FBX = os.path.join(OUTPUT_DIR, "labirint.fbx")


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def import_first_mesh(filepath, object_name):
    if not os.path.exists(filepath):
        raise FileNotFoundError(filepath)

    before_objs = set(bpy.context.scene.objects)
    bpy.ops.import_scene.fbx(filepath=filepath)
    new_objs = set(bpy.context.scene.objects) - before_objs
    for obj in new_objs:
        if obj.type == "MESH":
            obj.name = object_name
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            return obj
    raise RuntimeError(f"No mesh found in {filepath}")


def load_profile():
    profile = import_first_mesh(FORMA_FBX, "source_wall_profile")
    profile.scale = (LINK_LENGTH / 2.2985, 1.0, 1.0)
    bpy.ops.object.select_all(action="DESELECT")
    profile.select_set(True)
    bpy.context.view_layer.objects.active = profile
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    profile.hide_viewport = True
    profile.hide_render = True
    return profile


def load_floor_template():
    floor = import_first_mesh(FLOOR_FBX, "source_floor")
    floor.hide_viewport = True
    floor.hide_render = True
    return floor


def load_reference_materials():
    materials = {"wall": [], "floor": []}
    if not os.path.exists(REFERENCE_MATERIAL_FBX):
        return materials

    before_objs = set(bpy.context.scene.objects)
    bpy.ops.import_scene.fbx(filepath=REFERENCE_MATERIAL_FBX)
    imported_objs = set(bpy.context.scene.objects) - before_objs
    for obj in imported_objs:
        if obj.type != "MESH":
            continue
        key = "floor" if "floor" in obj.name.lower() else "wall"
        for mat in obj.data.materials:
            if mat:
                materials[key].append(mat.copy())

    bpy.ops.object.select_all(action="DESELECT")
    for obj in imported_objs:
        obj.select_set(True)
    bpy.ops.object.delete()
    return materials


def apply_materials(obj, material_list, fallback_name):
    obj.data.materials.clear()
    if material_list:
        for mat in material_list:
            obj.data.materials.append(mat.copy())
    else:
        obj.data.materials.append(bpy.data.materials.new(name=fallback_name))


def generate_maze_grid(seed=123):
    random.seed(seed)
    cells = [[{"top": True, "right": True, "bottom": True, "left": True, "visited": False}
              for _ in range(GRID_SIZE)] for _ in range(GRID_SIZE)]
    directions = [
        ("top", -1, 0, "bottom"),
        ("right", 0, 1, "left"),
        ("bottom", 1, 0, "top"),
        ("left", 0, -1, "right"),
    ]

    stack = [(0, 0)]
    cells[0][0]["visited"] = True
    while stack:
        r, c = stack[-1]
        neighbors = []
        for wall, dr, dc, opposite in directions:
            nr, nc = r + dr, c + dc
            if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE and not cells[nr][nc]["visited"]:
                neighbors.append((wall, nr, nc, opposite))

        if neighbors:
            wall, nr, nc, opposite = random.choice(neighbors)
            cells[r][c][wall] = False
            cells[nr][nc][opposite] = False
            cells[nr][nc]["visited"] = True
            stack.append((nr, nc))
        else:
            stack.pop()

    for _ in range(int(GRID_SIZE * GRID_SIZE * 0.08)):
        r = random.randint(0, GRID_SIZE - 2)
        c = random.randint(0, GRID_SIZE - 2)
        if random.choice([True, False]):
            cells[r][c]["right"] = False
            cells[r][c + 1]["left"] = False
        else:
            cells[r][c]["bottom"] = False
            cells[r + 1][c]["top"] = False

    return cells


def get_wall_edges(cells):
    active_edges = set()
    for c in range(GRID_SIZE):
        active_edges.add(frozenset({(c, 0), (c + 1, 0)}))
        active_edges.add(frozenset({(c, GRID_SIZE), (c + 1, GRID_SIZE)}))
    for r in range(GRID_SIZE):
        active_edges.add(frozenset({(0, r), (0, r + 1)}))
        active_edges.add(frozenset({(GRID_SIZE, r), (GRID_SIZE, r + 1)}))

    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            if cells[r][c]["right"] and c < GRID_SIZE - 1:
                active_edges.add(frozenset({(c + 1, r), (c + 1, r + 1)}))
            if cells[r][c]["top"] and r > 0:
                active_edges.add(frozenset({(c, r), (c + 1, r)}))
    return active_edges


def extract_non_branching_paths(edges_set):
    edges = set(edges_set)
    paths = []

    while edges:
        valences = {}
        for edge in edges:
            for vertex in edge:
                valences[vertex] = valences.get(vertex, 0) + 1

        start_v = None
        for vertex, valence in sorted(valences.items()):
            if valence == 1 or valence >= 3:
                start_v = vertex
                break
        if start_v is None:
            start_v = sorted(valences.keys())[0]

        path = [start_v]
        current_v = start_v
        while True:
            next_edge = None
            for edge in sorted(edges, key=lambda e: sorted(e)):
                if current_v in edge:
                    next_edge = edge
                    break
            if next_edge is None:
                break

            next_v = list(next_edge - {current_v})[0]
            path.append(next_v)
            edges.remove(next_edge)

            if valences.get(next_v, 0) > 2:
                break
            current_v = next_v

        if len(path) > 1:
            paths.append(path)

    return paths


def grid_to_world(vertex):
    c, r = vertex
    offset = -MAZE_TOTAL_SIZE / 2
    return (offset + c * CELL_SIZE, offset + r * CELL_SIZE, 0.0)


def round_path_corners(path, radius):
    points = [grid_to_world(vertex) for vertex in path]
    if len(points) <= 2:
        return [(p, "VECTOR", p, p) for p in points]

    rounded_points = [(points[0], "VECTOR", points[0], points[0])]
    for i in range(1, len(points) - 1):
        p_prev = points[i - 1]
        p_curr = points[i]
        p_next = points[i + 1]

        v_in = (p_prev[0] - p_curr[0], p_prev[1] - p_curr[1])
        v_out = (p_next[0] - p_curr[0], p_next[1] - p_curr[1])
        len_in = math.hypot(v_in[0], v_in[1])
        len_out = math.hypot(v_out[0], v_out[1])
        cross_prod = v_in[0] * v_out[1] - v_in[1] * v_out[0]

        if abs(cross_prod) > 1e-3 and len_in > 1e-6 and len_out > 1e-6:
            u_in = (v_in[0] / len_in, v_in[1] / len_in)
            u_out = (v_out[0] / len_out, v_out[1] / len_out)
            actual_radius = min(radius, len_in * 0.45, len_out * 0.45)

            pt_in = (p_curr[0] + u_in[0] * actual_radius, p_curr[1] + u_in[1] * actual_radius, 0.0)
            pt_out = (p_curr[0] + u_out[0] * actual_radius, p_curr[1] + u_out[1] * actual_radius, 0.0)
            handle_len = actual_radius * 0.55228

            h_in_left = (pt_in[0] + u_in[0] * handle_len, pt_in[1] + u_in[1] * handle_len, 0.0)
            h_in_right = (pt_in[0] - u_in[0] * handle_len, pt_in[1] - u_in[1] * handle_len, 0.0)
            h_out_left = (pt_out[0] - u_out[0] * handle_len, pt_out[1] - u_out[1] * handle_len, 0.0)
            h_out_right = (pt_out[0] + u_out[0] * handle_len, pt_out[1] + u_out[1] * handle_len, 0.0)

            rounded_points.append((pt_in, "FREE", h_in_left, h_in_right))
            rounded_points.append((pt_out, "FREE", h_out_left, h_out_right))
        else:
            rounded_points.append((p_curr, "VECTOR", p_curr, p_curr))

    rounded_points.append((points[-1], "VECTOR", points[-1], points[-1]))
    return rounded_points


def build_curve_from_path(rounded_points, name):
    curve_data = bpy.data.curves.new(name=name, type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.fill_mode = "FULL"

    spline = curve_data.splines.new(type="BEZIER")
    spline.bezier_points.add(len(rounded_points) - 1)
    for i, (co, handle_type, handle_left, handle_right) in enumerate(rounded_points):
        bp = spline.bezier_points[i]
        bp.co = co
        bp.handle_left = handle_left
        bp.handle_right = handle_right
        bp.handle_left_type = handle_type
        bp.handle_right_type = handle_type

    obj = bpy.data.objects.new(name, curve_data)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_maze_walls(paths, profile):
    wall_objects = []
    for idx, path in enumerate(paths):
        rounded = round_path_corners(path, FILLET_RADIUS)
        curve = build_curve_from_path(rounded, f"curve_{idx}")

        wall_mesh = profile.copy()
        wall_mesh.data = profile.data.copy()
        wall_mesh.name = f"wall_mesh_{idx}"
        wall_mesh.hide_viewport = False
        wall_mesh.hide_render = False
        wall_mesh.location = (0, 0, 0)
        wall_mesh.rotation_euler = (0, 0, 0)
        wall_mesh.scale = (1, 1, 1)
        bpy.context.scene.collection.objects.link(wall_mesh)

        arr = wall_mesh.modifiers.new(name="Array", type="ARRAY")
        arr.fit_type = "FIT_CURVE"
        arr.curve = curve
        arr.relative_offset_displace = (1.0, 0.0, 0.0)
        arr.use_merge_vertices = True
        arr.merge_threshold = 0.02

        curv_mod = wall_mesh.modifiers.new(name="Curve", type="CURVE")
        curv_mod.object = curve
        curv_mod.deform_axis = "POS_X"

        bpy.context.view_layer.update()
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = wall_mesh
        wall_mesh.select_set(True)
        bpy.ops.object.modifier_apply(modifier="Array")
        bpy.ops.object.modifier_apply(modifier="Curve")
        wall_objects.append(wall_mesh)

        bpy.ops.object.select_all(action="DESELECT")
        curve.select_set(True)
        bpy.ops.object.delete()

    return wall_objects


def create_floor_from_template(floor_template, maze_name, walls):
    floor = floor_template.copy()
    floor.data = floor_template.data.copy()
    floor.name = f"{maze_name}_floor"
    floor.location = (0, 0, 0)
    floor.rotation_euler = (0, 0, 0)
    floor.scale = (1, 1, 1)
    floor.hide_viewport = False
    floor.hide_render = False
    bpy.context.scene.collection.objects.link(floor)

    bpy.context.view_layer.update()
    target_size = max(walls.dimensions.x, walls.dimensions.y) + OUTER_WALL_THICKNESS * 2
    if floor.dimensions.x > 0 and floor.dimensions.y > 0:
        floor.scale.x *= target_size / floor.dimensions.x
        floor.scale.y *= target_size / floor.dimensions.y
    return floor


def export_variant(profile, floor_template, materials, maze_name, seed):
    keep = {profile, floor_template}
    bpy.ops.object.select_all(action="DESELECT")
    for obj in list(bpy.context.scene.objects):
        if obj not in keep:
            obj.select_set(True)
    bpy.ops.object.delete()

    profile.hide_viewport = True
    profile.hide_render = True
    floor_template.hide_viewport = True
    floor_template.hide_render = True

    cells = generate_maze_grid(seed=seed)
    edges = get_wall_edges(cells)
    paths = extract_non_branching_paths(edges)
    wall_objs = build_maze_walls(paths, profile)

    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in wall_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = wall_objs[0]
    bpy.ops.object.join()

    joined_walls = bpy.context.active_object
    joined_walls.name = f"{maze_name}_walls"
    joined_walls.hide_viewport = False
    joined_walls.hide_render = False
    bpy.ops.object.shade_flat()
    apply_materials(joined_walls, materials.get("wall", []), "WallsMaterial")

    floor = create_floor_from_template(floor_template, maze_name, joined_walls)
    apply_materials(floor, materials.get("floor", []), "FloorMaterial")

    bpy.ops.object.select_all(action="DESELECT")
    joined_walls.select_set(True)
    floor.select_set(True)
    bpy.context.view_layer.objects.active = joined_walls

    output_fbx = os.path.join(OUTPUT_DIR, f"{maze_name}.fbx")
    bpy.ops.export_scene.fbx(
        filepath=output_fbx,
        use_selection=True,
        global_scale=1.0,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_ALL",
        axis_forward="-Z",
        axis_up="Y",
        use_mesh_modifiers=True,
        mesh_smooth_type="FACE",
        add_leaf_bones=False,
        bake_anim=False,
    )
    print(f"Exported {maze_name}: paths={len(paths)}, walls={len(wall_objs)}, file={output_fbx}")


def main():
    print("\n" + "=" * 60)
    print("CONTINUOUS ROUNDED MAZE GENERATOR")
    print("=" * 60)

    clear_scene()
    profile = load_profile()
    floor_template = load_floor_template()
    materials = load_reference_materials()

    variants = [
        ("labirint2", 123),
        ("labirint_5", 2051),
        ("labirint_6", 3197),
        ("labirint_7", 4829),
        ("labirint_8", 6043),
        ("labirint_9", 7919),
    ]

    for maze_name, seed in variants:
        print(f"\n--- Generating {maze_name} (seed={seed}) ---")
        export_variant(profile, floor_template, materials, maze_name, seed)

    print("=" * 60)


if __name__ == "__main__":
    main()
