import { useState, useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Loader2, AlertCircle, MapPin } from 'lucide-react'

// Leaflet's default marker icon resolves its image paths relative to the
// built JS bundle, which breaks under Vite (404s for marker-icon.png etc.)
// unless you rewrite the asset URLs — an inline-SVG DivIcon sidesteps that
// entirely instead.
const pinIcon = L.divIcon({
    className: '',
    html: `<svg width="28" height="40" viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.5))">
        <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24c0-6.6-5.4-12-12-12z" fill="#f59e0b"/>
        <circle cx="12" cy="12" r="5" fill="#18181b"/>
    </svg>`,
    iconSize: [28, 40],
    iconAnchor: [14, 40],
    popupAnchor: [0, -34],
})

export default function GeoMapWidget({ normalizerModelId, normalizerUrl }) {
    const [location, setLocation] = useState(null)
    const [loading, setLoading]   = useState(false)
    const [error, setError]       = useState(null)

    const base = (normalizerUrl || '').replace(/\/$/, '')

    useEffect(() => {
        if (!normalizerModelId) return

        // Reset stale data immediately so the previous model's pin isn't
        // briefly visible while the new model's location fetches.
        setLocation(null)
        setError(null)
        setLoading(true)

        const ctrl = new AbortController()
        fetch(`${base}/models/${normalizerModelId}/location`, { signal: ctrl.signal })
            .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
            .then(setLocation)
            .catch(e => {
                if (e?.name === 'AbortError') return
                setError(e instanceof Error ? e.message : String(e))
            })
            .finally(() => setLoading(false))

        return () => ctrl.abort()
    }, [normalizerModelId, base])

    if (!normalizerModelId) return (
        <div className="flex items-center justify-center h-40 text-zinc-500 text-sm">
            Load a model to see its location.
        </div>
    )

    if (loading) return (
        <div className="flex items-center justify-center h-40 gap-2 text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading location…</span>
        </div>
    )

    if (error) return (
        <div className="flex items-center gap-2 p-4 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
        </div>
    )

    if (!location || location.lat == null || location.lon == null) return (
        <div className="flex flex-col items-center justify-center h-40 gap-1.5 text-zinc-500 text-sm text-center px-6">
            <MapPin className="w-5 h-5 text-zinc-600" />
            No location data in this model.
            <span className="text-xs text-zinc-600">
                Site geo-reference (IfcSite RefLatitude/RefLongitude) is only present in models imported from an IFC file.
            </span>
        </div>
    )

    const { lat, lon, elevation, site_name } = location
    const position = [lat, lon]

    return (
        <div className="h-full w-full">
            <MapContainer
                key={`${normalizerModelId}:${lat}:${lon}`}
                center={position}
                zoom={16}
                scrollWheelZoom
                style={{ height: '100%', width: '100%' }}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <Marker position={position} icon={pinIcon}>
                    <Popup>
                        <div className="text-sm">
                            <div className="font-semibold">{site_name || 'Site'}</div>
                            <div>{lat.toFixed(6)}, {lon.toFixed(6)}</div>
                            {elevation != null && (
                                <div className="text-xs text-zinc-500">Elevation: {elevation} m</div>
                            )}
                        </div>
                    </Popup>
                </Marker>
            </MapContainer>
        </div>
    )
}
