/**
 * Speckle Context Builder for AI Assistant
 * Based on: https://docs.speckle.systems/developers/data-schema/llm-notes
 * 
 * Builds rich context following official Speckle data model patterns
 */

export class SpeckleContextBuilder {
    constructor(data, fullData) {
        this.data = data;
        this.fullData = fullData;
    }

    /**
     * Extract available properties using nested traversal
     * Follows Speckle pattern: properties can be nested in 'properties', 'parameters', etc.
     */
    extractAvailableProperties() {
        const properties = new Set();

        const traverse = (obj, path = '') => {
            if (!obj || typeof obj !== 'object') return;

            Object.keys(obj).forEach(key => {
                // Skip internal Speckle fields
                if (key.startsWith('__') || key === 'speckle_type' || key === 'id') return;

                const fullPath = path ? `${path}.${key}` : key;
                properties.add(fullPath);

                // Recurse into nested objects (but limit depth to avoid explosion)
                if (typeof obj[key] === 'object' && obj[key] !== null && path.split('.').length < 4) {
                    traverse(obj[key], fullPath);
                }
            });
        };

        // Sample first 100 elements to extract property schema
        const sampleElements = (this.fullData?.elements || []).slice(0, 100);

        sampleElements.forEach(el => {
            // Traverse both properties and raw_properties
            if (el.properties) traverse(el.properties, 'properties');
            if (el.raw_properties) traverse(el.raw_properties, 'raw_properties');
        });

        return Array.from(properties).sort();
    }

    /**
     * Detect source connector pattern
     * Returns: 'revit', 'tekla', 'ifc', 'archicad', 'rhino', or 'generic'
     */
    detectConnectorPattern() {
        const firstElement = this.fullData?.elements?.[0];
        if (!firstElement) return 'generic';

        const sourceType = firstElement.source_type?.toLowerCase();
        return sourceType || 'generic';
    }

    /**
     * Get connector-specific hints
     * Based on official Speckle connector patterns
     */
    getConnectorHints(connector) {
        const hints = {
            revit: {
                propertyPaths: ['properties', 'parameters', 'quantities'],
                commonFilters: ['category', 'family', 'type', 'level', 'phase', 'workset'],
                spatialOrganization: 'levels',
                description: 'BIM connector with rich parameters and spatial hierarchy'
            },
            tekla: {
                propertyPaths: ['properties', 'Report'],
                commonFilters: ['profile', 'material', 'assembly_pos', 'PROFILE_TYPE'],
                spatialOrganization: 'phases',
                description: 'Structural steel connector with profile and assembly data'
            },
            ifc: {
                propertyPaths: ['properties', 'Element Type Attributes', 'BaseQuantities'],
                commonFilters: ['GlobalId', 'PredefinedType', 'ObjectType', 'IfcClass'],
                spatialOrganization: 'storeys',
                description: 'IFC standard with predefined types and base quantities'
            },
            archicad: {
                propertyPaths: ['properties', 'parameters'],
                commonFilters: ['category', 'layer', 'type'],
                spatialOrganization: 'stories',
                description: 'Architectural BIM connector'
            },
            rhino: {
                propertyPaths: ['properties', 'attributes'],
                commonFilters: ['layer', 'color', 'name'],
                spatialOrganization: 'layers',
                description: 'CAD connector with layer-based organization'
            }
        };

        return hints[connector] || {
            propertyPaths: ['properties'],
            commonFilters: ['category', 'type', 'name'],
            spatialOrganization: 'none',
            description: 'Generic connector'
        };
    }

    /**
     * Build comprehensive context for AI
     */
    buildContext() {
        const connector = this.detectConnectorPattern();
        const connectorHints = this.getConnectorHints(connector);
        const properties = this.extractAvailableProperties();

        return {
            model: {
                totalElements: this.data?.summary?.total_elements || 0,
                connector: connector,
                connectorDescription: connectorHints.description,
                units: this.fullData?.elements?.[0]?.units || 'mm'
            },
            categories: Object.keys(this.data?.summary?.by_category || {}).slice(0, 20),
            ifc_types: Object.keys(this.data?.summary?.by_ifc_type || {}).slice(0, 20),
            levels: Object.keys(this.data?.summary?.by_level || {}).slice(0, 20),
            materials: Object.keys(this.data?.summary?.by_material || {}).slice(0, 20),
            grades: Object.keys(this.data?.summary?.by_grade || {}).slice(0, 20),
            families: Object.keys(this.data?.summary?.by_family || {}).slice(0, 20),
            profiles: Object.keys(this.data?.summary?.by_profile || {}).slice(0, 20),
            phases: Object.keys(this.data?.summary?.by_phase || {}).slice(0, 10),
            worksets: Object.keys(this.data?.summary?.by_workset || {}).slice(0, 20),
            availableProperties: properties.slice(0, 50),
            connectorSpecific: connectorHints
        };
    }

    /**
     * Build enhanced system prompt for AI
     */
    buildSystemPrompt(currentFilters = {}) {
        const context = this.buildContext();

        return `You are a Speckle BIM Data Assistant with deep understanding of the Speckle data model.

## Current Model Context
- **Total Elements**: ${context.model.totalElements.toLocaleString()}
- **Connector**: ${context.model.connector} (${context.model.connectorDescription})
- **Units**: ${context.model.units}
- **Spatial Organization**: ${context.connectorSpecific.spatialOrganization}

## Available Categories
${context.categories.join(', ') || 'None'}

## IFC Element Types
${context.ifc_types.join(', ') || 'None'}

## Levels / Storeys
${context.levels.join(', ') || 'None'}

## Materials
${context.materials.join(', ') || 'None'}

## Material Grades
${context.grades.join(', ') || 'None'}

## Steel Profiles
${context.profiles.join(', ') || 'None'}

## Construction Phases
${context.phases.join(', ') || 'None'}

## Worksets
${context.worksets.join(', ') || 'None'}

## Key Properties (Sample)
${context.availableProperties.slice(0, 15).join('\n') || 'None detected'}

## Current Active Filters
${Object.entries(currentFilters).map(([k, v]) => `- ${k}: ${v}`).join('\n') || 'None'}

## Filterable Fields
category, ifc_type, level, material, grade_short, profile_name, family, type, discipline, phase, workset

## Your Capabilities
1. **Filters**: Use set_filters() with any of the filterable fields above
2. **Property Queries**: Reference nested properties (e.g., "parameters.Fire Rating")
3. **Aggregate Queries**: For SUM/AVG across elements, inform the user you can query the database
4. **IFC Types**: Use canonical IFC names (IfcBeam, IfcColumn, IfcWall, IfcSlab, IfcPlate) when filtering by element type
5. **Explanations**: Always explain what filters you're applying and why

## Query Examples
- "Show structural columns" → set_filters({ifc_type: "IfcColumn"})
- "S355 beams on Level 3" → set_filters({grade_short: "S355", ifc_type: "IfcBeam", level: "Level 3"})
- "Concrete walls on level 2" → set_filters({material: "Concrete", category: "Walls", level: "Level 2"})
- "Total steel weight by profile" → Inform: "I can query the database for this aggregate"

When filtering, be conversational and explain your reasoning.`;
    }
}
