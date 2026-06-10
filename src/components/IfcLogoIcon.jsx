export function IfcLogoIcon({ className = '' }) {
    return (
        <span
            className={className}
            style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: 'white', borderRadius: 3,
            }}
        >
            <img
                src="/buildingSMART%20International%20Icon%20-%20color.png"
                alt="IFC"
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
        </span>
    )
}
