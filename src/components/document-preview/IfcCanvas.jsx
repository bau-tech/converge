import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { Loader2 } from 'lucide-react'

// Standalone IFC-in-3D preview for an arbitrary uploaded document — separate
// from the app's main SpeckleViewer (which renders Speckle stream data, not
// raw IFC bytes). Uses web-ifc's WASM parser directly against this project's
// existing three.js (pinned to match @speckle/viewer's own version) rather
// than pulling in a second, heavier viewer library with its own three.js.
export function IfcCanvas({ url }) {
    const containerRef = useRef(null)
    const [status, setStatus] = useState('loading') // loading | ready | error
    const [error, setError] = useState(null)

    useEffect(() => {
        let cancelled = false
        let renderer, scene, camera, controls, animationId
        let ifcApi, modelID

        const resize = () => {
            const el = containerRef.current
            if (!el || !renderer || !camera) return
            const { clientWidth, clientHeight } = el
            renderer.setSize(clientWidth, clientHeight)
            camera.aspect = clientWidth / (clientHeight || 1)
            camera.updateProjectionMatrix()
        }

        async function load() {
            try {
                const WebIFC = await import('web-ifc')
                ifcApi = new WebIFC.IfcAPI()
                ifcApi.SetWasmPath('/wasm/', true)
                await ifcApi.Init()
                if (cancelled) return

                const res = await fetch(url)
                if (!res.ok) throw new Error(`Could not download file (${res.status})`)
                const buffer = new Uint8Array(await res.arrayBuffer())
                if (cancelled) return

                modelID = ifcApi.OpenModel(buffer)

                const geometries = []
                const transparentGeometries = []
                const materialCache = new Map()

                const getMaterial = (color) => {
                    const key = `${color.x}_${color.y}_${color.z}_${color.w}`
                    let mat = materialCache.get(key)
                    if (mat) return mat
                    mat = new THREE.MeshPhongMaterial({
                        color: new THREE.Color(color.x, color.y, color.z),
                        side: THREE.DoubleSide,
                    })
                    if (color.w !== 1) { mat.transparent = true; mat.opacity = color.w }
                    materialCache.set(key, mat)
                    return mat
                }

                ifcApi.StreamAllMeshes(modelID, (flatMesh) => {
                    const placedGeometries = flatMesh.geometries
                    for (let i = 0; i < placedGeometries.size(); i++) {
                        const placedGeometry = placedGeometries.get(i)
                        const geom = ifcApi.GetGeometry(modelID, placedGeometry.geometryExpressID)
                        const verts = ifcApi.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize())
                        const indices = ifcApi.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize())
                        geom.delete()

                        const posFloats = new Float32Array(verts.length / 2)
                        const normFloats = new Float32Array(verts.length / 2)
                        for (let v = 0; v < verts.length; v += 6) {
                            posFloats[v / 2] = verts[v]; posFloats[v / 2 + 1] = verts[v + 1]; posFloats[v / 2 + 2] = verts[v + 2]
                            normFloats[v / 2] = verts[v + 3]; normFloats[v / 2 + 1] = verts[v + 4]; normFloats[v / 2 + 2] = verts[v + 5]
                        }
                        const bufferGeometry = new THREE.BufferGeometry()
                        bufferGeometry.setAttribute('position', new THREE.BufferAttribute(posFloats, 3))
                        bufferGeometry.setAttribute('normal', new THREE.BufferAttribute(normFloats, 3))
                        bufferGeometry.setIndex(new THREE.BufferAttribute(indices, 1))

                        const matrix = new THREE.Matrix4().fromArray(placedGeometry.flatTransformation)
                        bufferGeometry.applyMatrix4(matrix)

                        const mat = getMaterial(placedGeometry.color)
                        bufferGeometry.userData.__mat = mat
                        if (placedGeometry.color.w !== 1) transparentGeometries.push(bufferGeometry)
                        else geometries.push(bufferGeometry)
                    }
                })

                if (cancelled) return
                if (geometries.length === 0 && transparentGeometries.length === 0) {
                    throw new Error('No renderable geometry found in this IFC file')
                }

                scene = new THREE.Scene()
                scene.background = new THREE.Color(0x1a1a1a)

                // useGroups=true preserves each source geometry's material as a
                // draw-range group on the merged geometry, so passing the
                // per-geometry materials (extracted from the IFC's own element
                // colors, via getMaterial() above) renders real colors instead
                // of one flat tint for the whole model.
                if (geometries.length > 0) {
                    const merged = mergeBufferGeometries(geometries, true)
                    const mesh = new THREE.Mesh(merged, geometries.map(g => g.userData.__mat))
                    scene.add(mesh)
                }
                if (transparentGeometries.length > 0) {
                    const merged = mergeBufferGeometries(transparentGeometries, true)
                    const mesh = new THREE.Mesh(merged, transparentGeometries.map(g => g.userData.__mat))
                    scene.add(mesh)
                }

                const box = new THREE.Box3().setFromObject(scene)
                const size = box.getSize(new THREE.Vector3())
                const center = box.getCenter(new THREE.Vector3())
                const maxDim = Math.max(size.x, size.y, size.z, 1)

                camera = new THREE.PerspectiveCamera(60, 1, maxDim / 1000, maxDim * 100)
                camera.position.set(center.x + maxDim, center.y + maxDim, center.z + maxDim)
                camera.lookAt(center)

                scene.add(new THREE.AmbientLight(0xffffff, 0.6))
                const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
                dirLight.position.set(1, 2, 1)
                scene.add(dirLight)

                renderer = new THREE.WebGLRenderer({ antialias: true })
                containerRef.current.appendChild(renderer.domElement)

                controls = new OrbitControls(camera, renderer.domElement)
                controls.target.copy(center)
                controls.update()

                resize()
                window.addEventListener('resize', resize)

                const animate = () => {
                    animationId = requestAnimationFrame(animate)
                    controls.update()
                    renderer.render(scene, camera)
                }
                animate()

                setStatus('ready')
            } catch (err) {
                if (!cancelled) {
                    setError(err.message)
                    setStatus('error')
                }
            }
        }

        load()

        return () => {
            cancelled = true
            window.removeEventListener('resize', resize)
            if (animationId) cancelAnimationFrame(animationId)
            if (controls) controls.dispose()
            if (renderer) {
                renderer.dispose()
                renderer.domElement?.remove()
            }
            if (scene) {
                scene.traverse((obj) => {
                    if (obj.geometry) obj.geometry.dispose()
                })
            }
            try {
                if (ifcApi && modelID !== undefined) ifcApi.CloseModel(modelID)
            } catch { /* already closed */ }
        }
    }, [url])

    return (
        <div className="relative w-full h-full">
            <div ref={containerRef} className="w-full h-full" />
            {status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-[var(--speckle-foreground-3)]">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading IFC geometry…
                </div>
            )}
            {status === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 px-8 text-center">
                    Could not preview this IFC file: {error}
                </div>
            )}
        </div>
    )
}
