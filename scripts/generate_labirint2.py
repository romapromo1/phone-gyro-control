import bpy
import math
import os
import random

# === CONFIGURATION ===
GRID_SIZE = 10          # 10x10 cell grid
MAZE_TOTAL_SIZE = 35.6157  # Total maze size in meters (exact user size!)
CELL_SIZE = MAZE_TOTAL_SIZE / GRID_SIZE  # ~3.56 meters per cell
WALL_THICKNESS = 0.4678     # Wall thickness (exact Y thickness of Cube.003)
WALL_HEIGHT = 0.9101       # Wall height (exact Z height of Cube.003)
OUTER_WALL_THICKNESS = 0.4678  # Outer border thickness (exact Y thickness of Cube.003)
CORNER_RADIUS = 1.4         # Large radius for smooth sweeping corners

# Output directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "public", "source")
FORMA_PATH = r"C:\Users\RocketPC\Downloads\forma.fbx"

def clear_scene():
    """Remove all objects from the scene."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    
    # Clear orphan data
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        if block.users == 0:
            bpy.data.materials.remove(block)

# === MAZE GENERATION ===
def generate_maze(rows, cols, seed=2026):
    """Generate a maze using recursive backtracking (DFS)."""
    random.seed(seed)
    cells = [[{'top': True, 'right': True, 'bottom': True, 'left': True, 'visited': False}
              for _ in range(cols)] for _ in range(rows)]
    
    directions = [
        ('top', -1, 0, 'bottom'),
        ('right', 0, 1, 'left'),
        ('bottom', 1, 0, 'top'),
        ('left', 0, -1, 'right')
    ]
    
    stack = [(0, 0)]
    cells[0][0]['visited'] = True
    
    while stack:
        r, c = stack[-1]
        neighbors = []
        
        for wall, dr, dc, opposite in directions:
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and not cells[nr][nc]['visited']:
                neighbors.append((wall, nr, nc, opposite))
        
        if neighbors:
            wall, nr, nc, opposite = random.choice(neighbors)
            cells[r][c][wall] = False
            cells[nr][nc][opposite] = False
            cells[nr][nc]['visited'] = True
            stack.append((nr, nc))
        else:
            stack.pop()
            
    # Remove some extra walls to make multiple paths
    extra_removals = int(rows * cols * 0.08)
    for _ in range(extra_removals):
        r = random.randint(0, rows - 2)
        c = random.randint(0, cols - 2)
        direction = random.choice(['right', 'bottom'])
        if direction == 'right' and c < cols - 1:
            cells[r][c]['right'] = False
            cells[r][c + 1]['left'] = False
        elif direction == 'bottom' and r < rows - 1:
            cells[r][c]['bottom'] = False
            cells[r + 1][c]['top'] = False
            
    return cells

def build_maze_skeleton_mesh(cells):
    """Build a 2D line mesh representing all the wall paths."""
    rows = len(cells)
    cols = len(cells[0])
    
    offset_x = -MAZE_TOTAL_SIZE / 2
    offset_y = -MAZE_TOTAL_SIZE / 2
    
    vertices = []
    edges = []
    vertex_map = {}
    
    def add_vertex(pt):
        pt_rounded = (round(pt[0], 5), round(pt[1], 5))
        if pt_rounded not in vertex_map:
            vertex_map[pt_rounded] = len(vertices)
            vertices.append((pt[0], pt[1], 0.0))
        return vertex_map[pt_rounded]
        
    def add_edge(pt1, pt2):
        idx1 = add_vertex(pt1)
        idx2 = add_vertex(pt2)
        edges.append((idx1, idx2))

    # 1. Create inner wall paths (each wall is a single line edge)
    for r in range(rows):
        for c in range(cols):
            cell_x = offset_x + c * CELL_SIZE + CELL_SIZE / 2
            cell_y = offset_y + r * CELL_SIZE + CELL_SIZE / 2
            
            if cells[r][c]['top'] and r > 0:  # Skip boundary
                add_edge(
                    (cell_x - CELL_SIZE / 2, cell_y - CELL_SIZE / 2),
                    (cell_x + CELL_SIZE / 2, cell_y - CELL_SIZE / 2)
                )
                
            if cells[r][c]['right'] and c < cols - 1:  # Skip boundary
                add_edge(
                    (cell_x + CELL_SIZE / 2, cell_y - CELL_SIZE / 2),
                    (cell_x + CELL_SIZE / 2, cell_y + CELL_SIZE / 2)
                )
                
    # Create the 2D skeleton mesh object
    mesh_data = bpy.data.meshes.new("MazeSkeleton")
    mesh_data.from_pydata(vertices, edges, [])
    mesh_obj = bpy.data.objects.new("MazeSkeletonObj", mesh_data)
    bpy.context.scene.collection.objects.link(mesh_obj)
    
    # 2. Select internal vertices to bevel them (keeps outer corners sharp)
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.mode_set(mode='OBJECT')
    
    # Select all vertices except those on the boundary
    boundary_limit = MAZE_TOTAL_SIZE / 2 - 0.05
    for v in mesh_obj.data.vertices:
        is_internal = abs(v.co.x) < boundary_limit and abs(v.co.y) < boundary_limit
        v.select = is_internal
        
    # Bevel the selected internal vertices to round the corners
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.bevel(affect='VERTICES', offset=CORNER_RADIUS, segments=8)
    bpy.ops.object.mode_set(mode='OBJECT')
    
    return mesh_obj

def build_profile_curve(wall_template):
    """Extract Y-Z profile points from Cube.003 and build a 2D Curve."""
    verts = [v.co for v in wall_template.data.vertices if v.co.x > 0.0]
    
    # Calculate center of profile
    center_y = sum(v.y for v in verts) / len(verts)
    center_z = sum(v.z for v in verts) / len(verts)
    
    # Sort vertices by angle around center to form a closed loop
    verts.sort(key=lambda v: math.atan2(v.z - center_z, v.y - center_y))
    
    # Build 2D Curve
    profile_curve = bpy.data.curves.new(name="ProfileCurve", type='CURVE')
    profile_curve.dimensions = '2D'
    
    profile_spline = profile_curve.splines.new(type='POLY')
    profile_spline.use_cyclic_u = True
    profile_spline.points.add(len(verts) - 1)
    
    for idx, v in enumerate(verts):
        profile_spline.points[idx].co = (v.y, v.z, 0.0, 1.0)
        
    profile_obj = bpy.data.objects.new("ProfileObj", profile_curve)
    bpy.context.scene.collection.objects.link(profile_obj)
    
    return profile_obj

def create_outer_walls_sharp(wall_template, maze_name):
    """Build the outer frame with sharp corners from Cube.003."""
    outer_objs = []
    
    # Top
    w = create_wall_segment_from_template(
        wall_template, 0, MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2, WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, OUTER_WALL_THICKNESS, WALL_HEIGHT,
        0, f"{maze_name}_outer_top"
    )
    outer_objs.append(w)
    
    # Bottom
    w = create_wall_segment_from_template(
        wall_template, 0, -(MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2), WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, OUTER_WALL_THICKNESS, WALL_HEIGHT,
        0, f"{maze_name}_outer_bottom"
    )
    outer_objs.append(w)
    
    # Left
    w = create_wall_segment_from_template(
        wall_template, -(MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2), 0, WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE, OUTER_WALL_THICKNESS, WALL_HEIGHT,
        math.radians(90), f"{maze_name}_outer_left"
    )
    outer_objs.append(w)
    
    # Right
    w = create_wall_segment_from_template(
        wall_template, MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2, 0, WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE, OUTER_WALL_THICKNESS, WALL_HEIGHT,
        math.radians(90), f"{maze_name}_outer_right"
    )
    outer_objs.append(w)
    
    # Join outer walls
    bpy.ops.object.select_all(action='DESELECT')
    for obj in outer_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = outer_objs[0]
    bpy.ops.object.join()
    
    joined_outer = bpy.context.active_object
    joined_outer.name = f"{maze_name}_outer_frame"
    
    return joined_outer

def main():
    print("\n" + "=" * 60)
    print("GENERATING NEW LABYRINTH 2 WITH HYBRID SMOOTH JUNCTIONS")
    print("=" * 60)
    
    clear_scene()
    
    # 1. Load template FBX
    print(f"Loading template model from: {FORMA_PATH}")
    bpy.ops.import_scene.fbx(filepath=FORMA_PATH)
    
    wall_template = bpy.data.objects.get("Cube.003")
    floor_obj = bpy.data.objects.get("floor")
    
    if not wall_template or not floor_obj:
        print("Error: Could not find 'Cube.003' or 'floor' in template FBX.")
        return
        
    # Scale floor to match overall size
    floor_obj.name = "labirint2_floor"
    floor_obj.location = (0, 0, -0.3668 / 2)
    floor_obj.dimensions = (MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, 
                            MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, 
                            0.3668)
    bpy.context.view_layer.objects.active = floor_obj
    floor_obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    floor_obj.select_set(False)

    # 2. Extract profile curve
    profile_obj = build_profile_curve(wall_template)
    
    # 3. Create outer sharp frame
    print("Assembling sharp outer frame...")
    outer_frame_mesh = create_outer_walls_sharp(wall_template, "labirint2")

    # 4. Generate maze layout
    cells = generate_maze(GRID_SIZE, GRID_SIZE, seed=2026)
    
    # 5. Build 2D line skeleton with rounded internal turns
    print("Generating rounded 2D inner skeleton...")
    skeleton_mesh_obj = build_maze_skeleton_mesh(cells)
    
    # Convert skeleton mesh to Curve
    bpy.ops.object.select_all(action='DESELECT')
    skeleton_mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = skeleton_mesh_obj
    bpy.ops.object.convert(target='CURVE')
    
    maze_curve_obj = bpy.context.active_object
    maze_curve_obj.name = "MazeInnerCurve"
    
    # Set custom profile sweep
    maze_curve_obj.data.bevel_mode = 'OBJECT'
    maze_curve_obj.data.bevel_object = profile_obj
    maze_curve_obj.data.use_fill_caps = True
    
    # Convert curve sweep to 3D Mesh
    bpy.ops.object.convert(target='MESH')
    
    # Position walls vertically on the floor (shifting up by half height)
    maze_curve_obj.location.z = WALL_HEIGHT / 2
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    
    # 6. Delete template objects
    bpy.data.objects.remove(wall_template, do_unlink=True)
    bpy.data.objects.remove(profile_obj, do_unlink=True)
    
    # 7. Join inner rounded walls with outer frame
    print("Merging inner walls and outer frame...")
    bpy.ops.object.select_all(action='DESELECT')
    maze_curve_obj.select_set(True)
    outer_frame_mesh.select_set(True)
    bpy.context.view_layer.objects.active = outer_frame_mesh
    bpy.ops.object.join()
    
    final_walls = bpy.context.active_object
    final_walls.name = "labirint2_walls_combined"
    
    # Weld/Merge double vertices
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.01)
    bpy.ops.object.mode_set(mode='OBJECT')
    
    # 8. Voxel Remesh to weld junctions cleanly (seamless)
    print("Voxel remeshing junctions...")
    remesh_mod = final_walls.modifiers.new(name="Remesh", type='REMESH')
    remesh_mod.mode = 'VOXEL'
    remesh_mod.voxel_size = 0.05
    bpy.ops.object.modifier_apply(modifier=remesh_mod.name)
    
    # 9. Gentle Smooth to blend the seams
    print("Blending seams...")
    smooth_mod = final_walls.modifiers.new(name="Smooth", type='SMOOTH')
    smooth_mod.factor = 1.0
    smooth_mod.iterations = 10  # Gentle smoothing to preserve profile but blend joints!
    bpy.ops.object.modifier_apply(modifier=smooth_mod.name)
    
    # 10. Sharp Frame Slice: Cut the outer frame to restore sharp 90-degree outer corners
    print("Slicing outer boundary for sharp corners...")
    slice_size = MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, WALL_HEIGHT / 2))
    slice_cube = bpy.context.active_object
    slice_cube.name = "SliceCube"
    slice_cube.scale = (slice_size, slice_size, WALL_HEIGHT * 2)
    bpy.ops.object.transform_apply(scale=True)
    
    # Apply Boolean Intersect to slice the outer edges flat
    bool_mod = final_walls.modifiers.new(name="Boolean", type='BOOLEAN')
    bool_mod.operation = 'INTERSECT'
    bool_mod.object = slice_cube
    bpy.context.view_layer.objects.active = final_walls
    bpy.ops.object.modifier_apply(modifier=bool_mod.name)
    
    # Delete temporary slice cube
    bpy.data.objects.remove(slice_cube, do_unlink=True)
    
    # 11. Planar Decimate to optimize flat faces
    print("Optimizing flat faces...")
    decimate_mod = final_walls.modifiers.new(name="Decimate", type='DECIMATE')
    decimate_mod.decimate_type = 'DISSOLVE'
    decimate_mod.angle_limit = math.radians(2)
    bpy.ops.object.modifier_apply(modifier=decimate_mod.name)
    
    final_walls.name = "labirint2_walls"
    
    # Apply default material
    mat_walls = bpy.data.materials.new(name="WallsMaterial")
    final_walls.data.materials.append(mat_walls)
    
    # Re-apply floor material slot
    mat_floor = bpy.data.materials.new(name="FloorMaterial")
    floor_obj.data.materials.append(mat_floor)
    
    # Select floor and walls for export
    bpy.ops.object.select_all(action='DESELECT')
    floor_obj.select_set(True)
    final_walls.select_set(True)
    
    # Export FBX
    output_path = os.path.join(OUTPUT_DIR, "labirint2.fbx")
    export_fbx(output_path)
    
    print("\n" + "=" * 60)
    print("NEW LABIRINT2 GENERATED SUCCESSFULLY!")
    print("=" * 60)

# Helper segment function for outer frame
def create_wall_segment_from_template(wall_template, x, y, z, length, thickness, height, rotation_z, name):
    obj = wall_template.copy()
    obj.data = wall_template.data.copy()
    obj.name = name
    bpy.context.scene.collection.objects.link(obj)
    obj.location = (x, y, z)
    obj.rotation_euler = (0, 0, rotation_z)
    obj.scale = (length / 2.2985, thickness / 0.4678, height / 0.9101)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.select_set(False)
    return obj

def export_fbx(filepath):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.fbx(
        filepath=filepath,
        use_selection=True,
        global_scale=1.0,
        apply_unit_scale=True,
        apply_scale_options='FBX_SCALE_ALL',
        axis_forward='-Z',
        axis_up='Y',
        use_mesh_modifiers=True,
        mesh_smooth_type='FACE',
        add_leaf_bones=False,
        bake_anim=False
    )
    print(f"  Exported: {filepath}")

if __name__ == "__main__":
    main()
