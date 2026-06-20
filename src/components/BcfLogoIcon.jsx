// Official BCF icon, sourced from buildingSMART's own BCF-API repo
// (https://github.com/BuildingSMART/BCF/blob/master/Icons/BCFicon128.png).
// No backdrop — the source PNG is already transparent, same as IfcLogoIcon/IdsLogoIcon.
export function BcfLogoIcon({ className = '' }) {
    return (
        <img
            src="/BCF-icon.png"
            alt="BCF"
            className={className}
            style={{ objectFit: 'contain', display: 'block' }}
        />
    )
}
