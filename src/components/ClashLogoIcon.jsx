// Two isometric cubes crossing — the neutral cube uses currentColor so it
// inherits whatever text color the surrounding button/header is themed with
// (visible on both dark and light chrome), while the colliding cube is tied
// to --speckle-danger so it follows the app's existing per-theme red instead
// of a hardcoded hex.
export function ClashLogoIcon({ className = '' }) {
    return (
        <svg viewBox="0 0 38 38" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
                d="M15 6 L22.79 10.5 L22.79 19.5 L15 24 L7.21 19.5 L7.21 10.5 Z
                   M7.21 10.5 L15 15 L22.79 10.5 M15 15 L15 24"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinejoin="round"
                strokeLinecap="round"
            />
            <path
                d="M23 14 L30.79 18.5 L30.79 27.5 L23 32 L15.21 27.5 L15.21 18.5 Z"
                fill="var(--speckle-danger)"
                fillOpacity="0.2"
                stroke="var(--speckle-danger)"
                strokeWidth="2.6"
                strokeLinejoin="round"
                strokeLinecap="round"
            />
            <path
                d="M15.21 18.5 L23 23 L30.79 18.5 M23 23 L23 32"
                stroke="var(--speckle-danger)"
                strokeWidth="2.6"
                strokeLinejoin="round"
                strokeLinecap="round"
            />
        </svg>
    )
}
