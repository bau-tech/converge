// GraphQL helper: uses variables (no string interpolation), checks HTTP status
// + GraphQL errors. Takes serverUrl/token explicitly (unlike App.jsx's own
// local gqlFetch, which reads the static default-server CONFIG) so callers
// can query whichever server the user has actually switched to.
export async function gqlFetch(serverUrl, token, query, variables = {}, signal) {
    const response = await fetch(`${serverUrl}/graphql`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal,
    })
    if (!response.ok) {
        throw new Error(`Speckle API ${response.status}: ${response.statusText}`)
    }
    const result = await response.json()
    if (result.errors?.length) {
        throw new Error(result.errors[0].message)
    }
    return result.data
}
