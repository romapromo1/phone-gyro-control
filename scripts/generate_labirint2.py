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

# Template duplicating function
def create_wall_segment_from_template(wall_template, x, y, z, length, thickness, height, rotation_z, name):
    obj = wall_template.copy()
    obj.data = wall_template.data.copy()  # Unlinked duplicate to allow transform_apply
    obj.name = name
    bpy.context.scene.collection.objects.link(obj)
    
    obj.location = (x, y, z)
    obj.rotation_euler = (0, 0, rotation_z)
    
    # Template dims: X=2.2985, Y=0.4678, Z=0.9101
    obj.scale = (length / 2.2985, thickness / 0.4678, height / 0.9101)
    
    # Apply scale and rotation
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.select_set(False)
    
    return obj

def build_maze_model(cells, wall_template, floor_obj, maze_name="labirint2"):
    rows = len(cells)
    cols = len(cells[0])
    
    # Position floor
    floor_obj.name = f"{maze_name}_floor"
    floor_obj.location = (0, 0, -0.3668 / 2)
    # Scale floor to match overall size
    floor_obj.dimensions = (MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, 
                            MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, 
                            0.3668)
    bpy.context.view_layer.objects.active = floor_obj
    floor_obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    floor_obj.select_set(False)
    
    # Unlink template from selection during creation
    wall_template.select_set(False)
    
    wall_objs = []
    
    offset_x = -MAZE_TOTAL_SIZE / 2
    offset_y = -MAZE_TOTAL_SIZE / 2
    
    # 1. Create outer walls
    # Top
    w = create_wall_segment_from_template(
        wall_template, 0, MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2, WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, OUTER_WALL_THICKNESS, WALL_HEIGHT,
        0, f"{maze_name}_outer_top"
    )
    wall_objs.append(w)
    
    # Bottom
    w = create_wall_segment_from_template(
        wall_template, 0, -(MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2), WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, OUTER_WALL_THICKNESS, WALL_HEIGHT,
        0, f"{maze_name}_outer_bottom"
    )
    wall_objs.append(w)
    
    # Left (rotated 90 degrees)
    w = create_wall_segment_from_template(
        wall_template, -(MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2), 0, WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE, OUTER_WALL_THICKNESS, WALL_HEIGHT,
        math.radians(90), f"{maze_name}_outer_left"
    )
    wall_objs.append(w)
    
    # Right (rotated 90 degrees)
    w = create_wall_segment_from_template(
        wall_template, MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2, 0, WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE, OUTER_WALL_THICKNESS, WALL_HEIGHT,
        math.radians(90), f"{maze_name}_outer_right"
    )
    wall_objs.append(w)
    
    # 2. Create internal walls
    wall_count = 0
    for r in range(rows):
        for c in range(cols):
            cell_x = offset_x + c * CELL_SIZE + CELL_SIZE / 2
            cell_y = offset_y + r * CELL_SIZE + CELL_SIZE / 2
            
            # Draw top and right walls of cell if they exist
            if cells[r][c]['top'] and r > 0:  # Skip boundary
                w = create_wall_segment_from_template(
                    wall_template, cell_x, cell_y - CELL_SIZE / 2, WALL_HEIGHT / 2,
                    CELL_SIZE + WALL_THICKNESS, WALL_THICKNESS, WALL_HEIGHT,
                    0, f"{maze_name}_wall_h_{wall_count}"
                )
                wall_objs.append(w)
                wall_count += 1
                
            if cells[r][c]['right'] and c < cols - 1:  # Skip boundary
                w = create_wall_segment_from_template(
                    wall_template, cell_x + CELL_SIZE / 2, cell_y, WALL_HEIGHT / 2,
                    CELL_SIZE + WALL_THICKNESS, WALL_THICKNESS, WALL_HEIGHT,
                    math.radians(90), f"{maze_name}_wall_v_{wall_count}"
                )
                wall_objs.append(w)
                wall_count += 1
                
    return wall_objs

def main():
    print("\n" + "=" * 60)
    print("GENERATING NEW LABYRINTH 2 WITH OPTIMIZED SMOOTH JUNCTIONS")
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

    # 2. Generate maze layout
    cells = generate_maze(GRID_SIZE, GRID_SIZE, seed=2026)
    
    # 3. Assemble all wall pieces (inner and outer)
    print("Assembling wall pieces...")
    wall_objs = build_maze_model(cells, wall_template, floor_obj, "labirint2")
    
    # Remove the original template object so it is not in the final scene
    bpy.data.objects.remove(wall_template, do_unlink=True)
    
    # 4. Join all walls into one object
    bpy.ops.object.select_all(action='DESELECT')
    for obj in wall_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = wall_objs[0]
    bpy.ops.object.join()
    
    joined_walls = bpy.context.active_object
    joined_walls.name = "labirint2_walls_raw"
    
    # Weld/Merge double vertices to clean up overlapping geometry faces
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.01)
    bpy.ops.object.mode_set(mode='OBJECT')
    
    # 5. Voxel Remesh to weld all intersections organically (seamless junctions!)
    print("Blending wall junctions...")
    remesh_mod = joined_walls.modifiers.new(name="Remesh", type='REMESH')
    remesh_mod.mode = 'VOXEL'
    remesh_mod.voxel_size = 0.05  # High-quality resolution for 35.6m scale
    remesh_mod.adaptivity = 0.0
    bpy.ops.object.modifier_apply(modifier=remesh_mod.name)
    
    # 6. Smooth to round corners and turns inside the corridors
    print("Smoothing turn angles...")
    smooth_mod = joined_walls.modifiers.new(name="Smooth", type='SMOOTH')
    smooth_mod.factor = 1.0
    smooth_mod.iterations = 65  # Creates soft inner turns and blends junctions (large radius)
    bpy.ops.object.modifier_apply(modifier=smooth_mod.name)
    
    # 7. Sharp Frame Slice: Cut the outer frame to restore sharp 90-degree outer corners
    print("Slicing outer boundary for sharp corners...")
    slice_size = MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, WALL_HEIGHT / 2))
    slice_cube = bpy.context.active_object
    slice_cube.name = "SliceCube"
    slice_cube.scale = (slice_size, slice_size, WALL_HEIGHT * 2)
    bpy.ops.object.transform_apply(scale=True)
    
    # Apply Boolean Intersect to slice the outer edges flat
    bool_mod = joined_walls.modifiers.new(name="Boolean", type='BOOLEAN')
    bool_mod.operation = 'INTERSECT'
    bool_mod.object = slice_cube
    bpy.context.view_layer.objects.active = joined_walls
    bpy.ops.object.modifier_apply(modifier=bool_mod.name)
    
    # Delete temporary slice cube
    bpy.data.objects.remove(slice_cube, do_unlink=True)
    
    # 8. Planar Decimate to clean up flat walls and keep polygon count optimized
    print("Optimizing flat faces...")
    decimate_mod = joined_walls.modifiers.new(name="Decimate", type='DECIMATE')
    decimate_mod.decimate_type = 'DISSOLVE'
    decimate_mod.angle_limit = math.radians(2)
    bpy.ops.object.modifier_apply(modifier=decimate_mod.name)
    
    joined_walls.name = "labirint2_walls"
    
    # Apply default material
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
    print("NEW LABIRINT2 GENERATED SUCCESSFULLY!")
    print("=" * 60)

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
