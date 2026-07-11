import bpy
import math
import random
import os

# === CONFIGURATION ===
GRID_SIZE = 10
MAZE_TOTAL_SIZE = 35.6  # Match Level 1 scale (35.6 units total width)
CELL_SIZE = MAZE_TOTAL_SIZE / GRID_SIZE  # 3.56 units per cell
WALL_HEIGHT = 0.91
FLOOR_THICKNESS = 0.37
FILLET_RADIUS = 1.17  # 1.5 * ball_radius (ball_radius is 0.78 units in this scale)
OUTER_WALL_THICKNESS = 0.45
LINK_LENGTH = 0.3     # Chain link segment length for smooth bending and low vertex count

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "public", "source")
FORMA_FBX = os.path.join(OUTPUT_DIR, "forma.fbx")
OUTPUT_FBX = os.path.join(OUTPUT_DIR, "labirint2.fbx")

def clear_scene_except_profile():
    """Remove all objects from the scene except the profile object."""
    bpy.ops.object.select_all(action='SELECT')
    # Keep Cube.003 if it already exists, otherwise we will load it
    profile_exists = "Cube.003" in bpy.data.objects
    for obj in bpy.context.scene.objects:
        if obj.name != "Cube.003":
            obj.select_set(True)
        else:
            obj.select_set(False)
    bpy.ops.object.delete(use_global=False)
    return profile_exists

def load_profile():
    """Load the profile Cube.003 from forma.fbx."""
    if "Cube.003" not in bpy.data.objects:
        print(f"Loading profile from {FORMA_FBX}...")
        bpy.ops.import_scene.fbx(filepath=FORMA_FBX)
    
    profile = bpy.data.objects.get("Cube.003")
    if not profile:
        raise Exception("Cube.003 profile not found in forma.fbx!")
    
    # Make sure scale and rotation are applied
    bpy.ops.object.select_all(action='DESELECT')
    profile.select_set(True)
    bpy.context.view_layer.objects.active = profile
    # Scale X to LINK_LENGTH to optimize vertex count and support smooth bending
    profile.scale = (LINK_LENGTH / 2.2985, 1.0, 1.0)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    profile.select_set(False)
    return profile

def generate_maze_grid(seed=123):
    """Generate a 10x10 maze layout using DFS."""
    random.seed(seed)
    cells = [[{'top': True, 'right': True, 'bottom': True, 'left': True, 'visited': False}
              for _ in range(GRID_SIZE)] for _ in range(GRID_SIZE)]
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
            if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE and not cells[nr][nc]['visited']:
                neighbors.append((wall, nr, nc, opposite))
        if neighbors:
            wall, nr, nc, opposite = random.choice(neighbors)
            cells[r][c][wall] = False
            cells[nr][nc][opposite] = False
            cells[nr][nc]['visited'] = True
            stack.append((nr, nc))
        else:
            stack.pop()
            
    # Remove some extra walls to create multiple paths
    for _ in range(int(GRID_SIZE * GRID_SIZE * 0.08)):
        r = random.randint(0, GRID_SIZE - 2)
        c = random.randint(0, GRID_SIZE - 2)
        if random.choice([True, False]):
            cells[r][c]['right'] = False
            cells[r][c+1]['left'] = False
        else:
            cells[r][c]['bottom'] = False
            cells[r+1][c]['top'] = False
            
    return cells

def get_wall_edges(cells):
    """Decompose the maze walls into a set of grid edges."""
    active_edges = set()
    
    # Outer border edges
    for c in range(GRID_SIZE):
        active_edges.add(frozenset({(c, 0), (c + 1, 0)})) # Bottom
        active_edges.add(frozenset({(c, GRID_SIZE), (c + 1, GRID_SIZE)})) # Top
    for r in range(GRID_SIZE):
        active_edges.add(frozenset({(0, r), (0, r + 1)})) # Left
        active_edges.add(frozenset({(GRID_SIZE, r), (GRID_SIZE, r + 1)})) # Right
        
    # Internal edges
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            if cells[r][c]['right'] and c < GRID_SIZE - 1:
                active_edges.add(frozenset({(c + 1, r), (c + 1, r + 1)}))
            if cells[r][c]['top'] and r > 0:
                active_edges.add(frozenset({(c, r), (c + 1, r)}))
                
    return active_edges

def extract_non_branching_paths(edges_set):
    """Trace the edges into a list of continuous, non-branching paths (splines)."""
    edges = set(edges_set)
    paths = []
    
    while edges:
        valences = {}
        for e in edges:
            for v in e:
                valences[v] = valences.get(v, 0) + 1
        
        # Start at an endpoint (valence 1) or a junction (valence 3+)
        start_v = None
        for v, val in valences.items():
            if val == 1 or val == 3:
                start_v = v
                break
        if start_v is None:
            start_v = list(valences.keys())[0]
            
        path = [start_v]
        current_v = start_v
        while True:
            next_edge = None
            for e in edges:
                if current_v in e:
                    next_edge = e
                    break
            if next_edge is None:
                break
            
            next_v = list(next_edge - {current_v})[0]
            path.append(next_v)
            edges.remove(next_edge)
            
            # Stop path at branches to avoid junctions in a single Curve
            v_val = valences.get(next_v, 0)
            if v_val > 2:
                break
            current_v = next_v
            
        if len(path) > 1:
            paths.append(path)
            
    return paths

def round_path_corners(path, R):
    """
    Fillet/round the corners of a 2D path.
    Replaces corner points with Bezier curve control points and handles to form circular arcs.
    """
    # Convert grid points to Blender coordinates
    offset = -MAZE_TOTAL_SIZE / 2
    points = []
    for (c, r) in path:
        x = offset + c * CELL_SIZE
        y = offset + r * CELL_SIZE
        points.append((x, y, 0.0))
        
    if len(points) <= 2:
        # Straight line, no corners to round
        return [(p, 'VECTOR', p, p) for p in points]
        
    rounded_points = []
    # Start point
    rounded_points.append((points[0], 'VECTOR', points[0], points[0]))
    
    # Process intermediate corner points
    for i in range(1, len(points) - 1):
        p_prev = points[i - 1]
        p_curr = points[i]
        p_next = points[i + 1]
        
        # Vectors
        v_in = [p_prev[0] - p_curr[0], p_prev[1] - p_curr[1]]
        v_out = [p_next[0] - p_curr[0], p_next[1] - p_curr[1]]
        
        len_in = math.sqrt(v_in[0]**2 + v_in[1]**2)
        len_out = math.sqrt(v_out[0]**2 + v_out[1]**2)
        
        # Check if collinear
        cross_prod = v_in[0]*v_out[1] - v_in[1]*v_out[0]
        is_corner = abs(cross_prod) > 1e-3
        
        if is_corner:
            u_in = [v_in[0]/len_in, v_in[1]/len_in]
            u_out = [v_out[0]/len_out, v_out[1]/len_out]
            
            # Limit R to half segment length
            actual_R = min(R, len_in * 0.45, len_out * 0.45)
            
            # Fillet points
            pt_in = (p_curr[0] + u_in[0]*actual_R, p_curr[1] + u_in[1]*actual_R, 0.0)
            pt_out = (p_curr[0] + u_out[0]*actual_R, p_curr[1] + u_out[1]*actual_R, 0.0)
            
            # Handle lengths (standard Bezier circular approximation factor)
            handle_len = actual_R * 0.55228
            
            # Handles pointing towards the corner
            h_in_right = (pt_in[0] - u_in[0]*handle_len, pt_in[1] - u_in[1]*handle_len, 0.0)
            h_in_left = (pt_in[0] + u_in[0]*handle_len, pt_in[1] + u_in[1]*handle_len, 0.0)
            
            h_out_left = (pt_out[0] - u_out[0]*handle_len, pt_out[1] - u_out[1]*handle_len, 0.0)
            h_out_right = (pt_out[0] + u_out[0]*handle_len, pt_out[1] + u_out[1]*handle_len, 0.0)
            
            # Add fillet start
            rounded_points.append((pt_in, 'FREE', h_in_left, h_in_right))
            # Add fillet end
            rounded_points.append((pt_out, 'FREE', h_out_left, h_out_right))
        else:
            # Collinear point
            rounded_points.append((p_curr, 'VECTOR', p_curr, p_curr))
            
    # End point
    rounded_points.append((points[-1], 'VECTOR', points[-1], points[-1]))
    
    return rounded_points

def build_curve_from_path(rounded_points, name="wall_curve"):
    """Create a Blender Bezier curve from rounded points."""
    curve_data = bpy.data.curves.new(name=name, type='CURVE')
    curve_data.dimensions = '3D'
    curve_data.fill_mode = 'FULL'
    
    spline = curve_data.splines.new(type='BEZIER')
    spline.bezier_points.add(len(rounded_points) - 1)
    
    for i, (co, h_type, hl, hr) in enumerate(rounded_points):
        bp = spline.bezier_points[i]
        bp.co = co
        bp.handle_left = hl
        bp.handle_right = hr
        bp.handle_left_type = h_type
        bp.handle_right_type = h_type
        
    obj = bpy.data.objects.new(name, curve_data)
    bpy.context.scene.collection.objects.link(obj)
    return obj

def build_maze_walls(paths, profile):
    """Build the final wall meshes by deforming the profile Cube.003 along the paths."""
    wall_objects = []
    
    for idx, path in enumerate(paths):
        # Round the path
        rounded = round_path_corners(path, FILLET_RADIUS)
        
        # Create curve
        curve = build_curve_from_path(rounded, name=f"curve_{idx}")
        
        # Duplicate profile mesh
        wall_mesh = profile.copy()
        wall_mesh.data = profile.data.copy()
        wall_mesh.name = f"wall_mesh_{idx}"
        wall_mesh.hide_viewport = False
        wall_mesh.hide_render = False
        bpy.context.scene.collection.objects.link(wall_mesh)
        
        # Position at curve origin (0, 0, 0)
        wall_mesh.location = (0, 0, 0)
        wall_mesh.rotation_euler = (0, 0, 0)
        wall_mesh.scale = (1, 1, 1)
        
        # Add Array modifier
        arr = wall_mesh.modifiers.new(name="Array", type='ARRAY')
        arr.fit_type = 'FIT_CURVE'
        arr.curve = curve
        # Offset along X (which is the length axis of Cube.003)
        arr.relative_offset_displace = (1.0, 0.0, 0.0)
        arr.use_merge_vertices = True
        arr.merge_threshold = 0.01
        
        # Add Curve modifier
        curv_mod = wall_mesh.modifiers.new(name="Curve", type='CURVE')
        curv_mod.object = curve
        curv_mod.deform_axis = 'POS_X'
        
        # Update view layer to synchronize the new objects
        bpy.context.view_layer.update()
        
        # Select and set active
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = wall_mesh
        wall_mesh.select_set(True)
        
        # Apply modifiers
        bpy.ops.object.modifier_apply(modifier="Array")
        bpy.ops.object.modifier_apply(modifier="Curve")
        
        wall_objects.append(wall_mesh)
        
        # Delete temporary curve
        bpy.ops.object.select_all(action='DESELECT')
        curve.select_set(True)
        bpy.ops.object.delete()
        
    return wall_objects

def create_floor():
    """Create the floor plate."""
    bpy.ops.mesh.primitive_cube_add(
        size=1,
        location=(0, 0, -FLOOR_THICKNESS / 2)
    )
    floor = bpy.context.active_object
    floor.name = "labirint2_floor"
    floor.scale = (MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, 
                   MAZE_TOTAL_SIZE + OUTER_WALL_THICKNESS * 2, 
                   FLOOR_THICKNESS)
    bpy.ops.object.transform_apply(scale=True)
    return floor

def main():
    print("\n" + "=" * 60)
    print("ROUNDED MAZE GENERATOR (labirint2)")
    print("=" * 60)
    
    # 1. Setup scene
    clear_scene_except_profile()
    profile = load_profile()
    
    # Hide profile from export
    profile.hide_viewport = True
    profile.hide_render = True
    
    # 2. Generate maze structure
    cells = generate_maze_grid(seed=123)
    edges = get_wall_edges(cells)
    paths = extract_non_branching_paths(edges)
    
    print(f"Generated {len(paths)} separate wall paths.")
    
    # 3. Build wall objects
    wall_objs = build_maze_walls(paths, profile)
    
    # 4. Join all walls into one object
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    for obj in wall_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = wall_objs[0]
    bpy.ops.object.join()
    
    joined_walls = bpy.context.active_object
    print(f"Joined Walls: {joined_walls.name if joined_walls else 'None'}, vertices count={len(joined_walls.data.vertices) if joined_walls else 0}")
    joined_walls.name = "labirint2_walls"
    
    # Apply flat shading (no smooth, no bevel as requested: "точь-в-точь, без smooth и bevel")
    bpy.ops.object.shade_flat()
    
    # Apply WallsMaterial
    mat_walls = bpy.data.materials.new(name="WallsMaterial")
    joined_walls.data.materials.append(mat_walls)
    
    # 5. Create Floor
    floor = create_floor()
    mat_floor = bpy.data.materials.new(name="FloorMaterial")
    floor.data.materials.append(mat_floor)
    
    # 6. Export FBX
    bpy.ops.object.select_all(action='SELECT')
    # Make sure profile is NOT selected for export
    profile.select_set(False)
    
    bpy.ops.export_scene.fbx(
        filepath=OUTPUT_FBX,
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
    
    print(f"Exported rounded maze to: {OUTPUT_FBX}")
    print("=" * 60)

if __name__ == "__main__":
    main()
