// 2-point-pair 2D similarity transform (translate + rotate + uniform scale)
// for the drawing-to-3D-model alignment feature. 2 point pairs is exactly
// enough to solve for the 4 unknowns (tx, ty, rotation, scale) — a
// closed-form solve, not a least-squares/Kabsch problem (that's for >=3
// pairs or noisy/overdetermined data).

export class DegenerateAlignmentPointsError extends Error {}

// drawing1/drawing2 are true (unshifted) DXF modelspace {x, y} points;
// world1/world2 are the corresponding Speckle viewer world {x, y} points
// (Z is handled separately as a user-supplied elevation, not solved here).
export function solveAlignmentTransform(drawing1, drawing2, world1, world2) {
    const dx = drawing2.x - drawing1.x
    const dy = drawing2.y - drawing1.y
    const drawingLen = Math.hypot(dx, dy)
    if (drawingLen < 1e-9) {
        throw new DegenerateAlignmentPointsError('The two drawing points must be distinct')
    }

    const wx = world2.x - world1.x
    const wy = world2.y - world1.y
    const worldLen = Math.hypot(wx, wy)
    if (worldLen < 1e-9) {
        throw new DegenerateAlignmentPointsError('The two 3D points must be distinct')
    }

    const scale = worldLen / drawingLen
    const rotation_rad = Math.atan2(wy, wx) - Math.atan2(dy, dx)

    const cos = Math.cos(rotation_rad)
    const sin = Math.sin(rotation_rad)
    // Where drawing1 lands after rotate+scale (about the drawing origin);
    // translation is whatever's needed to then land it on world1.
    const rotatedScaledX = scale * (drawing1.x * cos - drawing1.y * sin)
    const rotatedScaledY = scale * (drawing1.x * sin + drawing1.y * cos)
    const tx = world1.x - rotatedScaledX
    const ty = world1.y - rotatedScaledY

    return { tx, ty, rotation_rad, scale }
}

// Applies a solved transform to a drawing-space {x, y} point, returning the
// corresponding world-space {x, y}. Used both for the live calibration
// preview and for positioning the overlay plane's corners.
export function applyAlignmentTransform(transform, point) {
    const { tx, ty, rotation_rad, scale } = transform
    const cos = Math.cos(rotation_rad)
    const sin = Math.sin(rotation_rad)
    return {
        x: tx + scale * (point.x * cos - point.y * sin),
        y: ty + scale * (point.x * sin + point.y * cos),
    }
}
