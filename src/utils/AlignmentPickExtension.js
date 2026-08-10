// 3D point-picking for the drawing-to-3D-model alignment feature — mimics
// @speckle/viewer's own MeasurementsExtension (raycast off
// viewer.getRenderer().input's Click event, via the same
// Intersections/queryHitIds primitives) rather than inventing a new picking
// mechanism. Kept "dumb" on purpose: this extension only picks points and
// draws marker spheres for them — the pick/pick/confirm state machine lives
// in AlignmentPanel.jsx, which listens for the Picked event and decides
// what a given click means (point 1 vs point 2, ignore, etc).
import { Extension, CameraController, InputEvent, ObjectLayers } from '@speckle/viewer'
import { Mesh, MeshBasicMaterial, SphereGeometry } from 'three'

export const AlignmentPickEvent = { Picked: 'alignment-pick-picked' }

const MARKER_COLORS = [0x04d9ff, 0xffb703] // point 1, point 2 — distinguishable at a glance

export class AlignmentPickExtension extends Extension {
    get inject() {
        return [CameraController]
    }

    constructor(viewer, cameraProvider) {
        super(viewer, cameraProvider)
        this._markers = [null, null]
        this._onClick = this._onClick.bind(this)
    }

    get enabled() {
        return super.enabled
    }

    set enabled(value) {
        super.enabled = value
        const input = this.viewer.getRenderer().input
        if (value) input.on(InputEvent.Click, this._onClick)
        else input.removeListener(InputEvent.Click, this._onClick)
        if (!value) this.clearMarkers()
    }

    _onClick(arg) {
        const renderer = this.viewer.getRenderer()
        const camera = renderer.renderingCamera
        if (!camera) return
        const results = renderer.intersections.intersect(
            renderer.scene, camera, arg, ObjectLayers.STREAM_CONTENT_MESH, true
        )
        if (!results || !results.length) return
        const hits = renderer.queryHitIds(results)
        if (!hits || !hits.length) return
        const { point } = hits[0]
        this.emit(AlignmentPickEvent.Picked, { x: point.x, y: point.y, z: point.z })
    }

    // index: 0 or 1 (point 1 / point 2). Called by AlignmentPanel.jsx once
    // it's decided what a pick means — not automatic, since re-picking an
    // already-set point (or picking point 2 before point 1) is valid.
    setMarker(index, worldPoint) {
        const renderer = this.viewer.getRenderer()
        this._removeMarker(index)
        const geo = new SphereGeometry(0.15, 16, 16)
        const mat = new MeshBasicMaterial({ color: MARKER_COLORS[index] ?? 0xffffff, depthTest: false })
        const mesh = new Mesh(geo, mat)
        // OVERLAY layer — a plain THREE.Mesh added to the scene defaults to
        // layer 0, which the actual rendering camera's layers.mask (48 =
        // OVERLAY + MEASUREMENTS) excludes, so it would silently never
        // render otherwise. Confirmed via a live headless-browser spike
        // against this exact viewer before this extension was written.
        mesh.layers.set(ObjectLayers.OVERLAY)
        mesh.renderOrder = 999 // draw on top — depthTest is off, so paint order matters
        mesh.position.set(worldPoint.x, worldPoint.y, worldPoint.z)
        renderer.scene.add(mesh)
        this._markers[index] = mesh
        this.viewer.requestRender()
    }

    _removeMarker(index) {
        const mesh = this._markers[index]
        if (!mesh) return
        this.viewer.getRenderer().scene.remove(mesh)
        mesh.geometry.dispose()
        mesh.material.dispose()
        this._markers[index] = null
    }

    clearMarkers() {
        this._removeMarker(0)
        this._removeMarker(1)
        this.viewer.requestRender()
    }

    dispose() {
        this.enabled = false
        this.clearMarkers()
        super.dispose()
    }
}
