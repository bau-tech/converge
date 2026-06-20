// Starter templates for the IDS Visual Editor's "Templates" picker. Each
// references standard buildingSMART property sets and generic industry
// classification codes (EN 13501 fire classes, RC resistance classes, etc.)
// — public technical facts, not anyone's proprietary content — but the
// selection, naming, descriptions, and grouping here are written
// independently for this editor, not ported from any third-party tool's
// source (see the AGPL note in IdsGraphEditor.jsx for why).
//
// Node/edge indices are positions within the template's own `nodes` array;
// instantiateTemplate() below resolves them to freshly generated graph ids
// and lays nodes out in columns (facets left, restrictions middle, spec right).
export const SPEC_TEMPLATES = [
    // ── Safety ────────────────────────────────────────────────────────────
    {
        id: 'walls-fire-rating',
        name: 'Walls — Fire Rating',
        category: 'Safety',
        description: 'All walls must declare a fire rating',
        nodes: [
            { type: 'spec', data: { name: 'Walls-FireRating', ifcVersion: 'IFC4X3_ADD2', description: 'All walls must have a fire rating specified' } },
            { type: 'entity', data: { name: 'IFCWALL', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_WallCommon', baseName: 'FireRating', dataType: 'IFCLABEL', value: '', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },
    {
        id: 'doors-fire-exit',
        name: 'Doors — Fire Exit Compliance',
        category: 'Safety',
        description: 'Fire exit doors must declare fire rating and self-closing behavior',
        nodes: [
            { type: 'spec', data: { name: 'Doors-FireExit', ifcVersion: 'IFC4X3_ADD2', description: 'Fire exit doors must meet safety requirements' } },
            { type: 'entity', data: { name: 'IFCDOOR', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_DoorCommon', baseName: 'FireExit', dataType: 'IFCBOOLEAN', value: 'true', cardinality: 'required' } },
            { type: 'property', data: { propertySet: 'Pset_DoorCommon', baseName: 'FireRating', dataType: 'IFCLABEL', value: '', cardinality: 'required' } },
            { type: 'property', data: { propertySet: 'Pset_DoorCommon', baseName: 'SelfClosing', dataType: 'IFCBOOLEAN', value: 'true', cardinality: 'required' } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 0, targetHandle: 'applicability' },
            { from: 3, to: 0, targetHandle: 'requirements' },
            { from: 4, to: 0, targetHandle: 'requirements' },
        ],
    },
    {
        id: 'stairs-fire-safety',
        name: 'Stairs — Fire & Accessibility',
        category: 'Safety',
        description: 'Stairs must declare fire rating and accessibility',
        nodes: [
            { type: 'spec', data: { name: 'Stairs-Safety', ifcVersion: 'IFC4X3_ADD2', description: 'Stairs must meet fire rating and accessibility requirements' } },
            { type: 'entity', data: { name: 'IFCSTAIR', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_StairCommon', baseName: 'FireRating', dataType: 'IFCLABEL', value: '', cardinality: 'required' } },
            { type: 'property', data: { propertySet: 'Pset_StairCommon', baseName: 'HandicapAccessible', dataType: 'IFCBOOLEAN', value: '', cardinality: 'required' } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 0, targetHandle: 'requirements' },
            { from: 3, to: 0, targetHandle: 'requirements' },
        ],
    },

    // ── Structure ─────────────────────────────────────────────────────────
    {
        id: 'columns-load-bearing',
        name: 'Columns — Load Bearing',
        category: 'Structure',
        description: 'Structural columns must be flagged as load bearing',
        nodes: [
            { type: 'spec', data: { name: 'Columns-LoadBearing', ifcVersion: 'IFC4X3_ADD2', description: 'All structural columns must be marked load bearing' } },
            { type: 'entity', data: { name: 'IFCCOLUMN', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_ColumnCommon', baseName: 'LoadBearing', dataType: 'IFCBOOLEAN', value: 'true', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'applicability' }],
    },
    {
        id: 'beams-structural',
        name: 'Beams — Structural Properties',
        category: 'Structure',
        description: 'Beams need load-bearing and fire-rating data',
        nodes: [
            { type: 'spec', data: { name: 'Beams-Structural', ifcVersion: 'IFC4X3_ADD2', description: 'Beams must declare load bearing status and fire rating' } },
            { type: 'entity', data: { name: 'IFCBEAM', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_BeamCommon', baseName: 'LoadBearing', dataType: 'IFCBOOLEAN', value: 'true', cardinality: 'required' } },
            { type: 'property', data: { propertySet: 'Pset_BeamCommon', baseName: 'FireRating', dataType: 'IFCLABEL', value: '', cardinality: 'required' } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 0, targetHandle: 'requirements' },
            { from: 3, to: 0, targetHandle: 'requirements' },
        ],
    },
    {
        id: 'slabs-load-bearing',
        name: 'Slabs — Load Bearing & Reference',
        category: 'Structure',
        description: 'Structural slabs must be flagged load bearing with a reference id',
        nodes: [
            { type: 'spec', data: { name: 'Slabs-LoadBearing', ifcVersion: 'IFC4X3_ADD2', description: 'Structural slabs must declare load bearing status and a reference identifier' } },
            { type: 'entity', data: { name: 'IFCSLAB', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_SlabCommon', baseName: 'LoadBearing', dataType: 'IFCBOOLEAN', value: 'true', cardinality: 'required' } },
            { type: 'property', data: { propertySet: 'Pset_SlabCommon', baseName: 'Reference', dataType: 'IFCIDENTIFIER', value: '', cardinality: 'required' } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 0, targetHandle: 'applicability' },
            { from: 3, to: 0, targetHandle: 'requirements' },
        ],
    },

    // ── Space ─────────────────────────────────────────────────────────────
    {
        id: 'spaces-min-area',
        name: 'Spaces — Minimum Area',
        category: 'Space',
        description: 'Spaces must declare a planned net area',
        nodes: [
            { type: 'spec', data: { name: 'Spaces-MinArea', ifcVersion: 'IFC4X3_ADD2', description: 'Spaces must meet minimum area requirements' } },
            { type: 'entity', data: { name: 'IFCSPACE', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_SpaceCommon', baseName: 'NetPlannedArea', dataType: 'IFCAREAMEASURE', value: '', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },
    {
        id: 'spaces-occupancy',
        name: 'Spaces — Occupancy Type',
        category: 'Space',
        description: 'Spaces must declare an occupancy type',
        nodes: [
            { type: 'spec', data: { name: 'Spaces-Occupancy', ifcVersion: 'IFC4X3_ADD2', description: 'Spaces must declare their occupancy type' } },
            { type: 'entity', data: { name: 'IFCSPACE', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_SpaceOccupancyRequirements', baseName: 'OccupancyType', dataType: 'IFCLABEL', value: '', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },

    // ── Energy ────────────────────────────────────────────────────────────
    {
        id: 'external-walls-thermal',
        name: 'External Walls — Thermal Performance',
        category: 'Energy',
        description: 'External walls must meet a thermal transmittance value',
        nodes: [
            { type: 'spec', data: { name: 'ExternalWalls-Thermal', ifcVersion: 'IFC4X3_ADD2', description: 'External walls must meet thermal performance requirements' } },
            { type: 'entity', data: { name: 'IFCWALL', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_WallCommon', baseName: 'IsExternal', dataType: 'IFCBOOLEAN', value: 'true', cardinality: 'required' } },
            { type: 'property', data: { propertySet: 'Pset_WallCommon', baseName: 'ThermalTransmittance', dataType: 'IFCTHERMALTRANSMITTANCEMEASURE', value: '', cardinality: 'required' } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 0, targetHandle: 'applicability' },
            { from: 3, to: 0, targetHandle: 'requirements' },
        ],
    },
    {
        id: 'windows-thermal',
        name: 'Windows — Thermal Performance',
        category: 'Energy',
        description: 'External windows must meet a thermal transmittance value',
        nodes: [
            { type: 'spec', data: { name: 'Windows-Thermal', ifcVersion: 'IFC4X3_ADD2', description: 'External windows must meet thermal performance requirements' } },
            { type: 'entity', data: { name: 'IFCWINDOW', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_WindowCommon', baseName: 'IsExternal', dataType: 'IFCBOOLEAN', value: 'true', cardinality: 'required' } },
            { type: 'property', data: { propertySet: 'Pset_WindowCommon', baseName: 'ThermalTransmittance', dataType: 'IFCTHERMALTRANSMITTANCEMEASURE', value: '', cardinality: 'required' } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 0, targetHandle: 'applicability' },
            { from: 3, to: 0, targetHandle: 'requirements' },
        ],
    },
    {
        id: 'roofs-thermal',
        name: 'Roofs — Thermal Performance',
        category: 'Energy',
        description: 'External roofs must meet a thermal transmittance value',
        nodes: [
            { type: 'spec', data: { name: 'Roofs-Thermal', ifcVersion: 'IFC4X3_ADD2', description: 'External roofs must meet thermal performance requirements' } },
            { type: 'entity', data: { name: 'IFCROOF', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_RoofCommon', baseName: 'IsExternal', dataType: 'IFCBOOLEAN', value: 'true', cardinality: 'required' } },
            { type: 'property', data: { propertySet: 'Pset_RoofCommon', baseName: 'ThermalTransmittance', dataType: 'IFCTHERMALTRANSMITTANCEMEASURE', value: '', cardinality: 'required' } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 0, targetHandle: 'applicability' },
            { from: 3, to: 0, targetHandle: 'requirements' },
        ],
    },

    // ── Accessibility ─────────────────────────────────────────────────────
    {
        id: 'doors-accessibility',
        name: 'Doors — Accessibility',
        category: 'Accessibility',
        description: 'Doors must declare handicap-accessible status',
        nodes: [
            { type: 'spec', data: { name: 'Doors-Accessibility', ifcVersion: 'IFC4X3_ADD2', description: 'Doors must declare accessibility compliance' } },
            { type: 'entity', data: { name: 'IFCDOOR', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_DoorCommon', baseName: 'HandicapAccessible', dataType: 'IFCBOOLEAN', value: '', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },

    // ── Naming ────────────────────────────────────────────────────────────
    {
        id: 'doors-naming',
        name: 'Doors — Naming Convention',
        category: 'Naming',
        description: 'Doors must follow a naming convention',
        nodes: [
            { type: 'spec', data: { name: 'Doors-Naming', ifcVersion: 'IFC4X3_ADD2', description: 'All doors must follow the project naming convention' } },
            { type: 'entity', data: { name: 'IFCDOOR', predefinedType: '' } },
            { type: 'attribute', data: { name: 'Name', value: '', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },
    {
        id: 'walls-naming',
        name: 'Walls — Naming Convention',
        category: 'Naming',
        description: 'Walls must follow a naming convention',
        nodes: [
            { type: 'spec', data: { name: 'Walls-Naming', ifcVersion: 'IFC4X3_ADD2', description: 'All walls must follow the project naming convention' } },
            { type: 'entity', data: { name: 'IFCWALL', predefinedType: '' } },
            { type: 'attribute', data: { name: 'Name', value: '', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },

    // ── Classification ────────────────────────────────────────────────────
    {
        id: 'walls-classification',
        name: 'Walls — Classification',
        category: 'Classification',
        description: 'Walls must carry a Uniclass classification',
        nodes: [
            { type: 'spec', data: { name: 'Walls-Classification', ifcVersion: 'IFC4X3_ADD2', description: 'All walls must have a Uniclass classification reference' } },
            { type: 'entity', data: { name: 'IFCWALL', predefinedType: '' } },
            { type: 'classification', data: { system: 'Uniclass 2015', value: '', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },
    {
        id: 'doors-classification',
        name: 'Doors — Classification',
        category: 'Classification',
        description: 'Doors must carry a Uniclass classification',
        nodes: [
            { type: 'spec', data: { name: 'Doors-Classification', ifcVersion: 'IFC4X3_ADD2', description: 'All doors must have a Uniclass classification reference' } },
            { type: 'entity', data: { name: 'IFCDOOR', predefinedType: '' } },
            { type: 'classification', data: { system: 'Uniclass 2015', value: '', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },

    // ── Material ──────────────────────────────────────────────────────────
    {
        id: 'structural-steel',
        name: 'Structural Steel Material',
        category: 'Material',
        description: 'Structural beams must be steel',
        nodes: [
            { type: 'spec', data: { name: 'Structural-Steel', ifcVersion: 'IFC4X3_ADD2', description: 'Structural beams must use steel material' } },
            { type: 'entity', data: { name: 'IFCBEAM', predefinedType: '' } },
            { type: 'material', data: { value: 'Steel', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },
    {
        id: 'walls-concrete',
        name: 'Concrete Walls Material',
        category: 'Material',
        description: 'Structural walls must be concrete',
        nodes: [
            { type: 'spec', data: { name: 'Walls-Concrete', ifcVersion: 'IFC4X3_ADD2', description: 'Structural walls must use concrete material' } },
            { type: 'entity', data: { name: 'IFCWALL', predefinedType: '' } },
            { type: 'material', data: { value: 'Concrete', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },

    // ── Spatial ───────────────────────────────────────────────────────────
    {
        id: 'equipment-in-spaces',
        name: 'Equipment — Contained in Spaces',
        category: 'Spatial',
        description: 'Flow terminals must be contained within a space',
        nodes: [
            { type: 'spec', data: { name: 'Equipment-Spatial', ifcVersion: 'IFC4X3_ADD2', description: 'Equipment must be properly contained in spaces' } },
            { type: 'entity', data: { name: 'IFCFLOWTERMINAL', predefinedType: '' } },
            { type: 'partOf', data: { entity: 'IFCSPACE', relation: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },
    {
        id: 'furniture-in-spaces',
        name: 'Furniture — Contained in Spaces',
        category: 'Spatial',
        description: 'Furnishing elements must be contained within a space',
        nodes: [
            { type: 'spec', data: { name: 'Furniture-Spatial', ifcVersion: 'IFC4X3_ADD2', description: 'Furniture must be properly contained in spaces' } },
            { type: 'entity', data: { name: 'IFCFURNISHINGELEMENT', predefinedType: '' } },
            { type: 'partOf', data: { entity: 'IFCSPACE', relation: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', cardinality: 'required' } },
        ],
        edges: [{ from: 1, to: 0, targetHandle: 'applicability' }, { from: 2, to: 0, targetHandle: 'requirements' }],
    },

    // ── Restriction ───────────────────────────────────────────────────────
    {
        id: 'walls-fire-rating-enum',
        name: 'Walls — Fire Rating (Approved List)',
        category: 'Restriction',
        description: 'Fire rating must be one of the standard EN 13501 classes',
        nodes: [
            { type: 'spec', data: { name: 'Walls-FireRating-Enum', ifcVersion: 'IFC4X3_ADD2', description: 'Wall fire ratings must come from the approved list' } },
            { type: 'entity', data: { name: 'IFCWALL', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_WallCommon', baseName: 'FireRating', dataType: 'IFCLABEL', cardinality: 'required' } },
            { type: 'restriction', data: { restrictionType: 'enumeration', values: ['EI30', 'EI60', 'EI90', 'EI120', 'REI30', 'REI60', 'REI90', 'REI120'] } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 3 },
            { from: 2, to: 0, targetHandle: 'requirements' },
        ],
    },
    {
        id: 'doors-security-enum',
        name: 'Doors — Security Rating (Approved List)',
        category: 'Restriction',
        description: 'Security rating must be one of the standard RC resistance classes',
        nodes: [
            { type: 'spec', data: { name: 'Doors-SecurityRating-Enum', ifcVersion: 'IFC4X3_ADD2', description: 'Door security ratings must come from the approved list' } },
            { type: 'entity', data: { name: 'IFCDOOR', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_DoorCommon', baseName: 'SecurityRating', dataType: 'IFCLABEL', cardinality: 'required' } },
            { type: 'restriction', data: { restrictionType: 'enumeration', values: ['RC2', 'RC3', 'RC4', 'RC5', 'RC6'] } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 3 },
            { from: 2, to: 0, targetHandle: 'requirements' },
        ],
    },
    {
        id: 'windows-thermal-bounds',
        name: 'Windows — Thermal Transmittance Limit',
        category: 'Restriction',
        description: 'Thermal transmittance must stay under a maximum bound',
        nodes: [
            { type: 'spec', data: { name: 'Windows-Thermal-Bounds', ifcVersion: 'IFC4X3_ADD2', description: 'Window thermal transmittance must not exceed the maximum bound' } },
            { type: 'entity', data: { name: 'IFCWINDOW', predefinedType: '' } },
            { type: 'property', data: { propertySet: 'Pset_WindowCommon', baseName: 'ThermalTransmittance', dataType: 'IFCTHERMALTRANSMITTANCEMEASURE', cardinality: 'required' } },
            { type: 'restriction', data: { restrictionType: 'bounds', maxValue: '1.4' } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 3 },
            { from: 2, to: 0, targetHandle: 'requirements' },
        ],
    },
    {
        id: 'doors-naming-pattern',
        name: 'Doors — Naming Pattern',
        category: 'Restriction',
        description: 'Door names must match a fixed naming pattern',
        nodes: [
            { type: 'spec', data: { name: 'Doors-Naming-Pattern', ifcVersion: 'IFC4X3_ADD2', description: 'Door names must match the project naming pattern' } },
            { type: 'entity', data: { name: 'IFCDOOR', predefinedType: '' } },
            { type: 'attribute', data: { name: 'Name', cardinality: 'required' } },
            { type: 'restriction', data: { restrictionType: 'pattern', pattern: 'D-[0-9]{3}' } },
        ],
        edges: [
            { from: 1, to: 0, targetHandle: 'applicability' },
            { from: 2, to: 3 },
            { from: 2, to: 0, targetHandle: 'requirements' },
        ],
    },
]

export function instantiateTemplate(template) {
    const stamp = Date.now()
    const ids = template.nodes.map((_, i) => `${template.id}-${stamp}-${i}`)
    let facetRow = -1
    const nodes = template.nodes.map((n, i) => {
        let position
        if (n.type === 'spec') position = { x: 500, y: 150 }
        else if (n.type === 'restriction') position = { x: 300, y: 100 + facetRow * 140 }
        else { facetRow += 1; position = { x: 100, y: 100 + facetRow * 140 } }
        return { id: ids[i], type: n.type, position, data: { ...n.data } }
    })
    const edges = template.edges.map((e, i) => ({
        id: `${template.id}-${stamp}-edge-${i}`,
        source: ids[e.from],
        target: ids[e.to],
        targetHandle: e.targetHandle,
    }))
    return { nodes, edges }
}
