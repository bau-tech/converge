// Shared filter condition/operator definitions and evaluators.
// Used by FilterWidget for DNF (OR-of-AND-groups) element filtering.

export const OPERATOR_OPTIONS = [
    { label: 'Equals',         value: 'equals'         },
    { label: 'Not Equals',     value: 'not_equals'     },
    { label: 'Contains',       value: 'contains'       },
    { label: 'Is Any Of',      value: 'is_any_of'      },
    { label: 'Is None Of',     value: 'is_none_of'     },
    { label: 'Greater Than',   value: 'gt'             },
    { label: 'Less Than',      value: 'lt'             },
    { label: 'Is Defined',     value: 'is_defined'     },
    { label: 'Is Not Defined', value: 'is_not_defined' },
]

// Operators that don't need a value input at all
export const NO_VALUE_OPERATORS = new Set(['is_defined', 'is_not_defined'])

// Operators whose value is an array of selected values rather than a scalar
export const MULTI_VALUE_OPERATORS = new Set(['is_any_of', 'is_none_of'])

// A condition is "active" (usable for filtering) once it has a property and,
// unless the operator needs no value, a non-empty value.
export function isConditionActive(condition) {
    if (!condition?.property) return false
    if (NO_VALUE_OPERATORS.has(condition.operator)) return true
    if (MULTI_VALUE_OPERATORS.has(condition.operator)) {
        return Array.isArray(condition.value) && condition.value.length > 0
    }
    return condition.value !== '' && condition.value !== null && condition.value !== undefined
}

// Evaluate a single condition against a (possibly nested) property value.
export function evaluateCondition(value, condition) {
    const missing = value === undefined || value === null || value === ''

    switch (condition.operator) {
        case 'is_defined':     return !missing
        case 'is_not_defined': return missing
        case 'is_any_of':
            if (missing) return false
            return (condition.value || []).map(String).includes(String(value))
        case 'is_none_of':
            if (missing) return true
            return !(condition.value || []).map(String).includes(String(value))
        default: {
            if (missing) return false
            switch (condition.operator) {
                case 'equals':
                    return String(value) === String(condition.value)
                case 'not_equals':
                    return String(value) !== String(condition.value)
                case 'contains':
                    if (!condition.value) return false
                    return String(value).toLowerCase().includes(String(condition.value).toLowerCase())
                case 'gt':
                    return Number(value) > Number(condition.value)
                case 'lt':
                    return Number(value) < Number(condition.value)
                default:
                    return false
            }
        }
    }
}

// DNF evaluator: element matches if ANY group matches, where a group matches
// only if ALL of its active conditions match. Groups/conditions with no
// active conditions are ignored (never match).
export function evaluateGroups(element, groups, getNested) {
    return groups.some(group => {
        const activeConditions = group.conditions.filter(isConditionActive)
        if (activeConditions.length === 0) return false
        return activeConditions.every(condition =>
            evaluateCondition(getNested(element, condition.property), condition)
        )
    })
}

// True if at least one group has at least one active condition.
export function hasActiveConditions(groups) {
    return groups.some(group => group.conditions.some(isConditionActive))
}
