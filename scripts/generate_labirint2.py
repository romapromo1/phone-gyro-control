import bpy
import math
import os
import random

# === CONFIGURATION (in real-world METERS, matching labirint.fbx) ===
GRID_SIZE = 10
MAZE_TOTAL_SIZE = 35.6157  # Target size of the maze in meters
CELL_SIZE = MAZE_TOTAL_SIZE / GRID_SIZE  # ~3.56157 m per cell
WALL_THICKNESS = 0.4678  # exact Cube.003 thickness
WALL_HEIGHT = 0.9101     # exact Cube.003 height
OUTER_WALL_THICKNESS = 0.4678

# Output directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "public", "source")
FORMA_PATH = os.path.join(OUTPUT_DIR, "forma.fbx")

def clear_scene():
    """Remove all objects from the scene."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    
    # Clear orphan data
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in bpy.data.curves:
        if block.users == 0:
            bpy.data.curves.remove(block)
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

def main():
    print("\n" + "=" * 60)
    print("GENERATING ROUNDED CURVE-SWEEP LABIRINT2 (35.6157 m)")
    print("=" * 60)
    
    clear_scene()
    
    # 1. Load user's updated forma.fbx
    print(f"Loading template model from: {FORMA_PATH}")
    bpy.ops.import_scene.fbx(filepath=FORMA_PATH)
    
    wall_template = bpy.data.objects.get("Cube.003")
    if not wall_template:
        print("Error: Could not find 'Cube.003' in template FBX.")
        return
        
    # 2. Extract Y-Z profile vertices from Cube.003 at one of the ends (X > 0)
    verts_2d = []
    for v in wall_template.data.vertices:
        if v.co.x > 0:
            verts_2d.append((v.co.y, v.co.z))
            
    # Deduplicate extracted profile vertices
    unique_verts = []
    for p in verts_2d:
        if not any(math.isclose(p[0], u[0], abs_tol=1e-4) and math.isclose(p[1], u[1], abs_tol=1e-4) for u in unique_verts):
            unique_verts.append(p)
            
    # Sort vertices in circular order around centroid to form a closed shape
    cx = sum(p[0] for p in unique_verts) / len(unique_verts)
    cy = sum(p[1] for p in unique_verts) / len(unique_verts)
    unique_verts.sort(key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
    
    # Create the profile curve object
    profile_data = bpy.data.curves.new(name="WallProfile", type='CURVE')
    profile_data.dimensions = '2D'
    profile_obj = bpy.data.objects.new("WallProfile", profile_data)
    bpy.context.scene.collection.objects.link(profile_obj)
    
    spline = profile_data.splines.new(type='POLY')
    spline.points.add(len(unique_verts) - 1)
    for i, p in enumerate(unique_verts):
        spline.points[i].co = (p[0], p[1], 0, 1)
    spline.use_cyclic_u = True
    
    # Delete the imported wall template mesh
    bpy.data.objects.remove(wall_template, do_unlink=True)
    
    # 3. Create programmatic floor mesh
    print("Creating floor mesh...")
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.3668 / 2))
    floor_obj = bpy.context.active_object
    floor_obj.name = "labirint2_floor"
    floor_obj.scale = (34.6776, 35.6143, 0.3668)
    bpy.ops.object.transform_apply(scale=True)
    
    # 4. Generate maze grid layout
    cells = generate_maze(GRID_SIZE, GRID_SIZE, seed=2026)
    
    # 5. Build 2D centerline path mesh
    print("Assembling 2D centerline paths...")
    path_mesh = bpy.data.meshes.new(name="MazePath")
    path_obj = bpy.data.objects.new("MazePath", path_mesh)
    bpy.context.scene.collection.objects.link(path_obj)
    
    verts = []
    edges = []
    vert_map = {}
    
    def get_vertex(x, y):
        key = (round(x, 4), round(y, 4))
        if key not in vert_map:
            vert_map[key] = len(verts)
            verts.append((x, y, WALL_HEIGHT / 2)) # set path Z height to half wall height
        return vert_map[key]
        
    offset_x = -MAZE_TOTAL_SIZE / 2
    offset_y = -MAZE_TOTAL_SIZE / 2
    
    # Outer boundaries
    # Top wall
    for c in range(GRID_SIZE):
        v1 = get_vertex(offset_x + c * CELL_SIZE, offset_y + GRID_SIZE * CELL_SIZE)
        v2 = get_vertex(offset_x + (c+1) * CELL_SIZE, offset_y + GRID_SIZE * CELL_SIZE)
        edges.append((v1, v2))
    # Bottom wall
    for c in range(GRID_SIZE):
        v1 = get_vertex(offset_x + c * CELL_SIZE, offset_y)
        v2 = get_vertex(offset_x + (c+1) * CELL_SIZE, offset_y)
        edges.append((v1, v2))
    # Left wall
    for r in range(GRID_SIZE):
        v1 = get_vertex(offset_x, offset_y + r * CELL_SIZE)
        v2 = get_vertex(offset_x, offset_y + (r+1) * CELL_SIZE)
        edges.append((v1, v2))
    # Right wall
    for r in range(GRID_SIZE):
        v1 = get_vertex(offset_x + GRID_SIZE * CELL_SIZE, offset_y + r * CELL_SIZE)
        v2 = get_vertex(offset_x + GRID_SIZE * CELL_SIZE, offset_y + (r+1) * CELL_SIZE)
        edges.append((v1, v2))
        
    # Internal boundaries
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            if cells[r][c]['top'] and r > 0:
                v1 = get_vertex(offset_x + c * CELL_SIZE, offset_y + r * CELL_SIZE)
                v2 = get_vertex(offset_x + (c+1) * CELL_SIZE, offset_y + r * CELL_SIZE)
                edges.append((v1, v2))
            if cells[r][c]['right'] and c < GRID_SIZE - 1:
                v1 = get_vertex(offset_x + (c+1) * CELL_SIZE, offset_y + r * CELL_SIZE)
                v2 = get_vertex(offset_x + (c+1) * CELL_SIZE, offset_y + (r+1) * CELL_SIZE)
                edges.append((v1, v2))
                
    path_mesh.from_pydata(verts, edges, [])
    path_mesh.update()
    
    # 6. Bevel vertices in Edit Mode to create rounded corners at turns
    print("Beveling corners...")
    bpy.context.view_layer.objects.active = path_obj
    path_obj.select_set(True)
    
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    # Bevel vertices with 1.0m radius (5 segments) to round the 90-degree corners
    bpy.ops.mesh.bevel(offset=1.0, segments=5, affect='VERTICES')
    bpy.ops.object.mode_set(mode='OBJECT')
    
    # 7. Convert beveled path mesh into a Curve
    print("Converting path to curve and sweeping profile...")
    bpy.ops.object.convert(target='CURVE')
    path_curve_obj = bpy.context.active_object
    path_curve_data = path_curve_obj.data
    
    # Set up curve extrusion options using the profile curve
    path_curve_data.dimensions = '3D'
    path_curve_data.fill_mode = 'FULL'
    path_curve_data.bevel_mode = 'OBJECT'
    path_curve_data.bevel_object = profile_obj
    path_curve_data.use_fill_caps = True
    
    # 8. Convert swept curve back to final low-poly Mesh
    print("Converting curve back to mesh...")
    bpy.ops.object.convert(target='MESH')
    joined_walls = bpy.context.active_object
    joined_walls.name = "labirint2_walls"
    
    # Clean up profile curve template
    bpy.data.objects.remove(profile_obj, do_unlink=True)
    
    # Shade smooth and assign material
    bpy.ops.object.shade_smooth()
    mat_walls = bpy.data.materials.new(name="WallsMaterial")
    joined_walls.data.materials.append(mat_walls)
    
    # Re-apply floor material slot
    mat_floor = bpy.data.materials.new(name="FloorMaterial")
    floor_obj.data.materials.append(mat_floor)
    
    # Select floor and walls for export
    bpy.ops.object.select_all(action='DESELECT')
    floor_obj.select_set(True)
    joined_walls.select_set(True)
    
    # Export FBX
    output_path = os.path.join(OUTPUT_DIR, "labirint2.fbx")
    export_fbx(output_path)
    
    print("\n" + "=" * 60)
    print("ROUNDED OPTIMIZED LABIRINT2 COMPLETED SUCCESSFULLY!")
    print("=" * 60)

if __name__ == "__main__":
    main()
