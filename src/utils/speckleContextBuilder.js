export class SpeckleContextBuilder {
    constructor(data, fullData) {
        this.data = data;
        this.fullData = fullData;
    }

    detectConnectorPattern() {
        const firstElement = this.fullData?.elements?.[0];
        if (!firstElement) return 'generic';
        return firstElement.source_type?.toLowerCase() || 'generic';
    }

    getConnectorHints(connector) {
        const hints = {
            revit:    { spatialOrganization: 'levels',   description: 'BIM connector with rich parameters and spatial hierarchy' },
            tekla:    { spatialOrganization: 'phases',   description: 'Structural steel connector with profile and assembly data' },
            ifc:      { spatialOrganization: 'storeys',  description: 'IFC standard with predefined types and base quantities' },
            archicad: { spatialOrganization: 'stories',  description: 'Architectural BIM connector' },
            rhino:    { spatialOrganization: 'layers',   description: 'CAD connector with layer-based organization' },
        };
        return hints[connector] || { spatialOrganization: 'none', description: 'Generic connector' };
    }

    /**
     * Fetch one or more named sections of model metadata on demand.
     * Each section returns values sorted by element count descending.
     * This is called by the get_context tool — the LLM requests only what it needs.
     */
    getContextSection(sections = []) {
        const summary = this.data?.summary || {};
        const parts   = [];

        const fmtGroup = (label, obj, suffix = '') => {
            const entries = Object.entries(obj || {}).sort(([, a], [, b]) => b - a);
            if (!entries.length) return `${label}: none`;
            return `${label} (${entries.length}):\n` +
                entries.map(([k, v]) => `  ${k}: ${v}${suffix}`).join('\n');
        };

        for (const section of sections) {
            switch (section) {
                case 'categories': parts.push(fmtGroup('Categories',   summary.by_category)); break;
                case 'ifc_types':  parts.push(fmtGroup('IFC Types',    summary.by_ifc_type)); break;
                case 'levels':     parts.push(fmtGroup('Levels',        summary.by_level, ' elements')); break;
                case 'materials':  parts.push(fmtGroup('Materials',     summary.by_material)); break;
                case 'grades':     parts.push(fmtGroup('Steel Grades',  summary.by_grade)); break;
                case 'profiles':   parts.push(fmtGroup('Steel Profiles',summary.by_profile)); break;
                case 'families':   parts.push(fmtGroup('Families',      summary.by_family)); break;
                case 'phases':     parts.push(fmtGroup('Phases',        summary.by_phase)); break;
                case 'worksets':   parts.push(fmtGroup('Worksets',      summary.by_workset)); break;
                case 'summary':
                    parts.push([
                        'Model Totals:',
                        `  Elements: ${(summary.total_elements || 0).toLocaleString()}`,
                        `  Volume:   ${(summary.total_volume  || 0).toFixed(2)} m³`,
                        `  Weight:   ${(summary.total_weight  || 0).toFixed(0)} kg`,
                        `  Length:   ${(summary.total_length  || 0).toFixed(0)} m`,
                    ].join('\n'));
                    break;
                default:
                    parts.push(`Unknown section "${section}". Valid: categories, ifc_types, levels, materials, grades, profiles, families, phases, worksets, summary`);
            }
        }

        return parts.join('\n\n') || 'No sections requested.';
    }

    buildSystemPrompt(currentFilters = {}) {
        const connector     = this.detectConnectorPattern();
        const hints         = this.getConnectorHints(connector);
        const totalElements = this.data?.summary?.total_elements || 0;
        const units         = this.fullData?.elements?.[0]?.units || 'mm';
        const activeFilters = Object.entries(currentFilters).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';

        return `You are a BIM data assistant.
Model: ${totalElements.toLocaleString()} elements · ${connector} (${hints.description}) · units: ${units}
Active filters: ${activeFilters}

Call get_context(sections) to look up model values before filtering. Sections: categories, ifc_types, levels, materials, grades, profiles, families, phases, worksets, summary. Each returns values with element counts.

Filterable fields: category, ifc_type, level, material, grade_short, profile_name, family, type, discipline, phase, workset

Tools: set_filters · clear_filters · calculate_aggregate(field: volume_m3|weight_kg|area_m2|length_mm) · search_elements · find_outliers · get_context

For standard IFC types (IfcBeam, IfcColumn, IfcWall, IfcSlab, IfcPlate, IfcDoor, IfcWindow…) filter directly without fetching context. Call get_context when you need exact value names or want counts. Always explain your reasoning.`;
    }
}
