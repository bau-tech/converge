/**
 * Speckle Traversal Patterns
 * Based on: https://docs.speckle.systems/developers/data-schema/llm-notes
 * 
 * Official Speckle traversal patterns for:
 * - Finding DataObjects recursively
 * - Resolving proxy references (materials, levels)
 * - Extracting geometry
 */

/**
 * Find all DataObjects recursively in a collection
 * Pattern from official Speckle LLM docs
 * 
 * @param {Object} collection - Root collection or nested collection
 * @returns {Array} List of DataObjects
 */
export function findDataObjects(collection) {
    const objects = [];

    if (!collection) return objects;

    // Check if collection has elements property
    if (collection.elements && Array.isArray(collection.elements)) {
        for (const item of collection.elements) {
            const speckleType = item?.speckle_type || '';

            // Check if this is a DataObject
            if (speckleType.includes('DataObject')) {
                objects.push(item);
            }
            // Check if this is a nested Collection
            else if (speckleType.includes('Collection')) {
                // Recursively find DataObjects in nested collection
                objects.push(...findDataObjects(item));
            }
        }
    }

    return objects;
}

/**
 * Find a proxy by type and name at root collection level
 * Proxies are stored at root level, not nested
 * 
 * @param {Object} root - Root collection
 * @param {string} proxyType - Type of proxy (e.g., 'RenderMaterial', 'Level')
 * @param {string} name - Name of the resource
 * @returns {Object|null} Proxy object or null
 */
export function findProxyByName(root, proxyType, name) {
    if (!root || !root.elements) return null;

    // Proxies are at root level
    const proxies = root.elements.filter(el => {
        const type = el?.speckle_type || '';
        return type.includes(proxyType);
    });

    // Find proxy with matching name
    return proxies.find(proxy => proxy.name === name) || null;
}

/**
 * Traverse all objects in a collection tree
 * Helper for finding objects by applicationId
 * 
 * @param {Object} root - Root collection
 * @returns {Array} All objects (flat list)
 */
export function traverseAll(root) {
    const allObjects = [];

    function traverse(obj) {
        if (!obj) return;

        allObjects.push(obj);

        // Traverse elements if it's a collection
        if (obj.elements && Array.isArray(obj.elements)) {
            obj.elements.forEach(traverse);
        }

        // Traverse displayValue if present (geometry objects)
        if (obj.displayValue && Array.isArray(obj.displayValue)) {
            obj.displayValue.forEach(traverse);
        }
    }

    traverse(root);
    return allObjects;
}

/**
 * Find objects using a specific resource (proxy pattern)
 * Resolves proxy references by applicationId
 * 
 * @param {Object} root - Root collection
 * @param {string} proxyType - Proxy type (RenderMaterial, Level, etc.)
 * @param {string} resourceName - Name of the resource
 * @returns {Array} Objects using this resource
 */
export function findObjectsUsingResource(root, proxyType, resourceName) {
    // Find proxy by name
    const proxy = findProxyByName(root, proxyType, resourceName);
    if (!proxy) {
        console.warn(`Proxy not found: ${proxyType} - ${resourceName}`);
        return [];
    }

    // Get referenced applicationIds
    const referencedIds = proxy.objects || [];

    if (referencedIds.length === 0) {
        console.warn(`Proxy has no references: ${resourceName}`);
        return [];
    }

    // Find all objects matching those applicationIds
    const allObjects = traverseAll(root);
    const matchingObjects = allObjects.filter(obj =>
        obj.applicationId && referencedIds.includes(obj.applicationId)
    );

    return matchingObjects;
}

/**
 * Extract geometry from a DataObject
 * Geometry is always in displayValue array
 * 
 * @param {Object} obj - DataObject
 * @returns {Array} Geometry objects
 */
export function extractGeometry(obj) {
    if (!obj) return [];

    // Check if displayValue exists and is an array
    if (obj.displayValue && Array.isArray(obj.displayValue)) {
        return obj.displayValue;
    }

    return [];
}

/**
 * Extract all geometry from a collection
 * 
 * @param {Object} collection - Collection or DataObject
 * @returns {Array} All geometry objects (flat)
 */
export function extractAllGeometry(collection) {
    const geometries = [];

    // Get all DataObjects
    const dataObjects = findDataObjects(collection);

    // Extract geometry from each DataObject
    dataObjects.forEach(obj => {
        const geom = extractGeometry(obj);
        geometries.push(...geom);
    });

    return geometries;
}

/**
 * Get elements by level (proxy resolution)
 * 
 * @param {Object} root - Root collection
 * @param {string} levelName - Level name (e.g., "Level 1")
 * @returns {Array} Elements on this level
 */
export function getElementsByLevel(root, levelName) {
    return findObjectsUsingResource(root, 'Level', levelName);
}

/**
 * Get elements by material (proxy resolution)
 * 
 * @param {Object} root - Root collection
 * @param {string} materialName - Material name (e.g., "Concrete", "S355")
 * @returns {Array} Elements with this material
 */
export function getElementsByMaterial(root, materialName) {
    return findObjectsUsingResource(root, 'RenderMaterial', materialName);
}

/**
 * Get available levels from proxies
 * 
 * @param {Object} root - Root collection
 * @returns {Array} List of level names
 */
export function getAvailableLevels(root) {
    if (!root || !root.elements) return [];

    const levelProxies = root.elements.filter(el => {
        const type = el?.speckle_type || '';
        return type.includes('Level');
    });

    return levelProxies.map(proxy => proxy.name).filter(Boolean);
}

/**
 * Get available materials from proxies
 * 
 * @param {Object} root - Root collection
 * @returns {Array} List of material names
 */
export function getAvailableMaterials(root) {
    if (!root || !root.elements) return [];

    const materialProxies = root.elements.filter(el => {
        const type = el?.speckle_type || '';
        return type.includes('RenderMaterial');
    });

    return materialProxies.map(proxy => proxy.name).filter(Boolean);
}

/**
 * Get statistics about proxies in the model
 * 
 * @param {Object} root - Root collection
 * @returns {Object} Proxy statistics
 */
export function getProxyStats(root) {
    if (!root || !root.elements) {
        return { levels: 0, materials: 0, groups: 0, other: 0 };
    }

    const stats = { levels: 0, materials: 0, groups: 0, other: 0 };

    root.elements.forEach(el => {
        const type = el?.speckle_type || '';
        if (type.includes('Level')) stats.levels++;
        else if (type.includes('RenderMaterial')) stats.materials++;
        else if (type.includes('Group')) stats.groups++;
        else if (type.includes('Proxy') || type.includes('Definition')) stats.other++;
    });

    return stats;
}
