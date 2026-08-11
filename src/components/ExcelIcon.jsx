// Official Excel file-type icon, sourced from Microsoft's own Fluent UI
// System Icons file-type asset CDN (res.cdn.office.net — the same source
// their open-source @fluentui/react-icons-file-type package resolves
// against), same "official asset, no backdrop" pattern as IfcLogoIcon/
// BcfLogoIcon/IdsLogoIcon.
export function ExcelIcon({ className = '' }) {
    return (
        <img
            src="/excel-icon.svg"
            alt="Excel spreadsheet"
            className={className}
            style={{ objectFit: 'contain', display: 'block' }}
        />
    )
}
