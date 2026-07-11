"""
Blender 5.0 Python script to generate 3 maze FBX files with rounded/beveled walls.
Run with: blender --background --python generate_mazes.py

Output: labirint_2.fbx, labirint_3.fbx, labirint_4.fbx in public/source/
"""

import bpy
import bmesh
import random
import math
import os
import sys

# === CONFIGURATION ===
GRID_SIZE = 10          # 10x10 cell grid
MAZE_TOTAL_SIZE = 3560  # Total maze size in Blender units (matches original ~3561.6)
CELL_SIZE = MAZE_TOTAL_SIZE / GRID_SIZE  # ~356 units per cell
WALL_THICKNESS = 30     # Wall thickness
WALL_HEIGHT = 120       # Wall height
FLOOR_THICKNESS = 15    # Floor plate thickness
OUTER_WALL_THICKNESS = 45  # Outer border thickness
BEVEL_RADIUS = 12       # Rounding radius for wall edges
BEVEL_SEGMENTS = 3      # Smoothness of bevels

# Output directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "public", "source")


# === MAZE GENERATION (Recursive Backtracker / DFS) ===
def generate_maze(rows, cols, seed=42):
    """Generate a maze using recursive backtracking (DFS). Returns grid of cells with wall info."""
    random.seed(seed)
    
    # Each cell has 4 walls: top, right, bottom, left
    # True = wall exists, False = wall removed (passage)
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
    
    # Remove a few extra walls to create multiple paths (makes it more interesting)
    extra_removals = int(rows * cols * 0.08)  # Remove ~8% extra walls
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


def create_wall_segment(x, y, z, width, height, depth, name="wall"):
    """Create a single wall segment (box) with beveled edges."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, z))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (width, depth, height)
    bpy.ops.object.transform_apply(scale=True)
    
    # Add bevel modifier for rounded edges
    bevel = obj.modifiers.new(name="Bevel", type='BEVEL')
    bevel.width = BEVEL_RADIUS
    bevel.segments = BEVEL_SEGMENTS
    bevel.limit_method = 'ANGLE'
    bevel.angle_limit = math.radians(60)
    
    return obj


def build_maze_model(cells, maze_name="labirint"):
    """Build the 3D maze model from cell data."""
    rows = len(cells)
    cols = len(cells[0])
    
    objects = []
    
    # Origin offset: center the maze at (0, 0)
    offset_x = -MAZE_TOTAL_SIZE / 2
    offset_y = -MAZE_TOTAL_SIZE / 2
    
    # 1. Create floor
    bpy.ops.mesh.primitive_cube_add(
        size=1,
        location=(0, 0, -FLOOR_THICKNESS / 2)
    )
    floor = bpy.context.active_object
    floor.name = f"{maze_name}_floor"
    floor.scale = (MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, 
                   MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, 
                   FLOOR_THICKNESS)
    bpy.ops.object.transform_apply(scale=True)
    objects.append(floor)
    
    # 2. Create outer walls (frame)
    # Top wall (along +Y)
    obj = create_wall_segment(
        0, MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2, WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, WALL_HEIGHT, OUTER_WALL_THICKNESS,
        f"{maze_name}_outer_top"
    )
    objects.append(obj)
    
    # Bottom wall (along -Y)
    obj = create_wall_segment(
        0, -(MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2), WALL_HEIGHT / 2,
        MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, WALL_HEIGHT, OUTER_WALL_THICKNESS,
        f"{maze_name}_outer_bottom"
    )
    objects.append(obj)
    
    # Left wall (along -X)
    obj = create_wall_segment(
        -(MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2), 0, WALL_HEIGHT / 2,
        OUTER_WALL_THICKNESS, WALL_HEIGHT, MAZE_TOTAL_SIZE,
        f"{maze_name}_outer_left"
    )
    objects.append(obj)
    
    # Right wall (along +X)
    obj = create_wall_segment(
        MAZE_TOTAL_SIZE / 2 + OUTER_WALL_THICKNESS / 2, 0, WALL_HEIGHT / 2,
        OUTER_WALL_THICKNESS, WALL_HEIGHT, MAZE_TOTAL_SIZE,
        f"{maze_name}_outer_right"
    )
    objects.append(obj)
    
    # 3. Create internal walls
    wall_count = 0
    for r in range(rows):
        for c in range(cols):
            cell_x = offset_x + c * CELL_SIZE + CELL_SIZE / 2
            cell_y = offset_y + r * CELL_SIZE + CELL_SIZE / 2
            
            # Right wall of cell (vertical wall at cell's right edge)
            if cells[r][c]['right'] and c < cols - 1:
                wx = offset_x + (c + 1) * CELL_SIZE
                wy = cell_y
                obj = create_wall_segment(
                    wx, wy, WALL_HEIGHT / 2,
                    WALL_THICKNESS, WALL_HEIGHT, CELL_SIZE,
                    f"{maze_name}_wall_v_{wall_count}"
                )
                objects.append(obj)
                wall_count += 1
            
            # Top wall of cell (horizontal wall at cell's top edge)
            if cells[r][c]['top'] and r > 0:
                wx = cell_x
                wy = offset_y + r * CELL_SIZE
                obj = create_wall_segment(
                    wx, wy, WALL_HEIGHT / 2,
                    CELL_SIZE, WALL_HEIGHT, WALL_THICKNESS,
                    f"{maze_name}_wall_h_{wall_count}"
                )
                objects.append(obj)
                wall_count += 1
    
    print(f"  Created {wall_count} internal walls + 4 outer walls + 1 floor = {len(objects)} objects")
    
    return objects


def apply_modifiers_and_join(objects, final_name="labirint"):
    """Apply all modifiers and join wall objects, keeping the floor separate."""
    # Apply bevel modifiers
    for obj in objects:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for mod in obj.modifiers:
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except:
                pass
        obj.select_set(False)
    
    # Separate floor and wall objects
    floor_obj = None
    wall_objs = []
    for obj in objects:
        if "floor" in obj.name.lower():
            floor_obj = obj
        else:
            wall_objs.append(obj)
    
    # Join walls
    bpy.ops.object.select_all(action='DESELECT')
    for obj in wall_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = wall_objs[0]
    bpy.ops.object.join()
    
    # Rename walls
    joined_walls = bpy.context.active_object
    joined_walls.name = f"{final_name}_walls"
    bpy.ops.object.shade_smooth()
    
    # Add default material to walls
    mat_walls = bpy.data.materials.new(name="WallsMaterial")
    joined_walls.data.materials.append(mat_walls)
    
    # Handle floor separately
    if floor_obj:
        floor_obj.name = f"{final_name}_floor"
        mat_floor = bpy.data.materials.new(name="FloorMaterial")
        floor_obj.data.materials.append(mat_floor)
    
    return joined_walls


def export_fbx(filepath):
    """Export selected object as FBX."""
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


# === MAIN EXECUTION ===
def main():
    print("\n" + "=" * 60)
    print("MAZE GENERATOR FOR HOLOBOX GYRO LABYRINTH")
    print("=" * 60)
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # Define 3 maze variants with different seeds
    variants = [
        {"name": "labirint_2", "seed": 2026, "desc": "Variant 2 - Spiral paths"},
        {"name": "labirint_3", "seed": 7777, "desc": "Variant 3 - Wide corridors"},
        {"name": "labirint_4", "seed": 1337, "desc": "Variant 4 - Complex routes"},
    ]
    
    for variant in variants:
        print(f"\n--- Generating {variant['desc']} (seed={variant['seed']}) ---")
        
        # Clear scene
        clear_scene()
        
        # Generate maze layout
        cells = generate_maze(GRID_SIZE, GRID_SIZE, seed=variant['seed'])
        
        # Build 3D model
        objects = build_maze_model(cells, maze_name=variant['name'])
        
        # Join and finalize
        joined = apply_modifiers_and_join(objects, final_name=variant['name'])
        
        # Export FBX
        output_path = os.path.join(OUTPUT_DIR, f"{variant['name']}.fbx")
        export_fbx(output_path)
        
        print(f"  Done: {variant['name']}")
    
    print("\n" + "=" * 60)
    print("ALL 3 MAZES GENERATED SUCCESSFULLY!")
    print(f"Output directory: {OUTPUT_DIR}")
    print("=" * 60)


if __name__ == "__main__":
    main()
