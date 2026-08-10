import { BufferGeometry, Sphere } from 'three'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'

// Works around a confirmed @speckle/viewer bug: loading multiple root
// objects into one WorldTree (the combined/federated-view feature —
// SpeckleViewer.jsx's federated-models loading effect) produces geometry
// batches whose computeBoundingSphere() comes back with radius: NaN (seen
// for both plain BufferGeometry and, more often, the LineSegmentsGeometry
// used for edge/outline rendering — same bug, same stack trace, confirmed
// absent in single-model loading). A NaN bounding sphere on one batch
// appears to poison scene-wide operations that assume every batch has a
// finite bounds — outline highlighting for one of two selected elements,
// per-model tint colors on the largest combined model, and visibility
// toggling all silently no-op once any batch in the scene has this.
//
// This can't be fixed by anything we control on the loading/call side (no
// newer @speckle/viewer version fixes it; the zoomToObject load flag makes
// no difference; the multiple-loadObject-calls pattern that triggers it is
// Speckle's own documented, intended way to do combined viewing, not a
// misuse). So: patch the two geometry classes' computeBoundingSphere at the
// source, recomputing a genuinely finite fallback sphere from whichever
// finite vertex data actually exists whenever the original computation
// comes back non-finite, instead of letting NaN/Infinity leak into
// anything downstream.
//
// Both @speckle/viewer's bundle and this file resolve the same `three`
// package (confirmed: it imports LineSegmentsGeometry from the identical
// "three/examples/jsm/lines/LineSegmentsGeometry.js" path) — ES modules are
// cached per resolved path, so patching the prototype here patches the
// exact class @speckle/viewer's own code calls into, not a separate copy.

let installed = false

function boundsFromAttributes(attributes, names, itemSize = 3) {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    let any = false
    for (const name of names) {
        const attr = attributes?.[name]
        const arr = attr?.array
        if (!arr) continue
        for (let i = 0; i + itemSize - 1 < arr.length; i += itemSize) {
            const x = arr[i], y = arr[i + 1], z = arr[i + 2]
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
            any = true
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            if (z < minZ) minZ = z
            if (z > maxZ) maxZ = z
        }
    }
    return any ? { minX, minY, minZ, maxX, maxY, maxZ } : null
}

function patchClass(GeometryClass, attributeNames) {
    const proto = GeometryClass?.prototype
    if (!proto?.computeBoundingSphere) return
    const original = proto.computeBoundingSphere
    proto.computeBoundingSphere = function patchedComputeBoundingSphere(...args) {
        original.apply(this, args)
        const sphere = this.boundingSphere
        const finite = sphere
            && Number.isFinite(sphere.center.x) && Number.isFinite(sphere.center.y) && Number.isFinite(sphere.center.z)
            && Number.isFinite(sphere.radius)
        if (finite) return

        console.warn('[patchNaNSafeBoundingSphere] non-finite bounding sphere recovered for', GeometryClass.name)
        const bounds = boundsFromAttributes(this.attributes, attributeNames)
        if (!this.boundingSphere) this.boundingSphere = new Sphere()
        if (!bounds) {
            // No finite vertex data at all — degenerate but finite, so
            // nothing downstream inherits NaN/Infinity from this batch.
            this.boundingSphere.center.set(0, 0, 0)
            this.boundingSphere.radius = 0
            return
        }
        this.boundingSphere.center.set(
            (bounds.minX + bounds.maxX) / 2,
            (bounds.minY + bounds.maxY) / 2,
            (bounds.minZ + bounds.maxZ) / 2,
        )
        const dx = bounds.maxX - bounds.minX
        const dy = bounds.maxY - bounds.minY
        const dz = bounds.maxZ - bounds.minZ
        this.boundingSphere.radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2
    }
}

export function installNaNSafeBoundingSphere() {
    if (installed) return
    installed = true
    // Plain meshes/points — real vertex data lives directly in `position`.
    patchClass(BufferGeometry, ['position'])
    // Instanced thick lines (used for edge/outline rendering) — the base
    // `position`/`uv` attributes are just a template quad, not world
    // positions; the actual per-segment endpoints are instanceStart/End.
    patchClass(LineSegmentsGeometry, ['instanceStart', 'instanceEnd'])
}
