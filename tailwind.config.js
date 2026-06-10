/** @type {import('tailwindcss').Config} */
// Speckle design tokens — mirrored from @speckle/tailwind-theme
// Source: packages/tailwind-theme/src/plugin.ts (specklesystems/speckle-server)
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
            },
            colors: {
                // Speckle primary
                primary: {
                    DEFAULT: '#136CFF',
                    focus:   '#0057E5',
                    muted:   'var(--speckle-primary-muted)',
                },
                // Speckle foundation (surfaces)
                foundation: {
                    DEFAULT: 'var(--speckle-foundation)',
                    page:    'var(--speckle-foundation-page)',
                    2:       'var(--speckle-foundation-2)',
                    3:       'var(--speckle-foundation-3)',
                    4:       'var(--speckle-foundation-4)',
                    5:       'var(--speckle-foundation-5)',
                },
                // Speckle foreground (text)
                foreground: {
                    DEFAULT:   'var(--speckle-foreground)',
                    2:         'var(--speckle-foreground-2)',
                    3:         'var(--speckle-foreground-3)',
                    disabled:  'var(--speckle-foreground-disabled)',
                    'on-primary': 'var(--speckle-foreground-on-primary)',
                },
                // Speckle outline (borders)
                outline: {
                    1: 'var(--speckle-outline-1)',
                    2: 'var(--speckle-outline-2)',
                    3: 'var(--speckle-outline-3)',
                    4: 'var(--speckle-outline-4)',
                    5: 'var(--speckle-outline-5)',
                },
                // Speckle status
                success: {
                    DEFAULT: '#34D399',
                    lighter: '#53EDB5',
                    darker:  '#1CBA80',
                },
                warning: {
                    DEFAULT: '#FBBF24',
                    lighter: '#FFD770',
                    darker:  '#E0AB20',
                },
                danger: {
                    DEFAULT: 'var(--speckle-danger)',
                    lighter: 'var(--speckle-danger-lighter)',
                    darker:  'var(--speckle-danger-darker)',
                },
                info: {
                    DEFAULT: '#B8C0CC',
                },
            },
            animation: {
                'pulse-slow': 'pulse 3s infinite',
            },
        },
    },
    plugins: [],
}
